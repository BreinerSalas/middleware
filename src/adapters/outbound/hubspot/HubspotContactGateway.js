'use strict'

const async = require('async')
const { mapPartnerToContactProperties } = require('./partnerToContactMapper')

// Concurrency for the per-item fallback when a whole HubSpot batch/upsert chunk is rejected
// (e.g. one colliding/invalid email in the chunk). The shared HubSpot rate limiter is the
// real safety net regardless of this local cap.
const FALLBACK_CONCURRENCY = 10

class HubspotContactGateway {
  constructor({ apiClient, logger = null, idProperty = 'id_contacto_odoo' } = {}) {
    if (!apiClient) throw new Error('HubspotContactGateway requires apiClient')
    this.apiClient = apiClient
    this.logger = logger
    this.idProperty = idProperty
  }

  hasValidOdooId(odooPartner) {
    if (!odooPartner) return false
    const id = odooPartner.id
    if (id == null) return false
    if (typeof id === 'number') return Number.isFinite(id)
    const n = Number(id)
    return Number.isFinite(n)
  }

  extractOdooId(odooPartner) {
    return String(odooPartner.id)
  }

  buildProperties(odooPartner) {
    return mapPartnerToContactProperties(odooPartner, { idProperty: this.idProperty })
  }

  isDuplicateError(err) {
    if (!err) return false
    const status = err.httpStatus ?? err.status ?? (err.response && err.response.status)
    if (status !== 400 && status !== 409) return false
    const sources = [
      err.message,
      err.response && err.response.data && err.response.data.message,
      err.original && err.original.response && err.original.response.data && err.original.response.data.message
    ].filter(Boolean)
    const msg = sources.join(' ').toLowerCase()
    return msg.includes('already has that value') || msg.includes('propertyvaluecoordinates') ||
      msg.includes('contact already exists')
  }

  isInvalidPropertyValueError(err) {
    if (!err) return false
    const category =
      (err.original && err.original.response && err.original.response.data && err.original.response.data.category) ||
      (err.response && err.response.data && err.response.data.category)
    if (category === 'VALIDATION_ERROR') return true
    const sources = [
      err.message,
      err.response && err.response.data && err.response.data.message,
      err.original && err.original.response && err.original.response.data && err.original.response.data.message
    ].filter(Boolean)
    const msg = sources.join(' ').toLowerCase()
    return msg.includes('invalid_email') || msg.includes('property values were not valid')
  }

  // Shared classification of permanent, non-retryable per-item failures. Returns a `skipped`
  // reason string when the error should permanently skip the item (never counted as `failed`,
  // so it never blocks an incremental sync watermark), or null when the error should propagate
  // as a real failure.
  classifySkipReason(err) {
    if (this.isDuplicateError(err)) return 'duplicate_in_hubspot'
    if (this.isInvalidPropertyValueError(err)) return 'invalid_property_value'
    return null
  }

  async upsertByOdooId(odooPartner) {
    if (!odooPartner || !this.hasValidOdooId(odooPartner)) {
      return { skipped: true, reason: 'no_id', created: false }
    }
    const name = odooPartner.name == null ? '' : String(odooPartner.name).trim()
    if (!name) return { skipped: true, reason: 'no_name', created: false }

    const odooId = this.extractOdooId(odooPartner)
    const properties = this.buildProperties(odooPartner)

    let existing = null
    try {
      existing = await this.apiClient.searchContactByProperty(this.idProperty, odooId)
    } catch (err) {
      if (this.logger) {
        this.logger.warn('hubspot.contact.search failed; falling back to create', {
          odooId, error: err.message
        })
      }
    }
    if (existing && existing.id) {
      const data = await this.apiClient.updateContact(existing.id, properties)
      return { ...data, created: false }
    }
    try {
      const data = await this.apiClient.createContact(properties)
      return { ...data, created: true }
    } catch (err) {
      const reason = this.classifySkipReason(err)
      if (reason) {
        if (this.logger) {
          this.logger.warn(`hubspot.contact.${reason === 'duplicate_in_hubspot' ? 'duplicate' : 'invalid_property_value'}`, {
            odooId, sourceId: odooPartner.id, error: err.message
          })
        }
        return { skipped: true, reason, created: false }
      }
      throw err
    }
  }

  async batchUpsertByOdooIds(odooPartners, { chunkSize = 100, idProperty = this.idProperty } = {}) {
    if (!Array.isArray(odooPartners) || odooPartners.length === 0) {
      return { results: [], errors: [], skipped: [] }
    }

    const valid = []
    const skipped = []
    for (const p of odooPartners) {
      if (this.hasValidOdooId(p)) {
        valid.push(p)
      } else {
        skipped.push({ sourceId: p && p.id != null ? p.id : null, reason: 'no_id' })
      }
    }
    if (valid.length === 0) {
      return { results: [], errors: [], skipped }
    }

    const allResults = []
    const allErrors = []
    for (let i = 0; i < valid.length; i += chunkSize) {
      const chunk = valid.slice(i, i + chunkSize)
      const inputs = chunk.map((p) => ({
        id: this.extractOdooId(p),
        properties: this.buildProperties(p)
      }))
      try {
        const response = await this.apiClient.batchUpsertContacts({ inputs, idProperty })
        allResults.push(...(response.results || []))
        allErrors.push(...(response.errors || []))
      } catch (err) {
        // HubSpot can reject the WHOLE batch request for a single item's conflict (e.g. an
        // email that already belongs to another contact) or an invalid property value (e.g. a
        // malformed email) instead of returning it as a per-item error. Falling back to
        // single-item batch/upsert calls in parallel isolates just the offending partner(s) so
        // the rest of the chunk still syncs instead of every item failing forever, and costs
        // only 1 HTTP call per item instead of the 2 a search+create/update fallback would.
        if (this.logger) {
          this.logger.warn('hubspot.contact.batch_chunk_failed_fallback_to_individual', {
            chunkSize: chunk.length, error: err.message
          })
        }
        const fallbackResults = await async.mapLimit(chunk, FALLBACK_CONCURRENCY, async (p) => {
          const sourceId = p.id
          try {
            const single = await this.apiClient.batchUpsertContacts({
              inputs: [{ id: this.extractOdooId(p), properties: this.buildProperties(p) }],
              idProperty
            })
            const item = single && single.results && single.results[0]
            return { ok: true, item }
          } catch (itemErr) {
            const reason = this.classifySkipReason(itemErr)
            if (reason) {
              if (this.logger) {
                this.logger.warn(`hubspot.contact.${reason === 'duplicate_in_hubspot' ? 'duplicate' : 'invalid_property_value'}`, {
                  sourceId, error: itemErr.message
                })
              }
              return { ok: false, skipped: true, sourceId, reason }
            }
            return { ok: false, skipped: false, sourceId: this.extractOdooId(p), message: itemErr.message }
          }
        })
        for (const r of fallbackResults) {
          if (r.ok) {
            if (r.item) allResults.push(r.item)
          } else if (r.skipped) {
            skipped.push({ sourceId: r.sourceId, reason: r.reason })
          } else {
            allErrors.push({ id: r.sourceId, message: r.message })
          }
        }
      }
    }
    return { results: allResults, errors: allErrors, skipped }
  }
}

module.exports = { HubspotContactGateway }

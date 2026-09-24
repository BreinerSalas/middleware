'use strict'

const { calculateNextRetry, shouldDeadLetter } = require('../../domain/RetryPolicy')
const { SkipSyncError } = require('../../domain/errors')
const { mapContactToPartnerPayload } = require('../../../adapters/outbound/odoo/contactToPartnerMapper')

// HubSpot properties fetched for every contact. idProperty (injected, config-driven) is
// added on top of this fixed list — never hardcoded alongside it.
const CONTACT_PROPERTIES = [
  'email', 'firstname', 'lastname', 'phone', 'mobilephone',
  'address', 'city', 'zip', 'jobtitle', 'company', 'country'
]

const CONTACT_SOURCE_PREFIX = 'contact:'

function parseContactObjectId(sourceId) {
  const s = String(sourceId == null ? '' : sourceId)
  return s.startsWith(CONTACT_SOURCE_PREFIX) ? s.slice(CONTACT_SOURCE_PREFIX.length) : s
}

function normalizeEmail(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase()
}

function httpStatusOf(err) {
  return Number(err && (err.httpStatus || (err.response && err.response.status)))
}

// ProcessInboundContactSyncUseCase — HubSpot contact.creation -> Odoo res.partner (v1,
// creation-only). Mirrors ProcessSyncJobUseCase's shape but has its own handleError:
// deal-specific gateways/buildWriteBackPayload don't apply here (design decision,
// sdd/hubspot-contact-inbound-sync). Ports are injected clients directly, following
// manufacturingOrderRetrySyncModule's precedent, not new gateway classes.
class ProcessInboundContactSyncUseCase {
  constructor({
    hubspotApiClient,
    odooApiClient,
    partnerMappingRepository,
    jobRepository,
    idProperty,
    logger = null
  } = {}) {
    if (!hubspotApiClient) throw new Error('ProcessInboundContactSyncUseCase requires hubspotApiClient')
    if (!odooApiClient) throw new Error('ProcessInboundContactSyncUseCase requires odooApiClient')
    if (!partnerMappingRepository) throw new Error('ProcessInboundContactSyncUseCase requires partnerMappingRepository')
    if (!jobRepository) throw new Error('ProcessInboundContactSyncUseCase requires jobRepository')
    if (!idProperty) throw new Error('ProcessInboundContactSyncUseCase requires idProperty')
    this.hubspotApiClient = hubspotApiClient
    this.odooApiClient = odooApiClient
    this.partnerMappingRepository = partnerMappingRepository
    this.jobRepository = jobRepository
    this.idProperty = idProperty
    this.logger = logger
  }

  // Best-effort: ISO code first, then exact name. Never throws — an unresolved country
  // just leaves country_id absent from the create payload.
  async resolveCountryId(rawCountry) {
    const value = String(rawCountry == null ? '' : rawCountry).trim()
    if (!value) return undefined
    const byCode = await this.odooApiClient.searchCountryIdsByCodes([value])
    if (byCode[value]) return byCode[value].id
    const byName = await this.odooApiClient.searchCountryIdsByNames([value])
    if (byName[value]) return byName[value].id
    if (this.logger) this.logger.warn('contact_inbound.country_unresolved', { country: value })
    return undefined
  }

  async execute({ job }) {
    if (!job || !job._id) throw new Error('ProcessInboundContactSyncUseCase requires a persisted job')
    const { _id: jobId, sourceId, attempts: priorAttempts, maxAttempts } = job
    const objectId = parseContactObjectId(sourceId)

    try {
      let contact
      try {
        contact = await this.hubspotApiClient.getContactById(objectId, [this.idProperty, ...CONTACT_PROPERTIES])
      } catch (err) {
        if (httpStatusOf(err) === 404) throw new SkipSyncError('contact_not_found')
        throw err
      }
      if (!contact) throw new SkipSyncError('contact_not_found')

      const props = contact.properties || {}
      if (props[this.idProperty]) throw new SkipSyncError('echo_odoo_origin')

      const existingMapping = await this.partnerMappingRepository.findByHubspotId(objectId)
      let odooId

      if (existingMapping) {
        // Idempotent retry: a prior attempt already created/linked the partner and
        // persisted the mapping, but the write-back below failed. Skip straight to it.
        odooId = existingMapping.odooId
      } else {
        const email = normalizeEmail(props.email)
        if (!email) throw new SkipSyncError('missing_email')

        const matches = await this.odooApiClient.searchPartnersByEmail(email)
        if (matches.length >= 2) {
          if (this.logger) this.logger.warn('contact_inbound.ambiguous_email_match', { objectId, email, matchCount: matches.length })
          throw new SkipSyncError('ambiguous_email_match')
        }

        if (matches.length === 1) {
          // A partner was found by email (either pre-existing, or created by a prior
          // attempt whose mapping upsert then failed — the retry-safe backstop).
          const partnerOdooId = Number(matches[0].id)
          const mappingForPartner = await this.partnerMappingRepository.findByOdooId(partnerOdooId)
          if (mappingForPartner && mappingForPartner.hubspotId && String(mappingForPartner.hubspotId) !== String(objectId)) {
            throw new SkipSyncError('partner_already_linked')
          }
          odooId = partnerOdooId
          await this.partnerMappingRepository.upsert({ odooId, hubspotId: objectId, action: 'linked', direction: 'hubspot_to_odoo' })
        } else {
          const countryId = await this.resolveCountryId(props.country)
          const payload = mapContactToPartnerPayload(props, { countryId })
          let created
          try {
            created = await this.odooApiClient.createPartner(payload)
          } catch (err) {
            if (err && err.transient === false) throw new SkipSyncError('odoo_validation_error')
            throw err
          }
          odooId = Number(created.id)
          await this.partnerMappingRepository.upsert({ odooId, hubspotId: objectId, action: 'created', direction: 'hubspot_to_odoo' })
        }
      }

      try {
        await this.hubspotApiClient.updateContact(objectId, { [this.idProperty]: String(odooId) })
      } catch (err) {
        if (httpStatusOf(err) === 400) throw new SkipSyncError('writeback_conflict')
        throw err
      }

      const updated = await this.jobRepository.markCompleted(jobId)
      return { job: updated, odooId }
    } catch (err) {
      return this.handleError({ jobId, err, priorAttempts, maxAttempts })
    }
  }

  async handleError({ jobId, err, priorAttempts, maxAttempts }) {
    if (err instanceof SkipSyncError) {
      const updated = await this.jobRepository.markSkipped(jobId, err)
      if (this.logger) this.logger.warn('contact_inbound.skipped', { jobId, reason: err.reason || err.message })
      return { job: updated, skipped: true, error: err }
    }

    const attempts = priorAttempts || 0
    const retryable = !err || err.transient !== false
    const deadLetter = shouldDeadLetter({ attempts, maxAttempts, error: err }) || !retryable
    const nextRetryAt = deadLetter ? null : calculateNextRetry({ attempts })

    const updated = await this.jobRepository.markFailed(jobId, { error: err, nextRetryAt, deadLetter })
    if (this.logger) {
      this.logger.warn(deadLetter ? 'contact_inbound.dead_letter' : 'contact_inbound.retry_scheduled', {
        jobId, attempts, retryable, message: err && err.message
      })
    }
    return { job: updated, retryable, deadLetter, error: err }
  }
}

module.exports = { ProcessInboundContactSyncUseCase, parseContactObjectId }

'use strict'

const { SkipSyncError } = require('../core/domain/errors')
const { isUnsetQuoteCountry } = require('../core/domain/quoteCountryValue')

function normalizeAllowlist(allowed = []) {
  if (!Array.isArray(allowed)) return []
  return allowed.map((v) => String(v)).filter((v) => v.length > 0)
}

function mustHaveLineItems({ references = {}, record } = {}) {
  const items = Array.isArray(references.lineItems) ? references.lineItems : []
  if (items.length === 0) {
    throw new SkipSyncError('Deal has no line items', { detail: { sourceId: record && record.id } })
  }
}

function createMustHaveOdooCustomerId({ defaultCustomerId = '' } = {}) {
  const fallback = defaultCustomerId ? String(defaultCustomerId) : ''
  return function mustHaveOdooCustomerId({ record, references = {} } = {}) {
    const props = (record && record.properties) || {}
    const direct = props.id_cliente_odoo
    const ref = references.odooCustomerId
    if (!direct && !ref && !fallback) {
      const err = new Error('Missing Odoo customer reference for deal')
      err.transient = true
      err.code = 'MISSING_ODOO_CUSTOMER_ID'
      throw err
    }
  }
}

function createMustHaveQuoteCountry({ countryProperty = 'pais_de_destino' } = {}) {
  const prop = countryProperty || 'pais_de_destino'
  return function mustHaveQuoteCountry({ record } = {}) {
    // No-op on the legacy deal path (no quote): the partner-country fallback in
    // OdooTargetGateway.resolveCountryExpense handles it.
    if (!record || !record.quoteId) return
    const quoteProps = (record.quote && record.quote.properties) || {}
    const country = quoteProps[prop]
    if (country == null || String(country).trim() === '' || isUnsetQuoteCountry(country)) {
      throw new SkipSyncError(`Quote has no ${prop} (country code)`, {
        detail: { sourceId: record.id, quoteId: record.quoteId, missingProperty: prop }
      })
    }
  }
}

function mustBeClosedWon({ record } = {}) {
  const props = (record && record.properties) || {}
  const stage = props.dealstage
  if (stage !== 'closedwon') {
    throw new SkipSyncError(`Deal stage is not closedwon (${stage || 'unknown'})`, { detail: { sourceId: record && record.id, stage } })
  }
}

function createMustHaveDealStage({ allowed = [] } = {}) {
  const allowlist = normalizeAllowlist(allowed)
  return function mustHaveDealStage({ record } = {}) {
    const props = (record && record.properties) || {}
    const stage = props.dealstage == null ? null : String(props.dealstage)
    if (!stage || !allowlist.includes(stage)) {
      throw new SkipSyncError(
        `dealstage ${stage || 'unknown'} is not in allowed list (${allowlist.join(',') || '∅'})`,
        { detail: { sourceId: record && record.id, stage, allowedStageIds: allowlist } }
      )
    }
  }
}

function createMustBeInPipeline({ allowed = [], rejectWhenMissing = true } = {}) {
  const allowlist = normalizeAllowlist(allowed)
  return function mustBeInPipeline({ record } = {}) {
    const props = (record && record.properties) || {}
    const pipeline = props.pipeline == null ? null : String(props.pipeline)
    if (!pipeline) {
      if (rejectWhenMissing) {
        throw new SkipSyncError(
          `pipeline property is missing (allowed: ${allowlist.join(',') || '∅'})`,
          { detail: { sourceId: record && record.id, allowedPipelineIds: allowlist } }
        )
      }
      return
    }
    if (!allowlist.includes(pipeline)) {
      throw new SkipSyncError(
        `pipeline ${pipeline} is not in allowed list (${allowlist.join(',') || '∅'})`,
        { detail: { sourceId: record && record.id, pipeline, allowedPipelineIds: allowlist } }
      )
    }
  }
}

module.exports = {
  mustHaveLineItems,
  mustBeClosedWon,
  createMustHaveOdooCustomerId,
  createMustHaveDealStage,
  createMustBeInPipeline,
  createMustHaveQuoteCountry
}

'use strict'

const { SkipSyncError } = require('../core/domain/errors')

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
  createMustBeInPipeline
}

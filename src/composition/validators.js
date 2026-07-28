'use strict'

const { SkipSyncError } = require('../core/domain/errors')

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

module.exports = { mustHaveLineItems, mustBeClosedWon, createMustHaveOdooCustomerId }

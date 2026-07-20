'use strict'

const { SkipSyncError } = require('../../core/domain/errors')

function mustHaveLineItems({ record } = {}) {
  const props = (record && record.properties) || {}
  const items = Array.isArray(props.line_items) ? props.line_items : []
  if (items.length === 0) {
    throw new SkipSyncError('Deal has no line items', { detail: { sourceId: record && record.id } })
  }
}

function mustHaveOdooCustomerId({ record, references = {} } = {}) {
  const props = (record && record.properties) || {}
  const direct = props.id_cliente_odoo
  const ref = references.odooCustomerId
  if (!direct && !ref) {
    const err = new Error('Missing Odoo customer reference for deal')
    err.transient = true
    err.code = 'MISSING_ODOO_CUSTOMER_ID'
    throw err
  }
}

function mustBeClosedWon({ record } = {}) {
  const props = (record && record.properties) || {}
  const stage = props.dealstage
  if (stage !== 'closedwon') {
    throw new SkipSyncError(`Deal stage is not closedwon (${stage || 'unknown'})`, { detail: { sourceId: record && record.id, stage } })
  }
}

module.exports = { mustHaveLineItems, mustHaveOdooCustomerId, mustBeClosedWon }

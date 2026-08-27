'use strict'

const JOB_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  RETRY_PENDING: 'RETRY_PENDING',
  COMPLETED: 'COMPLETED',
  SKIPPED: 'SKIPPED',
  DEAD_LETTER: 'DEAD_LETTER'
})

const SOURCES = Object.freeze({
  HUBSPOT: 'hubspot'
})

const ENTITIES = Object.freeze({
  DEAL: 'deal'
})

const JOB_KIND = Object.freeze({
  DEAL: 'deal',
  QUOTE: 'quote',
  PRODUCT_SYNC: 'product_sync',
  SALE_ORDER_STATUS_SYNC: 'sale_order_status_sync',
  MANUFACTURING_ORDER_RETRY_SYNC: 'manufacturing_order_retry_sync',
  PARTNER_SYNC: 'partner_sync',
  PRODUCT_ORPHAN_RECONCILE: 'product_orphan_reconcile'
})

module.exports = {
  JOB_STATUS,
  SOURCES,
  ENTITIES,
  JOB_KIND
}

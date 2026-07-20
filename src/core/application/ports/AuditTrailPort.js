'use strict'

/**
 * Port: AuditTrailPort
 *
 * Append-only record of synchronization checkpoints. Implementations must
 * never mutate previously recorded entries.
 *
 * @typedef {Object} AuditEntry
 * @property {string|null} _id
 * @property {string|null} jobId
 * @property {string} sourceId
 * @property {string|null} correlationId
 * @property {string} event
 * @property {any} detail
 * @property {boolean} success
 * @property {Date} createdAt
 */

/**
 * @typedef {Object} AuditTrailPort
 * @property {(entry: AuditEntry) => Promise<AuditEntry>} record
 */

module.exports = {
  name: 'AuditTrailPort',
  description: 'Append-only audit trail for sync checkpoints'
}

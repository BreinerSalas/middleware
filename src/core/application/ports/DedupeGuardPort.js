'use strict'

/**
 * Port: DedupeGuardPort
 *
 * Short-lived idempotency guard for inbound webhook traffic. Fail-open: a
 * thrown error from `isDuplicate` MUST NOT prevent job creation; the
 * implementation should swallow and treat it as `false`.
 *
 * @typedef {Object} DedupeGuardPort
 * @property {(key: string) => Promise<boolean>} isDuplicate
 * @property {(key: string) => Promise<void>} markSeen
 */

module.exports = {
  name: 'DedupeGuardPort',
  description: 'Short TTL dedupe guard for inbound webhooks'
}

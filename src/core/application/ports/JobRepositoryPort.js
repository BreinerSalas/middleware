'use strict'

/**
 * Port: JobRepositoryPort
 *
 * Storage-agnostic contract for the persistent job queue used by the generic
 * sync engine. Implementations must guarantee:
 *  - `create(job)` returns the persisted job with a populated `_id`.
 *  - `findClaimable({limit, now})` atomically transitions eligible jobs to
 *    PROCESSING and increments `attempts`. Eligible = status PENDING or
 *    RETRY_PENDING with nextRetryAt <= now.
 *  - `markCompleted` / `markSkipped` / `markFailed` mutate and persist the
 *    terminal/intermediate state.
 *  - `recoverOrphans(now)` flips PROCESSING jobs older than the watchdog
 *    threshold back to PENDING so they can be re-claimed.
 *
 * Implementations: MongoJobRepository. Tests use in-memory fakes.
 */

/**
 * @typedef {Object} SyncJobDoc
 * @property {string|null} _id
 * @property {string} sourceId
 * @property {string|null} correlationId
 * @property {any} payload
 * @property {string|null} dedupeKey
 * @property {string} status
 * @property {number} attempts
 * @property {number} maxAttempts
 * @property {Date|null} nextRetryAt
 * @property {string|null} lastError
 * @property {string|null} lastErrorStack
 * @property {Date|null} completedAt
 * @property {Date} createdAt
 * @property {Date} updatedAt
 */

/**
 * @typedef {Object} JobRepositoryPort
 * @property {(job: SyncJobDoc) => Promise<SyncJobDoc>} create
 * @property {(opts?: {limit?: number, now?: Date}) => Promise<SyncJobDoc[]>} findClaimable
 * @property {(jobId: string, now?: Date) => Promise<SyncJobDoc|null>} markProcessing
 * @property {(jobId: string, now?: Date) => Promise<SyncJobDoc|null>} markCompleted
 * @property {(jobId: string, reason: Error|string, now?: Date) => Promise<SyncJobDoc|null>} markSkipped
 * @property {(jobId: string, opts: {error: Error, nextRetryAt?: Date|null, deadLetter: boolean, now?: Date}) => Promise<SyncJobDoc|null>} markFailed
 * @property {(now?: Date) => Promise<number>} recoverOrphans
 * @property {(jobId: string) => Promise<SyncJobDoc|null>} findById
 */

module.exports = {
  name: 'JobRepositoryPort',
  description: 'Persistent queue for SyncJob entities'
}

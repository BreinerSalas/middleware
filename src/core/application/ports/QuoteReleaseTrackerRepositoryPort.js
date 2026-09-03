'use strict'

/**
 * Port: QuoteReleaseTrackerRepositoryPort
 *
 * Persistence for QuoteReleaseTracker entities (src/core/domain/QuoteReleaseTracker.js).
 * Deliberately agnostic to whatever downstream object ends up backing a tracker in
 * production (a HubSpot ticket, a HubSpot custom object, etc.) — that mapping belongs
 * to a concrete adapter, not this port.
 *
 * NOTE: this port is in `src/core/application/ports/`, which is excluded from coverage.
 * It is a contract-only typedef; runtime behavior is exercised against whichever concrete
 * adapter implements it.
 */

/**
 * @typedef {Object} QuoteReleaseTrackerRepositoryPort
 * @property {(quoteId: string) => Promise<import('../../domain/QuoteReleaseTracker').QuoteReleaseTracker|null>} findByQuoteId
 * @property {(tracker: import('../../domain/QuoteReleaseTracker').QuoteReleaseTracker) => Promise<import('../../domain/QuoteReleaseTracker').QuoteReleaseTracker>} save
 */

module.exports = {
  name: 'QuoteReleaseTrackerRepositoryPort',
  description: 'Persistence for per-quote release-gate tracking, independent of the concrete downstream object type'
}

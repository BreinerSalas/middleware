'use strict'

const { QUOTE_RELEASE_STAGE } = require('../../domain/QuoteReleaseTracker')

class RevertQuoteReleaseOnCancellationUseCase {
  constructor({ trackerRepository, auditTrail = null, logger = null } = {}) {
    if (!trackerRepository) throw new Error('RevertQuoteReleaseOnCancellationUseCase requires trackerRepository')
    this.trackerRepository = trackerRepository
    this.auditTrail = auditTrail
    this.logger = logger
  }

  async execute({ quoteId, reason = null } = {}) {
    if (!quoteId) throw new Error('quoteId required')
    const tracker = await this.trackerRepository.findByQuoteId(quoteId)
    if (!tracker) {
      throw new Error(`RevertQuoteReleaseOnCancellationUseCase: no tracker found for quote ${quoteId}`)
    }
    // Already cancelled: skip the transition/persist/audit entirely. Odoo
    // keeps reporting the sale order as cancelled on every poll tick, so
    // without this guard we'd re-cancel (and re-audit) on every tick for as
    // long as the sale order stays cancelled, flooding the audit trail and
    // risking clobbering a legitimate concurrent re-release.
    if (tracker.stage === QUOTE_RELEASE_STAGE.CANCELLED) {
      return tracker
    }
    tracker.cancel()
    const persisted = await this.trackerRepository.save(tracker)
    if (this.auditTrail) {
      await this.auditTrail.record({
        sourceId: quoteId,
        event: 'quote_release.cancelled',
        success: true,
        detail: { dealId: tracker.dealId, reason }
      })
    }
    return persisted
  }
}

module.exports = { RevertQuoteReleaseOnCancellationUseCase }

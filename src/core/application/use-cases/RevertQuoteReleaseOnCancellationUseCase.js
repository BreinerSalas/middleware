'use strict'

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

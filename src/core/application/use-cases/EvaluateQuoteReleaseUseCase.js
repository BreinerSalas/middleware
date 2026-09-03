'use strict'

const { QuoteReleaseTracker } = require('../../domain/QuoteReleaseTracker')

class EvaluateQuoteReleaseUseCase {
  constructor({ trackerRepository, logger = null } = {}) {
    if (!trackerRepository) throw new Error('EvaluateQuoteReleaseUseCase requires trackerRepository')
    this.trackerRepository = trackerRepository
    this.logger = logger
  }

  async execute({ quoteId, dealId = null } = {}) {
    if (!quoteId) throw new Error('quoteId required')
    let tracker = await this.trackerRepository.findByQuoteId(quoteId)
    if (!tracker) {
      if (!dealId) {
        if (this.logger) this.logger.warn('EvaluateQuoteReleaseUseCase: no tracker found for quote', { quoteId })
        return { tracker: null, canRelease: false }
      }
      // First manual click on a quote nobody has tracked yet: implicitly pending, so
      // releasable without requiring a separate seeding step.
      tracker = new QuoteReleaseTracker({ quoteId, dealId })
      tracker = await this.trackerRepository.save(tracker)
    }
    return { tracker, canRelease: tracker.canRelease() }
  }
}

module.exports = { EvaluateQuoteReleaseUseCase }

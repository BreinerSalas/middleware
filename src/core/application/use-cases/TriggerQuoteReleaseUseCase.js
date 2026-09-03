'use strict'

class TriggerQuoteReleaseUseCase {
  constructor({ evaluateQuoteRelease, enqueueSyncJobUseCase, trackerRepository, logger = null } = {}) {
    if (!evaluateQuoteRelease) throw new Error('TriggerQuoteReleaseUseCase requires evaluateQuoteRelease')
    if (!enqueueSyncJobUseCase) throw new Error('TriggerQuoteReleaseUseCase requires enqueueSyncJobUseCase')
    if (!trackerRepository) throw new Error('TriggerQuoteReleaseUseCase requires trackerRepository')
    this.evaluateQuoteRelease = evaluateQuoteRelease
    this.enqueueSyncJobUseCase = enqueueSyncJobUseCase
    this.trackerRepository = trackerRepository
    this.logger = logger
  }

  async execute({ dealId, quoteId, correlationId = null, rawPayload = null } = {}) {
    if (!dealId) throw new Error('dealId required')
    if (!quoteId) throw new Error('quoteId required')

    const { tracker, canRelease } = await this.evaluateQuoteRelease.execute({ quoteId, dealId })
    if (!canRelease) {
      if (this.logger) this.logger.info('TriggerQuoteReleaseUseCase: quote not releasable yet', { dealId, quoteId })
      return { released: false, tracker, enqueued: null }
    }

    const sourceId = `${dealId}:q${quoteId}`
    const enqueued = await this.enqueueSyncJobUseCase.execute({
      sourceId,
      correlationId,
      rawPayload,
      kind: 'quote'
    })

    tracker.release()
    await this.trackerRepository.save(tracker)

    return { released: true, tracker, enqueued }
  }
}

module.exports = { TriggerQuoteReleaseUseCase }

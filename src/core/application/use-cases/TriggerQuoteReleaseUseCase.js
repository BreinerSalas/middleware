'use strict'

class TriggerQuoteReleaseUseCase {
  constructor({ evaluateQuoteRelease, enqueueSyncJobUseCase, trackerRepository, logger = null, clock = () => new Date() } = {}) {
    if (!evaluateQuoteRelease) throw new Error('TriggerQuoteReleaseUseCase requires evaluateQuoteRelease')
    if (!enqueueSyncJobUseCase) throw new Error('TriggerQuoteReleaseUseCase requires enqueueSyncJobUseCase')
    if (!trackerRepository) throw new Error('TriggerQuoteReleaseUseCase requires trackerRepository')
    this.evaluateQuoteRelease = evaluateQuoteRelease
    this.enqueueSyncJobUseCase = enqueueSyncJobUseCase
    this.trackerRepository = trackerRepository
    this.logger = logger
    this.clock = clock
  }

  async execute({ dealId, quoteId, correlationId = null, rawPayload = null } = {}) {
    if (!dealId) throw new Error('dealId required')
    if (!quoteId) throw new Error('quoteId required')

    const { tracker, canRelease } = await this.evaluateQuoteRelease.execute({ quoteId, dealId })
    if (!canRelease) {
      if (this.logger) this.logger.info('TriggerQuoteReleaseUseCase: quote not releasable yet', { dealId, quoteId })
      return { released: false, tracker, enqueued: null }
    }

    // Persist the release BEFORE enqueueing: the job poller runs on its own
    // timer and could claim this job almost immediately, reading the tracker
    // via ProcessSyncJobUseCase to decide whether to confirm the sale order.
    // If the tracker were still saved after, that read could race and see
    // the old stage (e.g. a re-released, previously cancelled quote), and
    // wrongly skip confirmation.
    tracker.release()
    await this.trackerRepository.save(tracker)

    const sourceId = `${dealId}:q${quoteId}`
    // The dedupe key derives from sourceId + rawPayload, and sourceId never
    // changes for a given quote. Without a per-attempt value in rawPayload,
    // a later re-release (e.g. after a revert-on-cancellation) would hash to
    // the exact same dedupeKey as the first release and be silently swallowed
    // as a duplicate forever, since MongoDedupeGuard keys never expire.
    // Stamping releasedAt guarantees each manual release attempt gets its
    // own dedupeKey.
    // shouldConfirm is decided ONCE, right here, at the moment a human explicitly
    // asked for release — nothing can race it after this point because it's now
    // baked into the immutable job document. ProcessSyncJobUseCase must read this
    // flag directly from the job payload rather than re-reading the (mutable,
    // concurrently-writable) tracker at processing time.
    const mergedRawPayload = {
      ...(rawPayload && typeof rawPayload === 'object' ? rawPayload : {}),
      releasedAt: this.clock().toISOString(),
      shouldConfirm: true
    }
    const enqueued = await this.enqueueSyncJobUseCase.execute({
      sourceId,
      correlationId,
      rawPayload: mergedRawPayload,
      kind: 'quote'
    })

    return { released: true, tracker, enqueued }
  }
}

module.exports = { TriggerQuoteReleaseUseCase }

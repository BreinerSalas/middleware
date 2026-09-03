'use strict'

const QUOTE_RELEASE_STAGE = Object.freeze({
  PENDING: 'pending',
  RELEASED: 'released',
  CANCELLED: 'cancelled'
})

class QuoteReleaseTracker {
  constructor({ quoteId, dealId, stage = QUOTE_RELEASE_STAGE.PENDING } = {}) {
    if (!quoteId) throw new Error('QuoteReleaseTracker requires quoteId')
    if (!dealId) throw new Error('QuoteReleaseTracker requires dealId')
    if (!Object.values(QUOTE_RELEASE_STAGE).includes(stage)) {
      throw new Error(`QuoteReleaseTracker received an unknown stage: ${stage}`)
    }
    this.quoteId = quoteId
    this.dealId = dealId
    this.stage = stage
  }

  release() {
    this.stage = QUOTE_RELEASE_STAGE.RELEASED
    return this
  }

  // Terminal: a cancelled quote must never become releasable again.
  cancel() {
    this.stage = QUOTE_RELEASE_STAGE.CANCELLED
    return this
  }

  canRelease() {
    return this.stage === QUOTE_RELEASE_STAGE.PENDING
  }
}

module.exports = { QUOTE_RELEASE_STAGE, QuoteReleaseTracker }

'use strict'

const { EvaluateQuoteReleaseUseCase } = require('../core/application/use-cases/EvaluateQuoteReleaseUseCase')
const { TriggerQuoteReleaseUseCase } = require('../core/application/use-cases/TriggerQuoteReleaseUseCase')
const { RevertQuoteReleaseOnCancellationUseCase } = require('../core/application/use-cases/RevertQuoteReleaseOnCancellationUseCase')

function createQuoteReleaseModule({
  trackerRepository,
  enqueueSyncJobUseCase,
  auditTrail = null,
  logger = null
} = {}) {
  if (!trackerRepository) throw new Error('createQuoteReleaseModule requires trackerRepository')
  if (!enqueueSyncJobUseCase) throw new Error('createQuoteReleaseModule requires enqueueSyncJobUseCase')

  const evaluateQuoteRelease = new EvaluateQuoteReleaseUseCase({ trackerRepository, logger })

  const triggerQuoteRelease = new TriggerQuoteReleaseUseCase({
    evaluateQuoteRelease,
    enqueueSyncJobUseCase,
    trackerRepository,
    logger
  })

  const revertQuoteReleaseOnCancellation = new RevertQuoteReleaseOnCancellationUseCase({
    trackerRepository,
    auditTrail,
    logger
  })

  return { evaluateQuoteRelease, triggerQuoteRelease, revertQuoteReleaseOnCancellation }
}

module.exports = { createQuoteReleaseModule }

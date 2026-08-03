'use strict'

const { v4: uuidv4 } = require('uuid')
const { EnqueueSyncJobUseCase } = require('../core/application/use-cases/EnqueueSyncJobUseCase')
const { ProcessSyncJobUseCase } = require('../core/application/use-cases/ProcessSyncJobUseCase')
const { PlanDealSyncUseCase } = require('../core/application/use-cases/PlanDealSyncUseCase')
const { JobPoller } = require('../core/application/JobPoller')
const { hashPayload } = require('../core/shared/hash')
const { isRetryableError } = require('../core/domain/RetryPolicy')

const { MongoJobRepository } = require('../adapters/outbound/mongo/MongoJobRepository')
const { MongoMappingRepository } = require('../adapters/outbound/mongo/MongoMappingRepository')
const { MongoDedupeGuard } = require('../adapters/outbound/mongo/MongoDedupeGuard')
const { MongoAuditTrail } = require('../adapters/outbound/mongo/MongoAuditTrail')
const { HubspotSourceGateway } = require('../adapters/outbound/hubspot/HubspotSourceGateway')
const { OdooTargetGateway } = require('../adapters/outbound/odoo/OdooTargetGateway')
const {
  mustHaveLineItems,
  mustBeClosedWon,
  createMustHaveOdooCustomerId,
  createMustHaveDealStage,
  createMustBeInPipeline,
  createMustHaveQuoteCountry
} = require('./validators')
const { JOB_KIND } = require('../config/constants')

function buildWriteBackPayload(mapping) {
  return {
    id_presupuesto_odoo: mapping && mapping.targetRef ? mapping.targetRef : null
  }
}

function createDealSyncModule({
  config,
  logger = null,
  jobRepository = null,
  mappingRepository = null,
  dedupeGuard = null,
  auditTrail = null,
  sourceGateway = null,
  targetGateway = null,
  echoGuard = null,
  processSyncJobUseCase = null,
  enqueueSyncJobUseCase = null,
  planDealSyncUseCase = null,
  jobPoller = null,
  validators = null,
  clock = () => Date.now()
} = {}) {
  if (!config) throw new Error('createDealSyncModule requires config')

  const _jobRepository = jobRepository || new MongoJobRepository({ logger })
  const _mappingRepository = mappingRepository || new MongoMappingRepository()
  const _dedupeGuard = dedupeGuard || new MongoDedupeGuard()
  const _auditTrail = auditTrail || new MongoAuditTrail()

  const _sourceGateway = sourceGateway || new HubspotSourceGateway({
    apiClient: require('../adapters/outbound/hubspot/hubspotApiClient').createHubspotApiClient({
      baseUrl: config.hubspot.apiBase,
      accessToken: config.hubspot.accessToken
    }),
    propertyOdooCustomerId: config.hubspot.propertyOdooCustomerId,
    propertyOdooOrderId: config.hubspot.propertyOdooOrderId,
    propertyOdooQuoteId: config.hubspot.propertyOdooQuoteId,
    propertyQuoteOdooQuoteId: config.hubspot.propertyQuoteOdooQuoteId,
    propertyQuoteCountry: config.hubspot.propertyQuoteCountry,
    quoteEligibleStatuses: config.hubspot.quoteEligibleStatuses,
    echoGuard,
    logger
  })
  const _targetGateway = targetGateway || new OdooTargetGateway({
    apiClient: require('../adapters/outbound/odoo/odooApiClient').createOdooApiClient({
      mode: config.odoo.mode,
      baseUrl: config.odoo.baseUrl,
      db: config.odoo.db,
      login: config.odoo.login,
      apiKey: config.odoo.apiKey
    }),
    hashPayload,
    defaultCustomerId: config.odoo.defaultCustomerId,
    propertyQuoteCountry: config.hubspot.propertyQuoteCountry,
    // En modo stub el cliente devuelve {} en todo lookup, asi que product_id es
    // siempre null; exigir match ahi convertiria cada corrida local en SKIPPED.
    requireProductMatch: config.odoo.mode === 'http',
    logger
  })

  const _defaultDealsConfig = (config && config.deals && typeof config.deals === 'object') ? config.deals : {}
  const defaultValidators = [
    createMustHaveDealStage({ allowed: _defaultDealsConfig.allowedStageIds || [] }),
    createMustBeInPipeline({
      allowed: _defaultDealsConfig.allowedPipelineIds || [],
      rejectWhenMissing: _defaultDealsConfig.rejectUnknownPipeline !== false
    }),
    mustHaveLineItems,
    createMustHaveOdooCustomerId({ defaultCustomerId: config.odoo.defaultCustomerId }),
    // No-op on the deal (fallback) path; on a quote job it re-checks the
    // country property right before processing, since listEligibleQuotes only
    // guaranteed it was present at planning time.
    createMustHaveQuoteCountry({ countryProperty: config.hubspot.propertyQuoteCountry })
  ]
  const _validators = Array.isArray(validators) ? validators : defaultValidators

  const _processSyncJobUseCase = processSyncJobUseCase || new ProcessSyncJobUseCase({
    jobRepository: _jobRepository,
    mappingRepository: _mappingRepository,
    sourceGateway: _sourceGateway,
    targetGateway: _targetGateway,
    auditTrail: _auditTrail,
    retryPolicy: {
      baseMs: 1000,
      maxDelayMs: config.retry.maxDelayMs,
      jitter: true,
      isRetryable: isRetryableError,
      hashPayload,
      buildWriteBackPayload
    },
    validators: _validators,
    logger
  })

  const _enqueueSyncJobUseCase = enqueueSyncJobUseCase || new EnqueueSyncJobUseCase({
    jobRepository: _jobRepository,
    dedupeGuard: _dedupeGuard,
    logger
  })

  // Pre-flight validators for the deal planner: same list as _processSyncJobUseCase
  // minus mustHaveLineItems (per-quote check; the planner doesn't resolve
  // references). The planner filters by identity.
  const _planDealSyncUseCase = planDealSyncUseCase || new PlanDealSyncUseCase({
    sourceGateway: _sourceGateway,
    enqueueSyncJobUseCase: _enqueueSyncJobUseCase,
    jobRepository: _jobRepository,
    auditTrail: _auditTrail,
    validators: _validators,
    logger
  })

  const _jobPoller = jobPoller || new JobPoller({
    jobRepository: _jobRepository,
    processFn: async (job) => {
      if (job && job.kind === JOB_KIND.QUOTE) return _processSyncJobUseCase.execute({ job })
      try {
        const plan = await _planDealSyncUseCase.execute({ job })
        if (plan && plan.mode === 'fallback') return _processSyncJobUseCase.execute({ job })
        return plan
      } catch (err) {
        // PlanDealSyncUseCase already turns SkipSyncError into markSkipped and
        // never re-throws it. Anything that reaches here is a non-Skip failure
        // (e.g. HubSpot 5xx/429 while listing quotes) that would otherwise leave
        // the deal job stuck in PROCESSING forever — JobPoller only logs an
        // unhandled processFn rejection, it never touches the job, and
        // findClaimable only reclaims PENDING/RETRY_PENDING. Route it through
        // the same retry/dead-letter policy ProcessSyncJobUseCase uses.
        return _processSyncJobUseCase.handleError({
          job,
          jobId: job._id,
          sourceId: job.sourceId,
          correlationId: job.correlationId,
          err,
          priorAttempts: job.attempts,
          maxAttempts: job.maxAttempts
        })
      }
    },
    concurrency: config.worker.concurrency,
    pollIntervalMs: config.worker.pollIntervalMs,
    recoverOrphansOnStart: true,
    logger,
    clock
  })

  async function enqueueWebhook({ rawBody, objectId, eventType }) {
    const correlationId = uuidv4()
    const result = await _enqueueSyncJobUseCase.execute({
      sourceId: objectId,
      correlationId,
      rawPayload: { rawBody, eventType }
    })
    return { ...result, correlationId }
  }

  return {
    enqueueWebhook,
    processSyncJob: _processSyncJobUseCase.execute.bind(_processSyncJobUseCase),
    startWorker: () => _jobPoller.start(),
    stopWorker: () => _jobPoller.stop(),
    _internals: {
      jobRepository: _jobRepository,
      mappingRepository: _mappingRepository,
      dedupeGuard: _dedupeGuard,
      auditTrail: _auditTrail,
      sourceGateway: _sourceGateway,
      targetGateway: _targetGateway,
      jobPoller: _jobPoller,
      planDealSyncUseCase: _planDealSyncUseCase
    }
  }
}

module.exports = { createDealSyncModule, buildWriteBackPayload }

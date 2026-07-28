'use strict'

const { v4: uuidv4 } = require('uuid')
const { EnqueueSyncJobUseCase } = require('../core/application/use-cases/EnqueueSyncJobUseCase')
const { ProcessSyncJobUseCase } = require('../core/application/use-cases/ProcessSyncJobUseCase')
const { JobPoller } = require('../core/application/JobPoller')
const { hashPayload } = require('../core/shared/hash')
const { isRetryableError } = require('../core/domain/RetryPolicy')

const { MongoJobRepository } = require('../adapters/outbound/mongo/MongoJobRepository')
const { MongoMappingRepository } = require('../adapters/outbound/mongo/MongoMappingRepository')
const { MongoDedupeGuard } = require('../adapters/outbound/mongo/MongoDedupeGuard')
const { MongoAuditTrail } = require('../adapters/outbound/mongo/MongoAuditTrail')
const { HubspotSourceGateway } = require('../adapters/outbound/hubspot/HubspotSourceGateway')
const { OdooTargetGateway } = require('../adapters/outbound/odoo/OdooTargetGateway')
const { mustHaveLineItems, mustBeClosedWon, createMustHaveOdooCustomerId } = require('./validators')

function buildWriteBackPayload(mapping) {
  return {
    id_orden_odoo: mapping && mapping.targetId ? mapping.targetId : null
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
    logger
  })

  const _validators = Array.isArray(validators) ? validators : [mustBeClosedWon, mustHaveLineItems, createMustHaveOdooCustomerId({ defaultCustomerId: config.odoo.defaultCustomerId })]

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

  const _jobPoller = jobPoller || new JobPoller({
    jobRepository: _jobRepository,
    processFn: async (job) => {
      return _processSyncJobUseCase.execute({ job })
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
      jobPoller: _jobPoller
    }
  }
}

module.exports = { createDealSyncModule, buildWriteBackPayload }

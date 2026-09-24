'use strict'

const { v4: uuidv4 } = require('uuid')
const { EnqueueSyncJobUseCase } = require('../core/application/use-cases/EnqueueSyncJobUseCase')
const { ProcessInboundContactSyncUseCase } = require('../core/application/use-cases/ProcessInboundContactSyncUseCase')
const { JobPoller } = require('../core/application/JobPoller')
const { MongoJobRepository } = require('../adapters/outbound/mongo/MongoJobRepository')
const { MongoDedupeGuard } = require('../adapters/outbound/mongo/MongoDedupeGuard')
const { MongoPartnerMappingRepository } = require('../adapters/outbound/mongo/MongoPartnerMappingRepository')
const { JOB_KIND } = require('../config/constants')

// (sdd/hubspot-contact-inbound-sync, Phase 5) Mirrors dealSyncModule's wiring shape —
// webhook-driven enqueue + a JobPoller filtered to this module's own kind.
const CONTACT_SOURCE_PREFIX = 'contact:'

function createContactInboundSyncModule({
  config,
  logger = null,
  jobRepository = null,
  dedupeGuard = null,
  partnerMappingRepository = null,
  hubspotApiClient = null,
  odooApiClient = null,
  enqueueSyncJobUseCase = null,
  processInboundContactSyncUseCase = null,
  jobPoller = null,
  clock = () => Date.now()
} = {}) {
  if (!config) throw new Error('createContactInboundSyncModule requires config')

  const _jobRepository = jobRepository || new MongoJobRepository({ logger })
  const _dedupeGuard = dedupeGuard || new MongoDedupeGuard()
  const _partnerMappingRepository = partnerMappingRepository || new MongoPartnerMappingRepository({ logger })

  const _hubspotApiClient = hubspotApiClient || require('../adapters/outbound/hubspot/hubspotApiClient').createHubspotApiClient({
    baseUrl: config.hubspot.apiBase,
    accessToken: config.hubspot.accessToken
  })
  const _odooApiClient = odooApiClient || require('../adapters/outbound/odoo/odooApiClient').createOdooApiClient({
    mode: config.odoo.mode,
    baseUrl: config.odoo.baseUrl,
    db: config.odoo.db,
    login: config.odoo.login,
    apiKey: config.odoo.apiKey
  })

  const _enqueueSyncJobUseCase = enqueueSyncJobUseCase || new EnqueueSyncJobUseCase({
    jobRepository: _jobRepository,
    dedupeGuard: _dedupeGuard,
    logger
  })

  // idProperty is always config-injected (config.hubspot.propertyOdooPartnerId), never a
  // literal — this is the same source of truth partnerSyncJobModule's HubspotContactGateway
  // uses for its idProperty (design decision "Echo guard").
  const _processInboundContactSyncUseCase = processInboundContactSyncUseCase || new ProcessInboundContactSyncUseCase({
    hubspotApiClient: _hubspotApiClient,
    odooApiClient: _odooApiClient,
    partnerMappingRepository: _partnerMappingRepository,
    jobRepository: _jobRepository,
    idProperty: config.hubspot.propertyOdooPartnerId,
    logger
  })

  const _jobPoller = jobPoller || new JobPoller({
    jobRepository: _jobRepository,
    processFn: (job) => _processInboundContactSyncUseCase.execute({ job }),
    concurrency: (config.worker && config.worker.concurrency) || 1,
    pollIntervalMs: (config.worker && config.worker.pollIntervalMs) || 5000,
    recoverOrphansOnStart: true,
    kind: JOB_KIND.CONTACT_INBOUND,
    logger,
    clock
  })

  async function enqueueWebhook({ rawBody, objectId, eventType }) {
    const correlationId = uuidv4()
    const result = await _enqueueSyncJobUseCase.execute({
      sourceId: `${CONTACT_SOURCE_PREFIX}${objectId}`,
      correlationId,
      rawPayload: { rawBody, eventType },
      kind: JOB_KIND.CONTACT_INBOUND,
      dedupeKey: `contact.creation:${objectId}`
    })
    return { ...result, correlationId }
  }

  return {
    enqueueWebhook,
    startWorker: () => _jobPoller.start(),
    stopWorker: () => _jobPoller.stop(),
    _internals: {
      jobRepository: _jobRepository,
      dedupeGuard: _dedupeGuard,
      partnerMappingRepository: _partnerMappingRepository,
      hubspotApiClient: _hubspotApiClient,
      odooApiClient: _odooApiClient,
      jobPoller: _jobPoller,
      enqueueSyncJobUseCase: _enqueueSyncJobUseCase,
      processInboundContactSyncUseCase: _processInboundContactSyncUseCase
    }
  }
}

module.exports = { createContactInboundSyncModule }

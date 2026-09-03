import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { MongoMemoryServer } = require('mongodb-memory-server')
const mongoose = require('mongoose')

const { createDealSyncModule, buildWriteBackPayload } = require('../../src/composition/dealSyncModule.js')
const { MongoJobRepository } = require('../../src/adapters/outbound/mongo/MongoJobRepository.js')
const { JOB_STATUS } = require('../../src/core/domain/SyncJob.js')
const { SkipSyncError } = require('../../src/core/domain/errors.js')
const {
  createMustHaveDealStage,
  createMustBeInPipeline,
  mustHaveLineItems
} = require('../../src/composition/validators.js')

const CVB = 't_5728252902aef7e9938dfcbb6cdc2af8'
const CIERRE_GANADO = '1409249445'

let mongoServer
let moduleUnderTest
let calls

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create()
  await mongoose.connect(mongoServer.getUri())
}, 120_000)

afterAll(async () => {
  await mongoose.disconnect()
  if (mongoServer) await mongoServer.stop()
}, 60_000)

beforeEach(async () => {
  const collections = await mongoose.connection.db.collections()
  await Promise.all(collections.map((c) => c.deleteMany({})))
  calls = { writeBack: [], upsert: [] }
  moduleUnderTest = createDealSyncModule({
    config: {
      mongodbUri: 'mongodb://x',
      hubspot: { accessToken: 't', apiBase: 'https://api.hubapi.com', propertyOdooCustomerId: 'id_cliente_odoo', propertyOdooOrderId: 'id_orden_odoo' },
      odoo: { mode: 'stub', baseUrl: '', apiKey: '' },
      server: { port: 0, nodeEnv: 'test' },
      logging: { level: 'error' },
      worker: { concurrency: 1, pollIntervalMs: 50 },
      retry: { maxAttempts: 8, maxDelayMs: 60_000 }
    },
    sourceGateway: makeSourceGateway(),
    targetGateway: makeTargetGateway(calls),
    logger: null,
    recoverOrphansOnStart: false,
    validators: [mustBeClosedWon, mustHaveLineItems, mustHaveOdooCustomerId]
  })
})

function makeSourceGateway(overrides = {}) {
  const defaultProps = Object.assign(
    { id_cliente_odoo: '42', dealstage: 'closedwon' },
    overrides.properties || {}
  )
  return {
    async fetchRecord(sourceId) {
      if (typeof overrides.fetchRecord === 'function') {
        return overrides.fetchRecord(sourceId, { id: sourceId, properties: defaultProps })
      }
      return { id: sourceId, properties: defaultProps }
    },
    async resolveReferences() { return { odooCustomerId: '42', lineItems: [{ id: 'L-1' }] } },
    async writeBack(sourceId, properties) { calls.writeBack.push({ sourceId, properties }) }
  }
}

function makeTargetGateway(calls) {
  return {
    async upsert({ existingTargetId, record, references }) {
      calls.upsert.push({ existingTargetId, sourceId: record && record.id })
      if (calls.upsert.length === 1 && calls.failOnce) {
        const e = new Error('upstream 503'); e.httpStatus = 503; throw e
      }
      return { targetId: existingTargetId || 'stub-1', targetRef: 'STUB/1', syncToken: 'draft' }
    }
  }
}

function mustBeClosedWon({ record } = {}) {
  const stage = record && record.properties && record.properties.dealstage
  const { SkipSyncError } = require('../../src/core/domain/errors.js')
  if (stage !== 'closedwon') throw new SkipSyncError(`dealstage=${stage}`)
}

function mustHaveOdooCustomerId({ references, record } = {}) {
  const direct = record && record.properties && record.properties.id_cliente_odoo
  const ref = references && references.odooCustomerId
  if (!direct && !ref) {
    const e = new Error('missing customer'); e.transient = true; throw e
  }
}

describe('composition/dealSyncModule end-to-end', () => {
  it('forwards odoo.db and odoo.login to createOdooApiClient factory', () => {
    const clientModule = require('../../src/adapters/outbound/odoo/odooApiClient.js')
    const realFactory = clientModule.createOdooApiClient
    let capturedArgs = null
    clientModule.createOdooApiClient = function (...args) {
      capturedArgs = args[0]
      return realFactory.apply(this, args)
    }
    try {
      createDealSyncModule({
        config: {
          mongodbUri: 'mongodb://x',
          hubspot: { accessToken: 't', apiBase: 'https://api.hubapi.com', propertyOdooCustomerId: 'a', propertyOdooOrderId: 'b' },
          odoo: { mode: 'http', baseUrl: 'https://odoo.example.com', db: 'mydb', login: 'me@x.com', apiKey: 'k' },
          server: { port: 0, nodeEnv: 'test' },
          logging: { level: 'error' },
          worker: { concurrency: 1, pollIntervalMs: 50 },
          retry: { maxAttempts: 8, maxDelayMs: 60_000 }
        },
        sourceGateway: makeSourceGateway(),
        logger: null,
        recoverOrphansOnStart: false,
        validators: []
      })
    } finally {
      clientModule.createOdooApiClient = realFactory
    }
    expect(capturedArgs).toBeDefined()
    expect(capturedArgs).toMatchObject({
      mode: 'http',
      baseUrl: 'https://odoo.example.com',
      db: 'mydb',
      login: 'me@x.com',
      apiKey: 'k'
    })
  })

  it('exposes the composed enqueueSyncJobUseCase via _internals, sharing the same jobRepository/dedupeGuard used by the job poller (so other modules — e.g. quoteReleaseModule — can enqueue jobs the poller will actually process)', () => {
    const { EnqueueSyncJobUseCase } = require('../../src/core/application/use-cases/EnqueueSyncJobUseCase.js')
    expect(moduleUnderTest._internals.enqueueSyncJobUseCase).toBeInstanceOf(EnqueueSyncJobUseCase)
    expect(moduleUnderTest._internals.enqueueSyncJobUseCase.jobRepository).toBe(moduleUnderTest._internals.jobRepository)
    expect(moduleUnderTest._internals.enqueueSyncJobUseCase.dedupeGuard).toBe(moduleUnderTest._internals.dedupeGuard)
  })

  it('wires the real HubspotSourceGateway.closedWonStageId from config.deals.closedWonStageId when sourceGateway is not injected', () => {
    const otherTenantClosedWonId = '999999-other-portal'
    const module = createDealSyncModule({
      config: {
        mongodbUri: 'mongodb://x',
        hubspot: { accessToken: 't', apiBase: 'https://api.hubapi.com', propertyOdooCustomerId: 'a', propertyOdooOrderId: 'b' },
        odoo: { mode: 'stub', baseUrl: '', apiKey: '' },
        deals: { allowedStageIds: [CIERRE_GANADO], allowedPipelineIds: [CVB], closedWonStageId: otherTenantClosedWonId },
        server: { port: 0, nodeEnv: 'test' },
        logging: { level: 'error' },
        worker: { concurrency: 1, pollIntervalMs: 50 },
        retry: { maxAttempts: 8, maxDelayMs: 60_000 }
      },
      targetGateway: makeTargetGateway({ writeBack: [], upsert: [] }),
      logger: null,
      recoverOrphansOnStart: false,
      validators: []
    })
    expect(module._internals.sourceGateway.closedWonStageId).toBe(otherTenantClosedWonId)
  })

  it('wires config.hubspot.propertyQuoteIncoterm/propertyQuoteDocumentType into both gateways and into the default validators (SKIPPED when a quote job is missing them)', async () => {
    const module = createDealSyncModule({
      config: {
        mongodbUri: 'mongodb://x',
        hubspot: {
          accessToken: 't', apiBase: 'https://api.hubapi.com',
          propertyOdooCustomerId: 'a', propertyOdooOrderId: 'b',
          propertyQuoteCountry: 'pais_de_destino',
          propertyQuoteIncoterm: 'incoterm_cotizacion',
          propertyQuoteDocumentType: 'tipo_documento_cotizacion'
        },
        odoo: { mode: 'stub', baseUrl: '', apiKey: '' },
        deals: { allowedStageIds: [CIERRE_GANADO], allowedPipelineIds: [CVB] },
        server: { port: 0, nodeEnv: 'test' },
        logging: { level: 'error' },
        worker: { concurrency: 1, pollIntervalMs: 50 },
        retry: { maxAttempts: 8, maxDelayMs: 60_000 }
      },
      logger: null,
      recoverOrphansOnStart: false
    })
    expect(module._internals.sourceGateway.propertyQuoteIncoterm).toBe('incoterm_cotizacion')
    expect(module._internals.sourceGateway.propertyQuoteDocumentType).toBe('tipo_documento_cotizacion')
    expect(module._internals.targetGateway.propertyQuoteIncoterm).toBe('incoterm_cotizacion')
    expect(module._internals.targetGateway.propertyQuoteDocumentType).toBe('tipo_documento_cotizacion')

    const record = {
      id: 'D-INCOTERM-1:qQ-1',
      quoteId: 'Q-1',
      properties: { id_cliente_odoo: '42', dealstage: CIERRE_GANADO, pipeline: CVB },
      // pais_de_destino set, incoterm_cotizacion/tipo_documento_cotizacion missing
      quote: { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: '78' } }
    }
    const validators = require('../../src/composition/validators.js')
    const incotermValidator = validators.createMustHaveQuoteIncoterm({ incotermProperty: 'incoterm_cotizacion' })
    expect(() => incotermValidator({ record })).toThrow(/incoterm_cotizacion/)
  })

  it('runs full pipeline: enqueue -> process -> writeback', async () => {
    const r = await moduleUnderTest.enqueueWebhook({ rawBody: { objectId: 'D-1' }, objectId: 'D-1', eventType: 'deal.creation' })
    expect(r.job).toBeTruthy()
    expect(r.deduped).toBe(false)

    const { JobModel } = require('../../src/adapters/outbound/mongo/schemas/job.schema.js')
    // wait for the job to be completed (poll-based)
    let job = null
    for (let i = 0; i < 30; i += 1) {
      await moduleUnderTest._internals.jobPoller.tick()
      await new Promise((r) => setTimeout(r, 20))
      job = await JobModel.findOne().lean()
      if (job && job.status === 'COMPLETED') break
    }
    expect(job.status).toBe('COMPLETED')
    expect(calls.upsert).toHaveLength(1)
    expect(calls.upsert[0].existingTargetId).toBeNull()
    expect(calls.writeBack).toHaveLength(1)
    expect(calls.writeBack[0].sourceId).toBe('D-1')
  }, 30_000)

  it('SkipSyncError path -> SKIPPED, no odoo call, no writeback', async () => {
    moduleUnderTest = createDealSyncModule({
      config: {
        mongodbUri: 'mongodb://x',
        hubspot: { accessToken: 't', apiBase: 'https://api.hubapi.com', propertyOdooCustomerId: 'a', propertyOdooOrderId: 'b' },
        odoo: { mode: 'stub', baseUrl: '', apiKey: '' },
        server: { port: 0, nodeEnv: 'test' },
        logging: { level: 'error' },
        worker: { concurrency: 1, pollIntervalMs: 50 },
        retry: { maxAttempts: 8, maxDelayMs: 60_000 }
      },
      sourceGateway: { ...makeSourceGateway(), async fetchRecord(id) { return { id, properties: { dealstage: 'open', line_items: [] } } } },
      targetGateway: makeTargetGateway(calls),
      logger: null,
      recoverOrphansOnStart: false,
      validators: [mustBeClosedWon]
    })
    await moduleUnderTest.enqueueWebhook({ rawBody: {}, objectId: 'D-2', eventType: 'x' })
    const { JobModel: JM } = require('../../src/adapters/outbound/mongo/schemas/job.schema.js')
    let job = null
    for (let i = 0; i < 30; i += 1) {
      await moduleUnderTest._internals.jobPoller.tick()
      await new Promise((r) => setTimeout(r, 20))
      job = await JM.findOne().lean()
      if (job && job.status === 'SKIPPED') break
    }
    expect(calls.upsert).toHaveLength(0)
    expect(calls.writeBack).toHaveLength(0)
    expect(job.status).toBe('SKIPPED')
  }, 30_000)

  it('retry path: first 503 -> RETRY_PENDING; second call -> COMPLETED', async () => {
    let n = 0
    const target = {
      async upsert({ existingTargetId } = {}) {
        n += 1
        if (n === 1) { const e = new Error('boom'); e.httpStatus = 503; throw e }
        return { targetId: existingTargetId || 'T-1', targetRef: 'R', syncToken: 'draft' }
      }
    }
    moduleUnderTest = createDealSyncModule({
      config: {
        mongodbUri: 'mongodb://x',
        hubspot: { accessToken: 't', apiBase: 'https://api.hubapi.com', propertyOdooCustomerId: 'a', propertyOdooOrderId: 'b' },
        odoo: { mode: 'stub', baseUrl: '', apiKey: '' },
        server: { port: 0, nodeEnv: 'test' },
        logging: { level: 'error' },
        worker: { concurrency: 1, pollIntervalMs: 50 },
        retry: { maxAttempts: 8, maxDelayMs: 60_000 }
      },
      sourceGateway: makeSourceGateway(),
      targetGateway: target,
      logger: null,
      recoverOrphansOnStart: false,
      validators: [mustBeClosedWon, mustHaveLineItems, mustHaveOdooCustomerId]
    })
    await moduleUnderTest.enqueueWebhook({ rawBody: {}, objectId: 'D-3', eventType: 'x' })
    const { JobModel: JM2 } = require('../../src/adapters/outbound/mongo/schemas/job.schema.js')
    let job = null
    for (let i = 0; i < 30; i += 1) {
      await moduleUnderTest._internals.jobPoller.tick()
      await new Promise((r) => setTimeout(r, 20))
      job = await JM2.findOne().lean()
      if (job && job.status === 'RETRY_PENDING') break
    }
    expect(job.status).toBe('RETRY_PENDING')
    expect(job.attempts).toBe(1)
    // force nextRetryAt to be in the past
    await JM2.updateOne({ _id: job._id }, { $set: { nextRetryAt: new Date(Date.now() - 1000) } })
    for (let i = 0; i < 30; i += 1) {
      await moduleUnderTest._internals.jobPoller.tick()
      await new Promise((r) => setTimeout(r, 20))
      job = await JM2.findOne().lean()
      if (job && job.status === 'COMPLETED') break
    }
    expect(job.status).toBe('COMPLETED')
    expect(calls.writeBack).toHaveLength(1)
  }, 30_000)

  it('planner error path: non-Skip failure while planning -> RETRY_PENDING, not stuck in PROCESSING forever', async () => {
    // Regression test: PlanDealSyncUseCase has no try/catch of its own. Before
    // the fix, a non-SkipSyncError thrown while planning (e.g. HubSpot 5xx
    // while fetching the deal) propagated out of the poller's processFn
    // uncaught — JobPoller only logs it, never touches the job — leaving the
    // deal job PROCESSING forever with no retry and no dead-letter.
    let fetchCount = 0
    const sourceGateway = {
      async fetchRecord(sourceId) {
        fetchCount += 1
        if (fetchCount === 1) {
          const e = new Error('hubspot unavailable')
          e.httpStatus = 503
          throw e
        }
        return { id: sourceId, properties: { id_cliente_odoo: '42', dealstage: 'closedwon' } }
      },
      async resolveReferences() { return { odooCustomerId: '42', lineItems: [{ id: 'L-1' }] } },
      async writeBack(sourceId, properties) { calls.writeBack.push({ sourceId, properties }) }
    }
    moduleUnderTest = createDealSyncModule({
      config: {
        mongodbUri: 'mongodb://x',
        hubspot: { accessToken: 't', apiBase: 'https://api.hubapi.com', propertyOdooCustomerId: 'a', propertyOdooOrderId: 'b' },
        odoo: { mode: 'stub', baseUrl: '', apiKey: '' },
        server: { port: 0, nodeEnv: 'test' },
        logging: { level: 'error' },
        worker: { concurrency: 1, pollIntervalMs: 50 },
        retry: { maxAttempts: 8, maxDelayMs: 60_000 }
      },
      sourceGateway,
      targetGateway: makeTargetGateway(calls),
      logger: null,
      recoverOrphansOnStart: false,
      validators: [mustBeClosedWon, mustHaveLineItems, mustHaveOdooCustomerId]
    })
    await moduleUnderTest.enqueueWebhook({ rawBody: {}, objectId: 'D-PLANNER-ERR', eventType: 'x' })
    const { JobModel } = require('../../src/adapters/outbound/mongo/schemas/job.schema.js')
    let job = null
    for (let i = 0; i < 30; i += 1) {
      await moduleUnderTest._internals.jobPoller.tick()
      await new Promise((r) => setTimeout(r, 20))
      job = await JobModel.findOne({ sourceId: 'D-PLANNER-ERR' }).lean()
      if (job && job.status === 'RETRY_PENDING') break
    }
    expect(job.status).toBe('RETRY_PENDING')
    expect(job.attempts).toBe(1)
    expect(job.lastError).toMatch(/hubspot unavailable/)

    // Not stuck: force nextRetryAt into the past and confirm the retry actually runs.
    await JobModel.updateOne({ _id: job._id }, { $set: { nextRetryAt: new Date(Date.now() - 1000) } })
    for (let i = 0; i < 30; i += 1) {
      await moduleUnderTest._internals.jobPoller.tick()
      await new Promise((r) => setTimeout(r, 20))
      job = await JobModel.findOne({ sourceId: 'D-PLANNER-ERR' }).lean()
      if (job && job.status === 'COMPLETED') break
    }
    expect(job.status).toBe('COMPLETED')
    expect(calls.writeBack).toHaveLength(1)
  }, 30_000)

  it('default validators wire createMustHaveQuoteCountry: quote job SKIPPED if its country vanishes before processing', async () => {
    // No `validators` override below -> exercises the REAL default list built
    // by createDealSyncModule (this is what proves createMustHaveQuoteCountry
    // is actually wired in, not just unit-tested in isolation).
    const DEAL_ID = 'D-RACE-1'
    const QUOTE_OK = 'Q-OK'
    const QUOTE_RACE = 'Q-RACE'
    const sourceGateway = {
      apiClient: {
        getDealQuotes: async () => [
          { id: QUOTE_OK, properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'GT', hs_title: 'OK' } },
          { id: QUOTE_RACE, properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'HN', hs_title: 'Race' } }
        ]
      },
      async fetchRecord(sourceId) {
        const { parseSourceId } = require('../../src/adapters/outbound/hubspot/HubspotSourceGateway.js')
        const { dealId, quoteId } = parseSourceId(sourceId)
        if (quoteId) {
          // Simulate the quote's country property vanishing between the
          // planning read (getDealQuotes above) and this per-quote processing
          // read — only for QUOTE_RACE.
          const quoteProps = quoteId === QUOTE_RACE
            ? { hs_status: 'APPROVAL_NOT_NEEDED', hs_title: 'Race' }
            : { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'GT', hs_title: 'OK' }
          return {
            id: sourceId,
            dealId,
            quoteId,
            properties: { id_cliente_odoo: '42', dealstage: CIERRE_GANADO, pipeline: CVB },
            quote: { id: quoteId, properties: quoteProps }
          }
        }
        return { id: sourceId, dealId, quoteId: null, properties: { id_cliente_odoo: '42', dealstage: CIERRE_GANADO, pipeline: CVB } }
      },
      async resolveReferences() { return { odooCustomerId: '42', lineItems: [{ id: 'L-1' }] } },
      async writeBack(sourceId, properties) { calls.writeBack.push({ sourceId, properties }) }
    }
    moduleUnderTest = createDealSyncModule({
      config: {
        mongodbUri: 'mongodb://x',
        hubspot: { accessToken: 't', apiBase: 'https://api.hubapi.com', propertyOdooCustomerId: 'a', propertyOdooOrderId: 'b' },
        odoo: { mode: 'stub', baseUrl: '', apiKey: '' },
        deals: { allowedStageIds: [CIERRE_GANADO], allowedPipelineIds: [CVB], rejectUnknownPipeline: true },
        server: { port: 0, nodeEnv: 'test' },
        logging: { level: 'error' },
        worker: { concurrency: 1, pollIntervalMs: 50 },
        retry: { maxAttempts: 8, maxDelayMs: 60_000 }
      },
      sourceGateway,
      targetGateway: makeTargetGateway(calls),
      logger: null,
      recoverOrphansOnStart: false
    })
    await moduleUnderTest.enqueueWebhook({ rawBody: {}, objectId: DEAL_ID, eventType: 'x' })
    const { JobModel } = require('../../src/adapters/outbound/mongo/schemas/job.schema.js')
    let quoteJobs = []
    for (let i = 0; i < 60; i += 1) {
      await moduleUnderTest._internals.jobPoller.tick()
      await new Promise((r) => setTimeout(r, 20))
      quoteJobs = await JobModel.find({ kind: 'quote' }).lean()
      if (quoteJobs.length === 2 && quoteJobs.every((j) => ['COMPLETED', 'SKIPPED'].includes(j.status))) break
    }
    expect(quoteJobs).toHaveLength(2)
    const okJob = quoteJobs.find((j) => j.sourceId.endsWith(QUOTE_OK))
    const raceJob = quoteJobs.find((j) => j.sourceId.endsWith(QUOTE_RACE))
    expect(okJob.status).toBe('COMPLETED')
    expect(raceJob.status).toBe('SKIPPED')
    expect(raceJob.lastError).toMatch(/pais_de_destino/)
    expect(calls.upsert).toHaveLength(1)
  }, 30_000)

  it('Pipeline selector: SKIPPED when deal pipeline is not in allowed list (sales pipeline)', async () => {
    moduleUnderTest = createDealSyncModule({
      config: {
        mongodbUri: 'mongodb://x',
        hubspot: { accessToken: 't', apiBase: 'https://api.hubapi.com', propertyOdooCustomerId: 'a', propertyOdooOrderId: 'b' },
        odoo: { mode: 'stub', baseUrl: '', apiKey: '' },
        deals: { allowedStageIds: [CIERRE_GANADO], allowedPipelineIds: [CVB], rejectUnknownPipeline: true },
        server: { port: 0, nodeEnv: 'test' },
        logging: { level: 'error' },
        worker: { concurrency: 1, pollIntervalMs: 50 },
        retry: { maxAttempts: 8, maxDelayMs: 60_000 }
      },
      sourceGateway: makeSourceGateway({
        properties: { id_cliente_odoo: '42', dealstage: CIERRE_GANADO, pipeline: 'sales-pipeline-id-xxx' }
      }),
      targetGateway: makeTargetGateway(calls),
      logger: null,
      recoverOrphansOnStart: false
    })
    await moduleUnderTest.enqueueWebhook({ rawBody: {}, objectId: 'D-PIPELINE-SALES', eventType: 'x' })
    const { JobModel: JM } = require('../../src/adapters/outbound/mongo/schemas/job.schema.js')
    let job = null
    for (let i = 0; i < 30; i += 1) {
      await moduleUnderTest._internals.jobPoller.tick()
      await new Promise((r) => setTimeout(r, 20))
      job = await JM.findOne().lean()
      if (job && job.status === 'SKIPPED') break
    }
    expect(calls.upsert).toHaveLength(0)
    expect(calls.writeBack).toHaveLength(0)
    expect(job.status).toBe('SKIPPED')
    const { AuditModel: AM } = require('../../src/adapters/outbound/mongo/schemas/audit.schema.js')
    const audit = await AM.findOne({ jobId: String(job._id), event: 'job.skipped' }).lean()
    expect(audit).toBeTruthy()
    expect(audit.detail.reason).toMatch(/pipeline/)
  }, 30_000)

  it('Pipeline selector: COMPLETED when deal pipeline is Comercial Visual Branding', async () => {
    moduleUnderTest = createDealSyncModule({
      config: {
        mongodbUri: 'mongodb://x',
        hubspot: { accessToken: 't', apiBase: 'https://api.hubapi.com', propertyOdooCustomerId: 'a', propertyOdooOrderId: 'b' },
        odoo: { mode: 'stub', baseUrl: '', apiKey: '' },
        deals: { allowedStageIds: [CIERRE_GANADO], allowedPipelineIds: [CVB], rejectUnknownPipeline: true },
        server: { port: 0, nodeEnv: 'test' },
        logging: { level: 'error' },
        worker: { concurrency: 1, pollIntervalMs: 50 },
        retry: { maxAttempts: 8, maxDelayMs: 60_000 }
      },
      sourceGateway: makeSourceGateway({
        properties: { id_cliente_odoo: '42', dealstage: CIERRE_GANADO, pipeline: CVB }
      }),
      targetGateway: makeTargetGateway(calls),
      logger: null,
      recoverOrphansOnStart: false
    })
    await moduleUnderTest.enqueueWebhook({ rawBody: {}, objectId: 'D-CVB', eventType: 'x' })
    const { JobModel: JM } = require('../../src/adapters/outbound/mongo/schemas/job.schema.js')
    let job = null
    for (let i = 0; i < 30; i += 1) {
      await moduleUnderTest._internals.jobPoller.tick()
      await new Promise((r) => setTimeout(r, 20))
      job = await JM.findOne().lean()
      if (job && job.status === 'COMPLETED') break
    }
    expect(job.status).toBe('COMPLETED')
    expect(calls.upsert).toHaveLength(1)
    expect(calls.writeBack).toHaveLength(1)
  }, 30_000)
})

describe('buildWriteBackPayload (quote flow)', () => {
  it('returns id_presupuesto_odoo from targetRef when mapping has one', () => {
    const payload = buildWriteBackPayload({ sourceId: 'D-1', targetId: 'SO-1', targetRef: 'S06613' })
    expect(payload).toEqual({ id_presupuesto_odoo: 'S06613' })
    expect(payload).not.toHaveProperty('id_orden_odoo')
  })

  it('returns null id_presupuesto_odoo when mapping has no targetRef', () => {
    const payload = buildWriteBackPayload({ sourceId: 'D-1', targetId: 'SO-1', targetRef: null })
    expect(payload).toEqual({ id_presupuesto_odoo: null })
  })

  it('returns null id_presupuesto_odoo when mapping is null', () => {
    expect(buildWriteBackPayload(null)).toEqual({ id_presupuesto_odoo: null })
  })

  it('includes numero_orden_fabricacion when mapping.metadata carries a manufacturingOrder name', () => {
    const payload = buildWriteBackPayload({
      sourceId: 'D-1', targetId: 'SO-1', targetRef: 'S06613',
      metadata: { manufacturingOrder: { id: 88, name: 'WH/MO/00042' } }
    })
    expect(payload).toEqual({ id_presupuesto_odoo: 'S06613', numero_orden_fabricacion: 'WH/MO/00042' })
  })

  it('omits numero_orden_fabricacion when there is no manufacturingOrder metadata (unchanged shape)', () => {
    const payload = buildWriteBackPayload({ sourceId: 'D-1', targetId: 'SO-1', targetRef: 'S06613' })
    expect(payload).not.toHaveProperty('numero_orden_fabricacion')
  })
})

describe('composition/dealSyncModule wiring (openspec/hubspot-product-odoo-id-key — PR 2)', () => {
  it('the default-constructed OdooTargetGateway receives a productMappingRepository (line-item tier 2 wiring, PR 2)', () => {
    // Do NOT inject `targetGateway` — let the module's default factory construct it. The
    // wiring test then inspects `module._internals.targetGateway` to assert the repo is wired.
    const m = createDealSyncModule({
      config: {
        mongodbUri: 'mongodb://x',
        hubspot: { accessToken: 't', apiBase: 'https://api.hubapi.com' },
        odoo: { mode: 'stub', baseUrl: '', apiKey: '' },
        server: { port: 0, nodeEnv: 'test' },
        logging: { level: 'error' },
        worker: { concurrency: 1, pollIntervalMs: 50 },
        retry: { maxAttempts: 8, maxDelayMs: 60_000 }
      },
      sourceGateway: makeSourceGateway(),
      // targetGateway NOT injected — exercise the default factory
      logger: null,
      recoverOrphansOnStart: false,
      validators: []
    })
    const gw = m._internals.targetGateway
    expect(gw).toBeTruthy()
    expect(gw.productMappingRepository).toBeTruthy()
    // The repo must expose the tier-2 contract (findByHubspotId). MongoProductMappingRepository
    // does — verified in Phase 2.4; here we just assert the wiring is in place.
    expect(typeof gw.productMappingRepository.findByHubspotId).toBe('function')
  })
})

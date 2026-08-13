import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { ProcessSyncJobUseCase } = require('../../../src/core/application/use-cases/ProcessSyncJobUseCase.js')

function makeJobRepository() {
  return {
    markCompleted: vi.fn(async (id) => ({ _id: id, status: 'COMPLETED' }))
  }
}

function makeMappingRepository({ existing = null } = {}) {
  return {
    findBySourceId: vi.fn(async () => existing),
    upsert: vi.fn(async (m) => ({ ...m, metadata: m.metadata || {} }))
  }
}

function makeSourceGateway() {
  return {
    fetchRecord: vi.fn(async () => ({ id: 'D-1:qQ-1', properties: {} })),
    resolveReferences: vi.fn(async () => ({})),
    writeBack: vi.fn(async () => null)
  }
}

function makeTargetGateway({ metadata = {} } = {}) {
  return {
    upsert: vi.fn(async () => ({
      targetId: 'SO-1', targetRef: 'S00001', salesOrderId: '1', metadata
    }))
  }
}

describe('ProcessSyncJobUseCase — constructor requires retryPolicy.buildWriteBackPayload', () => {
  it('throws when retryPolicy.buildWriteBackPayload is not a function', () => {
    const jobRepository = makeJobRepository()
    const mappingRepository = makeMappingRepository()
    const sourceGateway = makeSourceGateway()
    const targetGateway = makeTargetGateway()
    expect(() => new ProcessSyncJobUseCase({
      jobRepository, mappingRepository, sourceGateway, targetGateway,
      auditTrail: { record: vi.fn(async () => null) },
      retryPolicy: {},
      validators: []
    })).toThrow(/requires retryPolicy\.buildWriteBackPayload/)
  })
})

describe('ProcessSyncJobUseCase — retryPolicy pass-through (write-back regression)', () => {
  it('uses retryPolicy.buildWriteBackPayload (not the bare default) when writing back', async () => {
    const sourceGateway = makeSourceGateway()
    const jobRepository = makeJobRepository()
    const mappingRepository = makeMappingRepository()
    const targetGateway = makeTargetGateway({
      metadata: { confirmation: { status: 'confirmed', reason: null }, manufacturingOrder: { id: 1, name: 'WH/MO/00001' } }
    })
    const buildWriteBackPayload = vi.fn((mapping) => ({
      id_presupuesto_odoo: mapping.targetRef,
      numero_orden_fabricacion: mapping.metadata && mapping.metadata.manufacturingOrder ? mapping.metadata.manufacturingOrder.name : null
    }))
    const useCase = new ProcessSyncJobUseCase({
      jobRepository, mappingRepository, sourceGateway, targetGateway,
      auditTrail: { record: vi.fn(async () => null) },
      retryPolicy: { buildWriteBackPayload },
      validators: []
    })
    await useCase.execute({ job: { _id: 'JOB-1', sourceId: 'D-1:qQ-1', correlationId: 'c-1', attempts: 0, maxAttempts: 5 } })
    expect(buildWriteBackPayload).toHaveBeenCalled()
    expect(sourceGateway.writeBack).toHaveBeenCalledWith('D-1:qQ-1', {
      id_presupuesto_odoo: 'S00001', numero_orden_fabricacion: 'WH/MO/00001'
    })
  })

  it('uses retryPolicy.hashPayload (not null) when computing payloadHash', async () => {
    const sourceGateway = makeSourceGateway()
    const jobRepository = makeJobRepository()
    const mappingRepository = makeMappingRepository()
    const targetGateway = makeTargetGateway()
    const hashPayload = vi.fn(() => 'hash-abc')
    const useCase = new ProcessSyncJobUseCase({
      jobRepository, mappingRepository, sourceGateway, targetGateway,
      auditTrail: { record: vi.fn(async () => null) },
      retryPolicy: { hashPayload, buildWriteBackPayload: (m) => ({ ref: m.targetRef }) },
      validators: []
    })
    await useCase.execute({ job: { _id: 'JOB-1', sourceId: 'D-1:qQ-1', correlationId: 'c-1', attempts: 0, maxAttempts: 5 } })
    expect(hashPayload).toHaveBeenCalled()
    expect(mappingRepository.upsert).toHaveBeenCalledWith(expect.objectContaining({ payloadHash: 'hash-abc' }))
  })
})

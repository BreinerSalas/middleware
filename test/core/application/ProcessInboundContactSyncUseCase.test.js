import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { ProcessInboundContactSyncUseCase } = require('../../../src/core/application/use-cases/ProcessInboundContactSyncUseCase.js')

const ID_PROPERTY = 'id_contacto_odoo_v2'

function makeHubspotApiClient({ contact = { id: 'HS-1', properties: { email: 'a@b.com' } }, getError = null, updateError = null } = {}) {
  return {
    getContactById: vi.fn(async () => {
      if (getError) throw getError
      return contact
    }),
    updateContact: vi.fn(async () => {
      if (updateError) throw updateError
      return { id: 'HS-1' }
    })
  }
}

function makeOdooApiClient({ matches = [], createError = null, byCode = {}, byName = {} } = {}) {
  return {
    searchPartnersByEmail: vi.fn(async () => matches),
    createPartner: vi.fn(async (payload) => {
      if (createError) throw createError
      return { id: '42', raw: payload }
    }),
    searchCountryIdsByCodes: vi.fn(async () => byCode),
    searchCountryIdsByNames: vi.fn(async () => byName)
  }
}

function makeMappingRepository({ existingByHubspotId = null, existingByOdooId = null } = {}) {
  return {
    findByHubspotId: vi.fn(async () => existingByHubspotId),
    findByOdooId: vi.fn(async () => existingByOdooId),
    upsert: vi.fn(async (m) => m)
  }
}

function makeJobRepository() {
  return {
    markCompleted: vi.fn(async (id) => ({ _id: id, status: 'COMPLETED' })),
    markSkipped: vi.fn(async (id, err) => ({ _id: id, status: 'SKIPPED', lastError: err.reason || err.message })),
    markFailed: vi.fn(async (id, { deadLetter }) => ({ _id: id, status: deadLetter ? 'DEAD_LETTER' : 'RETRY_PENDING' }))
  }
}

function makeUseCase(overrides = {}) {
  const hubspotApiClient = overrides.hubspotApiClient || makeHubspotApiClient()
  const odooApiClient = overrides.odooApiClient || makeOdooApiClient()
  const partnerMappingRepository = overrides.partnerMappingRepository || makeMappingRepository()
  const jobRepository = overrides.jobRepository || makeJobRepository()
  const logger = { warn: vi.fn() }
  const useCase = new ProcessInboundContactSyncUseCase({
    hubspotApiClient, odooApiClient, partnerMappingRepository, jobRepository, idProperty: ID_PROPERTY, logger
  })
  return { useCase, hubspotApiClient, odooApiClient, partnerMappingRepository, jobRepository, logger }
}

const JOB = { _id: 'JOB-1', sourceId: 'contact:HS-1', attempts: 0, maxAttempts: 5 }

describe('ProcessInboundContactSyncUseCase — constructor', () => {
  it('requires every port and idProperty', () => {
    expect(() => new ProcessInboundContactSyncUseCase({})).toThrow(/hubspotApiClient/)
  })
})

describe('ProcessInboundContactSyncUseCase — not found / echo guard', () => {
  it('a 404 getContactById OR a null contact skips contact_not_found without touching Odoo', async () => {
    const notFound = Object.assign(new Error('not found'), { httpStatus: 404 })
    const { useCase, odooApiClient, jobRepository } = makeUseCase({ hubspotApiClient: makeHubspotApiClient({ getError: notFound }) })
    const result = await useCase.execute({ job: JOB })
    expect(result.skipped).toBe(true)
    expect(jobRepository.markSkipped).toHaveBeenCalledWith('JOB-1', expect.objectContaining({ reason: 'contact_not_found' }))
    expect(odooApiClient.searchPartnersByEmail).not.toHaveBeenCalled()

    const { useCase: useCase2 } = makeUseCase({ hubspotApiClient: makeHubspotApiClient({ contact: null }) })
    const result2 = await useCase2.execute({ job: JOB })
    expect(result2.error.reason).toBe('contact_not_found')
  })

  it('own idProperty already populated skips echo_odoo_origin with no mapping lookup', async () => {
    const contact = { id: 'HS-1', properties: { email: 'a@b.com', [ID_PROPERTY]: '99' } }
    const { useCase, partnerMappingRepository, jobRepository } = makeUseCase({ hubspotApiClient: makeHubspotApiClient({ contact }) })
    await useCase.execute({ job: JOB })
    expect(jobRepository.markSkipped).toHaveBeenCalledWith('JOB-1', expect.objectContaining({ reason: 'echo_odoo_origin' }))
    expect(partnerMappingRepository.findByHubspotId).not.toHaveBeenCalled()
  })
})

describe('ProcessInboundContactSyncUseCase — idempotent retry via existing mapping (goto write-back)', () => {
  it('findByHubspotId hit writes back only — no email search, no partner create/link (write-back-fails-then-retry backstop)', async () => {
    const { useCase, odooApiClient, hubspotApiClient, partnerMappingRepository, jobRepository } = makeUseCase({
      partnerMappingRepository: makeMappingRepository({ existingByHubspotId: { odooId: 7, hubspotId: 'HS-1' } })
    })
    const result = await useCase.execute({ job: JOB })
    expect(odooApiClient.searchPartnersByEmail).not.toHaveBeenCalled()
    expect(partnerMappingRepository.upsert).not.toHaveBeenCalled()
    expect(hubspotApiClient.updateContact).toHaveBeenCalledWith('HS-1', { [ID_PROPERTY]: '7' })
    expect(jobRepository.markCompleted).toHaveBeenCalledWith('JOB-1')
    expect(result.odooId).toBe(7)
  })
})

describe('ProcessInboundContactSyncUseCase — missing email', () => {
  it('empty/blank email skips missing_email before any Odoo call', async () => {
    const contact = { id: 'HS-1', properties: { email: '  ' } }
    const { useCase, odooApiClient, jobRepository } = makeUseCase({ hubspotApiClient: makeHubspotApiClient({ contact }) })
    await useCase.execute({ job: JOB })
    expect(jobRepository.markSkipped).toHaveBeenCalledWith('JOB-1', expect.objectContaining({ reason: 'missing_email' }))
    expect(odooApiClient.searchPartnersByEmail).not.toHaveBeenCalled()
  })
})

describe('ProcessInboundContactSyncUseCase — email match branching', () => {
  it('2+ matches skip ambiguous_email_match and warn-log for manual review', async () => {
    const { useCase, jobRepository, logger } = makeUseCase({
      odooApiClient: makeOdooApiClient({ matches: [{ id: 1 }, { id: 2 }] })
    })
    await useCase.execute({ job: JOB })
    expect(jobRepository.markSkipped).toHaveBeenCalledWith('JOB-1', expect.objectContaining({ reason: 'ambiguous_email_match' }))
    expect(logger.warn).toHaveBeenCalledWith('contact_inbound.ambiguous_email_match', expect.objectContaining({ matchCount: 2 }))
  })

  it('1 match with no per-partner mapping links silently, persists direction hubspot_to_odoo, writes back (mapping-persist-fails-then-retry backstop)', async () => {
    const { useCase, hubspotApiClient, partnerMappingRepository, jobRepository } = makeUseCase({
      odooApiClient: makeOdooApiClient({ matches: [{ id: 15 }] })
    })
    const result = await useCase.execute({ job: JOB })
    expect(partnerMappingRepository.upsert).toHaveBeenCalledWith({ odooId: 15, hubspotId: 'HS-1', action: 'linked', direction: 'hubspot_to_odoo' })
    expect(hubspotApiClient.updateContact).toHaveBeenCalledWith('HS-1', { [ID_PROPERTY]: '15' })
    expect(jobRepository.markCompleted).toHaveBeenCalled()
    expect(result.odooId).toBe(15)
  })

  it('1 match already mapped to a DIFFERENT hubspotId skips partner_already_linked without upserting', async () => {
    const { useCase, partnerMappingRepository, jobRepository } = makeUseCase({
      odooApiClient: makeOdooApiClient({ matches: [{ id: 15 }] }),
      partnerMappingRepository: makeMappingRepository({ existingByOdooId: { odooId: 15, hubspotId: 'HS-OTHER' } })
    })
    await useCase.execute({ job: JOB })
    expect(jobRepository.markSkipped).toHaveBeenCalledWith('JOB-1', expect.objectContaining({ reason: 'partner_already_linked' }))
    expect(partnerMappingRepository.upsert).not.toHaveBeenCalled()
  })
})

describe('ProcessInboundContactSyncUseCase — zero matches, create partner + country resolution', () => {
  it('resolves country via ISO code, creates the partner, persists mapping action:created, writes back', async () => {
    const contact = { id: 'HS-1', properties: { email: 'a@b.com', country: 'CR' } }
    const { useCase, odooApiClient, hubspotApiClient, partnerMappingRepository } = makeUseCase({
      hubspotApiClient: makeHubspotApiClient({ contact }),
      odooApiClient: makeOdooApiClient({ matches: [], byCode: { CR: { id: 9, name: 'Costa Rica' } } })
    })
    const result = await useCase.execute({ job: JOB })
    expect(odooApiClient.createPartner).toHaveBeenCalledWith(expect.objectContaining({ country_id: 9, is_company: false }))
    expect(partnerMappingRepository.upsert).toHaveBeenCalledWith({ odooId: 42, hubspotId: 'HS-1', action: 'created', direction: 'hubspot_to_odoo' })
    expect(hubspotApiClient.updateContact).toHaveBeenCalledWith('HS-1', { [ID_PROPERTY]: '42' })
    expect(result.odooId).toBe(42)
  })

  it('unresolved country (no code or name match) still creates the partner with no country_id and logs country_unresolved', async () => {
    const contact = { id: 'HS-1', properties: { email: 'a@b.com', country: 'Nowhereland' } }
    const { useCase, odooApiClient, logger } = makeUseCase({
      hubspotApiClient: makeHubspotApiClient({ contact }),
      odooApiClient: makeOdooApiClient({ matches: [] })
    })
    await useCase.execute({ job: JOB })
    const payload = odooApiClient.createPartner.mock.calls[0][0]
    expect(payload.country_id).toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith('contact_inbound.country_unresolved', { country: 'Nowhereland' })
  })

  it('Odoo permanent validation error (transient:false) on createPartner skips odoo_validation_error with no mapping upsert', async () => {
    const validationErr = Object.assign(new Error('invalid'), { transient: false })
    const { useCase, partnerMappingRepository, jobRepository } = makeUseCase({
      odooApiClient: makeOdooApiClient({ matches: [], createError: validationErr })
    })
    await useCase.execute({ job: JOB })
    expect(jobRepository.markSkipped).toHaveBeenCalledWith('JOB-1', expect.objectContaining({ reason: 'odoo_validation_error' }))
    expect(partnerMappingRepository.upsert).not.toHaveBeenCalled()
  })
})

describe('ProcessInboundContactSyncUseCase — write-back conflict', () => {
  it('a 400/duplicate-style updateContact error skips writeback_conflict after the partner+mapping already exist', async () => {
    const conflictErr = Object.assign(new Error('duplicate'), { httpStatus: 400 })
    const { useCase, partnerMappingRepository, jobRepository } = makeUseCase({
      odooApiClient: makeOdooApiClient({ matches: [] }),
      hubspotApiClient: makeHubspotApiClient({ updateError: conflictErr })
    })
    await useCase.execute({ job: JOB })
    expect(partnerMappingRepository.upsert).toHaveBeenCalledWith(expect.objectContaining({ action: 'created' }))
    expect(jobRepository.markSkipped).toHaveBeenCalledWith('JOB-1', expect.objectContaining({ reason: 'writeback_conflict' }))
  })
})

describe('ProcessInboundContactSyncUseCase — retry and dead-letter for unclassified errors', () => {
  it('a retryable (transient !== false) unclassified error schedules RETRY_PENDING with a computed nextRetryAt', async () => {
    const transientErr = Object.assign(new Error('timeout'), { transient: true })
    const { useCase, jobRepository } = makeUseCase({
      odooApiClient: makeOdooApiClient({ matches: [], createError: transientErr })
    })
    const result = await useCase.execute({ job: { ...JOB, attempts: 1, maxAttempts: 5 } })
    expect(result.deadLetter).toBe(false)
    expect(jobRepository.markFailed).toHaveBeenCalledWith('JOB-1', expect.objectContaining({ deadLetter: false, nextRetryAt: expect.any(Date) }))
  })

  it('exhausted attempts dead-letters even a retryable error, and a non-retryable unclassified error dead-letters immediately', async () => {
    const transientErr = Object.assign(new Error('timeout'), { transient: true })
    const { useCase, jobRepository } = makeUseCase({
      odooApiClient: makeOdooApiClient({ matches: [], createError: transientErr })
    })
    const exhausted = await useCase.execute({ job: { ...JOB, attempts: 5, maxAttempts: 5 } })
    expect(exhausted.deadLetter).toBe(true)
    expect(jobRepository.markFailed).toHaveBeenCalledWith('JOB-1', expect.objectContaining({ deadLetter: true, nextRetryAt: null }))
  })
})

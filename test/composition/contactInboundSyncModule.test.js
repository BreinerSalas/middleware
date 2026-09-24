import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createContactInboundSyncModule } = require('../../src/composition/contactInboundSyncModule.js')
const { JOB_KIND } = require('../../src/config/constants.js')

function baseConfig(overrides = {}) {
  return {
    hubspot: { accessToken: 't', apiBase: 'https://api.hubapi.com', propertyOdooPartnerId: 'custom_partner_id_field' },
    odoo: { mode: 'stub', baseUrl: '', apiKey: '' },
    worker: { concurrency: 1, pollIntervalMs: 50 },
    ...overrides
  }
}
function makeJobRepository() {
  return { findClaimable: vi.fn(async () => []), recoverOrphans: vi.fn(async () => 0) }
}
function makeEnqueueSyncJobUseCase() {
  return { execute: vi.fn(async () => ({ job: { _id: 'J-1' }, deduped: false })) }
}
function makePoller() {
  return { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
}

describe('composition/contactInboundSyncModule', () => {
  it('requires config', () => {
    expect(() => createContactInboundSyncModule({})).toThrow(/config/)
  })

  it('enqueueWebhook builds sourceId "contact:{objectId}", the design dedupeKey and kind CONTACT_INBOUND; startWorker/stopWorker delegate to the injected jobPoller', async () => {
    const enqueueSyncJobUseCase = makeEnqueueSyncJobUseCase()
    const jobPoller = makePoller()
    const m = createContactInboundSyncModule({ config: baseConfig(), jobRepository: makeJobRepository(), enqueueSyncJobUseCase, jobPoller })
    const result = await m.enqueueWebhook({ rawBody: { objectId: '42' }, objectId: '42', eventType: 'contact.creation' })
    const args = enqueueSyncJobUseCase.execute.mock.calls[0][0]
    expect(args.sourceId).toBe('contact:42')
    expect(args.dedupeKey).toBe('contact.creation:42')
    expect(args.kind).toBe(JOB_KIND.CONTACT_INBOUND)
    expect(result.job._id).toBe('J-1')
    expect(result.correlationId).toBeTruthy()

    await m.startWorker()
    expect(jobPoller.start).toHaveBeenCalledTimes(1)
    await m.stopWorker()
    expect(jobPoller.stop).toHaveBeenCalledTimes(1)
  })

  it('wires the default JobPoller to JOB_KIND.CONTACT_INBOUND and injects config.hubspot.propertyOdooPartnerId as idProperty (never a literal) when not overridden', () => {
    const m = createContactInboundSyncModule({ config: baseConfig(), jobRepository: makeJobRepository(), enqueueSyncJobUseCase: makeEnqueueSyncJobUseCase() })
    expect(m._internals.jobPoller.kind).toBe(JOB_KIND.CONTACT_INBOUND)
    expect(m._internals.processInboundContactSyncUseCase.idProperty).toBe('custom_partner_id_field')
  })
})

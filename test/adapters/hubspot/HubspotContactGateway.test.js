import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { HubspotContactGateway } = require('../../../src/adapters/outbound/hubspot/HubspotContactGateway.js')

function makeApi({
  search = async () => null,
  create = { id: 'NEW', properties: {} },
  update = { id: 'EXIST', properties: {} },
  batch = async () => ({ results: [], errors: [], numErrors: 0 })
} = {}) {
  return {
    searchContactByProperty: vi.fn(search),
    createContact: vi.fn(async () => create),
    updateContact: vi.fn(async () => update),
    batchUpsertContacts: vi.fn(batch)
  }
}

describe('HubspotContactGateway', () => {
  it('throws when constructed without apiClient', () => {
    expect(() => new HubspotContactGateway({})).toThrow(/apiClient/)
  })

  describe('idProperty wiring', () => {
    it('uses id_contacto_odoo as the default idProperty', () => {
      const api = makeApi()
      const gw = new HubspotContactGateway({ apiClient: api })
      expect(gw.idProperty).toBe('id_contacto_odoo')
    })

    it('accepts a custom idProperty override at construction time', () => {
      const api = makeApi()
      const gw = new HubspotContactGateway({ apiClient: api, idProperty: 'external_id' })
      expect(gw.idProperty).toBe('external_id')
    })
  })

  describe('hasValidOdooId / extractOdooId', () => {
    it('hasValidOdooId: numeric id is valid', () => {
      const gw = new HubspotContactGateway({ apiClient: makeApi() })
      expect(gw.hasValidOdooId({ id: 42 })).toBe(true)
      expect(gw.hasValidOdooId({ id: 0 })).toBe(true)
    })

    it('hasValidOdooId: null/undefined/missing id is invalid', () => {
      const gw = new HubspotContactGateway({ apiClient: makeApi() })
      expect(gw.hasValidOdooId({ id: null })).toBe(false)
      expect(gw.hasValidOdooId({ id: undefined })).toBe(false)
      expect(gw.hasValidOdooId({})).toBe(false)
    })

    it('hasValidOdooId: non-finite id (NaN/Infinity) is invalid', () => {
      const gw = new HubspotContactGateway({ apiClient: makeApi() })
      expect(gw.hasValidOdooId({ id: NaN })).toBe(false)
      expect(gw.hasValidOdooId({ id: Infinity })).toBe(false)
      expect(gw.hasValidOdooId({ id: 'oops' })).toBe(false)
    })

    it('extractOdooId returns String(partner.id)', () => {
      const gw = new HubspotContactGateway({ apiClient: makeApi() })
      expect(gw.extractOdooId({ id: 42 })).toBe('42')
      expect(gw.extractOdooId({ id: '42' })).toBe('42')
    })
  })

  describe('buildProperties', () => {
    it('delegates to mapPartnerToContactProperties (emits every key, includes idProperty)', () => {
      const gw = new HubspotContactGateway({ apiClient: makeApi() })
      const props = gw.buildProperties({
        id: 1, name: 'Ana Pérez', email: 'a@b.com', is_company: false, parent_id: false
      })
      expect(props.id_contacto_odoo).toBe('1')
      expect(props.firstname).toBe('Ana')
      expect(props.lastname).toBe('Pérez')
      expect(props.email).toBe('a@b.com')
      // every key always present (unconditional overwrite contract)
      expect(Object.keys(props).sort()).toEqual([
        'address', 'city', 'company', 'country', 'email', 'firstname', 'id_contacto_odoo',
        'jobtitle', 'lastname', 'mobilephone', 'phone', 'zip'
      ])
    })

    it('propagates idProperty override into the emitted properties', () => {
      const gw = new HubspotContactGateway({ apiClient: makeApi(), idProperty: 'external_id' })
      const props = gw.buildProperties({ id: 7, name: 'X', is_company: false, parent_id: false })
      expect(props.external_id).toBe('7')
      expect(props).not.toHaveProperty('id_contacto_odoo')
    })
  })

  describe('upsertByOdooId', () => {
    it('skips when partner is missing entirely (no id)', async () => {
      const api = makeApi()
      const gw = new HubspotContactGateway({ apiClient: api })
      const r = await gw.upsertByOdooId(null)
      expect(r).toEqual({ skipped: true, reason: 'no_id', created: false })
      expect(api.searchContactByProperty).not.toHaveBeenCalled()
    })

    it('skips with reason no_id when the partner has no id', async () => {
      const api = makeApi()
      const gw = new HubspotContactGateway({ apiClient: api })
      const r = await gw.upsertByOdooId({ name: 'NoId', is_company: false })
      expect(r).toEqual({ skipped: true, reason: 'no_id', created: false })
      expect(api.searchContactByProperty).not.toHaveBeenCalled()
    })

    it('skips with reason no_name when the name is empty', async () => {
      const api = makeApi()
      const gw = new HubspotContactGateway({ apiClient: api })
      const r = await gw.upsertByOdooId({ id: 1, name: '', is_company: false })
      expect(r).toEqual({ skipped: true, reason: 'no_name', created: false })
      expect(api.searchContactByProperty).not.toHaveBeenCalled()
      expect(api.createContact).not.toHaveBeenCalled()
    })

    it('skips with reason no_name when name is only whitespace', async () => {
      const api = makeApi()
      const gw = new HubspotContactGateway({ apiClient: api })
      const r = await gw.upsertByOdooId({ id: 1, name: '   ', is_company: false })
      expect(r.reason).toBe('no_name')
    })

    it('creates when search returns null (search runs by default idProperty)', async () => {
      const api = makeApi({ search: async () => null })
      const gw = new HubspotContactGateway({ apiClient: api })
      const r = await gw.upsertByOdooId({ id: 7, name: 'Ana', is_company: false, parent_id: false })
      expect(api.searchContactByProperty).toHaveBeenCalledWith('id_contacto_odoo', '7')
      expect(api.createContact).toHaveBeenCalledTimes(1)
      expect(api.updateContact).not.toHaveBeenCalled()
      expect(r.created).toBe(true)
      expect(r.id).toBe('NEW')
    })

    it('updates when search returns an existing contact', async () => {
      const api = makeApi({ search: async () => ({ id: 'C-1', properties: {} }) })
      const gw = new HubspotContactGateway({ apiClient: api })
      const r = await gw.upsertByOdooId({ id: 7, name: 'Ana', is_company: false, parent_id: false })
      expect(api.createContact).not.toHaveBeenCalled()
      expect(api.updateContact).toHaveBeenCalledTimes(1)
      expect(api.updateContact.mock.calls[0][0]).toBe('C-1')
      expect(r.created).toBe(false)
      expect(r.id).toBe('EXIST')
    })

    it('create 400 "already has that value" → skipped: duplicate_in_hubspot', async () => {
      const api = makeApi()
      api.searchContactByProperty = vi.fn(async () => { throw new Error('429') })
      api.createContact = vi.fn(async () => {
        const e = new Error('Cannot set PropertyValueCoordinates... 123 already has that value.')
        e.httpStatus = 400
        throw e
      })
      const logger = { warn: vi.fn() }
      const gw = new HubspotContactGateway({ apiClient: api, logger })
      const r = await gw.upsertByOdooId({ id: 7, name: 'X', is_company: false, parent_id: false })
      expect(r).toEqual({ skipped: true, reason: 'duplicate_in_hubspot', created: false })
      expect(logger.warn).toHaveBeenCalled()
    })

    it('create 409 "Contact already exists" (email collision) → skipped: duplicate_in_hubspot', async () => {
      const api = makeApi()
      api.searchContactByProperty = vi.fn(async () => null)
      api.createContact = vi.fn(async () => {
        const e = new Error('Contact already exists')
        e.httpStatus = 409
        e.original = { response: { data: { status: 'error', message: 'Contact already exists. Existing ID: 239629018713', category: 'CONFLICT' } } }
        throw e
      })
      const gw = new HubspotContactGateway({ apiClient: api })
      const r = await gw.upsertByOdooId({ id: 7, name: 'X', is_company: false, parent_id: false })
      expect(r).toEqual({ skipped: true, reason: 'duplicate_in_hubspot', created: false })
    })

    it('create 409 from real Axios-shape → skipped: duplicate_in_hubspot', async () => {
      const api = makeApi()
      api.searchContactByProperty = vi.fn(async () => { throw new Error('429') })
      api.createContact = vi.fn(async () => {
        const e = new Error('Request failed with status code 409')
        e.response = {
          status: 409,
          data: { status: 'error', message: 'Contact already has that value for id_contacto_odoo', category: 'CONFLICT' }
        }
        throw e
      })
      const logger = { warn: vi.fn() }
      const gw = new HubspotContactGateway({ apiClient: api, logger })
      const r = await gw.upsertByOdooId({ id: 7, name: 'X', is_company: false, parent_id: false })
      expect(r.reason).toBe('duplicate_in_hubspot')
    })

    it('swallows search errors and falls back to create', async () => {
      const api = makeApi({
        search: async () => { throw new Error('search-down') },
        create: { id: 'NEW', properties: {} }
      })
      const gw = new HubspotContactGateway({ apiClient: api })
      const r = await gw.upsertByOdooId({ id: 7, name: 'Ana', is_company: false, parent_id: false })
      expect(api.createContact).toHaveBeenCalledTimes(1)
      expect(r.created).toBe(true)
    })

    it('create fails with INVALID_EMAIL VALIDATION_ERROR → skipped: invalid_property_value', async () => {
      const api = makeApi()
      api.searchContactByProperty = vi.fn(async () => null)
      api.createContact = vi.fn(async () => {
        const e = new Error(
          'Property values were not valid: [{"isValid":false,"message":"Email address Gasolinera is invalid","error":"INVALID_EMAIL","name":"email"}]'
        )
        e.httpStatus = 400
        e.original = { response: { data: { category: 'VALIDATION_ERROR', message: e.message } } }
        throw e
      })
      const logger = { warn: vi.fn() }
      const gw = new HubspotContactGateway({ apiClient: api, logger })
      const r = await gw.upsertByOdooId({ id: 7, name: 'X', is_company: false, parent_id: false })
      expect(r).toEqual({ skipped: true, reason: 'invalid_property_value', created: false })
      expect(logger.warn).toHaveBeenCalled()
    })

    it('rethrows non-duplicate errors from createContact', async () => {
      const api = makeApi()
      api.searchContactByProperty = vi.fn(async () => null)
      api.createContact = vi.fn(async () => {
        const e = new Error('Server Error')
        e.httpStatus = 500
        throw e
      })
      const gw = new HubspotContactGateway({ apiClient: api })
      await expect(gw.upsertByOdooId({ id: 7, name: 'Ana', is_company: false, parent_id: false }))
        .rejects.toThrow(/Server Error/)
    })

    it('uses a custom idProperty for the search call', async () => {
      const api = makeApi({ search: async () => null })
      const gw = new HubspotContactGateway({ apiClient: api, idProperty: 'external_id' })
      await gw.upsertByOdooId({ id: 7, name: 'Ana', is_company: false, parent_id: false })
      expect(api.searchContactByProperty).toHaveBeenCalledWith('external_id', '7')
    })
  })

  describe('batchUpsertByOdooIds', () => {
    it('returns empty results/errors/skipped and no apiClient call when input is empty', async () => {
      const api = makeApi()
      const gw = new HubspotContactGateway({ apiClient: api })
      const r = await gw.batchUpsertByOdooIds([])
      expect(api.batchUpsertContacts).not.toHaveBeenCalled()
      expect(r).toEqual({ results: [], errors: [], skipped: [] })
    })

    it('calls apiClient.batchUpsertContacts with idProperty set to the gateway default', async () => {
      const api = makeApi({
        batch: vi.fn(async (args) => ({
          results: args.inputs.map((_, i) => ({ id: `C-${i}`, properties: {} })),
          errors: [],
          numErrors: 0
        }))
      })
      const gw = new HubspotContactGateway({ apiClient: api })
      const partners = [
        { id: 1, name: 'Ana', is_company: false, parent_id: false },
        { id: 2, name: 'Beto', is_company: false, parent_id: false }
      ]
      await gw.batchUpsertByOdooIds(partners)
      const [arg] = api.batchUpsertContacts.mock.calls[0]
      expect(arg.idProperty).toBe('id_contacto_odoo')
      expect(arg.inputs).toHaveLength(2)
      expect(arg.inputs[0].id).toBe('1')
      expect(arg.inputs[1].id).toBe('2')
    })

    it('uses a per-call idProperty override', async () => {
      const api = makeApi({
        batch: vi.fn(async () => ({ results: [], errors: [], numErrors: 0 }))
      })
      const gw = new HubspotContactGateway({ apiClient: api, idProperty: 'default_key' })
      await gw.batchUpsertByOdooIds([{ id: 1, name: 'Ana', is_company: false, parent_id: false }], { idProperty: 'override_key' })
      const [arg] = api.batchUpsertContacts.mock.calls[0]
      expect(arg.idProperty).toBe('override_key')
    })

    it('splits input into 100-item chunks and accumulates results/errors', async () => {
      const calls = []
      const api = makeApi({
        batch: vi.fn(async (args) => {
          calls.push(args.inputs.length)
          return {
            results: args.inputs.map((_, i) => ({ id: `C-${i}`, properties: {} })),
            errors: [],
            numErrors: 0
          }
        })
      })
      const gw = new HubspotContactGateway({ apiClient: api })
      const partners = Array.from({ length: 250 }, (_, i) => ({
        id: i + 1, name: `P-${i + 1}`, is_company: false, parent_id: false
      }))
      const r = await gw.batchUpsertByOdooIds(partners, { chunkSize: 100 })
      expect(calls).toEqual([100, 100, 50])
      expect(r.results).toHaveLength(250)
      expect(r.errors).toHaveLength(0)
      expect(r.skipped).toEqual([])
    })

    it('skips partners with missing id (defensive; should be rare since Odoo domain guarantees id)', async () => {
      const api = makeApi({
        batch: vi.fn(async (args) => ({
          results: args.inputs.map((_, i) => ({ id: `C-${i}`, properties: {} })),
          errors: [],
          numErrors: 0
        }))
      })
      const gw = new HubspotContactGateway({ apiClient: api })
      const r = await gw.batchUpsertByOdooIds([
        { id: 1, name: 'A', is_company: false, parent_id: false },
        { name: 'NoId', is_company: false, parent_id: false },
        { id: null, name: 'NullId', is_company: false, parent_id: false },
        { id: 3, name: 'D', is_company: false, parent_id: false }
      ])
      const inputs = api.batchUpsertContacts.mock.calls[0][0].inputs
      expect(inputs).toHaveLength(2)
      expect(inputs.map((i) => i.id)).toEqual(['1', '3'])
      // skipped entries are reported as null (id was unavailable)
      expect(r.skipped).toHaveLength(2)
    })

    it('collects per-item errors from the apiClient response into result.errors', async () => {
      const api = makeApi({
        batch: vi.fn(async () => ({
          results: [{ id: 'C-1', properties: {} }],
          errors: [{ id: '2', message: 'invalid value', category: 'VALIDATION_ERROR' }],
          numErrors: 1
        }))
      })
      const gw = new HubspotContactGateway({ apiClient: api })
      const r = await gw.batchUpsertByOdooIds([
        { id: 1, name: 'A', is_company: false, parent_id: false },
        { id: 2, name: 'B', is_company: false, parent_id: false }
      ])
      expect(r.results).toHaveLength(1)
      expect(r.errors).toHaveLength(1)
      expect(r.errors[0]).toMatchObject({ id: '2' })
    })

    it('falls back to single-item batch upsert per item when the whole batch call throws, isolating a duplicate-email conflict from the rest', async () => {
      const api = makeApi()
      api.batchUpsertContacts = vi.fn(async (args) => {
        if (args.inputs.length > 1) {
          const e = new Error('Contact already exists')
          e.httpStatus = 409
          e.original = { response: { data: { message: 'Contact already exists. Existing ID: 239629018713', category: 'CONFLICT' } } }
          throw e
        }
        const id = args.inputs[0].id
        if (id === '2') {
          const e = new Error('Contact already exists')
          e.httpStatus = 409
          e.original = { response: { data: { message: 'Contact already exists. Existing ID: 239629018713', category: 'CONFLICT' } } }
          throw e
        }
        return {
          results: [{ id: `NEW-${id}`, properties: args.inputs[0].properties, new: true }],
          errors: [],
          numErrors: 0
        }
      })
      const gw = new HubspotContactGateway({ apiClient: api })
      const r = await gw.batchUpsertByOdooIds([
        { id: 1, name: 'Good Partner', is_company: false, parent_id: false },
        { id: 2, name: 'Colliding Partner', is_company: false, parent_id: false }
      ])
      // 1 whole-chunk attempt + 2 single-item fallback calls, all via batchUpsertContacts
      expect(api.batchUpsertContacts).toHaveBeenCalledTimes(3)
      expect(api.searchContactByProperty).not.toHaveBeenCalled()
      expect(api.createContact).not.toHaveBeenCalled()
      expect(r.results).toHaveLength(1)
      expect(r.results[0].properties.id_contacto_odoo).toBe('1')
      expect(r.results[0].new).toBe(true)
      expect(r.errors).toHaveLength(0)
      expect(r.skipped).toHaveLength(1)
      expect(r.skipped[0]).toMatchObject({ sourceId: 2, reason: 'duplicate_in_hubspot' })
    })

    it('reports a genuinely unexpected per-item error (not a duplicate/invalid) via result.errors during chunk fallback', async () => {
      const api = makeApi()
      api.batchUpsertContacts = vi.fn(async (args) => {
        if (args.inputs.length > 1) throw new Error('batch-boom')
        const e = new Error('Internal Server Error')
        e.httpStatus = 500
        throw e
      })
      const gw = new HubspotContactGateway({ apiClient: api })
      const r = await gw.batchUpsertByOdooIds([
        { id: 1, name: 'A', is_company: false, parent_id: false }
      ])
      expect(api.searchContactByProperty).not.toHaveBeenCalled()
      expect(api.createContact).not.toHaveBeenCalled()
      expect(r.results).toHaveLength(0)
      expect(r.skipped).toHaveLength(0)
      expect(r.errors).toHaveLength(1)
      expect(r.errors[0]).toMatchObject({ id: '1', message: expect.stringContaining('Internal Server Error') })
    })

    it('classifies INVALID_EMAIL / VALIDATION_ERROR single-item fallback failures as skipped: invalid_property_value (not failed)', async () => {
      const api = makeApi()
      api.batchUpsertContacts = vi.fn(async (args) => {
        if (args.inputs.length > 1) throw new Error('batch-boom')
        const e = new Error(
          'Property values were not valid: [{"isValid":false,"message":"Email address Gasolinera is invalid","error":"INVALID_EMAIL","name":"email"}]'
        )
        e.httpStatus = 400
        e.original = { response: { data: { category: 'VALIDATION_ERROR', message: e.message } } }
        throw e
      })
      const gw = new HubspotContactGateway({ apiClient: api })
      const r = await gw.batchUpsertByOdooIds([
        { id: 1, name: 'Bad Email Partner', is_company: false, parent_id: false }
      ])
      expect(r.errors).toHaveLength(0)
      expect(r.results).toHaveLength(0)
      expect(r.skipped).toHaveLength(1)
      expect(r.skipped[0]).toMatchObject({ sourceId: 1, reason: 'invalid_property_value' })
    })

    it('runs the chunk fallback with bounded concurrency (never more than 10 in flight)', async () => {
      const api = makeApi()
      let inFlight = 0
      let maxInFlight = 0
      api.batchUpsertContacts = vi.fn(async (args) => {
        if (args.inputs.length > 1) throw new Error('batch-boom')
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        const id = args.inputs[0].id
        return { results: [{ id: `NEW-${id}`, properties: args.inputs[0].properties, new: true }], errors: [], numErrors: 0 }
      })
      const gw = new HubspotContactGateway({ apiClient: api })
      const partners = Array.from({ length: 25 }, (_, i) => ({
        id: i + 1, name: `P-${i + 1}`, is_company: false, parent_id: false
      }))
      const r = await gw.batchUpsertByOdooIds(partners, { chunkSize: 100 })
      expect(maxInFlight).toBeLessThanOrEqual(10)
      expect(maxInFlight).toBeGreaterThan(1)
      expect(r.results).toHaveLength(25)
    })
  })
})

import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createOdooApiClient } = require('../../../src/adapters/outbound/odoo/odooApiClient.js')

const PARTNER_FIELDS = ['id', 'name', 'email', 'phone', 'mobile', 'street', 'city', 'zip',
  'country_id', 'parent_id', 'is_company', 'function', 'type', 'write_date', 'active']

function httpApi(post) {
  return createOdooApiClient({
    mode: 'http', baseUrl: 'https://odoo.example.com', db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
  })
}

describe('odooApiClient contact-inbound methods (hubspot-contact-inbound-sync)', () => {
  it('searchPartnersByEmail: stub returns [], http search_reads case-insensitive by default limit 3, custom limit honored', async () => {
    expect(await createOdooApiClient({ mode: 'stub' }).searchPartnersByEmail('ana@example.com')).toEqual([])

    const row = { id: 1, name: 'Ana', email: 'ana@example.com' }
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: [row] }, status: 200 })
    expect(await httpApi(post).searchPartnersByEmail('ana@example.com')).toEqual([row])
    expect(post.mock.calls[1][1].params.args).toEqual([
      'db', 2, 'k', 'res.partner', 'search_read',
      [[['active', '=', true], ['email', '=ilike', 'ana@example.com']]],
      { fields: PARTNER_FIELDS, limit: 3 }
    ])

    const post2 = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: [] }, status: 200 })
    await httpApi(post2).searchPartnersByEmail('ana@example.com', { limit: 10 })
    expect(post2.mock.calls[1][1].params.args[6]).toEqual({ fields: PARTNER_FIELDS, limit: 10 })
  })

  it('createPartner: stub returns incrementing ids echoing the payload, http creates via res.partner create', async () => {
    const stubApi = createOdooApiClient({ mode: 'stub' })
    const payload = { name: 'Ana', email: 'ana@example.com', is_company: false }
    expect(await stubApi.createPartner(payload)).toEqual({ id: 'stub-partner-1', raw: payload })
    expect(await stubApi.createPartner(payload)).toEqual({ id: 'stub-partner-2', raw: payload })

    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: 77 }, status: 200 })
    const result = await httpApi(post).createPartner(payload)
    expect(result).toEqual({ id: '77', raw: payload })
    expect(post.mock.calls[1][1].params.args).toEqual(['db', 2, 'k', 'res.partner', 'create', [payload], {}])
  })

  it('updatePartner: stub returns the stringified id echoing the payload, http writes via res.partner write', async () => {
    const payload = { phone: '555-1234' }
    expect(await createOdooApiClient({ mode: 'stub' }).updatePartner(77, payload)).toEqual({ id: '77', raw: payload })

    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: true }, status: 200 })
    const result = await httpApi(post).updatePartner(77, payload)
    expect(result).toEqual({ id: 77, raw: payload, rpcResult: true })
    expect(post.mock.calls[1][1].params.args).toEqual(['db', 2, 'k', 'res.partner', 'write', [[77], payload], {}])
  })

  it('searchCountryIdsByNames: stub {}, http {} for empty input (no RPC), map keyed by name with an OR domain, single-term shape for one name', async () => {
    expect(await createOdooApiClient({ mode: 'stub' }).searchCountryIdsByNames(['Costa Rica'])).toEqual({})

    const noPost = vi.fn()
    expect(await httpApi(noPost).searchCountryIdsByNames([])).toEqual({})
    expect(noPost).not.toHaveBeenCalled()

    const post = vi.fn()
      .mockResolvedValueOnce({ data: { result: 4 }, status: 200 })
      .mockResolvedValueOnce({
        data: { result: [{ id: 50, code: 'CR', name: 'Costa Rica' }, { id: 90, code: 'GT', name: 'Guatemala' }] },
        status: 200
      })
    const result = await httpApi(post).searchCountryIdsByNames(['Costa Rica', 'Guatemala'])
    expect(result).toEqual({
      'Costa Rica': { id: 50, code: 'CR', name: 'Costa Rica' },
      Guatemala: { id: 90, code: 'GT', name: 'Guatemala' }
    })
    expect(post.mock.calls[1][1].params.args[5]).toEqual([
      ['|', ['name', '=ilike', 'Costa Rica'], ['name', '=ilike', 'Guatemala']]
    ])

    const post2 = vi.fn()
      .mockResolvedValueOnce({ data: { result: 4 }, status: 200 })
      .mockResolvedValueOnce({ data: { result: [{ id: 50, code: 'CR', name: 'Costa Rica' }] }, status: 200 })
    await httpApi(post2).searchCountryIdsByNames(['Costa Rica'])
    expect(post2.mock.calls[1][1].params.args[5]).toEqual([[['name', '=ilike', 'Costa Rica']]])
  })
})

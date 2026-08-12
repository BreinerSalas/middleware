import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createOdooApiClient } = require('../../../src/adapters/outbound/odoo/odooApiClient.js')

const PARTNER_DOMAIN = [['active', '=', true], '|', ['parent_id', '=', false], ['type', '=', 'contact']]
const PARTNER_FIELDS = ['id', 'name', 'email', 'phone', 'mobile', 'street', 'city', 'zip',
  'country_id', 'parent_id', 'is_company', 'function', 'type', 'write_date', 'active']

describe('odooApiClient partner methods (partner-sync)', () => {
  describe('countPartners', () => {
    it('stub mode returns 0', async () => {
      const api = createOdooApiClient({ mode: 'stub' })
      expect(await api.countPartners()).toBe(0)
    })

    it('http mode search_counts res.partner scoped by PARTNER_DOMAIN', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce({ data: { result: 42 }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
      })
      expect(await api.countPartners()).toBe(42)
      expect(post.mock.calls[1][1].params.args).toEqual([
        'db', 2, 'k', 'res.partner', 'search_count', [PARTNER_DOMAIN], {}
      ])
    })
  })

  describe('searchPartnersAll', () => {
    it('stub mode returns an empty array', async () => {
      const api = createOdooApiClient({ mode: 'stub' })
      expect(await api.searchPartnersAll()).toEqual([])
    })

    it('http mode search_reads res.partner with PARTNER_DOMAIN and PARTNER_FIELDS', async () => {
      const row = {
        id: 1, name: 'ACME', email: 'a@acme.com', phone: false, mobile: false, street: false,
        city: false, zip: false, country_id: false, parent_id: false, is_company: true,
        function: false, type: 'contact', write_date: '2026-08-01 00:00:00', active: true
      }
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce({ data: { result: [row] }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
      })
      const rows = await api.searchPartnersAll({ offset: 20, limit: 50 })
      expect(rows).toEqual([row])
      expect(post.mock.calls[1][1].params.args).toEqual([
        'db', 2, 'k', 'res.partner', 'search_read',
        [PARTNER_DOMAIN],
        { fields: PARTNER_FIELDS, offset: 20, limit: 50 }
      ])
    })

    it('http mode defaults offset to 0 and limit to 100', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce({ data: { result: [] }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
      })
      await api.searchPartnersAll()
      expect(post.mock.calls[1][1].params.args[6]).toEqual({ fields: PARTNER_FIELDS, offset: 0, limit: 100 })
    })
  })

  describe('searchPartnersChangedSince', () => {
    it('stub mode returns an empty array', async () => {
      const api = createOdooApiClient({ mode: 'stub' })
      expect(await api.searchPartnersChangedSince({ writeDateGte: '2026-08-01 00:00:00' })).toEqual([])
    })

    it('http mode ANDs write_date onto PARTNER_DOMAIN', async () => {
      const row = { id: 1, name: 'ACME', write_date: '2026-08-05 09:00:00' }
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce({ data: { result: [row] }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
      })
      const rows = await api.searchPartnersChangedSince({ writeDateGte: '2026-08-01 00:00:00', offset: 20, limit: 50 })
      expect(rows).toEqual([row])
      expect(post.mock.calls[1][1].params.args).toEqual([
        'db', 2, 'k', 'res.partner', 'search_read',
        [[...PARTNER_DOMAIN, ['write_date', '>', '2026-08-01 00:00:00']]],
        { fields: PARTNER_FIELDS, offset: 20, limit: 50 }
      ])
    })

    it('http mode defaults offset to 0 and limit to 100', async () => {
      const post = vi.fn()
        .mockResolvedValueOnce({ data: { result: 2 }, status: 200 })
        .mockResolvedValueOnce({ data: { result: [] }, status: 200 })
      const api = createOdooApiClient({
        mode: 'http', baseUrl: 'https://odoo.example.com',
        db: 'db', login: 'l@x.com', apiKey: 'k', transport: { post }
      })
      await api.searchPartnersChangedSince({ writeDateGte: '2026-08-01 00:00:00' })
      expect(post.mock.calls[1][1].params.args[6]).toEqual({ fields: PARTNER_FIELDS, offset: 0, limit: 100 })
    })
  })
})

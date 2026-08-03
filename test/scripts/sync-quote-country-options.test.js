import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { planOptions, applyOptions, buildOptions, resolveDryRun } = require('../../scripts/sync-quote-country-options.js')

function makeApiClient({ operationCosts = [], countryMap = {} } = {}) {
  return {
    listOperationCosts: vi.fn(async () => operationCosts),
    searchCountryIdsByCodes: vi.fn(async () => countryMap)
  }
}

function makeHubspot({ existingOptions = null } = {}) {
  const update = vi.fn(async () => ({}))
  const get = vi.fn(async () => existingOptions ? { options: existingOptions } : { options: [] })
  return { updateCustomProperty: update, getCustomProperty: get, _update: update, _get: get }
}

describe('buildOptions', () => {
  it('always prepends a "Sin definir" placeholder', () => {
    const opts = buildOptions({ countries: {}, countriesWithOpCosts: new Set(), usedIsos: ['GT'] })
    expect(opts[0]).toEqual({ label: 'Sin definir', value: '' })
  })

  it('appends ISO codes with the country name when available', () => {
    const opts = buildOptions({
      countries: { GT: { name: 'Guatemala' }, CR: { name: 'Costa Rica' } },
      countriesWithOpCosts: new Set(['GT', 'CR']),
      usedIsos: ['CR', 'GT']
    })
    expect(opts).toEqual([
      { label: 'Sin definir', value: '' },
      { label: 'CR — Costa Rica', value: 'CR' },
      { label: 'GT — Guatemala', value: 'GT' }
    ])
  })

  it('falls back to the ISO code when the country name is unknown', () => {
    const opts = buildOptions({
      countries: {},
      countriesWithOpCosts: new Set(),
      usedIsos: ['MX']
    })
    expect(opts).toEqual([
      { label: 'Sin definir', value: '' },
      { label: 'MX', value: 'MX' }
    ])
  })
})

describe('planOptions', () => {
  it('uses isos whose countryId appears in operation.costs', async () => {
    const apiClient = makeApiClient({
      operationCosts: [
        { countryId: 90, countryName: 'Guatemala' },
        { countryId: 50, countryName: 'Costa Rica' },
        { countryId: 96, countryName: 'Honduras' }
      ],
      countryMap: { CR: { id: 50, name: 'Costa Rica' }, GT: { id: 90, name: 'Guatemala' }, HN: { id: 96, name: 'Honduras' } }
    })
    const hubspot = makeHubspot()
    const plan = await planOptions({ apiClient, hubspot, propertyName: 'pais_de_destino' })
    expect(plan.usedIsos.sort()).toEqual(['CR', 'GT', 'HN'])
    expect(plan.options.find((o) => o.value === 'GT')).toEqual({ label: 'GT — Guatemala', value: 'GT' })
  })

  it('falls back to the fixed ISO list when no operation.costs match', async () => {
    const apiClient = makeApiClient({
      operationCosts: [{ countryId: 9999, countryName: 'Atlantis' }],
      countryMap: { CR: { id: 50, name: 'Costa Rica' }, GT: { id: 90, name: 'Guatemala' }, HN: { id: 96, name: 'Honduras' }, MX: { id: 156, name: 'Mexico' }, NI: { id: 164, name: 'Nicaragua' }, PA: { id: 172, name: 'Panama' }, SV: { id: 209, name: 'El Salvador' } }
    })
    const hubspot = makeHubspot()
    const plan = await planOptions({ apiClient, hubspot, propertyName: 'pais_de_destino' })
    expect(plan.usedIsos.sort()).toEqual(['CR', 'GT', 'HN', 'MX', 'NI', 'PA', 'SV'])
  })

  it('refuses to plan when the Odoo ISO lookup returns nothing at all (e.g. ODOO_CLIENT_MODE=stub)', async () => {
    // res.country is a static Odoo base table; a genuinely-connected Odoo
    // always answers at least one of CR/GT/HN/SV/NI/PA/MX. An empty countryMap
    // means the client couldn't really answer (stub mode, or a swallowed
    // connectivity failure) — silently falling back to the raw ISO list here
    // would publish country codes with no names attached to production HubSpot.
    const apiClient = makeApiClient({ operationCosts: [], countryMap: {} })
    const hubspot = makeHubspot()
    await expect(planOptions({ apiClient, hubspot, propertyName: 'pais_de_destino' }))
      .rejects.toThrow(/no res\.country rows/)
  })

  it('reports propertyLookupFailed when the HubSpot property read throws', async () => {
    const apiClient = makeApiClient({
      operationCosts: [{ countryId: 90, countryName: 'Guatemala' }],
      countryMap: { GT: { id: 90, name: 'Guatemala' } }
    })
    const hubspot = { getCustomProperty: vi.fn(async () => { throw new Error('403') }) }
    const plan = await planOptions({ apiClient, hubspot, propertyName: 'pais_de_destino' })
    expect(plan.propertyLookupFailed).toBe(true)
    expect(plan.currentProperty).toBeNull()
  })
})

describe('applyOptions — dry-run', () => {
  it('does not call updateCustomProperty when dryRun is true', async () => {
    const hubspot = makeHubspot()
    const r = await applyOptions({
      hubspot,
      propertyName: 'pais_de_destino',
      options: [{ label: 'Sin definir', value: '' }, { label: 'GT — Guatemala', value: 'GT' }],
      currentProperty: { options: [] },
      dryRun: true
    })
    expect(r).toEqual({ changed: false, dryRun: true })
    expect(hubspot._update).not.toHaveBeenCalled()
  })

  it('calls updateCustomProperty with the new options when not dry-run', async () => {
    const hubspot = makeHubspot({ existingOptions: [{ label: 'X', value: 'X' }] })
    const r = await applyOptions({
      hubspot,
      propertyName: 'pais_de_destino',
      options: [{ label: 'Sin definir', value: '' }, { label: 'GT — Guatemala', value: 'GT' }],
      currentProperty: { label: 'Pais', groupName: 'quoteinformation', options: [] },
      dryRun: false
    })
    expect(r).toEqual({ changed: true, dryRun: false })
    const call = hubspot._update.mock.calls[0]
    expect(call[0]).toBe('quotes')
    expect(call[1]).toBe('pais_de_destino')
    expect(call[2].options).toEqual([{ label: 'Sin definir', value: '' }, { label: 'GT — Guatemala', value: 'GT' }])
  })

  it('refuses to write when the property lookup failed (would silently revert label/groupName)', async () => {
    const hubspot = makeHubspot()
    await expect(applyOptions({
      hubspot,
      propertyName: 'pais_de_destino',
      options: [{ label: 'Sin definir', value: '' }],
      currentProperty: null,
      propertyLookupFailed: true,
      dryRun: false
    })).rejects.toThrow(/refusing to write/)
    expect(hubspot._update).not.toHaveBeenCalled()
  })

  it('refuses to write when currentProperty is null even without an explicit propertyLookupFailed flag', async () => {
    const hubspot = makeHubspot()
    await expect(applyOptions({
      hubspot,
      propertyName: 'pais_de_destino',
      options: [{ label: 'Sin definir', value: '' }],
      currentProperty: null,
      dryRun: false
    })).rejects.toThrow(/refusing to write/)
    expect(hubspot._update).not.toHaveBeenCalled()
  })
})

describe('resolveDryRun', () => {
  it('is true for bare --dry-run (parsed as boolean true)', () => {
    expect(resolveDryRun({ 'dry-run': true })).toBe(true)
  })

  it('is true for --dry-run=true (parsed as the string "true")', () => {
    expect(resolveDryRun({ 'dry-run': 'true' })).toBe(true)
  })

  it('is true for --dry-run=1 (parsed as the number 1)', () => {
    expect(resolveDryRun({ 'dry-run': 1 })).toBe(true)
  })

  it('is true for --dry-run="1"', () => {
    expect(resolveDryRun({ 'dry-run': '1' })).toBe(true)
  })

  it('is false when the flag is absent', () => {
    expect(resolveDryRun({})).toBe(false)
  })

  it('is false for --dry-run=false (parsed as the string "false")', () => {
    expect(resolveDryRun({ 'dry-run': 'false' })).toBe(false)
  })
})

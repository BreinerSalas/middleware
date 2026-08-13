import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { planOptions, applyOptions, buildOptions, resolveDryRun } = require('../../scripts/sync-quote-country-options.js')

function makeApiClient({ operationCosts = [], countriesById = {} } = {}) {
  return {
    listOperationCosts: vi.fn(async () => operationCosts),
    readCountriesByIds: vi.fn(async () => countriesById)
  }
}

function makeHubspot({ existingOptions = null } = {}) {
  const update = vi.fn(async () => ({}))
  const get = vi.fn(async () => existingOptions ? { options: existingOptions } : { options: [] })
  return { updateCustomProperty: update, getCustomProperty: get, _update: update, _get: get }
}

describe('buildOptions', () => {
  it('always prepends a "Sin definir" placeholder pinned to displayOrder 0', () => {
    const opts = buildOptions({ countries: {}, countriesWithOpCosts: new Set(), usedIsos: ['GT'] })
    expect(opts[0]).toEqual({ label: 'Sin definir', value: 'sin_definir', displayOrder: 0 })
  })

  it('appends ISO codes with the country name when available, with sequential displayOrder', () => {
    const opts = buildOptions({
      countries: { GT: { name: 'Guatemala' }, CR: { name: 'Costa Rica' } },
      countriesWithOpCosts: new Set(['GT', 'CR']),
      usedIsos: ['CR', 'GT']
    })
    expect(opts).toEqual([
      { label: 'Sin definir', value: 'sin_definir', displayOrder: 0 },
      { label: 'CR — Costa Rica', value: 'CR', displayOrder: 1 },
      { label: 'GT — Guatemala', value: 'GT', displayOrder: 2 }
    ])
  })

  it('falls back to the ISO code when the country name is unknown', () => {
    const opts = buildOptions({
      countries: {},
      countriesWithOpCosts: new Set(),
      usedIsos: ['MX']
    })
    expect(opts).toEqual([
      { label: 'Sin definir', value: 'sin_definir', displayOrder: 0 },
      { label: 'MX', value: 'MX', displayOrder: 1 }
    ])
  })

  // HubSpot auto-assigns displayOrder alphabetically by label when a PATCH
  // omits it — confirmed live: with 35 countries, "Sin definir" landed between
  // SX and TT instead of staying first. Sending an explicit displayOrder pins
  // the placeholder regardless of how many country labels alphabetically
  // surround it.
  it('pins "Sin definir" first even when country labels would alphabetically sort around it', () => {
    const opts = buildOptions({
      countries: { SR: { name: 'Suriname' }, SV: { name: 'El Salvador' }, SX: { name: 'Sint Maarten' } },
      countriesWithOpCosts: new Set(['SR', 'SV', 'SX']),
      usedIsos: ['SR', 'SV', 'SX']
    })
    expect(opts[0]).toEqual({ label: 'Sin definir', value: 'sin_definir', displayOrder: 0 })
  })
})

describe('planOptions', () => {
  it('resolves the ISO for every countryId present in operation.costs', async () => {
    const apiClient = makeApiClient({
      operationCosts: [
        { countryId: 90, countryName: 'Guatemala' },
        { countryId: 50, countryName: 'Costa Rica' },
        { countryId: 96, countryName: 'Honduras' }
      ],
      countriesById: {
        50: { code: 'CR', name: 'Costa Rica' },
        90: { code: 'GT', name: 'Guatemala' },
        96: { code: 'HN', name: 'Honduras' }
      }
    })
    const hubspot = makeHubspot()
    const plan = await planOptions({ apiClient, hubspot, propertyName: 'pais_de_destino' })
    expect(plan.usedIsos.sort()).toEqual(['CR', 'GT', 'HN'])
    expect(plan.options.find((o) => o.value === 'GT')).toEqual({ label: 'GT — Guatemala', value: 'GT', displayOrder: 2 })
  })

  // Regression for the old hardcoded ISO_CODES allow-list: it silently capped
  // the dropdown at 7 countries (CR/GT/HN/SV/NI/PA/MX) no matter how many
  // operation.costs Odoo actually had configured — the live business list has
  // 35. There is no fixed list anymore: whatever operation.costs resolves to
  // is what gets published, uncapped.
  it('is not capped to a fixed set of countries — reflects every country operation.costs actually has', async () => {
    const countryIds = Array.from({ length: 35 }, (_, i) => 1000 + i)
    const operationCosts = countryIds.map((id, i) => ({ countryId: id, countryName: `Country ${i}` }))
    const countriesById = {}
    const expectedIsos = []
    countryIds.forEach((id, i) => {
      const iso = `C${String(i).padStart(2, '0')}`
      countriesById[id] = { code: iso, name: `Country ${i}` }
      expectedIsos.push(iso)
    })
    const apiClient = makeApiClient({ operationCosts, countriesById })
    const hubspot = makeHubspot()
    const plan = await planOptions({ apiClient, hubspot, propertyName: 'pais_de_destino' })
    expect(plan.usedIsos.length).toBe(35)
    expect(plan.usedIsos.sort()).toEqual(expectedIsos.sort())
  })

  it('refuses to plan when Odoo resolves no res.country rows for the countries used in operation.costs', async () => {
    // A non-empty operation.costs with country ids but an empty resolution
    // means the id->country lookup itself came back empty (stub mode, or a
    // swallowed connectivity failure), not "Odoo genuinely has zero of these
    // countries" — refuse rather than silently publishing a blind list.
    const apiClient = makeApiClient({
      operationCosts: [{ countryId: 90, countryName: 'Guatemala' }],
      countriesById: {}
    })
    const hubspot = makeHubspot()
    await expect(planOptions({ apiClient, hubspot, propertyName: 'pais_de_destino' }))
      .rejects.toThrow(/no res\.country rows/)
  })

  it('refuses to plan when operation.costs has no country at all', async () => {
    const apiClient = makeApiClient({ operationCosts: [], countriesById: {} })
    const hubspot = makeHubspot()
    await expect(planOptions({ apiClient, hubspot, propertyName: 'pais_de_destino' }))
      .rejects.toThrow()
  })

  it('reports propertyLookupFailed when the HubSpot property read throws', async () => {
    const apiClient = makeApiClient({
      operationCosts: [{ countryId: 90, countryName: 'Guatemala' }],
      countriesById: { 90: { code: 'GT', name: 'Guatemala' } }
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
      options: [{ label: 'Sin definir', value: 'sin_definir', displayOrder: 0 }, { label: 'GT — Guatemala', value: 'GT', displayOrder: 1 }],
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
      options: [{ label: 'Sin definir', value: 'sin_definir', displayOrder: 0 }, { label: 'GT — Guatemala', value: 'GT', displayOrder: 1 }],
      currentProperty: { label: 'Pais', groupName: 'quoteinformation', options: [] },
      dryRun: false
    })
    expect(r).toEqual({ changed: true, dryRun: false })
    const call = hubspot._update.mock.calls[0]
    expect(call[0]).toBe('quotes')
    expect(call[1]).toBe('pais_de_destino')
    expect(call[2].options).toEqual([{ label: 'Sin definir', value: 'sin_definir', displayOrder: 0 }, { label: 'GT — Guatemala', value: 'GT', displayOrder: 1 }])
  })

  it('refuses to write when the property lookup failed (would silently revert label/groupName)', async () => {
    const hubspot = makeHubspot()
    await expect(applyOptions({
      hubspot,
      propertyName: 'pais_de_destino',
      options: [{ label: 'Sin definir', value: 'sin_definir' }],
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
      options: [{ label: 'Sin definir', value: 'sin_definir' }],
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

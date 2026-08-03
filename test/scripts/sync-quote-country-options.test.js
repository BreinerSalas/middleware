import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { planOptions, applyOptions, buildOptions } = require('../../scripts/sync-quote-country-options.js')

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
})

import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { planOptions, applyOptions, buildOptions, resolveDryRun } = require('../../scripts/sync-quote-country-options.js')

function makeApiClient({ operationCosts = [] } = {}) {
  return {
    listOperationCosts: vi.fn(async () => operationCosts)
  }
}

function makeHubspot({ existingOptions = null } = {}) {
  const update = vi.fn(async () => ({}))
  const get = vi.fn(async () => existingOptions ? { options: existingOptions } : { options: [] })
  return { updateCustomProperty: update, getCustomProperty: get, _update: update, _get: get }
}

describe('buildOptions', () => {
  it('always prepends a "Sin definir" placeholder pinned to displayOrder 0', () => {
    const opts = buildOptions({ records: [] })
    expect(opts[0]).toEqual({ label: 'Sin definir', value: 'sin_definir', displayOrder: 0 })
  })

  it('appends one option per record, value = String(id), label = literal name, sequential displayOrder', () => {
    const opts = buildOptions({
      records: [
        { id: 12, name: 'DDP Costa Rica' },
        { id: 7, name: 'EXW Guatemala' }
      ]
    })
    // Sorted by label codepoint compare: 'DDP...' < 'EXW...'
    expect(opts).toEqual([
      { label: 'Sin definir', value: 'sin_definir', displayOrder: 0 },
      { label: 'DDP Costa Rica', value: '12', displayOrder: 1 },
      { label: 'EXW Guatemala', value: '7', displayOrder: 2 }
    ])
  })

  it('falls back to "operation.costs #<id>" when the record name is blank/falsy', () => {
    const opts = buildOptions({
      records: [
        { id: 3, name: '' },
        { id: 4, name: null }
      ]
    })
    expect(opts).toEqual([
      { label: 'Sin definir', value: 'sin_definir', displayOrder: 0 },
      { label: 'operation.costs #3', value: '3', displayOrder: 1 },
      { label: 'operation.costs #4', value: '4', displayOrder: 2 }
    ])
  })

  it('dedupes by record id (defensive — ids should already be unique)', () => {
    const opts = buildOptions({
      records: [
        { id: 5, name: 'DDP Costa Rica' },
        { id: 5, name: 'DDP Costa Rica' }
      ]
    })
    expect(opts).toEqual([
      { label: 'Sin definir', value: 'sin_definir', displayOrder: 0 },
      { label: 'DDP Costa Rica', value: '5', displayOrder: 1 }
    ])
  })

  it('drops records without a positive integer id', () => {
    const opts = buildOptions({
      records: [
        { id: 0, name: 'Zero id' },
        { id: -1, name: 'Negative id' },
        { id: null, name: 'Null id' },
        { id: 9, name: 'Valid' }
      ]
    })
    expect(opts).toEqual([
      { label: 'Sin definir', value: 'sin_definir', displayOrder: 0 },
      { label: 'Valid', value: '9', displayOrder: 1 }
    ])
  })

  it('sorts by raw codepoint comparison on label (not localeCompare), tie-breaking on id ascending', () => {
    // Uppercase vs lowercase: codepoint compare puts all uppercase letters
    // before all lowercase ones ('A'=65 < 'a'=97), unlike locale-aware sort.
    const opts = buildOptions({
      records: [
        { id: 2, name: 'ddp costa rica' },
        { id: 1, name: 'DDP Costa Rica' }
      ]
    })
    expect(opts.map((o) => o.value)).toEqual(['sin_definir', '1', '2'])
  })

  it('tie-breaks equal labels by ascending id', () => {
    const opts = buildOptions({
      records: [
        { id: 20, name: 'DDP Costa Rica' },
        { id: 10, name: 'DDP Costa Rica' }
      ]
    })
    expect(opts.map((o) => o.value)).toEqual(['sin_definir', '10', '20'])
  })

  it('countryId is not required — records without one stay selectable', () => {
    const opts = buildOptions({
      records: [{ id: 8, name: 'No country id' }]
    })
    expect(opts).toEqual([
      { label: 'Sin definir', value: 'sin_definir', displayOrder: 0 },
      { label: 'No country id', value: '8', displayOrder: 1 }
    ])
  })

  it('disambiguates duplicate literal names by appending "(id)" — HubSpot rejects duplicate option labels outright', () => {
    const opts = buildOptions({
      records: [
        { id: 122, name: 'DDP Panamá' },
        { id: 67, name: 'DDP Panamá' },
        { id: 5, name: 'DDP Costa Rica' }
      ]
    })
    expect(opts).toEqual([
      { label: 'Sin definir', value: 'sin_definir', displayOrder: 0 },
      { label: 'DDP Costa Rica', value: '5', displayOrder: 1 },
      { label: 'DDP Panamá (67)', value: '67', displayOrder: 2 },
      { label: 'DDP Panamá (122)', value: '122', displayOrder: 3 }
    ])
  })
})

describe('planOptions', () => {
  it('builds one option per live operation.costs record', async () => {
    const apiClient = makeApiClient({
      operationCosts: [
        { id: 90, name: 'DDP Guatemala', countryId: 90, countryName: 'Guatemala' },
        { id: 50, name: 'CIP Costa Rica', countryId: 50, countryName: 'Costa Rica' }
      ]
    })
    const hubspot = makeHubspot()
    const plan = await planOptions({ apiClient, hubspot, propertyName: 'pais_de_destino' })
    expect(plan.records).toHaveLength(2)
    expect(plan.options.find((o) => o.value === '90')).toEqual({ label: 'DDP Guatemala', value: '90', displayOrder: plan.options.findIndex((o) => o.value === '90') })
    expect(plan.options).toHaveLength(3) // placeholder + 2 records
  })

  it('is not capped to a fixed set of countries — one option per live record, however many', async () => {
    const operationCosts = Array.from({ length: 35 }, (_, i) => ({ id: 1000 + i, name: `Operation Cost ${i}` }))
    const apiClient = makeApiClient({ operationCosts })
    const hubspot = makeHubspot()
    const plan = await planOptions({ apiClient, hubspot, propertyName: 'pais_de_destino' })
    expect(plan.records).toHaveLength(35)
    expect(plan.options).toHaveLength(36) // placeholder + 35 records
  })

  it('reports duplicateLabels for visibility while disambiguating the rendered option labels with "(id)"', async () => {
    const apiClient = makeApiClient({
      operationCosts: [
        { id: 1, name: 'DDP Costa Rica' },
        { id: 2, name: 'DDP Costa Rica' },
        { id: 3, name: 'EXW Guatemala' }
      ]
    })
    const hubspot = makeHubspot()
    const logger = { warn: vi.fn(), info: vi.fn() }
    const plan = await planOptions({ apiClient, hubspot, propertyName: 'pais_de_destino', logger })
    expect(plan.duplicateLabels).toEqual(['DDP Costa Rica'])
    expect(logger.warn).toHaveBeenCalled()
    // Options carry unique labels (HubSpot rejects duplicates outright) even
    // though duplicateLabels still flags the underlying literal-name clash.
    const labels = plan.options.map((o) => o.label)
    expect(labels).toContain('DDP Costa Rica (1)')
    expect(labels).toContain('DDP Costa Rica (2)')
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('duplicateLabels is empty when no live record shares a literal name', async () => {
    const apiClient = makeApiClient({
      operationCosts: [
        { id: 1, name: 'DDP Costa Rica' },
        { id: 2, name: 'EXW Guatemala' }
      ]
    })
    const hubspot = makeHubspot()
    const plan = await planOptions({ apiClient, hubspot, propertyName: 'pais_de_destino' })
    expect(plan.duplicateLabels).toEqual([])
  })

  it('refuses to plan when Odoo returns zero operation.costs records (EMPTY_OPERATION_COSTS)', async () => {
    const apiClient = makeApiClient({ operationCosts: [] })
    const hubspot = makeHubspot()
    const err = await planOptions({ apiClient, hubspot, propertyName: 'pais_de_destino' }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('EMPTY_OPERATION_COSTS')
  })

  it('refuses to plan when operation.costs records exist but none produce a valid option (EMPTY_OPERATION_COSTS_OPTIONS)', async () => {
    const apiClient = makeApiClient({
      operationCosts: [
        { id: 0, name: 'Zero id' },
        { id: null, name: 'Null id' }
      ]
    })
    const hubspot = makeHubspot()
    const err = await planOptions({ apiClient, hubspot, propertyName: 'pais_de_destino' }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('EMPTY_OPERATION_COSTS_OPTIONS')
  })

  it('reports propertyLookupFailed when the HubSpot property read throws', async () => {
    const apiClient = makeApiClient({
      operationCosts: [{ id: 90, name: 'DDP Guatemala' }]
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
      options: [{ label: 'Sin definir', value: 'sin_definir', displayOrder: 0 }, { label: 'DDP Guatemala', value: '90', displayOrder: 1 }],
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
      options: [{ label: 'Sin definir', value: 'sin_definir', displayOrder: 0 }, { label: 'DDP Guatemala', value: '90', displayOrder: 1 }],
      currentProperty: { label: 'Pais', groupName: 'quoteinformation', options: [] },
      dryRun: false
    })
    expect(r).toEqual({ changed: true, dryRun: false })
    const call = hubspot._update.mock.calls[0]
    expect(call[0]).toBe('quotes')
    expect(call[1]).toBe('pais_de_destino')
    expect(call[2].options).toEqual([{ label: 'Sin definir', value: 'sin_definir', displayOrder: 0 }, { label: 'DDP Guatemala', value: '90', displayOrder: 1 }])
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

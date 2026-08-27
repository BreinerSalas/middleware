import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { planOptions, applyOptions, buildOptions, resolveDryRun } = require('../../scripts/sync-quote-incoterm-options.js')

function makeApiClient({ incoterms = [] } = {}) {
  return {
    listIncoterms: vi.fn(async () => incoterms)
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

  it('appends one option per record, value = String(id), label = "CODE — name", sequential displayOrder', () => {
    const opts = buildOptions({
      records: [
        { id: 11, name: 'DELIVERED DUTY PAID', code: 'DDP' },
        { id: 1, name: 'EX WORKS', code: 'EXW' }
      ]
    })
    expect(opts).toEqual([
      { label: 'Sin definir', value: 'sin_definir', displayOrder: 0 },
      { label: 'DDP — DELIVERED DUTY PAID', value: '11', displayOrder: 1 },
      { label: 'EXW — EX WORKS', value: '1', displayOrder: 2 }
    ])
  })

  it('falls back to "account.incoterms #<id>" when name/code are both blank', () => {
    const opts = buildOptions({
      records: [{ id: 3, name: '', code: '' }]
    })
    expect(opts).toEqual([
      { label: 'Sin definir', value: 'sin_definir', displayOrder: 0 },
      { label: 'account.incoterms #3', value: '3', displayOrder: 1 }
    ])
  })

  it('dedupes by record id (defensive)', () => {
    const opts = buildOptions({
      records: [
        { id: 11, name: 'DELIVERED DUTY PAID', code: 'DDP' },
        { id: 11, name: 'DELIVERED DUTY PAID', code: 'DDP' }
      ]
    })
    expect(opts).toHaveLength(2)
  })

  it('drops records without a positive integer id', () => {
    const opts = buildOptions({
      records: [
        { id: 0, name: 'Zero id', code: 'X' },
        { id: null, name: 'Null id', code: 'Y' },
        { id: 9, name: 'Valid', code: 'V' }
      ]
    })
    expect(opts).toEqual([
      { label: 'Sin definir', value: 'sin_definir', displayOrder: 0 },
      { label: 'V — Valid', value: '9', displayOrder: 1 }
    ])
  })

  it('disambiguates duplicate labels by appending "(id)" — HubSpot rejects duplicate option labels outright', () => {
    const opts = buildOptions({
      records: [
        { id: 2, name: 'DUP', code: 'D' },
        { id: 1, name: 'DUP', code: 'D' }
      ]
    })
    expect(opts).toEqual([
      { label: 'Sin definir', value: 'sin_definir', displayOrder: 0 },
      { label: 'D — DUP (1)', value: '1', displayOrder: 1 },
      { label: 'D — DUP (2)', value: '2', displayOrder: 2 }
    ])
  })
})

describe('planOptions', () => {
  it('builds one option per live account.incoterms record', async () => {
    const apiClient = makeApiClient({
      incoterms: [
        { id: 11, name: 'DELIVERED DUTY PAID', code: 'DDP' },
        { id: 1, name: 'EX WORKS', code: 'EXW' }
      ]
    })
    const hubspot = makeHubspot()
    const plan = await planOptions({ apiClient, hubspot, propertyName: 'incoterm_cotizacion' })
    expect(plan.records).toHaveLength(2)
    expect(plan.options).toHaveLength(3)
  })

  it('refuses to plan when Odoo returns zero account.incoterms records (EMPTY_INCOTERMS)', async () => {
    const apiClient = makeApiClient({ incoterms: [] })
    const hubspot = makeHubspot()
    const err = await planOptions({ apiClient, hubspot, propertyName: 'incoterm_cotizacion' }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('EMPTY_INCOTERMS')
  })

  it('refuses to plan when records exist but none produce a valid option (EMPTY_INCOTERM_OPTIONS)', async () => {
    const apiClient = makeApiClient({
      incoterms: [{ id: 0, name: 'Zero id', code: 'X' }, { id: null, name: 'Null id', code: 'Y' }]
    })
    const hubspot = makeHubspot()
    const err = await planOptions({ apiClient, hubspot, propertyName: 'incoterm_cotizacion' }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('EMPTY_INCOTERM_OPTIONS')
  })

  it('reports propertyLookupFailed when the HubSpot property read throws', async () => {
    const apiClient = makeApiClient({ incoterms: [{ id: 11, name: 'DELIVERED DUTY PAID', code: 'DDP' }] })
    const hubspot = { getCustomProperty: vi.fn(async () => { throw new Error('403') }) }
    const plan = await planOptions({ apiClient, hubspot, propertyName: 'incoterm_cotizacion' })
    expect(plan.propertyLookupFailed).toBe(true)
    expect(plan.currentProperty).toBeNull()
  })

  it('reports duplicateLabels for visibility while disambiguating the rendered option labels with "(id)"', async () => {
    const apiClient = makeApiClient({
      incoterms: [
        { id: 1, name: 'DUP', code: 'D' },
        { id: 2, name: 'DUP', code: 'D' }
      ]
    })
    const hubspot = makeHubspot()
    const logger = { warn: vi.fn(), info: vi.fn() }
    const plan = await planOptions({ apiClient, hubspot, propertyName: 'incoterm_cotizacion', logger })
    expect(plan.duplicateLabels).toEqual(['D — DUP'])
    expect(logger.warn).toHaveBeenCalled()
    const labels = plan.options.map((o) => o.label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('applyOptions — dry-run', () => {
  it('does not call updateCustomProperty when dryRun is true', async () => {
    const hubspot = makeHubspot()
    const r = await applyOptions({
      hubspot,
      propertyName: 'incoterm_cotizacion',
      options: [{ label: 'Sin definir', value: 'sin_definir', displayOrder: 0 }],
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
      propertyName: 'incoterm_cotizacion',
      options: [{ label: 'Sin definir', value: 'sin_definir', displayOrder: 0 }, { label: 'DDP — DELIVERED DUTY PAID', value: '11', displayOrder: 1 }],
      currentProperty: { label: 'Incoterm', groupName: 'quoteinformation', options: [] },
      dryRun: false
    })
    expect(r).toEqual({ changed: true, dryRun: false })
    const call = hubspot._update.mock.calls[0]
    expect(call[0]).toBe('quotes')
    expect(call[1]).toBe('incoterm_cotizacion')
    expect(call[2].options).toHaveLength(2)
  })

  it('refuses to write when the property lookup failed', async () => {
    const hubspot = makeHubspot()
    await expect(applyOptions({
      hubspot,
      propertyName: 'incoterm_cotizacion',
      options: [{ label: 'Sin definir', value: 'sin_definir' }],
      currentProperty: null,
      propertyLookupFailed: true,
      dryRun: false
    })).rejects.toThrow(/refusing to write/)
    expect(hubspot._update).not.toHaveBeenCalled()
  })
})

describe('resolveDryRun', () => {
  it('is true for bare --dry-run', () => {
    expect(resolveDryRun({ 'dry-run': true })).toBe(true)
  })

  it('is false when the flag is absent', () => {
    expect(resolveDryRun({})).toBe(false)
  })
})

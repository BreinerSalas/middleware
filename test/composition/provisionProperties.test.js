import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { provisionProperties } = require('../../src/composition/provisionProperties.js')

describe('provisionProperties', () => {
  it('passes objectType to ensureCustomProperty and threads the result', async () => {
    const ensureCustomProperty = vi.fn(async () => ({ created: true }))
    const summary = await provisionProperties({
      api: { ensureCustomProperty },
      objectType: 'quotes',
      properties: [{ name: 'pais_de_destino', label: 'Pais' }]
    })
    expect(ensureCustomProperty).toHaveBeenCalledWith('quotes', 'pais_de_destino', expect.objectContaining({ name: 'pais_de_destino' }))
    expect(summary[0].status).toBe('created')
    expect(summary[0].objectType).toBe('quotes')
  })

  it('marks existing properties as "existing" instead of "created"', async () => {
    const summary = await provisionProperties({
      api: { ensureCustomProperty: async () => ({ created: false }) },
      objectType: 'deals',
      properties: [{ name: 'id_cliente_odoo', label: 'X' }]
    })
    expect(summary[0].status).toBe('existing')
  })

  it('records failures without throwing (so the boot continues)', async () => {
    const summary = await provisionProperties({
      api: { ensureCustomProperty: async () => { throw Object.assign(new Error('bad'), { httpStatus: 403 }) } },
      objectType: 'quotes',
      properties: [{ name: 'pais_de_destino', label: 'Pais' }]
    })
    expect(summary[0].status).toBe('failed')
    expect(summary[0].error).toBe('bad')
  })

  it('throws when api is missing or lacks ensureCustomProperty', async () => {
    await expect(provisionProperties({ api: null, objectType: 'deals', properties: [] })).rejects.toThrow(/api with ensureCustomProperty/)
    await expect(provisionProperties({ api: {}, objectType: 'deals', properties: [] })).rejects.toThrow(/api with ensureCustomProperty/)
  })

  it('throws when objectType is missing or not a string', async () => {
    await expect(provisionProperties({ api: { ensureCustomProperty: () => {} }, objectType: null, properties: [] })).rejects.toThrow(/objectType/)
    await expect(provisionProperties({ api: { ensureCustomProperty: () => {} }, objectType: 123, properties: [] })).rejects.toThrow(/objectType/)
  })

  it('throws when properties is not an array', async () => {
    await expect(provisionProperties({ api: { ensureCustomProperty: () => {} }, objectType: 'deals', properties: 'x' })).rejects.toThrow(/array/)
  })
})

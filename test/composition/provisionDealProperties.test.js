import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { provisionDealProperties } = require('../../src/composition/provisionDealProperties.js')

function makeApi({ ensureResults, ensureThrows }) {
  return {
    ensureCustomProperty: vi.fn(async (...args) => {
      if (ensureThrows) throw ensureThrows
      const key = `${args[0]}:${args[1]}`
      return ensureResults[key] || { created: false }
    })
  }
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

describe('provisionDealProperties', () => {
  const properties = [
    {
      name: 'id_orden_odoo',
      label: 'ID Orden Odoo',
      type: 'string',
      fieldType: 'text',
      groupName: 'dealinformation',
      description: 'ID de la orden de fabricacion (mrp.production) creada en Odoo.'
    },
    {
      name: 'id_cliente_odoo',
      label: 'ID Cliente Odoo',
      type: 'string',
      fieldType: 'text',
      groupName: 'dealinformation',
      description: 'ID del partner (res.partner) en Odoo. Override del default por env.'
    }
  ]

  it('returns a summary with one entry per property', async () => {
    const api = makeApi({ ensureResults: {} })
    const logger = makeLogger()
    const summary = await provisionDealProperties({ api, properties, logger })
    expect(summary).toHaveLength(2)
    expect(summary.map((s) => s.name)).toEqual(['id_orden_odoo', 'id_cliente_odoo'])
  })

  it('marks property as created when ensureCustomProperty returns created:true', async () => {
    const api = makeApi({ ensureResults: { 'deals:id_orden_odoo': { created: true } } })
    const logger = makeLogger()
    const summary = await provisionDealProperties({ api, properties, logger })
    const ord = summary.find((s) => s.name === 'id_orden_odoo')
    expect(ord.created).toBe(true)
    expect(ord.status).toBe('created')
  })

  it('marks property as existing when ensureCustomProperty returns created:false', async () => {
    const api = makeApi({ ensureResults: {} })
    const logger = makeLogger()
    const summary = await provisionDealProperties({ api, properties, logger })
    for (const entry of summary) {
      expect(entry.created).toBe(false)
      expect(entry.status).toBe('existing')
    }
  })

  it('calls api.ensureCustomProperty with objectType "deals" and the property definition', async () => {
    const api = makeApi({ ensureResults: {} })
    const logger = makeLogger()
    await provisionDealProperties({ api, properties, logger })
    const firstCall = api.ensureCustomProperty.mock.calls[0]
    expect(firstCall[0]).toBe('deals')
    expect(firstCall[1]).toBe('id_orden_odoo')
    expect(firstCall[2]).toMatchObject({ name: 'id_orden_odoo', label: 'ID Orden Odoo' })
  })

  it('continues provisioning other properties when one fails (best-effort)', async () => {
    const api = makeApi({
      ensureThrows: (() => {
        const e = new Error('missing scope')
        e.code = 'MISSING_SCOPES'
        return e
      })()
    })
    const logger = makeLogger()
    const summary = await provisionDealProperties({ api, properties, logger })
    expect(summary.every((s) => s.status === 'failed')).toBe(true)
    expect(summary[0].error).toContain('missing scope')
    expect(logger.warn).toHaveBeenCalled()
  })

  it('returns empty array when properties list is empty (no-op)', async () => {
    const api = makeApi({ ensureResults: {} })
    const logger = makeLogger()
    const summary = await provisionDealProperties({ api, properties: [], logger })
    expect(summary).toEqual([])
    expect(api.ensureCustomProperty).not.toHaveBeenCalled()
  })

  it('logger is optional (no throw when not provided)', async () => {
    const api = makeApi({ ensureResults: {} })
    const summary = await provisionDealProperties({ api, properties })
    expect(summary).toHaveLength(2)
  })

  it('logs info when a property is created', async () => {
    const api = makeApi({ ensureResults: { 'deals:id_orden_odoo': { created: true } } })
    const logger = makeLogger()
    await provisionDealProperties({ api, properties, logger })
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('id_orden_odoo'), expect.objectContaining({ created: true }))
  })

  it('logs warn when a property fails to provision (does not throw)', async () => {
    const api = makeApi({
      ensureThrows: (() => {
        const e = new Error('forbidden')
        e.httpStatus = 403
        return e
      })()
    })
    const logger = makeLogger()
    await expect(provisionDealProperties({ api, properties, logger })).resolves.toBeDefined()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('forbidden'), expect.anything())
  })
})
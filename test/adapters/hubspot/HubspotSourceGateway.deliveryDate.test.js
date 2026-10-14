import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { HubspotSourceGateway } = require('../../../src/adapters/outbound/hubspot/HubspotSourceGateway.js')

function build({ enabled = true, updateQuote = async () => ({}), ...options } = {}) {
  const api = { updateQuote: vi.fn(updateQuote), updateDeal: vi.fn(async () => ({})) }
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() }
  const gw = new HubspotSourceGateway({ apiClient: api, logger, quoteCostWritebackEnabled: enabled, ...options })
  return { gw, api, logger }
}

const payload = (date) => ({ id_presupuesto_odoo: 'S1', delivery_date: date })

describe('HubspotSourceGateway quote delivery date write-back', () => {
  it('flag off: no delivery date call', async () => {
    const { gw, api } = build({ enabled: false })
    await gw.writeBack('D-1:qQ-1', payload('2026-09-28 16:26:55'))
    expect(api.updateQuote).toHaveBeenCalledTimes(1)
  })

  it('date present: one separate updateQuote with the calendar date', async () => {
    const { gw, api } = build()
    await gw.writeBack('D-1:qQ-1', payload('2026-09-28 16:26:55'))
    expect(api.updateQuote).toHaveBeenCalledTimes(2)
    expect(api.updateQuote.mock.calls[1]).toEqual(['Q-1', { fecha_entrega_estimada: '2026-09-28' }])
  })

  it('converts UTC to America/Costa_Rica so an early-UTC time lands on the previous day', async () => {
    const { gw, api } = build()
    await gw.writeBack('D-1:qQ-1', payload('2026-09-29 02:30:00'))
    expect(api.updateQuote.mock.calls[1]).toEqual(['Q-1', { fecha_entrega_estimada: '2026-09-28' }])
  })

  it('honors a configured time zone', async () => {
    const { gw, api } = build({ deliveryDateTimeZone: 'UTC' })
    await gw.writeBack('D-1:qQ-1', payload('2026-09-29 02:30:00'))
    expect(api.updateQuote.mock.calls[1]).toEqual(['Q-1', { fecha_entrega_estimada: '2026-09-29' }])
  })

  it('honors a configured property name', async () => {
    const { gw, api } = build({ propertyQuoteDeliveryDate: 'entrega_custom' })
    await gw.writeBack('D-1:qQ-1', payload('2026-09-28 16:26:55'))
    expect(api.updateQuote.mock.calls[1]).toEqual(['Q-1', { entrega_custom: '2026-09-28' }])
  })

  it('swallows a failure with a warn and leaves other write-backs unaffected', async () => {
    let n = 0
    const { gw, api, logger } = build({ updateQuote: async () => { n += 1; if (n === 2) throw new Error('PROPERTY_DOESNT_EXIST') } })
    await expect(gw.writeBack('D-1:qQ-1', payload('2026-09-28 16:26:55'))).resolves.toBeUndefined()
    expect(api.updateQuote).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith('hubspot.quoteDeliveryDate.failed', expect.objectContaining({ sourceId: 'D-1:qQ-1', error: 'PROPERTY_DOESNT_EXIST' }))
  })

  it('skips silently when there is no date or no quote id', async () => {
    const { gw, api } = build()
    await gw.writeBack('D-1:qQ-1', { id_presupuesto_odoo: 'S1' })
    await gw.writeBack('D-1', payload('2026-09-28 16:26:55'))
    expect(api.updateQuote).toHaveBeenCalledTimes(1)
  })

  it('skips an unparseable date with a warn', async () => {
    const { gw, api, logger } = build()
    await gw.writeBack('D-1:qQ-1', payload('not-a-date'))
    expect(api.updateQuote).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith('hubspot.quoteDeliveryDate.unparseable', expect.objectContaining({ value: 'not-a-date' }))
  })
})

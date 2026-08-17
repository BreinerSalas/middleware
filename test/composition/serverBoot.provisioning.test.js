import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

// Mock the two dependencies of the helper directly. `runProductsProvisioningGate` is pure logic
// over `provisionProperties` + `buildProductPropertyDefinitions`, so we can mock them at the
// CJS require level without booting the rest of the server.
const stubProvisionProperties = vi.fn()
const stubBuildProductPropertyDefinitions = vi.fn(() => [
  { name: 'id_producto_odoo', label: 'ID Producto Odoo' }
])
const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
}

require.cache[require.resolve('../../src/composition/provisionProperties.js')] = {
  id: require.resolve('../../src/composition/provisionProperties.js'),
  filename: require.resolve('../../src/composition/provisionProperties.js'),
  loaded: true,
  exports: { provisionProperties: stubProvisionProperties }
}
require.cache[require.resolve('../../src/composition/productPropertyDefinitions.js')] = {
  id: require.resolve('../../src/composition/productPropertyDefinitions.js'),
  filename: require.resolve('../../src/composition/productPropertyDefinitions.js'),
  loaded: true,
  exports: { buildProductPropertyDefinitions: stubBuildProductPropertyDefinitions }
}

const { runProductsProvisioningGate } = require('../../src/composition/productsProvisioningGate.js')

describe('runProductsProvisioningGate (openspec/hubspot-product-odoo-id-key)', () => {
  it('returns the products summary when all entries are created/existing', async () => {
    stubProvisionProperties.mockResolvedValueOnce([
      { name: 'id_producto_odoo', objectType: 'products', status: 'created' }
    ])
    const summary = await runProductsProvisioningGate({
      api: { ensureCustomProperty: vi.fn() },
      hubspotCfg: { propertyOdooProductId: 'id_producto_odoo' },
      logger: stubLogger
    })
    expect(summary).toHaveLength(1)
    expect(summary[0].status).toBe('created')
    expect(stubBuildProductPropertyDefinitions).toHaveBeenCalledWith({ propertyOdooProductId: 'id_producto_odoo' })
  })

  it('throws when any products entry has status: "failed"', async () => {
    stubProvisionProperties.mockResolvedValueOnce([
      { name: 'id_producto_odoo', objectType: 'products', status: 'failed', error: 'groupName not found' }
    ])
    await expect(
      runProductsProvisioningGate({
        api: { ensureCustomProperty: vi.fn() },
        hubspotCfg: {},
        logger: stubLogger
      })
    ).rejects.toThrow(/products provisioning failed.*id_producto_odoo/)
  })

  it('throws with code PRODUCTS_PROVISIONING_FAILED and the failed entries', async () => {
    stubProvisionProperties.mockResolvedValueOnce([
      { name: 'id_producto_odoo', objectType: 'products', status: 'failed', error: 'groupName not found' }
    ])
    let caught = null
    try {
      await runProductsProvisioningGate({
        api: { ensureCustomProperty: vi.fn() },
        hubspotCfg: {},
        logger: stubLogger
      })
    } catch (err) { caught = err }
    expect(caught).toBeTruthy()
    expect(caught.code).toBe('PRODUCTS_PROVISIONING_FAILED')
    expect(Array.isArray(caught.failed)).toBe(true)
    expect(caught.failed[0].name).toBe('id_producto_odoo')
  })

  it('never falls back to SKU matching — boot must halt loud on products failure', async () => {
    stubProvisionProperties.mockResolvedValueOnce([
      { name: 'id_producto_odoo', objectType: 'products', status: 'failed' }
    ])
    let threw = false
    try {
      await runProductsProvisioningGate({
        api: { ensureCustomProperty: vi.fn() },
        hubspotCfg: {},
        logger: stubLogger
      })
    } catch (_) { threw = true }
    expect(threw).toBe(true)
  })
})

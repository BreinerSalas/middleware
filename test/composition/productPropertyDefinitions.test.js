import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { buildProductPropertyDefinitions } = require('../../src/composition/productPropertyDefinitions.js')

describe('buildProductPropertyDefinitions', () => {
  it('returns exactly one property definition', () => {
    const defs = buildProductPropertyDefinitions({})
    expect(defs).toHaveLength(1)
  })

  it('defaults the property name to id_producto_odoo', () => {
    const defs = buildProductPropertyDefinitions({})
    expect(defs[0].name).toBe('id_producto_odoo')
  })

  it('uses cfgHubspot.propertyOdooProductId as the property name when provided', () => {
    const defs = buildProductPropertyDefinitions({ propertyOdooProductId: 'id_producto_odoo_custom' })
    expect(defs[0].name).toBe('id_producto_odoo_custom')
  })

  it('declares a string/text property in the productinformation group', () => {
    const defs = buildProductPropertyDefinitions({})
    expect(defs[0].type).toBe('string')
    expect(defs[0].fieldType).toBe('text')
    expect(defs[0].groupName).toBe('productinformation')
  })

  it('uses the documented label and a description that mentions product.product.id', () => {
    const defs = buildProductPropertyDefinitions({})
    expect(defs[0].label).toBe('ID Producto Odoo')
    expect(defs[0].description).toMatch(/product\.product\.id/)
  })

  it('marks the property as unique so HubSpot batch upsert can use it as idProperty', () => {
    const defs = buildProductPropertyDefinitions({})
    expect(defs[0].hasUniqueValue).toBe(true)
  })
})

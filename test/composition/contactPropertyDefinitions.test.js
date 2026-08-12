import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { buildContactPropertyDefinitions } = require('../../src/composition/contactPropertyDefinitions.js')

describe('buildContactPropertyDefinitions', () => {
  it('returns exactly one property definition', () => {
    const defs = buildContactPropertyDefinitions({})
    expect(defs).toHaveLength(1)
  })

  it('defaults the property name to id_contacto_odoo_v2', () => {
    const defs = buildContactPropertyDefinitions({})
    expect(defs[0].name).toBe('id_contacto_odoo_v2')
  })

  it('uses cfgHubspot.propertyOdooPartnerId as the property name when provided', () => {
    const defs = buildContactPropertyDefinitions({ propertyOdooPartnerId: 'odoo_partner_id_custom' })
    expect(defs[0].name).toBe('odoo_partner_id_custom')
  })

  it('declares a string/text property in the contactinformation group', () => {
    const defs = buildContactPropertyDefinitions({})
    expect(defs[0].type).toBe('string')
    expect(defs[0].fieldType).toBe('text')
    expect(defs[0].groupName).toBe('contactinformation')
  })

  it('uses the documented label and a description that mentions res.partner.id', () => {
    const defs = buildContactPropertyDefinitions({})
    expect(defs[0].label).toBe('ID Contacto Odoo')
    expect(defs[0].description).toMatch(/res\.partner\.id/)
  })

  it('marks the property as unique so HubSpot batch upsert can use it as idProperty', () => {
    const defs = buildContactPropertyDefinitions({})
    expect(defs[0].hasUniqueValue).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  mapPartnerToContactProperties,
  splitName
} = require('../../../src/adapters/outbound/hubspot/partnerToContactMapper.js')

describe('splitName', () => {
  it('splits a two-token name into firstname and lastname', () => {
    expect(splitName('Ana Pérez')).toEqual({ firstname: 'Ana', lastname: 'Pérez' })
  })

  it('splits a three-or-more-token name: first token firstname, rest joined as lastname', () => {
    expect(splitName('María José García López')).toEqual({ firstname: 'María', lastname: 'José García López' })
  })

  it('single token falls back to lastname (no firstname)', () => {
    expect(splitName('Cher')).toEqual({ firstname: '', lastname: 'Cher' })
  })

  it('empty/null/undefined returns both empty', () => {
    expect(splitName('')).toEqual({ firstname: '', lastname: '' })
    expect(splitName(null)).toEqual({ firstname: '', lastname: '' })
    expect(splitName(undefined)).toEqual({ firstname: '', lastname: '' })
  })

  it('whitespace-only name returns both empty', () => {
    expect(splitName('   ')).toEqual({ firstname: '', lastname: '' })
  })

  it('collapses internal whitespace', () => {
    expect(splitName('Ana   Pérez')).toEqual({ firstname: 'Ana', lastname: 'Pérez' })
  })
})

describe('mapPartnerToContactProperties', () => {
  describe('key emission contract (the unconditional-overwrite rule)', () => {
    it('emits EVERY contact property key on every call, even with empty values', () => {
      const props = mapPartnerToContactProperties({ id: 1, name: 'Empty' })
      expect(Object.keys(props).sort()).toEqual([
        'address', 'city', 'company', 'country', 'email', 'firstname', 'id_contacto_odoo',
        'jobtitle', 'lastname', 'mobilephone', 'phone', 'zip'
      ])
    })

    it('emits all keys when the partner has only an id (no name)', () => {
      const props = mapPartnerToContactProperties({ id: 99 })
      expect(Object.keys(props).sort()).toEqual([
        'address', 'city', 'company', 'country', 'email', 'firstname', 'id_contacto_odoo',
        'jobtitle', 'lastname', 'mobilephone', 'phone', 'zip'
      ])
      // every non-id field must be '' (the unconditional-overwrite rule)
      expect(props.id_contacto_odoo).toBe('99')
      expect(props.firstname).toBe('')
      expect(props.lastname).toBe('')
      expect(props.email).toBe('')
      expect(props.phone).toBe('')
      expect(props.mobilephone).toBe('')
      expect(props.address).toBe('')
      expect(props.city).toBe('')
      expect(props.zip).toBe('')
      expect(props.country).toBe('')
      expect(props.jobtitle).toBe('')
      expect(props.company).toBe('')
    })

    it('never omits a key — always writes "" for empty/missing Odoo values (no merging)', () => {
      const partner = {
        id: 7,
        name: 'Ana',
        email: null,
        phone: false,
        mobile: '',
        street: undefined,
        city: 'Lima',
        zip: '15001',
        country_id: [51, 'Peru'],
        parent_id: false,
        is_company: false,
        function: false
      }
      const props = mapPartnerToContactProperties(partner)
      expect(props.email).toBe('')
      expect(props.phone).toBe('')
      expect(props.mobilephone).toBe('')
      expect(props.address).toBe('')
      expect(props.jobtitle).toBe('')
      expect(props.company).toBe('')
      expect(props.country).toBe('Peru')
    })
  })

  describe('idProperty wiring', () => {
    it('uses id_contacto_odoo as default and String(id) as value', () => {
      const props = mapPartnerToContactProperties({ id: 42, name: 'Ana' })
      expect(props.id_contacto_odoo).toBe('42')
    })

    it('accepts a custom idProperty override', () => {
      const props = mapPartnerToContactProperties({ id: 42, name: 'Ana' }, { idProperty: 'external_id' })
      expect(props.external_id).toBe('42')
      expect(props).not.toHaveProperty('id_contacto_odoo')
    })
  })

  describe('individual person (is_company !== true)', () => {
    it('splits name into firstname/lastname and leaves company empty when no parent_id', () => {
      const props = mapPartnerToContactProperties({
        id: 1, name: 'Ana Pérez', is_company: false, parent_id: false
      })
      expect(props.firstname).toBe('Ana')
      expect(props.lastname).toBe('Pérez')
      expect(props.company).toBe('')
    })

    it('uses parent_id[1] as company name when present', () => {
      const props = mapPartnerToContactProperties({
        id: 1, name: 'Beto López', is_company: false, parent_id: [10, 'ACME S.A.']
      })
      expect(props.company).toBe('ACME S.A.')
    })

    it('treats is_company === false and missing is_company the same way', () => {
      const a = mapPartnerToContactProperties({ id: 1, name: 'Ana Pérez', is_company: false })
      const b = mapPartnerToContactProperties({ id: 1, name: 'Ana Pérez' })
      expect(a.firstname).toBe(b.firstname)
      expect(a.lastname).toBe(b.lastname)
      expect(a.company).toBe(b.company)
    })
  })

  describe('company partner (is_company === true)', () => {
    it('puts the name in lastname, leaves firstname empty, and uses name as company', () => {
      const props = mapPartnerToContactProperties({
        id: 1, name: 'ACME S.A.', is_company: true, parent_id: false
      })
      expect(props.firstname).toBe('')
      expect(props.lastname).toBe('ACME S.A.')
      expect(props.company).toBe('ACME S.A.')
    })

    it('ignores parent_id for company partners (company is always name)', () => {
      const props = mapPartnerToContactProperties({
        id: 1, name: 'ACME S.A.', is_company: true, parent_id: [99, 'Other']
      })
      expect(props.company).toBe('ACME S.A.')
    })
  })

  describe('direct field mappings', () => {
    it('maps email/phone/mobile/street/city/zip straight through (stringified)', () => {
      const props = mapPartnerToContactProperties({
        id: 1,
        name: 'Ana',
        email: 'ana@example.com',
        phone: '+51 1 5551234',
        mobile: '+51 999888777',
        street: 'Av. Siempre Viva 742',
        city: 'Lima',
        zip: '15001'
      })
      expect(props.email).toBe('ana@example.com')
      expect(props.phone).toBe('+51 1 5551234')
      expect(props.mobilephone).toBe('+51 999888777')
      expect(props.address).toBe('Av. Siempre Viva 742')
      expect(props.city).toBe('Lima')
      expect(props.zip).toBe('15001')
    })

    it('maps country_id[1] (the human-readable name from a many2one tuple)', () => {
      const props = mapPartnerToContactProperties({
        id: 1, name: 'Ana', country_id: [51, 'Peru']
      })
      expect(props.country).toBe('Peru')
    })

    it('maps function (Odoo) → jobtitle (HubSpot)', () => {
      const props = mapPartnerToContactProperties({
        id: 1, name: 'Ana', function: 'Gerente Comercial'
      })
      expect(props.jobtitle).toBe('Gerente Comercial')
    })

    it('coerces non-string scalar values to strings', () => {
      const props = mapPartnerToContactProperties({
        id: 1, name: 'Ana', email: 42, zip: 15001
      })
      expect(props.email).toBe('42')
      expect(props.zip).toBe('15001')
    })
  })

  describe('defensive coercions', () => {
    it('treats false (Odoo "no value") as empty string', () => {
      const props = mapPartnerToContactProperties({
        id: 1, name: 'Ana',
        email: false, phone: false, mobile: false, street: false, city: false, zip: false,
        country_id: false, parent_id: false, function: false
      })
      expect(props.email).toBe('')
      expect(props.phone).toBe('')
      expect(props.mobilephone).toBe('')
      expect(props.address).toBe('')
      expect(props.city).toBe('')
      expect(props.zip).toBe('')
      expect(props.country).toBe('')
      expect(props.company).toBe('')
      expect(props.jobtitle).toBe('')
    })
  })
})

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { mapContactToPartnerPayload } = require('../../../src/adapters/outbound/odoo/contactToPartnerMapper.js')

describe('mapContactToPartnerPayload', () => {
  it('builds name from firstname + lastname when both are present', () => {
    expect(mapContactToPartnerPayload({ firstname: 'Ana', lastname: 'Pérez', email: 'ana@example.com' }).name).toBe('Ana Pérez')
  })

  it('falls back to the email local-part when firstname/lastname are both empty or blank', () => {
    expect(mapContactToPartnerPayload({ email: 'beto.lopez@example.com' }).name).toBe('beto.lopez')
    expect(mapContactToPartnerPayload({ firstname: '  ', lastname: '', email: 'x@example.com' }).name).toBe('x')
  })

  it('maps direct fields straight through, defaults missing ones to "", and always sets is_company:false', () => {
    const filled = mapContactToPartnerPayload({
      firstname: 'Ana', lastname: 'Pérez', email: 'ana@example.com', phone: '+51 1 5551234',
      mobilephone: '+51 999888777', address: 'Av. Siempre Viva 742', city: 'Lima', zip: '15001', jobtitle: 'Gerente Comercial'
    })
    expect(filled).toMatchObject({
      email: 'ana@example.com', phone: '+51 1 5551234', mobile: '+51 999888777',
      street: 'Av. Siempre Viva 742', city: 'Lima', zip: '15001', function: 'Gerente Comercial', is_company: false
    })
    const empty = mapContactToPartnerPayload({ email: 'a@b.com' })
    expect(empty).toMatchObject({ phone: '', mobile: '', street: '', city: '', zip: '', function: '', is_company: false })
  })

  it('copies company verbatim into comment, and omits the comment key entirely when absent or empty', () => {
    expect(mapContactToPartnerPayload({ email: 'a@b.com', company: 'ACME S.A.' }).comment).toBe('ACME S.A.')
    expect(mapContactToPartnerPayload({ email: 'a@b.com' })).not.toHaveProperty('comment')
    expect(mapContactToPartnerPayload({ email: 'a@b.com', company: '' })).not.toHaveProperty('comment')
  })

  it('passes through an already-resolved country_id, and omits the key entirely when none is given', () => {
    expect(mapContactToPartnerPayload({ email: 'a@b.com' }, { countryId: 50 }).country_id).toBe(50)
    expect(mapContactToPartnerPayload({ email: 'a@b.com' })).not.toHaveProperty('country_id')
    expect(mapContactToPartnerPayload({ email: 'a@b.com' }, { countryId: undefined })).not.toHaveProperty('country_id')
  })

  it('treats null/undefined contact properties as "" rather than the strings "null"/"undefined"', () => {
    const payload = mapContactToPartnerPayload({ firstname: null, lastname: undefined, email: 'a@b.com', phone: null })
    expect(payload.phone).toBe('')
    expect(payload.name).toBe('a')
  })
})

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { mustHaveLineItems, mustBeClosedWon, createMustHaveOdooCustomerId } = require('../../src/composition/validators.js')
const { SkipSyncError } = require('../../src/core/domain/errors.js')

describe('composition/validators', () => {
  describe('mustHaveLineItems', () => {
    it('throws SkipSyncError when references.lineItems is missing', () => {
      expect(() => mustHaveLineItems({ record: { id: 'D-1', properties: {} }, references: {} })).toThrow(SkipSyncError)
    })
    it('throws SkipSyncError when references.lineItems is empty', () => {
      expect(() => mustHaveLineItems({ record: { id: 'D-1', properties: {} }, references: { lineItems: [] } })).toThrow(SkipSyncError)
    })
    it('passes when references.lineItems has at least one item', () => {
      expect(() => mustHaveLineItems({ record: { id: 'D-1', properties: {} }, references: { lineItems: [{ id: 'L-1' }] } })).not.toThrow()
    })
  })

  describe('mustBeClosedWon', () => {
    it('throws SkipSyncError when not closedwon', () => {
      expect(() => mustBeClosedWon({ record: { id: 'D-1', properties: { dealstage: 'open' } } })).toThrow(/closedwon/)
    })
    it('passes when closedwon', () => {
      expect(() => mustBeClosedWon({ record: { id: 'D-1', properties: { dealstage: 'closedwon' } } })).not.toThrow()
    })
    it('handles missing stage', () => {
      expect(() => mustBeClosedWon({ record: { id: 'D-1', properties: {} } })).toThrow(/closedwon/)
    })
  })

  describe('createMustHaveOdooCustomerId', () => {
    it('returns a function', () => {
      const fn = createMustHaveOdooCustomerId()
      expect(typeof fn).toBe('function')
    })

    it('passes when direct property present', () => {
      const v = createMustHaveOdooCustomerId()
      expect(() => v({ record: { properties: { id_cliente_odoo: '42' } }, references: {} })).not.toThrow()
    })

    it('passes when references.odooCustomerId present', () => {
      const v = createMustHaveOdooCustomerId()
      expect(() => v({ record: { properties: {} }, references: { odooCustomerId: '42' } })).not.toThrow()
    })

    it('throws transient error when neither property nor reference, and no default', () => {
      const v = createMustHaveOdooCustomerId()
      try {
        v({ record: { properties: {} }, references: {} })
        throw new Error('should have thrown')
      } catch (err) {
        expect(err.transient).toBe(true)
        expect(err.code).toBe('MISSING_ODOO_CUSTOMER_ID')
      }
    })

    it('passes when defaultCustomerId is configured and no deal property is set', () => {
      const v = createMustHaveOdooCustomerId({ defaultCustomerId: '42' })
      expect(() => v({ record: { properties: {} }, references: {} })).not.toThrow()
    })

    it('passes when defaultCustomerId is configured but deal property is also set (deal property wins, but both are valid)', () => {
      const v = createMustHaveOdooCustomerId({ defaultCustomerId: '99' })
      expect(() => v({ record: { properties: { id_cliente_odoo: '42' } }, references: {} })).not.toThrow()
    })

    it('throws transient error when defaultCustomerId is empty string and no other source', () => {
      const v = createMustHaveOdooCustomerId({ defaultCustomerId: '' })
      try {
        v({ record: { properties: {} }, references: {} })
        throw new Error('should have thrown')
      } catch (err) {
        expect(err.transient).toBe(true)
        expect(err.code).toBe('MISSING_ODOO_CUSTOMER_ID')
      }
    })
  })
})

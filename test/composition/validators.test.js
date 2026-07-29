import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  mustHaveLineItems,
  mustBeClosedWon,
  createMustHaveOdooCustomerId,
  createMustHaveDealStage,
  createMustBeInPipeline
} = require('../../src/composition/validators.js')
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

  describe('createMustHaveDealStage', () => {
    it('returns a function', () => {
      expect(typeof createMustHaveDealStage()).toBe('function')
    })

    it('passes when dealstage is in the allowlist', () => {
      const v = createMustHaveDealStage({ allowed: ['1409249445'] })
      expect(() => v({ record: { id: 'D-1', properties: { dealstage: '1409249445' } } })).not.toThrow()
    })

    it('throws SkipSyncError when dealstage is not in the allowlist', () => {
      const v = createMustHaveDealStage({ allowed: ['1409249445'] })
      try {
        v({ record: { id: 'D-1', properties: { dealstage: '999999' } } })
        throw new Error('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(SkipSyncError)
        expect(err.reason).toMatch(/dealstage/)
      }
    })

    it('throws SkipSyncError when dealstage is the legacy string "closedwon"', () => {
      const v = createMustHaveDealStage({ allowed: ['1409249445'] })
      try {
        v({ record: { id: 'D-1', properties: { dealstage: 'closedwon' } } })
        throw new Error('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(SkipSyncError)
      }
    })

    it('accepts multiple stages', () => {
      const v = createMustHaveDealStage({ allowed: ['1409249445', '999999'] })
      expect(() => v({ record: { id: 'D-1', properties: { dealstage: '999999' } } })).not.toThrow()
    })

    it('throws when dealstage property missing', () => {
      const v = createMustHaveDealStage({ allowed: ['1409249445'] })
      expect(() => v({ record: { id: 'D-1', properties: {} } })).toThrow(SkipSyncError)
    })
  })

  describe('createMustBeInPipeline', () => {
    const CVB = 't_5728252902aef7e9938dfcbb6cdc2af8'

    it('returns a function', () => {
      expect(typeof createMustBeInPipeline()).toBe('function')
    })

    it('passes when pipeline is in the allowlist', () => {
      const v = createMustBeInPipeline({ allowed: [CVB] })
      expect(() => v({ record: { id: 'D-1', properties: { pipeline: CVB } } })).not.toThrow()
    })

    it('throws SkipSyncError when pipeline is outside the allowlist (sales pipeline)', () => {
      const v = createMustBeInPipeline({ allowed: [CVB] })
      try {
        v({ record: { id: 'D-1', properties: { pipeline: 'sales-pipeline-id-xxx' } } })
        throw new Error('should have thrown')
      } catch (err) {
        expect(err).toBeInstanceOf(SkipSyncError)
        expect(err.reason).toMatch(/pipeline/)
      }
    })

    it('throws SkipSyncError when pipeline is missing and rejectWhenMissing=true (default)', () => {
      const v = createMustBeInPipeline({ allowed: [CVB] })
      expect(() => v({ record: { id: 'D-1', properties: {} } })).toThrow(SkipSyncError)
    })

    it('passes when pipeline is missing and rejectWhenMissing=false', () => {
      const v = createMustBeInPipeline({ allowed: [CVB], rejectWhenMissing: false })
      expect(() => v({ record: { id: 'D-1', properties: {} } })).not.toThrow()
    })

    it('accepts multiple pipelines', () => {
      const v = createMustBeInPipeline({ allowed: [CVB, 'another-pipeline-id'] })
      expect(() => v({ record: { id: 'D-1', properties: { pipeline: 'another-pipeline-id' } } })).not.toThrow()
    })
  })
})

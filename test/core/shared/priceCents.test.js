import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { toCents, pricesMatchInCents } = require('../../../src/core/shared/priceCents.js')

// (sdd/hubspot-product-reverse-discovery, design D4) Integer-cents compare, no epsilon
// tuning — sub-cent differences DO collapse into a match (deterministic rounding). Used by
// Track A/B to decide auto-link/archive vs quarantine; safety comes from match-counting
// (0 or 2+ candidates quarantines), not from refusing to round sub-cent noise.
describe('priceCents', () => {
  describe('toCents', () => {
    it('converts a plain float to integer cents', () => {
      expect(toCents(93.04)).toBe(9304)
    })

    it('converts a numeric string to integer cents', () => {
      expect(toCents('93.04')).toBe(9304)
    })

    it('returns NaN for null/undefined/non-numeric input', () => {
      expect(Number.isNaN(toCents(null))).toBe(true)
      expect(Number.isNaN(toCents(undefined))).toBe(true)
      expect(Number.isNaN(toCents('not-a-number'))).toBe(true)
    })
  })

  describe('pricesMatchInCents', () => {
    it('matches equal prices given as floats', () => {
      expect(pricesMatchInCents(93.04, 93.04)).toBe(true)
    })

    it('matches equal prices given as a string vs a float', () => {
      expect(pricesMatchInCents('93.04', 93.04)).toBe(true)
    })

    it('rounds sub-cent differences into the same cents bucket (deterministic, no tuned epsilon)', () => {
      // 93.041 rounds to the same integer cents as 93.04 — this is intentional per
      // design D4: it is Math.round-driven determinism, not a tuned tolerance window.
      expect(pricesMatchInCents(93.04, 93.041)).toBe(true)
    })

    it('does NOT match on a full-cent difference', () => {
      expect(pricesMatchInCents(93.04, 93.05)).toBe(false)
    })

    it('does NOT match when either side is null/NaN', () => {
      expect(pricesMatchInCents(null, 93.04)).toBe(false)
      expect(pricesMatchInCents(93.04, 'not-a-number')).toBe(false)
    })
  })
})

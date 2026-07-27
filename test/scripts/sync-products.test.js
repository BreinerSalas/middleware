import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { parseArgs, resolveIntervalMs, shouldRunOnce } = require('../../scripts/sync-products.lib.js')

describe('sync-products.lib', () => {
  describe('parseArgs', () => {
    it('parses flags without values as true', () => {
      expect(parseArgs(['--once', '--dry-run'])).toEqual({ once: true, 'dry-run': true })
    })

    it('parses flags with values as numbers when numeric', () => {
      expect(parseArgs(['--interval=60000', '--limit=10'])).toEqual({ interval: 60000, limit: 10 })
    })

    it('parses flags with values as strings when non-numeric', () => {
      expect(parseArgs(['--target=staging'])).toEqual({ target: 'staging' })
    })

    it('ignores non-flag arguments', () => {
      expect(parseArgs(['positional', '--once', 'another'])).toEqual({ once: true })
    })

    it('handles empty input', () => {
      expect(parseArgs([])).toEqual({})
    })

    it('handles --flag=value with empty value', () => {
      expect(parseArgs(['--target='])).toEqual({ target: '' })
    })
  })

  describe('resolveIntervalMs', () => {
    it('returns null when --interval is bare flag (invalid)', () => {
      expect(resolveIntervalMs({ interval: true }, {})).toBeNull()
    })

    it('returns explicit --interval=N value', () => {
      expect(resolveIntervalMs({ interval: 30000 }, {})).toBe(30000)
    })

    it('returns 0 when --once is set (no interval)', () => {
      expect(resolveIntervalMs({ once: true }, {})).toBe(0)
    })

    it('falls back to env var PRODUCT_SYNC_INTERVAL_MS', () => {
      expect(resolveIntervalMs({}, { PRODUCT_SYNC_INTERVAL_MS: '45000' })).toBe(45000)
    })

    it('falls back to default 60000 when nothing provided', () => {
      expect(resolveIntervalMs({}, {})).toBe(60000)
    })

    it('ignores invalid (non-numeric) env var, uses default', () => {
      expect(resolveIntervalMs({}, { PRODUCT_SYNC_INTERVAL_MS: 'abc' })).toBe(60000)
    })

    it('env var overridden by explicit --interval', () => {
      expect(resolveIntervalMs({ interval: 10000 }, { PRODUCT_SYNC_INTERVAL_MS: '60000' })).toBe(10000)
    })
  })

  describe('shouldRunOnce', () => {
    it('true when --once set', () => {
      expect(shouldRunOnce({ once: true })).toBe(true)
    })

    it('true when interval resolves to 0', () => {
      expect(shouldRunOnce({})).toBe(false)
      expect(shouldRunOnce({ interval: 1000 })).toBe(false)
      expect(shouldRunOnce({})).toBe(false)
    })
  })

  describe('--include-no-sku flag', () => {
    it('parseArgs captures --include-no-sku as true', () => {
      expect(parseArgs(['--include-no-sku'])).toEqual({ 'include-no-sku': true })
    })

    it('parseArgs normalizes include-no-sku from boolean flag', () => {
      const args = parseArgs(['--once', '--include-no-sku', '--dry-run'])
      expect(args['include-no-sku']).toBe(true)
      expect(args.once).toBe(true)
      expect(args['dry-run']).toBe(true)
    })
  })
})

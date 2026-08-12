import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { buildProductImageUrlBuilder } = require('../../src/composition/productImageUrlBuilder.js')
const { verifyProductImageToken } = require('../../src/core/shared/mediaSignature.js')

describe('buildProductImageUrlBuilder', () => {
  it('returns null when urlSecret is missing', () => {
    const builder = buildProductImageUrlBuilder({ urlSecret: '', publicBaseUrl: 'https://mw.example.com' })
    expect(builder).toBeNull()
  })

  it('returns null when publicBaseUrl is missing', () => {
    const builder = buildProductImageUrlBuilder({ urlSecret: 'secret', publicBaseUrl: '' })
    expect(builder).toBeNull()
  })

  it('returns a function when both urlSecret and publicBaseUrl are set', () => {
    const builder = buildProductImageUrlBuilder({ urlSecret: 'secret', publicBaseUrl: 'https://mw.example.com' })
    expect(typeof builder).toBe('function')
  })

  it('builds the expected URL shape and encodes a token that round-trips to the odoo product id', () => {
    const builder = buildProductImageUrlBuilder({ urlSecret: 'secret', publicBaseUrl: 'https://mw.example.com' })
    const url = builder({ id: 42, name: 'Widget' })

    expect(url.startsWith('https://mw.example.com/media/products/')).toBe(true)
    expect(url.endsWith('/image')).toBe(true)

    const match = url.match(/^https:\/\/mw\.example\.com\/media\/products\/(.+)\/image$/)
    expect(match).not.toBeNull()
    const token = match[1]
    expect(verifyProductImageToken(token, 'secret')).toBe(42)
  })

  it('strips trailing slashes consistently with publicBaseUrl already normalized upstream', () => {
    const builder = buildProductImageUrlBuilder({ urlSecret: 'secret', publicBaseUrl: 'https://mw.example.com' })
    const url = builder({ id: 7 })
    expect(url).toMatch(/^https:\/\/mw\.example\.com\/media\/products\/[^/]+\/image$/)
  })

  it('returns empty string for a product with no id instead of throwing', () => {
    const builder = buildProductImageUrlBuilder({ urlSecret: 'secret', publicBaseUrl: 'https://mw.example.com' })
    expect(builder({})).toBe('')
    expect(builder(null)).toBe('')
  })

  it('returns empty string for a product with an invalid (non-positive) id instead of throwing', () => {
    const builder = buildProductImageUrlBuilder({ urlSecret: 'secret', publicBaseUrl: 'https://mw.example.com' })
    expect(builder({ id: 0 })).toBe('')
    expect(builder({ id: -5 })).toBe('')
    expect(builder({ id: 'not-a-number' })).toBe('')
  })
})

import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createMustHaveQuoteCountry } = require('../../src/composition/validators.js')

describe('createMustHaveQuoteCountry', () => {
  const validator = createMustHaveQuoteCountry({ countryProperty: 'pais_de_destino' })

  it('is a no-op when record has no quoteId (legacy/deal path)', () => {
    expect(() => validator({ record: { id: 'D-1', properties: {} } })).not.toThrow()
  })

  it('is a no-op when record.quoteId is null', () => {
    expect(() => validator({ record: { id: 'D-1', quoteId: null, properties: {} } })).not.toThrow()
  })

  it('throws SkipSyncError when quote is present but country is missing', () => {
    const { SkipSyncError } = require('../../src/core/domain/errors.js')
    const record = {
      id: 'D-1:qQ-1',
      quoteId: 'Q-1',
      quote: { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED' } }
    }
    expect(() => validator({ record })).toThrow(SkipSyncError)
  })

  it('passes when quote is present with the country set', () => {
    const record = {
      id: 'D-1:qQ-1',
      quoteId: 'Q-1',
      quote: { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'GT' } }
    }
    expect(() => validator({ record })).not.toThrow()
  })

  it('treats empty string country as missing', () => {
    const { SkipSyncError } = require('../../src/core/domain/errors.js')
    const record = {
      id: 'D-1:qQ-1',
      quoteId: 'Q-1',
      quote: { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: '' } }
    }
    expect(() => validator({ record })).toThrow(SkipSyncError)
  })

  it('honors a custom countryProperty name', () => {
    const v = createMustHaveQuoteCountry({ countryProperty: 'pais_iso' })
    const { SkipSyncError } = require('../../src/core/domain/errors.js')
    const record = {
      id: 'D-1:qQ-1',
      quoteId: 'Q-1',
      quote: { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'GT' } }
    }
    expect(() => v({ record })).toThrow(SkipSyncError)
  })
})

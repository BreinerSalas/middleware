import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createMustHaveQuoteCountry, createMustHaveQuoteIncoterm, createMustHaveQuoteDocumentType } = require('../../src/composition/validators.js')

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

  it('throws SkipSyncError when quote country is the sin_definir sentinel', () => {
    const { SkipSyncError } = require('../../src/core/domain/errors.js')
    const record = {
      id: 'D-1:qQ-1',
      quoteId: 'Q-1',
      quote: { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', pais_de_destino: 'sin_definir' } }
    }
    expect(() => validator({ record })).toThrow(SkipSyncError)
  })

  it('is still a no-op on the legacy deal path (no quoteId) even when pais_de_destino is sin_definir', () => {
    const record = { id: 'D-1', properties: { pais_de_destino: 'sin_definir' } }
    expect(() => validator({ record })).not.toThrow()
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

describe('createMustHaveQuoteIncoterm', () => {
  const validator = createMustHaveQuoteIncoterm({ incotermProperty: 'incoterm_cotizacion' })

  it('is a no-op (never throws) when incotermProperty is not configured — opt-in, like isEligibleQuote', () => {
    const v = createMustHaveQuoteIncoterm({})
    const record = {
      id: 'D-1:qQ-1',
      quoteId: 'Q-1',
      quote: { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED' } }
    }
    expect(() => v({ record })).not.toThrow()
  })

  it('is a no-op when record has no quoteId (legacy/deal path)', () => {
    expect(() => validator({ record: { id: 'D-1', properties: {} } })).not.toThrow()
  })

  it('throws SkipSyncError when quote is present but incoterm is missing', () => {
    const { SkipSyncError } = require('../../src/core/domain/errors.js')
    const record = {
      id: 'D-1:qQ-1',
      quoteId: 'Q-1',
      quote: { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED' } }
    }
    expect(() => validator({ record })).toThrow(SkipSyncError)
  })

  it('passes when quote is present with incoterm set', () => {
    const record = {
      id: 'D-1:qQ-1',
      quoteId: 'Q-1',
      quote: { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', incoterm_cotizacion: '11' } }
    }
    expect(() => validator({ record })).not.toThrow()
  })

  it('throws SkipSyncError when incoterm is the sin_definir sentinel', () => {
    const { SkipSyncError } = require('../../src/core/domain/errors.js')
    const record = {
      id: 'D-1:qQ-1',
      quoteId: 'Q-1',
      quote: { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', incoterm_cotizacion: 'sin_definir' } }
    }
    expect(() => validator({ record })).toThrow(SkipSyncError)
  })

  it('honors a custom incotermProperty name', () => {
    const v = createMustHaveQuoteIncoterm({ incotermProperty: 'incoterm_custom' })
    const record = {
      id: 'D-1:qQ-1',
      quoteId: 'Q-1',
      quote: { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', incoterm_custom: '11' } }
    }
    expect(() => v({ record })).not.toThrow()
  })
})

describe('createMustHaveQuoteDocumentType', () => {
  const validator = createMustHaveQuoteDocumentType({ documentTypeProperty: 'tipo_documento_cotizacion' })

  it('is a no-op (never throws) when documentTypeProperty is not configured — opt-in, like isEligibleQuote', () => {
    const v = createMustHaveQuoteDocumentType({})
    const record = {
      id: 'D-1:qQ-1',
      quoteId: 'Q-1',
      quote: { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED' } }
    }
    expect(() => v({ record })).not.toThrow()
  })

  it('is a no-op when record has no quoteId (legacy/deal path)', () => {
    expect(() => validator({ record: { id: 'D-1', properties: {} } })).not.toThrow()
  })

  it('throws SkipSyncError when quote is present but tipo de documento is missing', () => {
    const { SkipSyncError } = require('../../src/core/domain/errors.js')
    const record = {
      id: 'D-1:qQ-1',
      quoteId: 'Q-1',
      quote: { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED' } }
    }
    expect(() => validator({ record })).toThrow(SkipSyncError)
  })

  it('passes when quote is present with tipo de documento set', () => {
    const record = {
      id: 'D-1:qQ-1',
      quoteId: 'Q-1',
      quote: { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', tipo_documento_cotizacion: '01' } }
    }
    expect(() => validator({ record })).not.toThrow()
  })

  it('throws SkipSyncError when tipo de documento is the sin_definir sentinel', () => {
    const { SkipSyncError } = require('../../src/core/domain/errors.js')
    const record = {
      id: 'D-1:qQ-1',
      quoteId: 'Q-1',
      quote: { id: 'Q-1', properties: { hs_status: 'APPROVAL_NOT_NEEDED', tipo_documento_cotizacion: 'sin_definir' } }
    }
    expect(() => validator({ record })).toThrow(SkipSyncError)
  })
})

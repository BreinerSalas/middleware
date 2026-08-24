import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { buildQuotePropertyDefinitions } = require('../../src/composition/quotePropertyDefinitions.js')

describe('buildQuotePropertyDefinitions', () => {
  it('returns seven properties: country dropdown + odoo quote id + MO number + estado + facturacion + incoterm dropdown + tipo de documento dropdown', () => {
    const defs = buildQuotePropertyDefinitions({
      propertyQuoteCountry: 'pais_de_destino',
      propertyOdooQuoteId: 'id_presupuesto_odoo',
      propertyManufacturingOrder: 'numero_orden_fabricacion',
      propertyQuoteState: 'estado_presupuesto_odoo',
      propertyQuoteInvoiceStatus: 'estado_facturacion_odoo',
      propertyQuoteIncoterm: 'incoterm_cotizacion',
      propertyQuoteDocumentType: 'tipo_documento_cotizacion'
    })
    expect(defs).toHaveLength(7)
    expect(defs[0].name).toBe('pais_de_destino')
    expect(defs[0].type).toBe('enumeration')
    expect(defs[0].fieldType).toBe('select')
    expect(defs[1].name).toBe('id_presupuesto_odoo')
    expect(defs[1].type).toBe('string')
    expect(defs[1].fieldType).toBe('text')
    expect(defs[2].name).toBe('numero_orden_fabricacion')
    expect(defs[2].type).toBe('string')
    expect(defs[2].fieldType).toBe('text')
    expect(defs[3].name).toBe('estado_presupuesto_odoo')
    expect(defs[3].type).toBe('string')
    expect(defs[3].fieldType).toBe('text')
    expect(defs[4].name).toBe('estado_facturacion_odoo')
    expect(defs[4].type).toBe('string')
    expect(defs[4].fieldType).toBe('text')
    expect(defs[5].name).toBe('incoterm_cotizacion')
    expect(defs[5].type).toBe('enumeration')
    expect(defs[5].fieldType).toBe('select')
    expect(defs[6].name).toBe('tipo_documento_cotizacion')
    expect(defs[6].type).toBe('enumeration')
    expect(defs[6].fieldType).toBe('select')
  })

  it('seeds the incoterm dropdown with only the "Sin definir" placeholder (populated by scripts/sync-quote-incoterm-options.js)', () => {
    const defs = buildQuotePropertyDefinitions({})
    expect(defs[5].options).toEqual([{ label: 'Sin definir', value: 'sin_definir' }])
  })

  it('seeds the tipo de documento dropdown with the 3 fixed Odoo operation_type_sv codes', () => {
    const defs = buildQuotePropertyDefinitions({})
    expect(defs[6].options).toEqual([
      { label: 'Sin definir', value: 'sin_definir' },
      { label: 'Factura', value: '01' },
      { label: 'Comprobante de crédito fiscal', value: '03' },
      { label: 'Facturas de exportación', value: '11' }
    ])
  })

  it('defaults the incoterm and tipo de documento property names', () => {
    const defs = buildQuotePropertyDefinitions({})
    expect(defs[5].name).toBe('incoterm_cotizacion')
    expect(defs[6].name).toBe('tipo_documento_cotizacion')
  })

  it('defaults the MO number property to numero_orden_fabricacion', () => {
    const defs = buildQuotePropertyDefinitions({})
    expect(defs[2].name).toBe('numero_orden_fabricacion')
  })

  it('defaults the quote state / invoice status properties (Fase 6)', () => {
    const defs = buildQuotePropertyDefinitions({})
    expect(defs[3].name).toBe('estado_presupuesto_odoo')
    expect(defs[4].name).toBe('estado_facturacion_odoo')
  })

  it('defaults the country property to pais_de_destino', () => {
    const defs = buildQuotePropertyDefinitions({})
    expect(defs[0].name).toBe('pais_de_destino')
  })

  it('defaults the quote id property to id_presupuesto_odoo', () => {
    const defs = buildQuotePropertyDefinitions({})
    expect(defs[1].name).toBe('id_presupuesto_odoo')
  })

  it('seeds the country dropdown with a "Sin definir" placeholder using a non-blank value', () => {
    // HubSpot rejects enumeration options with value: '' ("cannot have
    // options with blank values") on both create and update.
    const defs = buildQuotePropertyDefinitions({})
    expect(defs[0].options).toEqual([{ label: 'Sin definir', value: 'sin_definir' }])
    expect(defs[0].options[0].value).not.toBe('')
  })

  it('drops the "(ISO-2)" label/description now that the dropdown mirrors operation.costs records, not ISO codes', () => {
    const defs = buildQuotePropertyDefinitions({})
    expect(defs[0].label).not.toMatch(/ISO-2/)
    expect(defs[0].description).not.toMatch(/ISO-2|Código ISO/)
  })
})

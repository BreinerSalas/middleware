'use strict'

function buildQuotePropertyDefinitions(cfgHubspot = {}) {
  const countryProperty = cfgHubspot.propertyQuoteCountry || 'pais_de_destino'
  const quoteIdProperty = cfgHubspot.propertyOdooQuoteId || 'id_presupuesto_odoo'
  const manufacturingOrderProperty = cfgHubspot.propertyManufacturingOrder || 'numero_orden_fabricacion'
  // Build the dropdown options from the configured list. The actual options
  // are populated/refreshed by scripts/sync-quote-country-options.js — here
  // we just declare the schema with a single placeholder so the property
  // exists end-to-end.
  return [
    {
      name: countryProperty,
      label: 'País de destino (ISO-2)',
      type: 'enumeration',
      fieldType: 'select',
      groupName: 'quoteinformation',
      description: 'Código ISO-2 del país de la cotización (CR, GT, HN, SV, NI, PA, MX). El dropdown se sincroniza desde Odoo.',
      // HubSpot rejects enumeration options with a blank ('') value at create
      // and update time ("cannot have options with blank values"). A property
      // with no answer picked already renders blank in the UI without needing
      // an explicit placeholder option, so this uses a real, non-empty
      // sentinel value instead of ''.
      options: [
        { label: 'Sin definir', value: 'sin_definir' }
      ]
    },
    {
      name: quoteIdProperty,
      label: 'ID Presupuesto Odoo',
      type: 'string',
      fieldType: 'text',
      groupName: 'quoteinformation',
      description: 'Nombre del presupuesto (sale.order.name, ej. S06613) creado en Odoo a partir de esta cotización. El middleware lo escribe en writeback.'
    },
    {
      name: manufacturingOrderProperty,
      label: 'Número de orden de fabricación',
      type: 'string',
      fieldType: 'text',
      groupName: 'quoteinformation',
      description: 'Nombre de la mrp.production (ej. WH/MO/00042) generada por Odoo al confirmar el presupuesto. El middleware lo escribe en writeback cuando la auto-confirmación está activa.'
    }
  ]
}

module.exports = { buildQuotePropertyDefinitions }

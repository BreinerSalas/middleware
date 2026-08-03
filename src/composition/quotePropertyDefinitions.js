'use strict'

function buildQuotePropertyDefinitions(cfgHubspot = {}) {
  const countryProperty = cfgHubspot.propertyQuoteCountry || 'pais_de_destino'
  const quoteIdProperty = cfgHubspot.propertyOdooQuoteId || 'id_presupuesto_odoo'
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
      options: [
        { label: 'Sin definir', value: '' }
      ]
    },
    {
      name: quoteIdProperty,
      label: 'ID Presupuesto Odoo',
      type: 'string',
      fieldType: 'text',
      groupName: 'quoteinformation',
      description: 'Nombre del presupuesto (sale.order.name, ej. S06613) creado en Odoo a partir de esta cotización. El middleware lo escribe en writeback.'
    }
  ]
}

module.exports = { buildQuotePropertyDefinitions }

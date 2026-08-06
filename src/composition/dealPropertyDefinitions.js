'use strict'

function buildDealPropertyDefinitions(cfgHubspot = {}) {
  return [
    {
      name: cfgHubspot.propertyOdooOrderId,
      label: 'ID Orden Odoo',
      type: 'string',
      fieldType: 'text',
      groupName: 'dealinformation',
      description: 'Reservado para un futuro backfill de la orden de fabricacion (mrp.production). El middleware ya no escribe este campo: crea el sale.order y Odoo genera la MO al confirmar el presupuesto.'
    },
    {
      name: cfgHubspot.propertyOdooCustomerId,
      label: 'ID Cliente Odoo',
      type: 'string',
      fieldType: 'text',
      groupName: 'dealinformation',
      description: 'ID del partner (res.partner) en Odoo. Override del default por env.'
    },
    {
      name: cfgHubspot.propertyOdooQuoteId,
      label: 'ID Presupuesto Odoo',
      type: 'string',
      fieldType: 'text',
      groupName: 'dealinformation',
      description: 'Nombre del presupuesto (sale.order.name, ej. S06613) creado en Odoo al cerrar el negocio. La orden de fabricacion la genera Odoo al confirmar el presupuesto.'
    },
    {
      name: cfgHubspot.propertyQuoteState || 'estado_presupuesto_odoo',
      label: 'Estado del presupuesto en Odoo',
      type: 'string',
      fieldType: 'text',
      groupName: 'dealinformation',
      description: 'sale.order.state tal cual lo reporta Odoo. Se usa cuando el deal no tuvo cotizaciones elegibles y se sincronizo en modo fallback (un solo sale.order para todo el deal).'
    },
    {
      name: cfgHubspot.propertyQuoteInvoiceStatus || 'estado_facturacion_odoo',
      label: 'Estado de facturación en Odoo',
      type: 'string',
      fieldType: 'text',
      groupName: 'dealinformation',
      description: 'sale.order.invoice_status tal cual lo reporta Odoo. Se usa cuando el deal no tuvo cotizaciones elegibles y se sincronizo en modo fallback.'
    },
    {
      name: cfgHubspot.propertyManufacturingOrder || 'numero_orden_fabricacion',
      label: 'Número de orden de fabricación',
      type: 'string',
      fieldType: 'text',
      groupName: 'dealinformation',
      description: 'Nombre de la mrp.production generada por Odoo al confirmar el presupuesto. Se usa cuando el deal no tuvo cotizaciones elegibles y se sincronizo en modo fallback.'
    }
  ]
}

module.exports = { buildDealPropertyDefinitions }

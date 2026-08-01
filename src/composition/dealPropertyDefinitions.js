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
    }
  ]
}

module.exports = { buildDealPropertyDefinitions }

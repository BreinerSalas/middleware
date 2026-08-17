'use strict'

function buildProductPropertyDefinitions(cfgHubspot = {}) {
  const productIdProperty = cfgHubspot.propertyOdooProductId || 'id_producto_odoo'
  return [
    {
      name: productIdProperty,
      label: 'ID Producto Odoo',
      type: 'string',
      fieldType: 'text',
      groupName: 'productinformation',
      description: 'product.product.id de Odoo. Clave de idempotencia del product-sync.',
      hasUniqueValue: true
    }
  ]
}

module.exports = { buildProductPropertyDefinitions }

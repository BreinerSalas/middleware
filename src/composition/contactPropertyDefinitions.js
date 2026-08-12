'use strict'

function buildContactPropertyDefinitions(cfgHubspot = {}) {
  const partnerIdProperty = cfgHubspot.propertyOdooPartnerId || 'id_contacto_odoo_v2'
  return [
    {
      name: partnerIdProperty,
      label: 'ID Contacto Odoo',
      type: 'string',
      fieldType: 'text',
      groupName: 'contactinformation',
      description: 'res.partner.id de Odoo. Clave de idempotencia del partner-sync.',
      hasUniqueValue: true
    }
  ]
}

module.exports = { buildContactPropertyDefinitions }

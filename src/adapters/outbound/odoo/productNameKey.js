'use strict'

// Clave de comparacion de nombres de producto entre HubSpot y Odoo.
// La tienen que usar ambos lados (el cliente al armar el map de resultados y el
// gateway al buscar), o una diferencia de mayusculas o de espacios falla en silencio.
function normalizeProductName(value) {
  if (value == null) return ''
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase()
}

module.exports = { normalizeProductName }

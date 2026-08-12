'use strict'

function splitName(name) {
  if (name == null) return { firstname: '', lastname: '' }
  const trimmed = String(name).trim().replace(/\s+/g, ' ')
  if (trimmed === '') return { firstname: '', lastname: '' }
  const idx = trimmed.indexOf(' ')
  if (idx === -1) return { firstname: '', lastname: trimmed }
  return { firstname: trimmed.slice(0, idx), lastname: trimmed.slice(idx + 1) }
}

function asString(value) {
  if (value === false || value == null) return ''
  if (typeof value === 'string') return value
  return String(value)
}

function pickMany2oneName(value) {
  if (!value) return ''
  if (Array.isArray(value) && value.length >= 2) return asString(value[1])
  return asString(value)
}

function mapPartnerToContactProperties(partner, { idProperty = 'id_contacto_odoo' } = {}) {
  if (!partner || partner.id == null) {
    throw new Error('mapPartnerToContactProperties requires a partner with id')
  }

  const isCompany = partner.is_company === true
  const name = asString(partner.name)
  const split = splitName(name)

  const firstname = isCompany ? '' : split.firstname
  const lastname = isCompany ? name : split.lastname
  const company = isCompany
    ? name
    : pickMany2oneName(partner.parent_id)

  return {
    [idProperty]: asString(partner.id),
    firstname,
    lastname,
    email: asString(partner.email),
    phone: asString(partner.phone),
    mobilephone: asString(partner.mobile),
    address: asString(partner.street),
    city: asString(partner.city),
    zip: asString(partner.zip),
    country: pickMany2oneName(partner.country_id),
    jobtitle: asString(partner.function),
    company
  }
}

module.exports = { mapPartnerToContactProperties, splitName }

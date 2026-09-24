'use strict'

function asString(value) {
  if (value === false || value == null) return ''
  if (typeof value === 'string') return value
  return String(value)
}

function emailLocalPart(email) {
  const str = asString(email)
  const idx = str.indexOf('@')
  return idx === -1 ? str : str.slice(0, idx)
}

function resolveName(contact) {
  const firstname = asString(contact.firstname).trim()
  const lastname = asString(contact.lastname).trim()
  const parts = [firstname, lastname].filter((p) => p !== '')
  if (parts.length > 0) return parts.join(' ')
  return emailLocalPart(contact.email)
}

// Pure mapper: HubSpot contact properties -> res.partner create payload.
// `country_id` is NOT resolved here — Odoo country lookup is an async
// operation that belongs to the use-case (Phase 4), which calls this
// function synchronously after it has already resolved the id.
function mapContactToPartnerPayload(contact, { countryId } = {}) {
  const company = asString(contact.company)

  const payload = {
    name: resolveName(contact),
    email: asString(contact.email),
    phone: asString(contact.phone),
    mobile: asString(contact.mobilephone),
    street: asString(contact.address),
    city: asString(contact.city),
    zip: asString(contact.zip),
    function: asString(contact.jobtitle),
    is_company: false
  }

  if (company !== '') {
    payload.comment = company
  }

  if (countryId !== undefined) {
    payload.country_id = countryId
  }

  return payload
}

module.exports = { mapContactToPartnerPayload }

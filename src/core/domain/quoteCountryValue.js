'use strict'

const QUOTE_COUNTRY_UNSET = 'sin_definir'

const LEGACY_ISO_PATTERN = /^[A-Za-z]{2}$/
const NUMERIC_ID_PATTERN = /^\d+$/

function isUnsetQuoteCountry(raw) {
  if (raw == null) return true
  const trimmed = String(raw).trim()
  if (trimmed === '') return true
  return trimmed.toLowerCase() === QUOTE_COUNTRY_UNSET
}

function classifyQuoteCountryValue(raw) {
  if (raw == null) {
    return { kind: 'absent', value: '', operationCostId: null }
  }

  const trimmed = String(raw).trim()

  if (trimmed === '') {
    return { kind: 'absent', value: '', operationCostId: null }
  }

  if (trimmed.toLowerCase() === QUOTE_COUNTRY_UNSET) {
    return { kind: 'unset', value: trimmed, operationCostId: null }
  }

  if (LEGACY_ISO_PATTERN.test(trimmed)) {
    return { kind: 'legacy_iso', value: trimmed, operationCostId: null }
  }

  if (NUMERIC_ID_PATTERN.test(trimmed) && Number(trimmed) > 0) {
    return { kind: 'operation_cost_id', value: trimmed, operationCostId: Number(trimmed) }
  }

  return { kind: 'unrecognized', value: trimmed, operationCostId: null }
}

module.exports = { QUOTE_COUNTRY_UNSET, isUnsetQuoteCountry, classifyQuoteCountryValue }

'use strict'

function normalizeForMatch(value) {
  if (value == null) return ''
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
}

function isExactDdpForCountry(name, normalizedCountry) {
  if (!name || !normalizedCountry) return false
  const m = /^DDP\s+(.+)$/i.exec(String(name).trim())
  if (!m) return false
  return normalizeForMatch(m[1]) === normalizedCountry
}

function fallbackToLowestId(records, reason) {
  const sorted = [...records].sort((a, b) => Number(a.id) - Number(b.id))
  const chosen = sorted[0]
  return {
    id: Number(chosen.id),
    name: chosen.name,
    matches: records.length,
    ids: records.map((r) => Number(r.id)),
    ambiguous: true,
    reason
  }
}

function pickOperationCostForCountry(records, countryName) {
  if (!Array.isArray(records) || records.length === 0) return null

  if (records.length === 1) {
    const only = records[0]
    return {
      id: Number(only.id),
      name: only.name,
      matches: 1,
      ids: [Number(only.id)],
      ambiguous: false
    }
  }

  const normalizedCountry = normalizeForMatch(countryName)
  if (!normalizedCountry) {
    return fallbackToLowestId(records, 'country_name_required')
  }

  const ddpExact = records.find((r) => isExactDdpForCountry(r.name, normalizedCountry))
  if (ddpExact) {
    return {
      id: Number(ddpExact.id),
      name: ddpExact.name,
      matches: records.length,
      ids: records.map((r) => Number(r.id)),
      ambiguous: false,
      reason: 'ddp_exact_match'
    }
  }

  return fallbackToLowestId(records, 'no_ddp_exact_match')
}

module.exports = { pickOperationCostForCountry, normalizeForMatch, isExactDdpForCountry }

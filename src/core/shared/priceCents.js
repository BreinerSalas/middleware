'use strict'

// (sdd/hubspot-product-reverse-discovery, design D4) Deterministic price comparison for
// the orphan-reconciliation Track A/B disambiguation: integer cents via Math.round, no
// tuned epsilon. A sub-cent difference DOES collapse into a match (both round to the same
// cents bucket) — that's deterministic rounding, not guessing. Safety instead comes from
// counting how many candidates match: 0 or 2+ matches quarantines, exactly 1 auto-resolves.
function toCents(value) {
  if (value == null) return NaN
  const n = Number(value)
  if (!Number.isFinite(n)) return NaN
  return Math.round(n * 100)
}

function pricesMatchInCents(a, b) {
  const centsA = toCents(a)
  const centsB = toCents(b)
  if (Number.isNaN(centsA) || Number.isNaN(centsB)) return false
  return centsA === centsB
}

module.exports = { toCents, pricesMatchInCents }

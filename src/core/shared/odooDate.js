'use strict'

function parseOdooDateUtc(value) {
  if (!value) return null
  const iso = `${String(value).trim().replace(' ', 'T')}Z`
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms
}

function formatOdooDateUtc(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

module.exports = { parseOdooDateUtc, formatOdooDateUtc }

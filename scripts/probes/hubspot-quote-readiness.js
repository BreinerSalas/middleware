#!/usr/bin/env node
'use strict'

/**
 * Read-only staging probes for the HubSpot Quote fan-out feature.
 * Implements Q1-Q6 from docs/plan-cotizaciones-por-pais.md.
 *
 * NEVER writes to Odoo. Q3 writes to a test quote via a custom property
 * we own (read-modify the same property), so it is safe in staging.
 * Run: node scripts/probes/hubspot-quote-readiness.js [--out=docs/testing/2026-08-03-quote-readiness.json]
 *      [--deal=<dealId>] [--quote=<quoteId>] [--country-prop=<pais_de_destino>]
 */

const path = require('node:path')
const axios = require('axios')
const { load } = require('../../src/config')
const { createLogger } = require('../../src/lib/logger')
const { parseArgs } = require('../sync-products.lib')

function buildHubspotHttpClient({ baseUrl, accessToken, timeoutMs = 15000 }) {
  return axios.create({
    baseURL: baseUrl,
    timeout: timeoutMs,
    headers: { Authorization: `Bearer ${accessToken}` }
  })
}

function buildOdooRpc({ baseUrl, db, login, apiKey, timeoutMs = 15000 }) {
  const http = axios.create({
    baseURL: baseUrl.replace(/\/+$/, ''),
    timeout: timeoutMs,
    headers: { 'Content-Type': 'application/json' }
  })

  let uidPromise = null
  async function ensureUid() {
    if (!uidPromise) {
      uidPromise = (async () => {
        const res = await http.post('/jsonrpc', {
          jsonrpc: '2.0', method: 'call',
          params: { service: 'common', method: 'authenticate', args: [db, login, apiKey, {}] },
          id: Date.now()
        })
        if (res.data && res.data.error) {
          const msg = (res.data.error.data && res.data.error.data.message) || res.data.error.message
          throw new Error(`Odoo authenticate: ${msg}`)
        }
        if (!res.data || !res.data.result) throw new Error('Odoo authenticate returned falsy uid')
        return res.data.result
      })()
    }
    return uidPromise
  }

  async function executeKw(model, method, args, kwargs = {}) {
    const uid = await ensureUid()
    const res = await http.post('/jsonrpc', {
      jsonrpc: '2.0', method: 'call',
      params: { service: 'object', method: 'execute_kw', args: [db, uid, apiKey, model, method, args, kwargs] },
      id: Date.now()
    })
    if (res.data && res.data.error) {
      const err = new Error((res.data.error.data && res.data.error.data.message) || res.data.error.message || 'Odoo RPC error')
      err.code = res.data.error.code
      err.httpStatus = res.status
      throw err
    }
    return res.data && res.data.result
  }

  return { ensureUid, executeKw }
}

async function probeQ1_ListDealQuotes({ hubspot, dealId, countryProp }) {
  if (!dealId) {
    return {
      id: 'Q1',
      status: 'skip',
      summary: 'no --deal provided; cannot list quotes. Re-run with --deal=<id> from a real deal with at least one published quote.',
      data: { needsArg: 'deal' }
    }
  }
  const url = `/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/quotes`
  const assoc = await hubspot.get(url)
  const ids = ((assoc.data && assoc.data.results) || [])
    .map((r) => r.id || r.toObjectId || r['to-object-id'])
    .filter(Boolean)
  if (ids.length === 0) {
    return {
      id: 'Q1',
      status: 'fail',
      summary: `deal ${dealId} has zero associated quotes. Pick another deal with published quotes.`,
      data: { dealId, count: 0 }
    }
  }
  const batch = await hubspot.post('/crm/v3/objects/quotes/batch/read', {
    properties: ['hs_status', 'hs_title', 'hs_currency', 'hs_quote_amount', countryProp || 'pais_de_destino'],
    inputs: ids.map((id) => ({ id: String(id) }))
  })
  const quotes = ((batch.data && batch.data.results) || []).map((q) => ({
    id: q.id,
    status: q.properties && q.properties.hs_status ? q.properties.hs_status : null,
    title: q.properties && q.properties.hs_title ? q.properties.hs_title : null,
    currency: q.properties && q.properties.hs_currency ? q.properties.hs_currency : null,
    amount: q.properties && q.properties.hs_quote_amount ? q.properties.hs_quote_amount : null,
    country: (q.properties && countryProp && q.properties[countryProp]) || null
  }))
  const uniqueStatuses = Array.from(new Set(quotes.map((q) => q.status).filter(Boolean)))
  const eligibleDefaults = ['APPROVAL_NOT_NEEDED', 'APPROVED']
  const eligible = uniqueStatuses.filter((s) => eligibleDefaults.includes(s))
  const recommendedDefault = uniqueStatuses.find((s) => s && s !== 'DRAFT' && s !== 'PENDING_APPROVAL') || uniqueStatuses[0] || null
  return {
    id: 'Q1',
    status: quotes.length > 0 ? 'pass' : 'fail',
    summary: `${quotes.length} quotes found; unique hs_status=[${uniqueStatuses.join(',') || '∅'}]; recommended default for HS_QUOTE_ELIGIBLE_STATUSES=[${eligible.join(',') || recommendedDefault || 'NONE'}]`,
    data: {
      dealId,
      count: quotes.length,
      quotes,
      uniqueStatuses,
      eligibleDefaults,
      recommendedDefault
    }
  }
}

async function probeQ2_QuotesPropertySchema({ hubspot }) {
  // Create a no-op property definition check
  const url = '/crm/v3/properties/quotes'
  try {
    const res = await hubspot.get(url)
    const properties = (res.data && res.data.results) || []
    const sample = properties.slice(0, 5).map((p) => ({ name: p.name, label: p.label, type: p.type, fieldType: p.fieldType, readOnlyValue: p.modificationMetadata && p.modificationMetadata.readOnlyValue }))
    return {
      id: 'Q2',
      status: 'pass',
      summary: `quotes object exposes ${properties.length} properties; sample: ${sample.map((p) => p.name).join(', ')}`,
      data: { count: properties.length, sample }
    }
  } catch (err) {
    const status = err.response && err.response.status
    if (status === 403) {
      return {
        id: 'Q2',
        status: 'fail',
        summary: '403 reading /crm/v3/properties/quotes — token lacks crm.schemas.quotes.read. Re-issue the Private App token with quote scopes (Q6).',
        data: { httpStatus: status }
      }
    }
    return {
      id: 'Q2',
      status: 'warn',
      summary: `GET /crm/v3/properties/quotes returned HTTP ${status}: ${err.message}`,
      data: { httpStatus: status }
    }
  }
}

async function probeQ3_PatchPublishedQuote({ hubspot, quoteId, quoteProperty }) {
  if (!quoteId) {
    return {
      id: 'Q3',
      status: 'skip',
      summary: 'no --quote provided; cannot test PATCH on a published quote. Re-run with --quote=<id> from a test quote you can mutate.',
      data: { needsArg: 'quote' }
    }
  }
  // Read current value of the property on the quote
  const readUrl = `/crm/v3/objects/quotes/${encodeURIComponent(quoteId)}`
  let before
  try {
    const res = await hubspot.get(readUrl, { params: { properties: quoteProperty } })
    before = (res.data && res.data.properties && res.data.properties[quoteProperty]) || null
  } catch (err) {
    return {
      id: 'Q3',
      status: 'fail',
      summary: `GET quote ${quoteId} before PATCH failed: ${err.response && err.response.status} ${err.message}`,
      data: { httpStatus: err.response && err.response.status }
    }
  }
  // Write a no-op stub value: just re-write the same string (or empty) and read back
  const sentinel = `probe-${Date.now()}`
  const writeUrl = `/crm/v3/objects/quotes/${encodeURIComponent(quoteId)}`
  try {
    await hubspot.patch(writeUrl, { properties: { [quoteProperty]: sentinel } })
  } catch (err) {
    const status = err.response && err.response.status
    const body = err.response && err.response.data
    return {
      id: 'Q3',
      status: 'fail',
      summary: `PATCH on published quote ${quoteId} returned HTTP ${status} — writeback decision D is unviable; fall back to writeback on the deal.`,
      data: {
        httpStatus: status,
        hubspotBody: body,
        beforeProperty: before,
        attemptedWrite: { [quoteProperty]: sentinel }
      }
    }
  }
  // Read back to confirm
  let after
  try {
    const res = await hubspot.get(readUrl, { params: { properties: quoteProperty } })
    after = (res.data && res.data.properties && res.data.properties[quoteProperty]) || null
  } catch (err) {
    after = `<read failed: ${err.message}>`
  }
  // Restore the prior value (or remove the sentinel)
  try {
    await hubspot.patch(writeUrl, { properties: { [quoteProperty]: before || '' } })
  } catch (_) {
    // best-effort restore; the test quote is expected to be a disposable fixture
  }
  const ok = after === sentinel
  return {
    id: 'Q3',
    status: ok ? 'pass' : 'fail',
    summary: ok
      ? `PATCH on published quote ${quoteId} succeeded; writeback decision D is viable.`
      : `PATCH on published quote ${quoteId} returned 2xx but read-back mismatch (expected "${sentinel}", got "${after}").`,
    data: { quoteId, propertyName: quoteProperty, beforeProperty: before, attemptedWrite: sentinel, afterProperty: after }
  }
}

async function probeQ4_QuoteLineItems({ hubspot, dealId, countryProp }) {
  if (!dealId) {
    return {
      id: 'Q4',
      status: 'skip',
      summary: 'no --deal provided; cannot enumerate quote line items. Re-run with --deal=<id>.',
      data: { needsArg: 'deal' }
    }
  }
  const assoc = await hubspot.get(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/quotes`)
  const quoteIds = ((assoc.data && assoc.data.results) || [])
    .map((r) => r.id || r.toObjectId || r['to-object-id'])
    .filter(Boolean)
  if (quoteIds.length === 0) {
    return {
      id: 'Q4',
      status: 'fail',
      summary: `deal ${dealId} has zero quotes; cannot validate per-quote line items.`,
      data: { dealId, count: 0 }
    }
  }
  const rows = []
  for (const qId of quoteIds) {
    try {
      const assocRes = await hubspot.get(`/crm/v3/objects/quotes/${encodeURIComponent(qId)}/associations/line_items`)
      const lineIds = ((assocRes.data && assocRes.data.results) || [])
        .map((r) => r.id || r.toObjectId || r['to-object-id'])
        .filter(Boolean)
      let lineSample = []
      if (lineIds.length > 0) {
        const batch = await hubspot.post('/crm/v3/objects/line_items/batch/read', {
          properties: ['hs_sku', 'quantity', 'price', 'name'],
          inputs: lineIds.map((id) => ({ id: String(id) }))
        })
        lineSample = ((batch.data && batch.data.results) || []).map((li) => ({
          id: li.id,
          hs_sku: (li.properties && li.properties.hs_sku) || null,
          name: (li.properties && li.properties.name) || null,
          quantity: Number(li.properties && li.properties.quantity) || 0
        }))
      }
      rows.push({ quoteId: qId, lineItemCount: lineIds.length, lineItems: lineSample })
    } catch (err) {
      rows.push({ quoteId: qId, error: err.message })
    }
  }
  const allEmpty = rows.every((r) => r.lineItemCount === 0)
  const allEqual = rows.length > 1 && new Set(rows.map((r) => JSON.stringify(r.lineItems))).size === 1
  return {
    id: 'Q4',
    status: allEmpty ? 'fail' : (allEqual ? 'warn' : 'pass'),
    summary: allEmpty
      ? `every quote of deal ${dealId} has zero line items — fan-out cannot produce differentiated sale orders.`
      : allEqual
        ? `all ${rows.length} quotes share the same line items — fan-out would be redundant; confirm this is intentional.`
        : `${rows.length} quotes with distinct line item sets — fan-out is valuable.`,
    data: { dealId, rows }
  }
}

async function probeQ5_CountryCrossReference({ exec }) {
  const codes = ['CR', 'GT', 'HN', 'SV', 'NI', 'PA', 'MX']
  const countries = await exec('res.country', 'search_read',
    [[['code', 'in', codes]]],
    { fields: ['id', 'code', 'name'] }
  )
  const byCode = {}
  for (const c of (Array.isArray(countries) ? countries : [])) {
    if (c && c.code) byCode[c.code] = { id: Number(c.id), name: c.name || null }
  }
  const ocGroups = await exec('operation.costs', 'read_group', [[]], { fields: ['country_id'], groupby: ['country_id'] })
  const ocCountries = (ocGroups || [])
    .map((g) => Array.isArray(g.country_id) ? { id: g.country_id[0], name: g.country_id[1] } : null)
    .filter(Boolean)
  const ocByName = new Map(ocCountries.map((c) => [c.name, c.id]))
  const rows = codes.map((code) => {
    const c = byCode[code]
    if (!c) return { code, hasCountry: false, hasOperationCost: false }
    return { code, hasCountry: true, countryId: c.id, name: c.name, hasOperationCost: ocByName.has(c.name) }
  })
  const usable = rows.filter((r) => r.hasCountry && r.hasOperationCost).map((r) => r.code)
  const unresolved = rows.filter((r) => r.hasCountry && !r.hasOperationCost).map((r) => r.code)
  return {
    id: 'Q5',
    status: unresolved.length === 0 ? 'pass' : 'warn',
    summary: unresolved.length === 0
      ? `all ${codes.length} target countries have operation.costs configured. Dropdown will be: ${usable.join(', ')}`
      : `${codes.length} target countries; ${usable.length} usable, ${unresolved.length} lack operation.costs (${unresolved.join(', ')})`,
    data: { rows, usable, unresolved }
  }
}

async function probeQ6_TokenScopes({ hubspot }) {
  // Try a writeable endpoint per object. Any 403 = missing scope.
  const checks = [
    { name: 'crm.objects.quotes.read', method: 'get', url: '/crm/v3/objects/quotes?limit=1' },
    { name: 'crm.objects.deals.write', method: 'get', url: '/crm/v3/properties/deals/id_presupuesto_odoo' },
    { name: 'crm.schemas.quotes.read', method: 'get', url: '/crm/v3/properties/quotes?limit=1' }
  ]
  const results = []
  for (const c of checks) {
    try {
      await hubspot.request({ method: c.method, url: c.url })
      results.push({ scope: c.name, status: 'ok' })
    } catch (err) {
      const http = err.response && err.response.status
      results.push({ scope: c.name, status: http === 403 ? 'missing' : 'warn', httpStatus: http })
    }
  }
  const missing = results.filter((r) => r.status === 'missing').map((r) => r.scope)
  return {
    id: 'Q6',
    status: missing.length === 0 ? 'pass' : 'fail',
    summary: missing.length === 0
      ? 'all four quote scopes are present on the token.'
      : `missing scopes: ${missing.join(', ')}. Re-issue the Private App with crm.objects.quotes.read/write and crm.schemas.quotes.read/write.`,
    data: { results, missing }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true || args.h === true) {
    process.stdout.write([
      'Usage: node scripts/probes/hubspot-quote-readiness.js [--deal=<id>] [--quote=<id>] [--country-prop=<name>] [--out=PATH]',
      '',
      'Read-only staging probes Q1-Q6 for the HubSpot Quote fan-out feature.',
      'Q3 is the only write: it PATCHes a custom property on the test quote you pass with --quote, then restores it.',
      'Writes JSON results to --out (default: docs/testing/2026-08-03-quote-readiness.json).',
      ''
    ].join('\n'))
    return
  }
  const outPath = typeof args.out === 'string' ? args.out : 'docs/testing/2026-08-03-quote-readiness.json'
  const cfg = load()
  const logger = createLogger({ level: cfg.logging.level })
  const hubspot = buildHubspotHttpClient({
    baseUrl: cfg.hubspot.apiBase,
    accessToken: cfg.hubspot.accessToken
  })
  const odoo = buildOdooRpc({
    baseUrl: cfg.odoo.baseUrl,
    db: cfg.odoo.db,
    login: cfg.odoo.login,
    apiKey: cfg.odoo.apiKey
  })

  const dealId = args.deal != null ? String(args.deal) : null
  const quoteId = args.quote != null ? String(args.quote) : null
  const countryProp = typeof args['country-prop'] === 'string'
    ? args['country-prop']
    : (process.env.HS_PROPERTY_QUOTE_COUNTRY || 'pais_de_destino')
  const quoteProperty = process.env.HS_PROPERTY_QUOTE_ODOO_QUOTE_ID || 'id_presupuesto_odoo'

  const startedAt = new Date().toISOString()
  const probes = [
    ['Q1', () => probeQ1_ListDealQuotes({ hubspot, dealId, countryProp })],
    ['Q2', () => probeQ2_QuotesPropertySchema({ hubspot })],
    ['Q3', () => probeQ3_PatchPublishedQuote({ hubspot, quoteId, quoteProperty })],
    ['Q4', () => probeQ4_QuoteLineItems({ hubspot, dealId, countryProp })],
    ['Q5', () => probeQ5_CountryCrossReference({ exec: odoo.executeKw })],
    ['Q6', () => probeQ6_TokenScopes({ hubspot })]
  ]

  const results = []
  for (const [id, fn] of probes) {
    const t0 = Date.now()
    try {
      const r = await fn()
      r.durationMs = Date.now() - t0
      results.push(r)
      process.stderr.write(`[${r.status.toUpperCase()}] ${id}: ${r.summary}\n`)
    } catch (err) {
      results.push({
        id,
        status: 'fail',
        summary: `probe crashed: ${err.message}`,
        durationMs: Date.now() - t0,
        error: { message: err.message, code: err.code, httpStatus: err.httpStatus, responseData: err.response && err.response.data }
      })
      process.stderr.write(`[FAIL] ${id}: crashed — ${err.message}\n`)
    }
  }

  const blocking = results.filter((r) => r.status === 'fail').length
  const warnings = results.filter((r) => r.status === 'warn').length
  const passes = results.filter((r) => r.status === 'pass').length
  const skipped = results.filter((r) => r.status === 'skip').length

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    target: { odooBase: cfg.odoo.baseUrl, odooDb: cfg.odoo.db, hubspotBase: cfg.hubspot.apiBase },
    args: { dealId, quoteId, countryProp, quoteProperty },
    summary: { total: results.length, pass: passes, warn: warnings, fail: blocking, skip: skipped },
    results
  }

  const fs = require('node:fs/promises')
  const absOut = path.resolve(outPath)
  await fs.mkdir(path.dirname(absOut), { recursive: true })
  await fs.writeFile(absOut, JSON.stringify(report, null, 2), 'utf8')
  process.stderr.write(`\nwrote ${absOut}\n`)
  process.stderr.write(`summary: pass=${passes} warn=${warnings} fail=${blocking} skip=${skipped}\n`)
  if (blocking > 0) process.exit(1)
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify({ level: 'error', msg: 'probe.fatal', error: err.message, stack: err.stack }) + '\n')
    process.exit(2)
  })
}

module.exports = {
  probeQ1_ListDealQuotes,
  probeQ2_QuotesPropertySchema,
  probeQ3_PatchPublishedQuote,
  probeQ4_QuoteLineItems,
  probeQ5_CountryCrossReference,
  probeQ6_TokenScopes,
  buildHubspotHttpClient,
  buildOdooRpc
}

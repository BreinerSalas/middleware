#!/usr/bin/env node
'use strict'

/**
 * Read-only staging probes for the country_expense feature.
 * Implements P1-P7 from docs/plan-presupuesto-pais-y-mo.md.
 *
 * NEVER writes to Odoo or HubSpot. Only reads.
 * Run: node scripts/probes/odoo-quote-readiness.js [--out=docs/testing/2026-07-31-probe-results.json]
 */

const path = require('node:path')
const axios = require('axios')
const { load } = require('../../src/config')
const { createLogger } = require('../../src/lib/logger')
const { parseArgs } = require('../sync-products.lib')

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

async function probeP1_FieldsGetCountryExpense(exec, logger) {
  // sale.order.fields_get(['country_expense']) — determines if settable via RPC
  const fields = await exec('sale.order', 'fields_get', [['country_expense']])
  const f = fields && fields.country_expense
  if (!f) {
    return { id: 'P1', status: 'fail', summary: 'country_expense field not found on sale.order', data: { fields } }
  }
  const settable = f.readonly !== true
  const computed = typeof f.compute === 'string' && f.compute.length > 0
  const hasInverse = f.inverse === true || (typeof f.inverse === 'string' && f.inverse.length > 0)
  return {
    id: 'P1',
    status: settable ? 'pass' : 'fail',
    summary: settable
      ? `country_expense is writable (readonly=${f.readonly}, compute=${f.compute || 'none'})`
      : `country_expense is readonly; feature is a no-op via RPC. design changes.`,
    data: {
      type: f.type,
      readonly: f.readonly === true,
      required: f.required === true,
      compute: f.compute || null,
      related: f.related || null,
      store: f.store,
      hasInverse,
      help: f.help || null,
      string: f.string || null
    }
  }
}

async function probeP2_OperationCostsPerCountry(exec) {
  // operation.costs.read_group([], ['country_id'], ['country_id']) — 1:1 vs 1:N
  const groups = await exec('operation.costs', 'read_group', [[]], { fields: ['country_id'], groupby: ['country_id'] })
  const perCountry = (groups || []).map((g) => ({
    countryId: Array.isArray(g.country_id) ? g.country_id[0] : (g.country_id || null),
    countryName: Array.isArray(g.country_id) ? g.country_id[1] : null,
    count: g.country_id_count || g.__count || 0
  }))
  const multiCountry = perCountry.filter((g) => g.count > 1)
  const nullCount = perCountry.find((g) => g.countryId === false)?.count || 0
  return {
    id: 'P2',
    status: multiCountry.length === 0 ? 'pass' : 'warn',
    summary: `${perCountry.length} country buckets; ${multiCountry.length} have >1 record; ${nullCount} records with no country`,
    data: { totalCountries: perCountry.length, multiCountryCount: multiCountry.length, nullCountryCount: nullCount, perCountry }
  }
}

async function probeP3_AmbiguityCheck(exec) {
  // For each country with >1 record: are the numeric params equal? Is there a generic (product_id=false)?
  const groups = await exec('operation.costs', 'read_group', [[]], { fields: ['country_id'], groupby: ['country_id'] })
  const multi = (groups || []).filter((g) => Array.isArray(g.country_id) && (g.country_id_count || g.__count || 0) > 1)
  const ambiguous = []
  for (const g of multi) {
    const countryId = Array.isArray(g.country_id) ? g.country_id[0] : null
    const records = await exec('operation.costs', 'search_read', [[['country_id', '=', countryId]]],
      { fields: ['id', 'name', 'country_id', 'product_id', 'dai', 'iva', 'insurance', 'financing'] })
    const numericKeys = ['dai', 'iva', 'insurance', 'financing']
    const generic = records.find((r) => !r.product_id || r.product_id === false)
    const allNumericEqual = numericKeys.every((k) => {
      const values = new Set(records.map((r) => JSON.stringify(r[k] ?? null)))
      return values.size === 1
    })
    ambiguous.push({
      countryId,
      countryName: Array.isArray(g.country_id) ? g.country_id[1] : null,
      recordCount: records.length,
      hasGeneric: !!generic,
      genericId: generic ? generic.id : null,
      numericParamsEqual: allNumericEqual,
      sample: records.slice(0, 3).map((r) => ({ id: r.id, name: r.name, product_id: r.product_id }))
    })
  }
  const needsEscalation = ambiguous.some((c) => !c.hasGeneric && !c.numericParamsEqual)
  return {
    id: 'P3',
    status: needsEscalation ? 'fail' : (ambiguous.length > 0 ? 'warn' : 'pass'),
    summary: needsEscalation
      ? 'one or more countries have multiple records with divergent params and no generic — STOP and ask'
      : (ambiguous.length === 0
          ? 'no country has >1 record; ambiguity policy not exercised'
          : `${ambiguous.length} ambiguous countries, all either have a generic record or share numeric params`),
    data: { countries: ambiguous }
  }
}

async function probeP4_PartnerCountryWalk(exec, logger) {
  // res.partner: count without country_id; read country_id, parent_id from partners of our 9 existing SO partners
  const missingCountry = await exec('res.partner', 'search_count', [[['country_id', '=', false]]])
  const totalPartners = await exec('res.partner', 'search_count', [[]])
  // Find partners associated with recent sale.order rows that have origin like 'hs:%'
  const orders = await exec('sale.order', 'search_read', [[['origin', '=like', 'hs:%']]],
    { fields: ['id', 'name', 'partner_id'], limit: 25, order: 'id desc' })
  const partnerIds = [...new Set(orders.map((o) => Array.isArray(o.partner_id) ? o.partner_id[0] : null).filter(Boolean))]
  const partners = partnerIds.length > 0
    ? await exec('res.partner', 'read', [partnerIds], { fields: ['id', 'name', 'country_id', 'parent_id', 'commercial_partner_id'] })
    : []
  const childWithoutCountry = partners.filter((p) => !p.country_id || p.country_id === false).length
  const needsWalk = childWithoutCountry > 0
  return {
    id: 'P4',
    status: needsWalk ? 'warn' : 'pass',
    summary: needsWalk
      ? `${childWithoutCountry}/${partners.length} recent-deal partners lack country_id; may need parent_id walk`
      : `all ${partners.length} recent-deal partners have country_id directly`,
    data: { totalPartners, partnersWithoutCountry: missingCountry, recentDeals: orders.length, partnersChecked: partners.length, childWithoutCountry }
  }
}

async function probeP5_CountrySetDiff(exec) {
  // Countries in operation.costs vs countries on partners with sales
  const ocGroups = await exec('operation.costs', 'read_group', [[]], { fields: ['country_id'], groupby: ['country_id'] })
  const ocCountries = new Set(
    (ocGroups || [])
      .map((g) => Array.isArray(g.country_id) ? g.country_id[1] : null)
      .filter(Boolean)
  )
  const orderRows = await exec('sale.order', 'search_read', [[['origin', '=like', 'hs:%']]],
    { fields: ['partner_id'], limit: 500 })
  const partnerIds = [...new Set(orderRows.map((o) => Array.isArray(o.partner_id) ? o.partner_id[0] : null).filter(Boolean))]
  const partners = partnerIds.length > 0
    ? await exec('res.partner', 'read', [partnerIds], { fields: ['id', 'country_id'] })
    : []
  const partnerCountries = new Set(
    partners.map((p) => Array.isArray(p.country_id) ? p.country_id[1] : null).filter(Boolean)
  )
  const inPartnersNotInOC = [...partnerCountries].filter((c) => !ocCountries.has(c))
  const inOCNotInPartners = [...ocCountries].filter((c) => !partnerCountries.has(c))
  return {
    id: 'P5',
    status: inPartnersNotInOC.length > 0 ? 'warn' : 'pass',
    summary: inPartnersNotInOC.length > 0
      ? `${inPartnersNotInOC.length} countries appear on partners but not in operation.costs: ${inPartnersNotInOC.slice(0, 10).join(', ')}`
      : 'every partner country has a matching operation.costs record',
    data: {
      ocCountries: [...ocCountries].sort(),
      partnerCountries: [...partnerCountries].sort(),
      inPartnersNotInOC,
      inOCNotInPartners
    }
  }
}

async function probeP6_MultiLineMOCount(exec) {
  // For each historical confirmed SO with origin hs:%, count its mrp.production by origin contains so.name
  const orders = await exec('sale.order', 'search_read', [[['origin', '=like', 'hs:%'], ['state', 'in', ['sale', 'done']]]],
    { fields: ['id', 'name', 'order_line'], limit: 50, order: 'id desc' })
  const rows = []
  for (const so of orders) {
    // Count order_line entries: tuple commands need read on sale.order.line
    const lineIds = Array.isArray(so.order_line) ? so.order_line.map((x) => Array.isArray(x) ? x[0] : x).filter(Boolean) : []
    const moCount = await exec('mrp.production', 'search_count', [[['origin', '=', so.name]]])
    rows.push({ soName: so.name, lineCount: lineIds.length, moCount })
  }
  const mismatches = rows.filter((r) => r.lineCount > 0 && r.moCount !== r.lineCount)
  return {
    id: 'P6',
    status: mismatches.length > 0 ? 'warn' : (rows.length === 0 ? 'skip' : 'pass'),
    summary: rows.length === 0
      ? 'no confirmed historical SOs with origin hs:% — cannot validate multi-line premise'
      : mismatches.length > 0
        ? `${mismatches.length}/${rows.length} confirmed SOs have MO count != line count`
        : `all ${rows.length} confirmed historical SOs have MO count == line count`,
    data: { rows }
  }
}

async function probeP7_HubspotQuoteProperty({ hubspot, propertyName }) {
  const url = `/crm/v3/properties/deals/${encodeURIComponent(propertyName)}`
  try {
    const res = await hubspot.get(url)
    return {
      id: 'P7',
      status: 'pass',
      summary: `HubSpot property deals/${propertyName} exists (type=${res.data && res.data.type}, fieldType=${res.data && res.data.fieldType})`,
      data: { name: res.data.name, label: res.data.label, type: res.data.type, fieldType: res.data.fieldType, groupName: res.data.groupName }
    }
  } catch (err) {
    const status = err.response && err.response.status
    return {
      id: 'P7',
      status: status === 404 ? 'fail' : 'warn',
      summary: status === 404
        ? `HubSpot property deals/${propertyName} does NOT exist — must be created before deploy (Risk 4)`
        : `HubSpot property lookup returned HTTP ${status}: ${err.message}`,
      data: { httpStatus: status }
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true || args.h === true) {
    process.stdout.write([
      'Usage: node scripts/probes/odoo-quote-readiness.js [--out=docs/testing/2026-07-31-probe-results.json]',
      '',
      'Read-only staging probes P1-P7 for the country_expense feature.',
      'Writes JSON results to --out (default: docs/testing/2026-07-31-probe-results.json).',
      ''
    ].join('\n'))
    return
  }
  const outPath = typeof args.out === 'string' ? args.out : 'docs/testing/2026-07-31-probe-results.json'
  const cfg = load()
  const logger = createLogger({ level: cfg.logging.level })
  const odoo = buildOdooRpc({
    baseUrl: cfg.odoo.baseUrl,
    db: cfg.odoo.db,
    login: cfg.odoo.login,
    apiKey: cfg.odoo.apiKey
  })
  const hubspot = axios.create({
    baseURL: cfg.hubspot.apiBase,
    timeout: 15000,
    headers: { Authorization: `Bearer ${cfg.hubspot.accessToken}` }
  })

  const startedAt = new Date().toISOString()
  const probes = [
    ['P1', () => probeP1_FieldsGetCountryExpense(odoo.executeKw, logger)],
    ['P2', () => probeP2_OperationCostsPerCountry(odoo.executeKw)],
    ['P3', () => probeP3_AmbiguityCheck(odoo.executeKw)],
    ['P4', () => probeP4_PartnerCountryWalk(odoo.executeKw, logger)],
    ['P5', () => probeP5_CountrySetDiff(odoo.executeKw)],
    ['P6', () => probeP6_MultiLineMOCount(odoo.executeKw)],
    ['P7', () => probeP7_HubspotQuoteProperty({ hubspot, propertyName: cfg.hubspot.propertyOdooQuoteId || 'id_presupuesto_odoo' })]
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
        error: { message: err.message, code: err.code, httpStatus: err.httpStatus }
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

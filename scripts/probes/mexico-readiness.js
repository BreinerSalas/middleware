#!/usr/bin/env node
'use strict'

/**
 * Read-only staging probes for the Mexico intermediary + currency-safety feature.
 * Implements X1-X11 from docs/plan-mexico.md.
 *
 * X9 is the only write to Odoo (draft SOs, cleaned up via unlink).
 * X10 is the only write to HubSpot (PATCH on a test quote you pass via --quote, restored).
 * All other probes are strictly read-only.
 *
 * Reuses buildOdooRpc / buildHubspotHttpClient exported from hubspot-quote-readiness.js
 * so we keep one canonical JSON-RPC and HTTP client shape.
 *
 * Run: node scripts/probes/mexico-readiness.js [--out=PATH]
 *      [--quote=<quoteId>] [--country-prop=<name>] [--sync-status-prop=<name>]
 *
 * Compuerta (exit 1 on any fail): X1, X2, X3, X7, X9, X11.
 * Tolerated as warnings (do not trigger exit 1): X5, X6.
 * X4 / X8 / X10 failures also trigger exit 1 (default behavior of the probe runner).
 */

const path = require('node:path')
const { load } = require('../../src/config')
const { createLogger } = require('../../src/lib/logger')
const { parseArgs } = require('../sync-products.lib')
const { buildOdooRpc, buildHubspotHttpClient } = require('./hubspot-quote-readiness')

const REQUIRED_PROBE_IDS = ['X1', 'X2', 'X3', 'X7', 'X9', 'X11']
const WARN_TOLERATED_PROBE_IDS = ['X5', 'X6']

const PROBE_TAG = 'probe:mx:'

function isFatalFailure(result) {
  if (result.status !== 'fail') return false
  if (WARN_TOLERATED_PROBE_IDS.includes(result.id)) return false
  return true
}

async function probeX1_HubspotCurrencySurface({ hubspot }) {
  const accountUrl = '/account-info/v3/details'
  const propsUrl = '/crm/v3/properties/quotes/hs_currency'
  const accountRes = await hubspot.get(accountUrl)
  const accountBody = (accountRes && accountRes.data) || {}
  const companyCurrency = accountBody.companyCurrency || accountBody.currency || null
  const portalPortalId = accountBody.portalId || accountBody.hubId || null

  const propRes = await hubspot.get(propsUrl)
  const propBody = (propRes && propRes.data) || {}
  const options = Array.isArray(propBody.options)
    ? propBody.options.map((o) => ({ value: o.value, label: o.label, displayOrder: o.displayOrder, hidden: o.hidden }))
    : []
  const activeOptions = options.filter((o) => !o.hidden).map((o) => o.value)
  const fieldType = propBody.fieldType || null
  const type = propBody.type || null

  return {
    id: 'X1',
    status: 'pass',
    summary: `portal companyCurrency=${companyCurrency || '∅'}; hs_currency is ${type || '∅'}/${fieldType || '∅'} with ${activeOptions.length} active options (${activeOptions.slice(0, 6).join(',')}${activeOptions.length > 6 ? '…' : ''})`,
    data: {
      portalId: portalPortalId,
      companyCurrency,
      hsCurrencyProperty: { name: propBody.name, label: propBody.label, type, fieldType, optionCount: options.length, activeOptions, options }
    }
  }
}

async function probeX2_VisualMexicoPartner({ exec }) {
  const domain = [['name', 'ilike', 'visual%m%xico']]
  const rows = await exec('res.partner', 'search_read', [domain], {
    fields: ['id', 'name', 'is_company', 'parent_id', 'country_id', 'company_id', 'property_product_pricelist', 'customer_rank']
  })
  const partners = (Array.isArray(rows) ? rows : []).map((r) => ({
    id: Number(r.id),
    name: r.name || null,
    isCompany: r.is_company === true,
    parentId: Array.isArray(r.parent_id) ? { id: r.parent_id[0], name: r.parent_id[1] } : null,
    countryId: Array.isArray(r.country_id) ? { id: r.country_id[0], name: r.country_id[1] } : null,
    companyId: Array.isArray(r.company_id) ? { id: r.company_id[0], name: r.company_id[1] } : null,
    pricelistId: Array.isArray(r.property_product_pricelist) ? { id: r.property_product_pricelist[0], name: r.property_product_pricelist[1] } : (r.property_product_pricelist ? Number(r.property_product_pricelist) : null),
    customerRank: Number(r.customer_rank || 0)
  }))
  const candidates = partners.filter((p) => p.isCompany && p.customerRank > 0)
  if (partners.length === 0) {
    return {
      id: 'X2',
      status: 'fail',
      summary: "no res.partner matches name ilike 'visual%m%xico'. Confirm the intermediary exists with the expected naming before continuing.",
      data: { matchCount: 0, partners }
    }
  }
  if (candidates.length === 0) {
    return {
      id: 'X2',
      status: 'fail',
      summary: `${partners.length} partner(s) match the name pattern but none is_company=true with customer_rank>0. Verify visual México is registered as a company-type customer.`,
      data: { matchCount: partners.length, partners }
    }
  }
  if (candidates.length > 1) {
    return {
      id: 'X2',
      status: 'warn',
      summary: `${candidates.length} candidates match; pick exactly one id for ODOO_COUNTRY_PARTNER_OVERRIDES. They differ in pricelist/parent — manual disambiguation required.`,
      data: { matchCount: candidates.length, partners }
    }
  }
  const c = candidates[0]
  return {
    id: 'X2',
    status: 'pass',
    summary: `visual México = res.partner id=${c.id} name="${c.name}"; pricelist=${c.pricelistId ? `${c.pricelistId.id} (${c.pricelistId.name})` : '∅'}; country=${c.countryId ? c.countryId.name : '∅'}`,
    data: { matchCount: partners.length, candidate: c, partners }
  }
}

async function probeX3_VisualMexicoCompany({ exec }) {
  const companies = await exec('res.company', 'search_read', [[]], { fields: ['id', 'name', 'currency_id', 'country_id'] })
  const companyRows = (Array.isArray(companies) ? companies : []).map((c) => ({
    id: Number(c.id),
    name: c.name || null,
    currencyId: Array.isArray(c.currency_id) ? { id: c.currency_id[0], name: c.currency_id[1] } : null,
    countryId: Array.isArray(c.country_id) ? { id: c.country_id[0], name: c.country_id[1] } : null
  }))

  let userRow = null
  let uid = null
  let userError = null
  try {
    uid = await exec('res.users', 'search_read', [[['login', '!=', false]]], { fields: ['id'], limit: 1 }).then((rows) => (Array.isArray(rows) && rows[0] ? Number(rows[0].id) : null))
    if (uid != null) {
      const me = await exec('res.users', 'read', [[uid]], { fields: ['id', 'name', 'login', 'company_id', 'company_ids'] })
      const u = (Array.isArray(me) && me[0]) || null
      if (u) {
        userRow = {
          id: Number(u.id),
          name: u.name || null,
          login: u.login || null,
          companyId: Array.isArray(u.company_id) ? { id: u.company_id[0], name: u.company_id[1] } : null,
          companyIds: Array.isArray(u.company_ids) ? u.company_ids.map((c) => Array.isArray(c) ? { id: c[0], name: c[1] } : Number(c)) : []
        }
      }
    }
  } catch (err) {
    userError = err.message
  }

  const mexicoCompanies = companyRows.filter((c) => /m[eé]xico/i.test(c.name || ''))
  const isSeparateCompany = mexicoCompanies.length > 0
  if (isSeparateCompany) {
    return {
      id: 'X3',
      status: 'fail',
      summary: `visual México appears to be a res.company (${mexicoCompanies.length} match: ${mexicoCompanies.map((c) => c.name).join(', ')}). The lever changes to company_id; replan Phase 3 instead of proceeding.`,
      data: { companyCount: companyRows.length, mexicoCompanies, currentUser: userRow, userError, halt: true }
    }
  }
  return {
    id: 'X3',
    status: 'pass',
    summary: `no res.company name matches México (${companyRows.length} companies total). visual México is a res.partner — partner_id is the right lever.`,
    data: { companyCount: companyRows.length, mexicoCompanies, currentUser: userRow, userError }
  }
}

async function probeX4_MexicoResolution({ exec }) {
  const countries = await exec('res.country', 'search_read', [[['code', '=', 'MX']]], { fields: ['id', 'name', 'code'] })
  const mx = (Array.isArray(countries) && countries[0]) ? { id: Number(countries[0].id), name: countries[0].name, code: countries[0].code } : null

  const ocGroups = await exec('operation.costs', 'read_group', [[]], { fields: ['country_id'], groupby: ['country_id'] })
  const ocMx = (ocGroups || [])
    .filter((g) => Array.isArray(g.country_id) && /m[eé]xico/i.test(g.country_id[1] || ''))
    .map((g) => ({ countryId: g.country_id[0], countryName: g.country_id[1], count: g.country_id_count || g.__count || 0 }))

  const partnerDomain = [['name', 'ilike', 'visual%m%xico']]
  const partners = await exec('res.partner', 'search_read', [partnerDomain], { fields: ['id', 'name', 'country_id', 'parent_id', 'company_id'] })
  const chain = []
  for (const p of (Array.isArray(partners) ? partners : [])) {
    const visited = new Set()
    let current = { id: Number(p.id), name: p.name, countryId: Array.isArray(p.country_id) ? { id: p.country_id[0], name: p.country_id[1] } : null, parentId: Array.isArray(p.parent_id) ? p.parent_id[0] : null }
    while (current && current.parentId && !visited.has(current.parentId)) {
      visited.add(current.parentId)
      const [parent] = await exec('res.partner', 'read', [[current.parentId]], { fields: ['id', 'name', 'country_id', 'parent_id'] })
      if (!parent) break
      current = {
        id: Number(parent.id),
        name: parent.name,
        countryId: Array.isArray(parent.country_id) ? { id: parent.country_id[0], name: parent.country_id[1] } : null,
        parentId: Array.isArray(parent.parent_id) ? parent.parent_id[0] : null
      }
      chain.push(current)
    }
  }
  const naiveOverrideWouldResolve = chain.some((c) => c.countryId && /costa rica|m[eé]xico/i.test(c.countryId.name || '')) && chain.some((c) => c.countryId && /costa rica/i.test(c.countryId.name || ''))
  return {
    id: 'X4',
    status: mx && ocMx.length > 0 ? 'pass' : 'warn',
    summary: mx
      ? `MX resolves to res.country id=${mx.id}; operation.costs has ${ocMx.length} Mexico bucket(s); partner chain length=${chain.length}; naive-override misroute risk=${naiveOverrideWouldResolve ? 'YES' : 'no'}`
      : "res.country with code='MX' not found — ISO lookup will fall back to parent walk",
    data: { mxCountry: mx, operationCostsMx: ocMx, parentChain: chain, naiveOverrideMisrouteRisk: naiveOverrideWouldResolve }
  }
}

async function probeX5_Pricelists({ exec }) {
  const lists = await exec('product.pricelist', 'search_read', [[]], {
    fields: ['id', 'name', 'currency_id', 'company_id', 'active'],
    context: { active_test: false }
  })
  const rows = (Array.isArray(lists) ? lists : []).map((p) => ({
    id: Number(p.id),
    name: p.name || null,
    currencyId: Array.isArray(p.currency_id) ? { id: p.currency_id[0], name: p.currency_id[1] } : null,
    companyId: Array.isArray(p.company_id) ? { id: p.company_id[0], name: p.company_id[1] } : null,
    active: p.active !== false
  }))
  const byCurrency = new Map()
  for (const r of rows) {
    const code = r.currencyId ? r.currencyId.name : '∅'
    if (!byCurrency.has(code)) byCurrency.set(code, [])
    byCurrency.get(code).push(r)
  }
  const crossCompany = rows.filter((r) => r.companyId === null).length
  const inactive = rows.filter((r) => !r.active).length
  const hasMxn = (byCurrency.get('MXN') || []).length > 0
  return {
    id: 'X5',
    status: hasMxn ? 'pass' : 'warn',
    summary: `${rows.length} pricelists; ${inactive} inactive; ${crossCompany} cross-company (no company_id); MXN pricelists: ${(byCurrency.get('MXN') || []).length}`,
    data: { total: rows.length, inactive, crossCompany, hasMxn, byCurrency: Object.fromEntries(byCurrency), sample: rows.slice(0, 5) }
  }
}

async function probeX6_Currencies({ exec }) {
  const wanted = ['USD', 'CRC', 'GTQ', 'HNL', 'NIO', 'MXN', 'PAB']
  const rows = await exec('res.currency', 'search_read', [[['name', 'in', wanted]]], {
    fields: ['id', 'name', 'active', 'rounding', 'symbol'],
    context: { active_test: false }
  })
  const map = new Map()
  for (const r of (Array.isArray(rows) ? rows : [])) map.set(r.name, r)
  const present = wanted.map((code) => {
    const c = map.get(code)
    if (!c) return { code, present: false }
    return {
      code,
      present: true,
      id: Number(c.id),
      active: c.active !== false,
      rounding: c.rounding != null ? Number(c.rounding) : null,
      symbol: c.symbol || null
    }
  })
  const missing = present.filter((p) => !p.present).map((p) => p.code)
  const archived = present.filter((p) => p.present && !p.active).map((p) => p.code)
  const coarseRounding = present.filter((p) => p.present && p.active && p.rounding != null && p.rounding >= 1).map((p) => p.code)
  if (missing.length > 0) {
    return {
      id: 'X6',
      status: 'warn',
      summary: `${missing.length} target currencies not in res.currency (even with active_test:false): ${missing.join(', ')}. They may not have been installed.`,
      data: { present, missing, archived, coarseRounding }
    }
  }
  if (archived.length > 0 || coarseRounding.length > 0) {
    return {
      id: 'X6',
      status: 'warn',
      summary: `currencies present; archived=[${archived.join(',') || '∅'}]; coarse-rounding (≥1)=[${coarseRounding.join(',') || '∅'}]. Active fine-rounding currencies safe to use.`,
      data: { present, missing, archived, coarseRounding }
    }
  }
  return {
    id: 'X6',
    status: 'pass',
    summary: `all ${wanted.length} target currencies present, active, rounding<1. Currency compare/decision can proceed.`,
    data: { present, missing, archived, coarseRounding }
  }
}

async function probeX7_SaleOrderCurrencyMisalignment({ exec, hubspot, dealId }) {
  if (!dealId) {
    return {
      id: 'X7',
      status: 'skip',
      summary: 'no --deal provided; cannot cross-check sale.order currency with quote hs_currency. Re-run with --deal=<id> from a deal with hs:% origins.',
      data: { needsArg: 'deal' }
    }
  }
  const orders = await exec('sale.order', 'search_read', [[['origin', '=like', 'hs:%']]], {
    fields: ['id', 'name', 'origin', 'partner_id', 'pricelist_id', 'currency_id', 'amount_total', 'state'],
    limit: 100,
    order: 'id desc'
  })
  const rows = (Array.isArray(orders) ? orders : []).map((o) => ({
    id: Number(o.id),
    name: o.name,
    origin: o.origin,
    state: o.state,
    partnerId: Array.isArray(o.partner_id) ? o.partner_id[0] : null,
    pricelistId: Array.isArray(o.pricelist_id) ? { id: o.pricelist_id[0], name: o.pricelist_id[1] } : null,
    currencyId: Array.isArray(o.currency_id) ? { id: o.currency_id[0], name: o.currency_id[1] } : null,
    amountTotal: o.amount_total != null ? Number(o.amount_total) : null
  }))
  let quotes = []
  let quotesError = null
  try {
    const assoc = await hubspot.get(`/crm/v3/objects/deals/${encodeURIComponent(dealId)}/associations/quotes`)
    const ids = ((assoc.data && assoc.data.results) || []).map((r) => r.id || r.toObjectId || r['to-object-id']).filter(Boolean)
    if (ids.length > 0) {
      const batch = await hubspot.post('/crm/v3/objects/quotes/batch/read', {
        properties: ['hs_currency'],
        inputs: ids.map((id) => ({ id: String(id) }))
      })
      quotes = ((batch.data && batch.data.results) || []).map((q) => ({
        id: q.id,
        hsCurrency: (q.properties && q.properties.hs_currency) || null
      }))
    }
  } catch (err) {
    quotesError = err.message
  }

  const misalignment = []
  for (const o of rows) {
    const match = quotes.find((q) => q.hsCurrency && o.pricelistId && q.hsCurrency === o.pricelistId.name)
    if (!match && quotes.some((q) => q.hsCurrency)) {
      const hsForThisOrigin = quotes.find((q) => q.hsCurrency)
      if (hsForThisOrigin && o.currencyId && hsForThisOrigin.hsCurrency && hsForThisOrigin.hsCurrency !== o.currencyId.name) {
        misalignment.push({ orderName: o.name, hsCurrency: hsForThisOrigin.hsCurrency, odooCurrency: o.currencyId.name, amountTotal: o.amountTotal })
      }
    }
  }
  return {
    id: 'X7',
    status: misalignment.length > 0 ? 'fail' : 'pass',
    summary: misalignment.length > 0
      ? `misalignment detected on ${misalignment.length} live order(s); the latent currency bug already fired in production — incident, not hypothesis.`
      : `${rows.length} recent hs:% orders checked; no obvious misalignment with quote hs_currency on deal ${dealId}.`,
    data: { recentOrderCount: rows.length, quoteCount: quotes.length, quotesError, misalignment, sample: rows.slice(0, 5), quotes }
  }
}

async function probeX8_SaleOrderFieldShape({ exec }) {
  const soFields = await exec('sale.order', 'fields_get', [['pricelist_id', 'currency_id', 'company_id']], { attributes: ['type', 'required', 'readonly', 'help', 'string'] })
  const lineFields = await exec('sale.order.line', 'fields_get', [['price_unit', 'discount', 'tax_id']], { attributes: ['type', 'required', 'readonly', 'digits'] })
  const required = []
  for (const [model, fields] of [['sale.order', soFields], ['sale.order.line', lineFields]]) {
    for (const [name, def] of Object.entries(fields || {})) {
      if (def && def.required === true) required.push(`${model}.${name}`)
    }
  }
  let version = null
  try {
    const v = await exec('common', 'version', [[]])
    if (v && typeof v === 'object') version = { serverVersion: v.server_version || null, serverSerie: v.server_serie || null }
  } catch (_) {
    // common/version may not be exposed; ignore
  }
  const soPricelist = soFields && soFields.pricelist_id ? { type: soFields.pricelist_id.type, required: soFields.pricelist_id.required === true, readonly: soFields.pricelist_id.readonly === true } : null
  return {
    id: 'X8',
    status: soPricelist && soPricelist.required ? 'warn' : 'pass',
    summary: soPricelist
      ? `pricelist_id on sale.order is ${soPricelist.required ? 'REQUIRED' : 'optional'} (${soPricelist.type || '∅'}); ${required.length} required field(s) across sale.order/sale.order.line; odoo ${version ? version.serverSerie || version.serverVersion || '∅' : '∅'}`
      : 'sale.order.pricelist_id not returned by fields_get — instance schema differs from expectation',
    data: { saleOrder: soFields, saleOrderLine: lineFields, requiredFields: required, version }
  }
}

async function probeX9_SaleOrderWriteExperiment({ exec, cfg, logger }) {
  const ts = Date.now()
  const probeTagA = `${PROBE_TAG}${ts}:A`
  const probeTagB = `${PROBE_TAG}${ts}:B`
  const probeTagD = `${PROBE_TAG}${ts}:D`

  const basePartnerId = cfg.odoo.defaultCustomerId ? Number(cfg.odoo.defaultCustomerId) : null
  if (!basePartnerId || Number.isNaN(basePartnerId)) {
    return {
      id: 'X9',
      status: 'fail',
      summary: 'ODOO_DEFAULT_CUSTOMER_ID is not set; cannot pick a deterministic partner_id for the create-without-pricelist arm of the experiment.',
      data: { needsEnv: 'ODOO_DEFAULT_CUSTOMER_ID' }
    }
  }

  const pricelists = await exec('product.pricelist', 'search_read', [[]], {
    fields: ['id', 'name', 'currency_id', 'company_id'],
    context: { active_test: false }
  })
  const priceListA = (Array.isArray(pricelists) ? pricelists : []).find((p) => Array.isArray(p.company_id) ? false : true) || (Array.isArray(pricelists) ? pricelists[0] : null)
  const priceListB = (Array.isArray(pricelists) ? pricelists : []).find((p) => p && priceListA && Number(p.id) !== Number(priceListA.id) && p.currency_id && priceListA.currency_id && p.currency_id[0] !== priceListA.currency_id[0]) || null

  const visualMx = await exec('res.partner', 'search_read', [[['name', 'ilike', 'visual%m%xico'], ['is_company', '=', true], ['customer_rank', '>', 0]]], {
    fields: ['id', 'name', 'property_product_pricelist']
  })
  const partnerD = (Array.isArray(visualMx) && visualMx[0]) ? { id: Number(visualMx[0].id), name: visualMx[0].name, pricelistId: Array.isArray(visualMx[0].property_product_pricelist) ? visualMx[0].property_product_pricelist[0] : null } : null

  const productId = await exec('product.product', 'search', [[]], { limit: 1 }).then((r) => (Array.isArray(r) && r[0]) ? Number(r[0]) : null)
  if (!productId) {
    return {
      id: 'X9',
      status: 'fail',
      summary: 'no product.product found; cannot create a line item for the experiment.',
      data: { productSearch: 'empty' }
    }
  }

  const created = []
  let crash = null

  try {
    // A: implicit pricelist resolution
    const aId = await exec('sale.order', 'create', [{
      origin: probeTagA,
      partner_id: basePartnerId,
      order_line: [[0, 0, { product_id: productId, product_uom_qty: 1, price_unit: 1234.56 }]]
    }])
    created.push({ tag: probeTagA, id: Number(aId) })

    // B: explicit pricelist, different currency
    if (priceListB) {
      const bId = await exec('sale.order', 'create', [{
        origin: probeTagB,
        partner_id: basePartnerId,
        pricelist_id: Number(priceListB.id),
        order_line: [[0, 0, { product_id: productId, product_uom_qty: 1, price_unit: 1234.56 }]]
      }])
      created.push({ tag: probeTagB, id: Number(bId) })
    }

    // D: partner substitution to visual México
    if (partnerD) {
      const dId = await exec('sale.order', 'create', [{
        origin: probeTagD,
        partner_id: partnerD.id,
        order_line: [[0, 0, { product_id: productId, product_uom_qty: 1, price_unit: 1234.56 }]]
      }])
      created.push({ tag: probeTagD, id: Number(dId) })
    }
  } catch (err) {
    crash = { message: err.message, code: err.code, httpStatus: err.httpStatus }
  }

  const readback = []
  for (const c of created) {
    try {
      const [row] = await exec('sale.order', 'read', [[c.id]], {
        fields: ['id', 'name', 'origin', 'partner_id', 'pricelist_id', 'currency_id', 'amount_total', 'amount_tax', 'order_line']
      })
      readback.push({
        id: c.id,
        tag: c.tag,
        partnerId: Array.isArray(row.partner_id) ? row.partner_id[0] : null,
        pricelistId: Array.isArray(row.pricelist_id) ? { id: row.pricelist_id[0], name: row.pricelist_id[1] } : null,
        currencyId: Array.isArray(row.currency_id) ? { id: row.currency_id[0], name: row.currency_id[1] } : null,
        amountTotal: row.amount_total != null ? Number(row.amount_total) : null,
        amountTax: row.amount_tax != null ? Number(row.amount_tax) : null,
        lineIds: Array.isArray(row.order_line) ? row.order_line.map((x) => Array.isArray(x) ? x[0] : x) : []
      })
    } catch (err) {
      readback.push({ id: c.id, tag: c.tag, error: err.message })
    }
  }

  let updateProbe = null
  if (created.length >= 2 && priceListA) {
    try {
      await exec('sale.order', 'write', [[created[0].id], { pricelist_id: Number(priceListA.id) }])
      const [after] = await exec('sale.order', 'read', [[created[0].id]], { fields: ['id', 'pricelist_id', 'currency_id'] })
      const onchangeVisible = after && Array.isArray(after.pricelist_id) && Number(after.pricelist_id[0]) === Number(priceListA.id)
      updateProbe = {
        attempt: { orderId: created[0].id, toPricelistId: Number(priceListA.id) },
        result: { pricelistId: Array.isArray(after.pricelist_id) ? after.pricelist_id[0] : null, currencyId: Array.isArray(after.currency_id) ? after.currency_id[1] : null },
        showUpdatePricelist: onchangeVisible
      }
    } catch (err) {
      updateProbe = { attempt: { orderId: created[0].id }, error: err.message }
    }
  }

  const lineSnapshots = []
  for (const r of readback) {
    if (r.lineIds && r.lineIds.length > 0) {
      try {
        const lines = await exec('sale.order.line', 'read', [r.lineIds], { fields: ['id', 'price_unit', 'discount', 'tax_id', 'price_subtotal'] })
        lineSnapshots.push({ orderId: r.id, tag: r.tag, lines: (Array.isArray(lines) ? lines : []).map((l) => ({ id: Number(l.id), priceUnit: Number(l.price_unit), discount: Number(l.discount || 0), taxIds: Array.isArray(l.tax_id) ? l.tax_id.map((t) => Array.isArray(t) ? t[0] : t) : [], priceSubtotal: l.price_subtotal != null ? Number(l.price_subtotal) : null })) })
      } catch (err) {
        lineSnapshots.push({ orderId: r.id, tag: r.tag, error: err.message })
      }
    }
  }

  let cleanup = null
  try {
    if (created.length > 0) {
      const ids = created.map((c) => c.id)
      await exec('sale.order', 'unlink', [ids])
    }
    const remaining = created.length > 0
      ? await exec('sale.order', 'search_count', [[['origin', '=like', `${PROBE_TAG}${ts}%`]]])
      : 0
    cleanup = { unlinked: created.length, remaining }
  } catch (err) {
    cleanup = { unlinked: 0, error: err.message }
  }

  const status = crash ? 'fail' : 'pass'
  const summary = crash
    ? `experiment crashed during create: ${crash.message}. Phase 3 lever '${priceListB ? 'pricelist_id' : '∅'}' is unverified in this instance.`
    : `A/B/D created (${created.length}), read-back OK, update arm ${updateProbe ? 'ran' : 'skipped'}, cleanup unlinked=${cleanup ? cleanup.unlinked : '∅'} remaining=${cleanup ? cleanup.remaining : '∅'}.`
  return {
    id: 'X9',
    status,
    summary,
    data: {
      tags: { A: probeTagA, B: probeTagB, D: probeTagD },
      created,
      readback,
      lineSnapshots,
      updateProbe,
      cleanup,
      crash,
      chosenPricelists: { A: priceListA ? { id: Number(priceListA.id), name: priceListA.name, currency: priceListA.currency_id ? priceListA.currency_id[1] : null } : null, B: priceListB ? { id: Number(priceListB.id), name: priceListB.name, currency: priceListB.currency_id ? priceListB.currency_id[1] : null } : null },
      partnerD
    }
  }
}

async function probeX10_QuoteEnumerationPropertyPatch({ hubspot, quoteId, syncStatusProp }) {
  const propertyName = syncStatusProp || 'estado_sync_odoo'
  const propUrl = `/crm/v3/properties/quotes/${encodeURIComponent(propertyName)}`

  let preflight
  try {
    const res = await hubspot.get(propUrl)
    preflight = {
      httpStatus: res.status,
      name: res.data && res.data.name,
      type: res.data && res.data.type,
      fieldType: res.data && res.data.fieldType,
      options: Array.isArray(res.data && res.data.options) ? res.data.options.map((o) => o.value) : [],
      alreadyExists: true
    }
    return {
      id: 'X10',
      status: 'fail',
      summary: `quotes/${propertyName} already exists (type=${preflight.type}/${preflight.fieldType}); do NOT boot the property provisioner — a stale options set would make every PATCH return 400. Reconcile manually first.`,
      data: { preflight }
    }
  } catch (err) {
    const status = err.response && err.response.status
    preflight = { httpStatus: status, alreadyExists: false }
    if (status !== 404) {
      return {
        id: 'X10',
        status: 'warn',
        summary: `preflight GET quotes/${propertyName} returned HTTP ${status}; cannot confirm a clean slate before PATCH.`,
        data: { preflight, error: err.message }
      }
    }
  }

  if (!quoteId) {
    return {
      id: 'X10',
      status: 'skip',
      summary: 'preflight confirms property does not exist (good); no --quote provided to PATCH. Re-run with --quote=<id> to exercise the enumeration write path.',
      data: { needsArg: 'quote', preflight }
    }
  }

  const writeUrl = `/crm/v3/objects/quotes/${encodeURIComponent(quoteId)}`
  const validValue = 'requiere_accion'
  const invalidValue = '__definitely_not_a_valid_option__'
  const results = {}
  let before = null
  try {
    const res = await hubspot.get(writeUrl, { params: { properties: propertyName } })
    before = (res.data && res.data.properties && res.data.properties[propertyName]) || null
  } catch (err) {
    results.beforeRead = { httpStatus: err.response && err.response.status, error: err.message }
  }

  try {
    await hubspot.patch(writeUrl, { properties: { [propertyName]: validValue } })
    results.validWrite = { ok: true, value: validValue }
  } catch (err) {
    results.validWrite = { ok: false, httpStatus: err.response && err.response.status, body: err.response && err.response.data }
  }

  try {
    await hubspot.patch(writeUrl, { properties: { [propertyName]: invalidValue } })
    results.invalidWrite = { ok: true, unexpected: 'enumeration accepted unknown value — strict validation not enforced' }
  } catch (err) {
    const s = err.response && err.response.status
    results.invalidWrite = { ok: false, httpStatus: s, expected: s === 400, body: err.response && err.response.data }
  }

  try {
    await hubspot.patch(writeUrl, { properties: { [propertyName]: before || '' } })
  } catch (_) {
    // best-effort restore
  }

  const validOk = results.validWrite && results.validWrite.ok === true
  const invalidRejected = results.invalidWrite && results.invalidWrite.ok === false && results.invalidWrite.expected === true
  return {
    id: 'X10',
    status: validOk && invalidRejected ? 'pass' : (validOk ? 'warn' : 'fail'),
    summary: validOk && invalidRejected
      ? `enumeration write OK on quote ${quoteId}: valid="${validValue}" accepted, invalid rejected with 400.`
      : validOk
        ? `valid value accepted but invalid value did NOT return 400 — enumeration is not strictly validated.`
        : `valid enumeration write failed on quote ${quoteId}; status writeback cannot be safely added in production yet.`,
    data: { quoteId, propertyName, before, results, preflight }
  }
}

async function probeX11_RateLimitHeadroom({ hubspot }) {
  const samples = []
  const probes = [
    { name: 'account-info', method: 'get', url: '/account-info/v3/details' },
    { name: 'properties-quotes-list', method: 'get', url: '/crm/v3/properties/quotes?limit=1' },
    { name: 'properties-deals-list', method: 'get', url: '/crm/v3/properties/deals?limit=1' }
  ]

  let lowestRemaining = null
  let maxSeen = null
  let intervalMs = null

  for (const p of probes) {
    const res = await hubspot.request({ method: p.method, url: p.url })
    const headers = (res && res.headers) || {}
    const remainingRaw = headers['x-hubspot-ratelimit-remaining']
    const maxRaw = headers['x-hubspot-ratelimit-max']
    const intervalRaw = headers['x-hubspot-ratelimit-interval-milliseconds']
    const remaining = remainingRaw != null ? Number(remainingRaw) : null
    const max = maxRaw != null ? Number(maxRaw) : null
    const interval = intervalRaw != null ? Number(intervalRaw) : null
    if (Number.isFinite(interval)) intervalMs = interval
    if (Number.isFinite(max)) maxSeen = Number.isFinite(maxSeen) ? Math.max(maxSeen, max) : max
    if (Number.isFinite(remaining)) lowestRemaining = lowestRemaining == null ? remaining : Math.min(lowestRemaining, remaining)
    samples.push({
      name: p.name,
      httpStatus: res.status,
      remaining,
      max,
      intervalMs: interval
    })
  }

  const noHeaders = samples.every((s) => s.remaining == null && s.max == null)
  if (noHeaders) {
    return {
      id: 'X11',
      status: 'warn',
      summary: 'no X-HubSpot-RateLimit-* headers observed on any sample. HubSpot may have changed the contract; rate-limit headroom cannot be measured by this probe.',
      data: { samples, noHeaders: true }
    }
  }

  const headroomRatio = Number.isFinite(maxSeen) && Number.isFinite(lowestRemaining) && maxSeen > 0
    ? lowestRemaining / maxSeen
    : null
  const lowHeadroom = headroomRatio != null && headroomRatio < 0.3
  return {
    id: 'X11',
    status: lowHeadroom ? 'fail' : 'pass',
    summary: `lowest remaining=${lowestRemaining}/${maxSeen} over ${intervalMs || '∅'}ms window (${samples.length} samples); headroom=${headroomRatio != null ? (headroomRatio * 100).toFixed(1) + '%' : '∅'}${lowHeadroom ? ' — too tight for the additional Mexico writes' : ''}`,
    data: { samples, lowestRemaining, maxSeen, intervalMs, headroomRatio }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true || args.h === true) {
    process.stdout.write([
      'Usage: node scripts/probes/mexico-readiness.js [--deal=<id>] [--quote=<id>]',
      '                                [--country-prop=<name>] [--sync-status-prop=<name>] [--out=PATH]',
      '',
      'Read-only staging probes X1-X11 for the Mexico intermediary + currency feature.',
      'X9 writes draft sale.order rows tagged probe:mx:<ts>:A/B/D and unlinks them.',
      'X10 PATCHes a HubSpot quote property you pass with --quote and restores it.',
      'Writes JSON to --out (default: docs/testing/<UTC-date>-mexico-readiness.json).',
      ''
    ].join('\n'))
    return
  }

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
  const countryProp = typeof args['country-prop'] === 'string' ? args['country-prop'] : cfg.hubspot.propertyQuoteCountry
  const syncStatusProp = typeof args['sync-status-prop'] === 'string' ? args['sync-status-prop'] : process.env.HS_PROPERTY_QUOTE_SYNC_STATUS || 'estado_sync_odoo'

  const utcDate = new Date().toISOString().slice(0, 10)
  const defaultOut = `docs/testing/${utcDate}-mexico-readiness.json`
  const outPath = typeof args.out === 'string' ? args.out : defaultOut

  const startedAt = new Date().toISOString()
  const probes = [
    ['X1', () => probeX1_HubspotCurrencySurface({ hubspot })],
    ['X2', () => probeX2_VisualMexicoPartner({ exec: odoo.executeKw })],
    ['X3', () => probeX3_VisualMexicoCompany({ exec: odoo.executeKw })],
    ['X4', () => probeX4_MexicoResolution({ exec: odoo.executeKw })],
    ['X5', () => probeX5_Pricelists({ exec: odoo.executeKw })],
    ['X6', () => probeX6_Currencies({ exec: odoo.executeKw })],
    ['X7', () => probeX7_SaleOrderCurrencyMisalignment({ exec: odoo.executeKw, hubspot, dealId })],
    ['X8', () => probeX8_SaleOrderFieldShape({ exec: odoo.executeKw })],
    ['X9', () => probeX9_SaleOrderWriteExperiment({ exec: odoo.executeKw, cfg, logger })],
    ['X10', () => probeX10_QuoteEnumerationPropertyPatch({ hubspot, quoteId, syncStatusProp })],
    ['X11', () => probeX11_RateLimitHeadroom({ hubspot })]
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

  const blocking = results.filter(isFatalFailure).length
  const passes = results.filter((r) => r.status === 'pass').length
  const warnings = results.filter((r) => r.status === 'warn').length
  const skipped = results.filter((r) => r.status === 'skip').length
  const toleratedFailures = results.filter((r) => r.status === 'fail' && WARN_TOLERATED_PROBE_IDS.includes(r.id)).length

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    target: { odooBase: cfg.odoo.baseUrl, odooDb: cfg.odoo.db, hubspotBase: cfg.hubspot.apiBase },
    args: { dealId, quoteId, countryProp, syncStatusProp },
    compuerta: { requiredProbeIds: REQUIRED_PROBE_IDS, warnToleratedProbeIds: WARN_TOLERATED_PROBE_IDS },
    summary: { total: results.length, pass: passes, warn: warnings, fail: blocking, skip: skipped, toleratedFailures },
    results
  }

  const fs = require('node:fs/promises')
  const absOut = path.resolve(outPath)
  await fs.mkdir(path.dirname(absOut), { recursive: true })
  await fs.writeFile(absOut, JSON.stringify(report, null, 2), 'utf8')
  process.stderr.write(`\nwrote ${absOut}\n`)
  process.stderr.write(`summary: pass=${passes} warn=${warnings} fail=${blocking} skip=${skipped} toleratedFailures=${toleratedFailures}\n`)
  if (blocking > 0) process.exit(1)
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify({ level: 'error', msg: 'probe.fatal', error: err.message, stack: err.stack }) + '\n')
    process.exit(2)
  })
}

module.exports = {
  REQUIRED_PROBE_IDS,
  WARN_TOLERATED_PROBE_IDS,
  isFatalFailure,
  probeX1_HubspotCurrencySurface,
  probeX2_VisualMexicoPartner,
  probeX3_VisualMexicoCompany,
  probeX4_MexicoResolution,
  probeX5_Pricelists,
  probeX6_Currencies,
  probeX7_SaleOrderCurrencyMisalignment,
  probeX8_SaleOrderFieldShape,
  probeX9_SaleOrderWriteExperiment,
  probeX10_QuoteEnumerationPropertyPatch,
  probeX11_RateLimitHeadroom
}
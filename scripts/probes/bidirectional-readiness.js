#!/usr/bin/env node
'use strict'

/**
 * Read-only staging probes for the Fase 6 spike (bidirectionality decision) —
 * docs/plan-cambios-2026-08-05.md § Fase 6.
 *
 * Decides, with data instead of guessing:
 *   B1/B2/B3 — can this Odoo push an outbound webhook on sale.order state change
 *              (native ir.actions.server state='webhook', Odoo 17+), without custom code?
 *   B4       — exact field surface needed for the payload Andrea asked for
 *              (quote state, MO number, e-invoicing fields).
 *   B5       — mrp.production field surface for MO status readback.
 *
 * Strictly read-only. No writes to Odoo or HubSpot.
 * Reuses buildOdooRpc exported from hubspot-quote-readiness.js.
 *
 * Run: node scripts/probes/bidirectional-readiness.js [--out=PATH]
 */

const path = require('node:path')
const { load } = require('../../src/config')
const { buildOdooRpc } = require('./hubspot-quote-readiness')

const REQUIRED_PROBE_IDS = ['B1', 'B2']
const EINVOICING_NAME_RE = /edi|einvoic|fiscal|cfdi|hacienda|dte|l10n_cr/i

function isFatalFailure(result) {
  return result.status === 'fail' && REQUIRED_PROBE_IDS.includes(result.id)
}

async function probeB1_BaseAutomationInstalled({ exec }) {
  const rows = await exec('ir.module.module', 'search_read',
    [[['name', '=', 'base_automation']]],
    { fields: ['id', 'name', 'state'] })
  const mod = Array.isArray(rows) && rows.length > 0 ? rows[0] : null
  if (!mod) {
    return { id: 'B1', status: 'fail', summary: 'ir.module.module has no base_automation row — module not present in this Odoo.', data: { mod: null } }
  }
  const installed = mod.state === 'installed'
  return {
    id: 'B1',
    status: installed ? 'pass' : 'warn',
    summary: `base_automation state=${mod.state} — Automation Rules UI ${installed ? 'is' : 'is NOT'} available`,
    data: { mod }
  }
}

async function probeB2_WebhookActionTypeAvailable({ exec }) {
  const fields = await exec('ir.actions.server', 'fields_get', [['state']], { attributes: ['selection'] })
  const selection = fields && fields.state && Array.isArray(fields.state.selection) ? fields.state.selection : []
  const values = selection.map((s) => (Array.isArray(s) ? s[0] : s))
  const hasWebhook = values.includes('webhook')
  return {
    id: 'B2',
    status: hasWebhook ? 'pass' : 'fail',
    summary: hasWebhook
      ? 'ir.actions.server supports state=webhook natively — an Automation Rule can POST outbound on sale.order write, with zero custom Python.'
      : `ir.actions.server has no native 'webhook' action state (found: ${values.join(', ') || '∅'}) — outbound push would need custom server-action code (usually blocked by safe_eval) or a client-side polling fallback.`,
    data: { availableStates: values }
  }
}

async function probeB3_ExistingAutomationRulesOnSaleOrder({ exec }) {
  let count = 0
  let rows = []
  try {
    const modelRows = await exec('ir.model', 'search_read', [[['model', '=', 'sale.order']]], { fields: ['id'] })
    const modelId = Array.isArray(modelRows) && modelRows.length > 0 ? Number(modelRows[0].id) : null
    if (modelId != null) {
      rows = await exec('base.automation', 'search_read',
        [[['model_id', '=', modelId]]],
        { fields: ['id', 'name', 'trigger', 'state'] })
      count = Array.isArray(rows) ? rows.length : 0
    }
  } catch (err) {
    return { id: 'B3', status: 'warn', summary: `base.automation lookup failed: ${err.message} — likely means the module isn't installed (consistent with B1).`, data: { error: err.message } }
  }
  return {
    id: 'B3',
    status: count > 0 ? 'pass' : 'warn',
    summary: count > 0
      ? `${count} existing Automation Rule(s) already configured on sale.order — prior art to copy/extend.`
      : 'No Automation Rules configured yet on sale.order — would be built from scratch.',
    data: { count, rules: rows }
  }
}

async function probeB4_SaleOrderPayloadFieldSurface({ exec }) {
  const wanted = ['state', 'invoice_status', 'name', 'amount_total', 'partner_id', 'partner_invoice_id', 'origin']
  const soFields = await exec('sale.order', 'fields_get', [wanted], { attributes: ['type', 'string', 'selection'] })
  const allFieldNames = Object.keys(await exec('sale.order', 'fields_get', [], { attributes: ['type'] }) || {})
  const einvoicingCandidates = allFieldNames.filter((n) => EINVOICING_NAME_RE.test(n))
  const companyFieldNames = Object.keys(await exec('res.company', 'fields_get', [], { attributes: ['type'] }) || {})
  const einvoicingCompanyCandidates = companyFieldNames.filter((n) => EINVOICING_NAME_RE.test(n))
  const missing = wanted.filter((f) => !soFields || !soFields[f])
  return {
    id: 'B4',
    status: missing.length === 0 ? 'pass' : 'warn',
    summary: missing.length === 0
      ? `All ${wanted.length} core payload fields present on sale.order. E-invoicing field candidates: sale.order=${einvoicingCandidates.length}, res.company=${einvoicingCompanyCandidates.length}.`
      : `Missing on sale.order: ${missing.join(', ')}. E-invoicing candidates: sale.order=${einvoicingCandidates.length}, res.company=${einvoicingCompanyCandidates.length}.`,
    data: { soFields, einvoicingCandidates, einvoicingCompanyCandidates }
  }
}

async function probeB5_ManufacturingOrderFieldSurface({ exec }) {
  const wanted = ['name', 'state', 'origin', 'product_qty', 'date_planned_start']
  const fields = await exec('mrp.production', 'fields_get', [wanted], { attributes: ['type', 'string', 'selection'] })
  const missing = wanted.filter((f) => !fields || !fields[f])
  const stateSelection = fields && fields.state && Array.isArray(fields.state.selection) ? fields.state.selection.map((s) => s[0]) : []
  return {
    id: 'B5',
    status: missing.length === 0 ? 'pass' : 'warn',
    summary: missing.length === 0
      ? `mrp.production has all ${wanted.length} fields needed for MO status readback. state values: ${stateSelection.join(', ')}`
      : `mrp.production missing: ${missing.join(', ')}`,
    data: { fields, stateSelection }
  }
}

async function main() {
  const cfg = load()
  const odoo = buildOdooRpc({ baseUrl: cfg.odoo.baseUrl, db: cfg.odoo.db, login: cfg.odoo.login, apiKey: cfg.odoo.apiKey })

  const utcDate = new Date().toISOString().slice(0, 10)
  const outPath = process.argv.find((a) => a.startsWith('--out='))
    ? process.argv.find((a) => a.startsWith('--out=')).slice('--out='.length)
    : `docs/testing/${utcDate}-bidirectional-readiness.json`

  const startedAt = new Date().toISOString()
  const probes = [
    ['B1', () => probeB1_BaseAutomationInstalled({ exec: odoo.executeKw })],
    ['B2', () => probeB2_WebhookActionTypeAvailable({ exec: odoo.executeKw })],
    ['B3', () => probeB3_ExistingAutomationRulesOnSaleOrder({ exec: odoo.executeKw })],
    ['B4', () => probeB4_SaleOrderPayloadFieldSurface({ exec: odoo.executeKw })],
    ['B5', () => probeB5_ManufacturingOrderFieldSurface({ exec: odoo.executeKw })]
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
      results.push({ id, status: 'fail', summary: `probe crashed: ${err.message}`, durationMs: Date.now() - t0, error: { message: err.message, code: err.code } })
      process.stderr.write(`[FAIL] ${id}: crashed — ${err.message}\n`)
    }
  }

  const blocking = results.filter(isFatalFailure).length
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    target: { odooBase: cfg.odoo.baseUrl, odooDb: cfg.odoo.db },
    compuerta: { requiredProbeIds: REQUIRED_PROBE_IDS },
    summary: {
      total: results.length,
      pass: results.filter((r) => r.status === 'pass').length,
      warn: results.filter((r) => r.status === 'warn').length,
      fail: blocking
    },
    results
  }

  const fs = require('node:fs/promises')
  const absOut = path.resolve(outPath)
  await fs.mkdir(path.dirname(absOut), { recursive: true })
  await fs.writeFile(absOut, JSON.stringify(report, null, 2), 'utf8')
  process.stderr.write(`\nwrote ${absOut}\n`)
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
  isFatalFailure,
  probeB1_BaseAutomationInstalled,
  probeB2_WebhookActionTypeAvailable,
  probeB3_ExistingAutomationRulesOnSaleOrder,
  probeB4_SaleOrderPayloadFieldSurface,
  probeB5_ManufacturingOrderFieldSurface
}

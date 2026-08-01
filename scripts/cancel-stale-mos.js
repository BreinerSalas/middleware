#!/usr/bin/env node
'use strict'

/**
 * Cancel stale mrp.production rows from the pre-quote flow.
 *
 * Background: before the country_expense feature, the middleware created both a
 * `sale.order` and an `mrp.production` per closed-won deal. The new flow only
 * creates the sale.order. This script lists (and, with --apply, cancels) the
 * orphan MOs whose `origin` starts with `hs:` — those are the ones the
 * middleware wrote.
 *
 * Usage:
 *   node scripts/cancel-stale-mos.js                 # dry-run (default): list only
 *   node scripts/cancel-stale-mos.js --apply         # actually write state='cancel'
 *   node scripts/cancel-stale-mos.js --limit=20      # cap the result count
 *
 * Read-only by default. Refuses to touch anything without an explicit --apply.
 * Requires ODOO_CLIENT_MODE=http (cannot cancel via stub).
 */

const path = require('node:path')
const axios = require('axios')
const { load } = require('../src/config')
const { createLogger } = require('../src/lib/logger')
const { parseArgs } = require('./sync-products.lib')

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
      const msg = (res.data.error.data && res.data.error.data.message) || res.data.error.message || 'Odoo RPC error'
      const e = new Error(msg)
      e.code = res.data.error.code
      throw e
    }
    return res.data && res.data.result
  }
  return { ensureUid, executeKw }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true || args.h === true) {
    process.stdout.write([
      'Usage: node scripts/cancel-stale-mos.js [--apply] [--limit=N]',
      '',
      'Reads mrp.production rows whose origin starts with "hs:".',
      'Without --apply: lists them. With --apply: writes state="cancel".',
      ''
    ].join('\n'))
    return
  }

  const apply = args.apply === true
  const limit = typeof args.limit === 'number' ? args.limit : 200

  const cfg = load()
  const logger = createLogger({ level: cfg.logging.level })

  if (cfg.odoo.mode !== 'http') {
    process.stderr.write(`cancel-stale-mos requires ODOO_CLIENT_MODE=http (current: ${cfg.odoo.mode}). aborting.\n`)
    process.exit(2)
  }

  const rpc = buildOdooRpc({
    baseUrl: cfg.odoo.baseUrl, db: cfg.odoo.db, login: cfg.odoo.login, apiKey: cfg.odoo.apiKey
  })

  const rows = await rpc.executeKw('mrp.production', 'search_read',
    [[['origin', '=like', 'hs:%']]],
    { fields: ['id', 'name', 'origin', 'state', 'product_id'], limit, order: 'id desc' })

  process.stderr.write(`found ${rows.length} mrp.production rows with origin=hs:% (limit=${limit}, mode=${apply ? 'apply' : 'dry-run'})\n`)
  if (rows.length === 0) return

  for (const r of rows) {
    const productName = Array.isArray(r.product_id) ? r.product_id[1] : ''
    process.stdout.write(`${r.id}\t${r.name}\t${r.origin}\tstate=${r.state}\t${productName}\n`)
  }

  if (!apply) {
    process.stderr.write('\nre-run with --apply to actually cancel these.\n')
    return
  }

  let cancelled = 0
  let failed = 0
  for (const r of rows) {
    try {
      await rpc.executeKw('mrp.production', 'write', [[Number(r.id)], { state: 'cancel' }], {})
      cancelled += 1
      process.stdout.write(`cancelled id=${r.id} name=${r.name}\n`)
    } catch (err) {
      failed += 1
      logger.error('cancel.failed', { id: r.id, name: r.name, error: err.message })
    }
  }
  process.stderr.write(`\ncancelled ${cancelled}/${rows.length} (failed=${failed})\n`)
  if (failed > 0) process.exit(1)
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify({ level: 'error', msg: 'cancel-stale-mos.fatal', error: err.message, stack: err.stack }) + '\n')
    process.exit(1)
  })
}

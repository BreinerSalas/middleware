#!/usr/bin/env node
'use strict'

// Backfill: write `id_producto_odoo = odooId` onto every existing HubSpot product that already
// has a `product_mapping` row, and create `product_mapping` rows for products that don't have
// one yet (Fase 4 of openspec/hubspot-product-odoo-id-key). Idempotent and safe to run during
// business hours under the existing rps:15/burst:20 limiter (~11k ÷ 100 ≈ 110 calls).
//
// Two phases:
//   Phase A — AUTHORITATIVE: rows with lastAction ∈ {created, updated} (SKU-derived). Write
//             id_producto_odoo directly via batchUpdateProducts (native hubspotId, no
//             idProperty) — HubSpot's batch/upsert endpoint requires idProperty on every
//             input, so writing by a known native id needs the separate batch/update endpoint.
//   Phase B — QUARANTINE: rows with lastAction ∈ {backfilled, no_sku_no_match} (D6 heuristic).
//             Promote ONLY when the name uniquely matches one Odoo product AND one HubSpot
//             product; otherwise leave unmapped and report to the quarantine list (a visible
//             duplicate from step 4 of the migration is recoverable; a silent wrong id is not).

const { normalizeProductName } = require('../src/adapters/outbound/odoo/productNameKey')

// Kept as an alias of the shared name-comparison key so both HubSpot and Odoo
// name lookups collapse to the exact same key (see productNameKey.js).
const normalizeName = normalizeProductName

async function runBackfill({
  hubspotApi,
  odooApi = null,
  mappingRepo,
  logger = null,
  dryRun = false,
  chunkSize = 100
} = {}) {
  if (!hubspotApi || typeof hubspotApi.batchUpdateProducts !== 'function') {
    throw new Error('runBackfill requires hubspotApi with batchUpdateProducts')
  }
  if (!mappingRepo || typeof mappingRepo.findAllForBackfill !== 'function') {
    throw new Error('runBackfill requires mappingRepo with findAllForBackfill')
  }
  const log = (level, msg, extra) => {
    if (logger && typeof logger[level] === 'function') logger[level](msg, extra)
  }

  const allRows = await mappingRepo.findAllForBackfill()
  log('info', 'backfill.start', { total: allRows.length, dryRun })

  const authoritative = allRows.filter((r) => r && (r.lastAction === 'created' || r.lastAction === 'updated'))
  const heuristic = allRows.filter((r) => r && (r.lastAction === 'backfilled' || r.lastAction === 'no_sku_no_match'))

  let written = 0
  const promoted = []
  const quarantined = []

  // Phase A — authoritative
  const inputsA = authoritative
    .filter((r) => r.hubspotId != null && r.odooId != null)
    .map((r) => ({
      id: String(r.hubspotId),
      properties: { id_producto_odoo: String(r.odooId) }
    }))
  if (inputsA.length > 0) {
    for (let i = 0; i < inputsA.length; i += chunkSize) {
      const chunk = inputsA.slice(i, i + chunkSize)
      if (!dryRun) {
        const response = await hubspotApi.batchUpdateProducts({ inputs: chunk })
        const ok = chunk.length - ((response.errors && response.errors.length) || 0)
        written += ok
        log('info', 'backfill.phaseA.chunk', { chunkSize: chunk.length, written: ok })
      } else {
        log('info', 'backfill.phaseA.dryRun.chunk', { chunkSize: chunk.length })
      }
    }
  }

  // Phase B — quarantine / promote
  if (!dryRun && heuristic.length > 0) {
    if (!odooApi || typeof odooApi.searchProductIdsByNames !== 'function') {
      throw new Error('runBackfill requires odooApi with searchProductIdsByNames to process quarantined (heuristic) rows')
    }
    for (const row of heuristic) {
      const rawName = (row.metadata && row.metadata.name) || row.odooName || null
      if (!row.hubspotId || !row.odooId || !rawName) {
        // No name to disambiguate by → quarantine
        quarantined.push({ odooId: row.odooId, hubspotId: row.hubspotId, reason: 'no_name' })
        continue
      }
      const targetName = normalizeName(rawName)
      let odooMatches = 0
      let hubspotMatches = 0
      try {
        // (D6) Promotion requires the name to uniquely match BOTH one Odoo product AND one HubSpot
        // product — checked against each system's own client, never the same client twice.
        const odooMap = await odooApi.searchProductIdsByNames([rawName])
        const odooEntry = odooMap && odooMap[targetName]
        odooMatches = odooEntry ? odooEntry.matches : 0

        const hubResp = await hubspotApi.searchProducts({
          filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: rawName }] }],
          properties: ['name'],
          limit: 5
        })
        hubspotMatches = ((hubResp && hubResp.results) || []).length
      } catch (err) {
        log('warn', 'backfill.phaseB.lookup_failed', { odooId: row.odooId, error: err.message })
        quarantined.push({ odooId: row.odooId, hubspotId: row.hubspotId, reason: 'lookup_error' })
        continue
      }
      if (odooMatches === 1 && hubspotMatches === 1) {
        // Unique by name in BOTH systems, not yet claimed → safe to promote.
        await hubspotApi.batchUpdateProducts({
          inputs: [{ id: String(row.hubspotId), properties: { id_producto_odoo: String(row.odooId) } }]
        })
        promoted.push({ odooId: row.odooId, hubspotId: row.hubspotId })
        written += 1
      } else {
        quarantined.push({ odooId: row.odooId, hubspotId: row.hubspotId, reason: 'ambiguous_or_claimed' })
      }
    }
  } else if (heuristic.length > 0) {
    // dry-run: report all heuristic rows as scanned (no lookup, no write)
    log('info', 'backfill.phaseB.dryRun', { scanned: heuristic.length })
  }

  log('info', 'backfill.done', {
    dryRun,
    scanned: allRows.length,
    written,
    promoted: promoted.length,
    quarantined: quarantined.length
  })

  return {
    scanned: allRows.length,
    written,
    promoted,
    quarantined
  }
}

// (sdd/hubspot-product-reverse-discovery, design D1) The staged orphan-reconciliation
// pipeline (D6 promote -> Track A -> Track B -> quarantine) now lives in
// src/composition/productOrphanReconcileModule.js so src/ never depends on scripts/. This
// re-export keeps the CLI entrypoint and all prior tests working unchanged.
const { reconcileOrphans } = require('../src/composition/productOrphanReconcileModule')

module.exports = { runBackfill, normalizeName, reconcileOrphans }

async function main() {
  // Lazy require to keep the CLI boundary thin (the function above is the testable unit).
  const path = require('node:path')
  const { load } = require('../src/config')
  const { createLogger } = require('../src/lib/logger')
  const { createHubspotApiClient } = require('../src/adapters/outbound/hubspot/hubspotApiClient')
  const { createOdooApiClient } = require('../src/adapters/outbound/odoo/odooApiClient')
  const { MongoProductMappingRepository } = require('../src/adapters/outbound/mongo/MongoProductMappingRepository')
  const { connectMongo, disconnectMongo } = require('../src/adapters/outbound/mongo/connection')

  const args = require('./sync-products.lib').parseArgs(process.argv.slice(2))
  const dryRun = args['dry-run'] === true
  const envFileRaw = process.env.SMARTFLOW_ENV_FILE || null
  const envFile = envFileRaw ? path.resolve(envFileRaw) : null
  const cfg = load(envFile ? { envFile } : {})
  const logger = createLogger({ level: cfg.logging.level })
  await connectMongo({ uri: cfg.mongodbUri, logger })

  const hubspotApi = createHubspotApiClient({
    baseUrl: cfg.hubspot.apiBase,
    accessToken: cfg.hubspot.accessToken
  })
  const odooApi = createOdooApiClient({
    mode: cfg.odoo.mode,
    baseUrl: cfg.odoo.baseUrl,
    db: cfg.odoo.db,
    login: cfg.odoo.login,
    apiKey: cfg.odoo.apiKey
  })
  const mappingRepo = new MongoProductMappingRepository({ logger })

  // Mongo doesn't natively support find-by-list-of-actions; the repo wraps that. Provide a
  // minimal helper for the backfill that filters in-memory after a listAll.
  const baseRepo = mappingRepo
  const wrappedRepo = {
    findAllForBackfill: async () => {
      const all = await baseRepo.listAll()
      return all
    }
  }

  const reconcile = args['reconcile-orphans'] === true
  const limit = typeof args.limit === 'number' ? args.limit : null

  try {
    if (reconcile) {
      const result = await reconcileOrphans({ hubspotApi, odooApi, mappingRepo, logger, dryRun, limit })
      if (result.quarantined.length > 0) {
        process.stderr.write(JSON.stringify({ level: 'warn', msg: 'reconcile.quarantine', items: result.quarantined }) + '\n')
      }
      process.stderr.write(JSON.stringify({
        level: 'info',
        msg: 'reconcile.summary',
        scanned: result.scanned,
        promoted: result.promoted.length,
        quarantined: result.quarantined.length,
        dryRun
      }) + '\n')
      return
    }
    const result = await runBackfill({ hubspotApi, odooApi, mappingRepo: wrappedRepo, logger, dryRun })
    if (result.quarantined.length > 0) {
      process.stderr.write(JSON.stringify({ level: 'warn', msg: 'backfill.quarantine', items: result.quarantined }) + '\n')
    }
    process.stderr.write(JSON.stringify({
      level: 'info',
      msg: 'backfill.summary',
      scanned: result.scanned,
      written: result.written,
      promoted: result.promoted.length,
      quarantined: result.quarantined.length,
      dryRun
    }) + '\n')
  } finally {
    await disconnectMongo({ logger })
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify({ level: 'error', msg: 'backfill.fatal', error: err.message, stack: err.stack }) + '\n')
    process.exit(1)
  })
}

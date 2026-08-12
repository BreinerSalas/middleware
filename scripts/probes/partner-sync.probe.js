#!/usr/bin/env node
'use strict'

/**
 * Throttled backfill probe for the `partner-sync` flow (Odoo res.partner -> HubSpot Contact).
 * Mirrors scripts/sync-products.js. Intended to be run manually, BEFORE
 * PARTNER_SYNC_JOB_ENABLED=true is set, to:
 *   1) size the backfill via countPartners() (open risk from the proposal's Rollback Plan /
 *      Risks table: volume may far exceed products and needs a throttled first run), and
 *   2) run a bounded runOnce({ limit, dryRun }) against the live Odoo/HubSpot instances.
 *
 * Run: node scripts/probes/partner-sync.probe.js [--limit=N] [--dry-run] [--once]
 */

const path = require('node:path')
const { load } = require('../../src/config')
const { createLogger } = require('../../src/lib/logger')
const { createOdooApiClient } = require('../../src/adapters/outbound/odoo/odooApiClient')
const { createHubspotApiClient } = require('../../src/adapters/outbound/hubspot/hubspotApiClient')
const { OdooPartnerSource } = require('../../src/adapters/outbound/odoo/OdooPartnerSource')
const { HubspotContactGateway } = require('../../src/adapters/outbound/hubspot/HubspotContactGateway')
const { createPartnerSyncModule } = require('../../src/composition/partnerSyncModule')
const { MongoPartnerMappingRepository } = require('../../src/adapters/outbound/mongo/MongoPartnerMappingRepository')
const { MongoPartnerSyncRunRepository } = require('../../src/adapters/outbound/mongo/MongoPartnerSyncRunRepository')
const { connectMongo, disconnectMongo } = require('../../src/adapters/outbound/mongo/connection')
const { parseArgs, resolveIntervalMs, shouldRunOnce } = require('../sync-products.lib')

function buildClients(cfg, logger) {
  const odooApi = createOdooApiClient({
    mode: cfg.odoo.mode, baseUrl: cfg.odoo.baseUrl, db: cfg.odoo.db, login: cfg.odoo.login, apiKey: cfg.odoo.apiKey
  })
  const hubspotApi = createHubspotApiClient({ baseUrl: cfg.hubspot.apiBase, accessToken: cfg.hubspot.accessToken })
  const source = new OdooPartnerSource({ apiClient: odooApi, logger, pageSize: cfg.partnerSync.pageSize })
  const gateway = new HubspotContactGateway({ apiClient: hubspotApi, logger, idProperty: cfg.hubspot.propertyOdooPartnerId })
  const mappingRepo = new MongoPartnerMappingRepository({ logger })
  const runRepo = new MongoPartnerSyncRunRepository({ logger })
  return {
    source,
    gateway,
    mod: createPartnerSyncModule({
      config: cfg, odooSource: source, hubspotGateway: gateway, mappingRepo, runRepo, logger, concurrency: 10
    })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const envFileRaw = process.env.SMARTFLOW_ENV_FILE || null
  const envFile = envFileRaw ? path.resolve(envFileRaw) : null
  const cfg = load(envFile ? { envFile } : {})
  const logger = createLogger({ level: cfg.logging.level })
  await connectMongo({ uri: cfg.mongodbUri, logger })

  if (args.help === true || args.h === true) {
    process.stdout.write([
      'Usage: node scripts/probes/partner-sync.probe.js [--interval=60000] [--limit=N] [--once] [--dry-run]',
      '',
      'Flags:',
      '  --interval=MS   repeat runOnce every MS (default: 60000; --once to run a single pass)',
      '  --once          run once and exit',
      '  --limit=N       process only the first N eligible partners from Odoo (throttled backfill)',
      '  --dry-run       log planned changes, do not write to HubSpot',
      '',
      'Pre-production checklist (see proposal.md Risks / Rollback Plan):',
      '  1. Run this probe with --dry-run --limit=<small N> first.',
      '  2. Check countPartners() below to size the real backfill before removing --limit.',
      '  3. Verify res.partner.type on the live instance — PARTNER_CONTACT_TYPE in odooApiClient.js',
      '     assumes \'contact\'; some Odoo versions use \'private\' for individual child partners.',
      '  4. Only after a clean backfill, set PARTNER_SYNC_JOB_ENABLED=true to enable the recurring tick.',
      ''
    ].join('\n'))
    await disconnectMongo({ logger })
    return
  }

  const { source, mod } = buildClients(cfg, logger)
  const total = await source.count()
  process.stderr.write(`partner-sync probe: countPartners()=${total} eligible partner(s) in Odoo\n`)

  const intervalMs = resolveIntervalMs(args, process.env)
  const limit = typeof args.limit === 'number' ? args.limit : null
  const dryRun = args['dry-run'] === true || args.dryRun === true

  const tick = () => mod.runOnce({ limit, dryRun })

  if (shouldRunOnce(args) || intervalMs === 0) {
    await tick()
    await disconnectMongo({ logger })
    return
  }

  process.stderr.write(`partner-sync loop: interval=${intervalMs}ms, limit=${limit}, dryRun=${dryRun}\n`)
  await tick()
  const timer = setInterval(() => {
    tick().catch((err) => {
      if (logger && typeof logger.error === 'function') logger.error('partner-sync.probe.tick.failed', { error: err.message })
    })
  }, intervalMs)
  const stop = () => { clearInterval(timer); disconnectMongo({ logger }).catch(() => undefined); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify({ level: 'error', msg: 'partner-sync.probe.fatal', error: err.message }) + '\n')
    process.exit(1)
  })
}

module.exports = { buildClients }

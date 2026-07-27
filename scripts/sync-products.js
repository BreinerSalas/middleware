#!/usr/bin/env node
'use strict'

const path = require('node:path')
const { load } = require('../src/config')
const { createLogger } = require('../src/lib/logger')
const { createOdooApiClient } = require('../src/adapters/outbound/odoo/odooApiClient')
const { createHubspotApiClient } = require('../src/adapters/outbound/hubspot/hubspotApiClient')
const { OdooProductSource } = require('../src/adapters/outbound/odoo/OdooProductSource')
const { HubspotProductGateway } = require('../src/adapters/outbound/hubspot/HubspotProductGateway')
const { createProductSyncModule } = require('../src/composition/productSyncModule')
const { parseArgs, resolveIntervalMs, shouldRunOnce } = require('./sync-products.lib')

function buildClients(cfg, logger) {
  const odooApi = createOdooApiClient({
    mode: cfg.odoo.mode,
    baseUrl: cfg.odoo.baseUrl,
    db: cfg.odoo.db,
    login: cfg.odoo.login,
    apiKey: cfg.odoo.apiKey
  })
  const hubspotApi = createHubspotApiClient({
    baseUrl: cfg.hubspot.apiBase,
    accessToken: cfg.hubspot.accessToken
  })
  const source = new OdooProductSource({ apiClient: odooApi, logger })
  const gateway = new HubspotProductGateway({ apiClient: hubspotApi, logger })
  return { source, gateway, mod: createProductSyncModule({ config: cfg, odooSource: source, hubspotGateway: gateway, logger, concurrency: 10 }) }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const envFileRaw = process.env.SMARTFLOW_ENV_FILE || null
  const envFile = envFileRaw ? path.resolve(envFileRaw) : null
  const cfg = load(envFile ? { envFile } : {})
  const logger = createLogger({ level: cfg.logging.level })

  if (args.help === true || args.h === true) {
    process.stdout.write([
      'Usage: node scripts/sync-products.js [--interval=60000] [--limit=N] [--once] [--dry-run]',
      '',
      'Flags:',
      '  --interval=MS   repeat runOnce every MS (default: $PRODUCT_SYNC_INTERVAL_MS or 60000)',
      '  --once          run once and exit',
      '  --limit=N       process only first N products from Odoo',
      '  --dry-run       log planned changes, do not write to HubSpot',
      '',
      'Env:',
      '  PRODUCT_SYNC_INTERVAL_MS   default interval when --interval omitted',
      '  SMARTFLOW_ENV_FILE         alternate .env path (e.g. .env.staging)',
      ''
    ].join('\n'))
    return
  }

  const { source, gateway, mod } = buildClients(cfg, logger)
  const intervalMs = resolveIntervalMs(args, process.env)
  const limit = typeof args.limit === 'number' ? args.limit : null
  const dryRun = args['dry-run'] === true

  const tick = () => mod.runOnce({ limit, dryRun })

  if (shouldRunOnce(args) || intervalMs === 0) {
    await tick()
    return
  }

  process.stderr.write(`product-sync loop: interval=${intervalMs}ms, limit=${limit}, dryRun=${dryRun}\n`)
  await tick()
  const timer = setInterval(() => {
    tick().catch((err) => {
      if (logger && typeof logger.error === 'function') logger.error('product-sync.tick.failed', { error: err.message })
    })
  }, intervalMs)
  const stop = () => { clearInterval(timer); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify({ level: 'error', msg: 'sync-products.fatal', error: err.message }) + '\n')
    process.exit(1)
  })
}

module.exports = { buildClients }

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
const { MongoProductMappingRepository } = require('../src/adapters/outbound/mongo/MongoProductMappingRepository')
const { MongoProductSyncRunRepository } = require('../src/adapters/outbound/mongo/MongoProductSyncRunRepository')
const { connectMongo, disconnectMongo } = require('../src/adapters/outbound/mongo/connection')
const { parseArgs, resolveIntervalMs, shouldRunOnce } = require('./sync-products.lib')

async function buildClients(cfg, logger) {
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
  const mappingRepo = new MongoProductMappingRepository({ logger })
  const runRepo = new MongoProductSyncRunRepository({ logger })
  return {
    source,
    gateway,
    mappingRepo,
    runRepo,
    mod: createProductSyncModule({
      config: cfg,
      odooSource: source,
      hubspotGateway: gateway,
      mappingRepo,
      runRepo,
      logger,
      concurrency: 10
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
        'Usage: node scripts/sync-products.js [--interval=60000] [--limit=N] [--once] [--dry-run] [--include-no-sku]',
        '',
        'Flags:',
        '  --interval=MS       repeat runOnce every MS (default: $PRODUCT_SYNC_INTERVAL_MS or 60000)',
        '  --once              run once and exit',
        '  --limit=N           process only first N products from Odoo',
        '  --dry-run           log planned changes, do not write to HubSpot',
        '  --include-no-sku    include products WITHOUT default_code (default: skip; 5848 with SKU vs ~11132 all)',
        '',
        'Env:',
        '  PRODUCT_SYNC_INTERVAL_MS   default interval when --interval omitted',
        '  SMARTFLOW_ENV_FILE         alternate .env path (e.g. .env.staging, .env.client)',
        ''
      ].join('\n'))
      return
    }

  const { mod } = await buildClients(cfg, logger)
  const intervalMs = resolveIntervalMs(args, process.env)
  const limit = typeof args.limit === 'number' ? args.limit : null
  const dryRun = args['dry-run'] === true
  const includeNoSku = args['include-no-sku'] === true || args.includeNoSku === true

  const tick = () => mod.runOnce({ limit, dryRun, includeNoSku })

  if (shouldRunOnce(args) || intervalMs === 0) {
    await tick()
    await disconnectMongo({ logger })
    return
  }

  process.stderr.write(`product-sync loop: interval=${intervalMs}ms, limit=${limit}, dryRun=${dryRun}\n`)
  await tick()
  const timer = setInterval(() => {
    tick().catch((err) => {
      if (logger && typeof logger.error === 'function') logger.error('product-sync.tick.failed', { error: err.message })
    })
  }, intervalMs)
  const stop = () => { clearInterval(timer); disconnectMongo({ logger }).catch(() => undefined); process.exit(0) }
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

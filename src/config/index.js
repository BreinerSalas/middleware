'use strict'

const path = require('node:path')
const dotenv = require('dotenv')

const REQUIRED_KEYS = [
  'MONGODB_URI',
  'HUBSPOT_ACCESS_TOKEN',
  'HUBSPOT_CLIENT_SECRET'
]

const OPTIONAL_KEYS = [
  'HUBSPOT_API_BASE',
  'HUBSPOT_WEBHOOK_TS_TOLERANCE_MS',
  'WEBHOOK_SHARED_SECRET',
  'WEBHOOK_SHARED_SECRET_HEADER_NAME',
  'HS_PROPERTY_ODOO_CUSTOMER_ID',
  'HS_PROPERTY_ODOO_ORDER_ID',
  'ODOO_CLIENT_MODE',
  'ODOO_BASE_URL',
  'ODOO_DB',
  'ODOO_LOGIN',
  'ODOO_API_KEY',
  'ODOO_DEFAULT_CUSTOMER_ID',
  'PORT',
  'NODE_ENV',
  'LOG_LEVEL',
  'WORKER_CONCURRENCY',
  'WORKER_POLL_INTERVAL_MS',
  'MAX_RETRY_ATTEMPTS',
  'RETRY_MAX_DELAY_MS',
  'PANEL_TOKEN',
  'PANEL_TOKEN_HEADER_NAME'
]

function loadEnvFile({ envFile = null, override = false } = {}) {
  if (envFile) {
    dotenv.config({ path: envFile, override })
  } else {
    dotenv.config({ override })
  }
}

function load({ env = process.env, envFile = null, override = false } = {}) {
  const targetFile = envFile === null ? path.resolve(process.cwd(), '.env') : envFile
  loadEnvFile({ envFile: targetFile, override })
  const missing = REQUIRED_KEYS.filter((k) => !env[k] || String(env[k]).trim() === '')
  if (missing.length > 0) {
    const err = new Error(`Missing required env var(s): ${missing.join(', ')}`)
    err.code = 'CONFIG_MISSING'
    err.missing = missing
    throw err
  }
  return {
    mongodbUri: env.MONGODB_URI,
    hubspot: {
      accessToken: env.HUBSPOT_ACCESS_TOKEN,
      apiBase: env.HUBSPOT_API_BASE || 'https://api.hubapi.com',
      clientSecret: env.HUBSPOT_CLIENT_SECRET,
      signatureTimestampToleranceMs: Number(env.HUBSPOT_WEBHOOK_TS_TOLERANCE_MS || 300000),
      propertyOdooCustomerId: env.HS_PROPERTY_ODOO_CUSTOMER_ID || 'id_cliente_odoo',
      propertyOdooOrderId: env.HS_PROPERTY_ODOO_ORDER_ID || 'id_orden_odoo'
    },
    webhook: {
      sharedSecret: env.WEBHOOK_SHARED_SECRET || '',
      headerName: (env.WEBHOOK_SHARED_SECRET_HEADER_NAME || 'x-smartflow-secret').toLowerCase()
    },
    odoo: {
      mode: (env.ODOO_CLIENT_MODE || 'stub').toLowerCase(),
      baseUrl: (env.ODOO_BASE_URL || '').replace(/\/+$/, ''),
      db: env.ODOO_DB || '',
      login: env.ODOO_LOGIN || '',
      apiKey: env.ODOO_API_KEY || '',
      defaultCustomerId: env.ODOO_DEFAULT_CUSTOMER_ID || ''
    },
    server: {
      port: Number(env.PORT || 3007),
      nodeEnv: env.NODE_ENV || 'development'
    },
    logging: {
      level: env.LOG_LEVEL || 'info'
    },
    worker: {
      concurrency: Number(env.WORKER_CONCURRENCY || 3),
      pollIntervalMs: Number(env.WORKER_POLL_INTERVAL_MS || 5000)
    },
    retry: {
      maxAttempts: Number(env.MAX_RETRY_ATTEMPTS || 8),
      maxDelayMs: Number(env.RETRY_MAX_DELAY_MS || 300000)
    },
    panel: {
      token: env.PANEL_TOKEN || '',
      headerName: (env.PANEL_TOKEN_HEADER_NAME || 'x-panel-token').toLowerCase()
    }
  }
}

module.exports = { load, REQUIRED_KEYS, OPTIONAL_KEYS }

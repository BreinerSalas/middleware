'use strict'

const path = require('node:path')
const dotenv = require('dotenv')

const REQUIRED_KEYS = [
  'MONGODB_URI',
  'HUBSPOT_ACCESS_TOKEN',
  'HUBSPOT_CLIENT_SECRET',
  'HS_ALLOWED_STAGE_IDS',
  'HS_ALLOWED_PIPELINE_IDS',
  'HS_CLOSED_WON_STAGE_ID'
]

const OPTIONAL_KEYS = [
  'HUBSPOT_API_BASE',
  'HUBSPOT_WEBHOOK_TS_TOLERANCE_MS',
  'HS_PROPERTY_ODOO_CUSTOMER_ID',
  'HS_PROPERTY_ODOO_ORDER_ID',
  'HS_PROPERTY_ODOO_QUOTE_ID',
  'HS_PROPERTY_QUOTE_COUNTRY',
  'HS_PROPERTY_QUOTE_INCOTERM',
  'HS_PROPERTY_QUOTE_DOCUMENT_TYPE',
  'HS_PROPERTY_QUOTE_ODOO_QUOTE_ID',
  'HS_QUOTE_ELIGIBLE_STATUSES',
  'HS_PROPERTY_MANUFACTURING_ORDER',
  'ODOO_CLIENT_MODE',
  'ODOO_BASE_URL',
  'ODOO_DB',
  'ODOO_LOGIN',
  'ODOO_API_KEY',
  'ODOO_DEFAULT_CUSTOMER_ID',
  'ODOO_AUTO_CONFIRM_QUOTES',
  'HS_REJECT_UNKNOWN_PIPELINE',
  'PORT',
  'NODE_ENV',
  'LOG_LEVEL',
  'WORKER_CONCURRENCY',
  'WORKER_POLL_INTERVAL_MS',
  'MAX_RETRY_ATTEMPTS',
  'RETRY_MAX_DELAY_MS',
  'PANEL_TOKEN',
  'PANEL_TOKEN_HEADER_NAME',
  'MEDIA_URL_SECRET',
  'MEDIA_PUBLIC_BASE_URL',
  'PRODUCT_SYNC_JOB_ENABLED',
  'PRODUCT_SYNC_TICK_INTERVAL_MS',
  'PRODUCT_SYNC_ORPHAN_WATCHDOG_MS',
  'PRODUCT_SYNC_INCLUDE_NO_SKU',
  'PARTNER_SYNC_JOB_ENABLED',
  'PARTNER_SYNC_TICK_INTERVAL_MS',
  'PARTNER_SYNC_ORPHAN_WATCHDOG_MS',
  'PARTNER_SYNC_PAGE_SIZE',
  'HS_PROPERTY_ODOO_PARTNER_ID',
  'HS_PROPERTY_ODOO_PRODUCT_ID'
]

function parseCsvList(raw) {
  if (raw == null) return []
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

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
  const stageIds = parseCsvList(env.HS_ALLOWED_STAGE_IDS)
  const pipelineIds = parseCsvList(env.HS_ALLOWED_PIPELINE_IDS)
  const quoteEligibleStatuses = parseCsvList(env.HS_QUOTE_ELIGIBLE_STATUSES)
  const missing = REQUIRED_KEYS.filter((k) => !env[k] || String(env[k]).trim() === '')
  if (stageIds.length === 0 && !missing.includes('HS_ALLOWED_STAGE_IDS')) missing.push('HS_ALLOWED_STAGE_IDS')
  if (pipelineIds.length === 0 && !missing.includes('HS_ALLOWED_PIPELINE_IDS')) missing.push('HS_ALLOWED_PIPELINE_IDS')
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
      propertyOdooOrderId: env.HS_PROPERTY_ODOO_ORDER_ID || 'id_orden_odoo',
      propertyOdooQuoteId: env.HS_PROPERTY_ODOO_QUOTE_ID || 'id_presupuesto_odoo',
      propertyQuoteCountry: env.HS_PROPERTY_QUOTE_COUNTRY || 'pais_de_destino',
      propertyQuoteIncoterm: env.HS_PROPERTY_QUOTE_INCOTERM || 'incoterm_cotizacion',
      propertyQuoteDocumentType: env.HS_PROPERTY_QUOTE_DOCUMENT_TYPE || 'tipo_documento_cotizacion',
      propertyQuoteOdooQuoteId: env.HS_PROPERTY_QUOTE_ODOO_QUOTE_ID || env.HS_PROPERTY_ODOO_QUOTE_ID || 'id_presupuesto_odoo',
      quoteEligibleStatuses: quoteEligibleStatuses.length > 0 ? quoteEligibleStatuses : ['APPROVAL_NOT_NEEDED', 'APPROVED'],
      propertyManufacturingOrder: env.HS_PROPERTY_MANUFACTURING_ORDER || 'numero_orden_fabricacion',
      propertyQuoteState: env.HS_PROPERTY_QUOTE_STATE || 'estado_presupuesto_odoo',
      propertyQuoteInvoiceStatus: env.HS_PROPERTY_QUOTE_INVOICE_STATUS || 'estado_facturacion_odoo',
      propertyOdooPartnerId: env.HS_PROPERTY_ODOO_PARTNER_ID || 'id_contacto_odoo_v2',
      propertyOdooProductId: env.HS_PROPERTY_ODOO_PRODUCT_ID || 'id_producto_odoo'
    },
    odoo: {
      mode: (env.ODOO_CLIENT_MODE || 'stub').toLowerCase(),
      baseUrl: (env.ODOO_BASE_URL || '').replace(/\/+$/, ''),
      db: env.ODOO_DB || '',
      login: env.ODOO_LOGIN || '',
      apiKey: env.ODOO_API_KEY || '',
      defaultCustomerId: env.ODOO_DEFAULT_CUSTOMER_ID || '',
      autoConfirmQuotes: String(env.ODOO_AUTO_CONFIRM_QUOTES || 'false').toLowerCase() === 'true'
    },
    deals: {
      allowedStageIds: stageIds,
      allowedPipelineIds: pipelineIds,
      closedWonStageId: String(env.HS_CLOSED_WON_STAGE_ID || '').trim(),
      rejectUnknownPipeline: String(env.HS_REJECT_UNKNOWN_PIPELINE || 'true').toLowerCase() !== 'false'
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
    },
    media: {
      urlSecret: env.MEDIA_URL_SECRET || '',
      publicBaseUrl: (env.MEDIA_PUBLIC_BASE_URL || '').replace(/\/+$/, '')
    },
    productSync: {
      jobEnabled: String(env.PRODUCT_SYNC_JOB_ENABLED || 'false').toLowerCase() === 'true',
      tickIntervalMs: Number(env.PRODUCT_SYNC_TICK_INTERVAL_MS || 60000),
      orphanWatchdogMs: Number(env.PRODUCT_SYNC_ORPHAN_WATCHDOG_MS || 30 * 60 * 1000),
      includeNoSku: String(env.PRODUCT_SYNC_INCLUDE_NO_SKU || 'true').toLowerCase() === 'true'
    },
    saleOrderStatusSync: {
      jobEnabled: String(env.SALE_ORDER_STATUS_SYNC_JOB_ENABLED || 'false').toLowerCase() === 'true',
      tickIntervalMs: Number(env.SALE_ORDER_STATUS_SYNC_TICK_INTERVAL_MS || 60000),
      orphanWatchdogMs: Number(env.SALE_ORDER_STATUS_SYNC_ORPHAN_WATCHDOG_MS || 30 * 60 * 1000)
    },
    manufacturingOrderRetrySync: {
      jobEnabled: String(env.MANUFACTURING_ORDER_RETRY_SYNC_JOB_ENABLED || 'false').toLowerCase() === 'true',
      tickIntervalMs: Number(env.MANUFACTURING_ORDER_RETRY_SYNC_TICK_INTERVAL_MS || 60000),
      orphanWatchdogMs: Number(env.MANUFACTURING_ORDER_RETRY_SYNC_ORPHAN_WATCHDOG_MS || 30 * 60 * 1000)
    },
    partnerSync: {
      jobEnabled: String(env.PARTNER_SYNC_JOB_ENABLED || 'false').toLowerCase() === 'true',
      tickIntervalMs: Number(env.PARTNER_SYNC_TICK_INTERVAL_MS || 60000),
      orphanWatchdogMs: Number(env.PARTNER_SYNC_ORPHAN_WATCHDOG_MS || 30 * 60 * 1000),
      pageSize: Number(env.PARTNER_SYNC_PAGE_SIZE || 100)
    }
  }
}

module.exports = { load, REQUIRED_KEYS, OPTIONAL_KEYS }

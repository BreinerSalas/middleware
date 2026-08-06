import { describe, it, expect } from 'vitest'
import { load, REQUIRED_KEYS } from '../src/config/index.js'

describe('config', () => {
  it('throws when required env vars are missing', () => {
    expect(() => load({ env: {} })).toThrow(/Missing required/)
  })

  it('throws with code CONFIG_MISSING', () => {
    let err
    try { load({ env: {} }) } catch (e) { err = e }
    expect(err.code).toBe('CONFIG_MISSING')
    expect(err.missing).toEqual(expect.arrayContaining(REQUIRED_KEYS))
  })

  it('lists HUBSPOT_CLIENT_SECRET in required keys (Private App mode)', () => {
    expect(REQUIRED_KEYS).toContain('HUBSPOT_CLIENT_SECRET')
  })

  it('returns parsed config when env is valid', () => {
    const env = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      HUBSPOT_CLIENT_SECRET: 'client-secret-hex',
      ODOO_CLIENT_MODE: 'stub',
      PORT: '4321',
      WORKER_CONCURRENCY: '5',
      WORKER_POLL_INTERVAL_MS: '2500',
      MAX_RETRY_ATTEMPTS: '4',
      RETRY_MAX_DELAY_MS: '60000'
    }
    const cfg = load({ env })
    expect(cfg.server.port).toBe(4321)
    expect(cfg.worker.concurrency).toBe(5)
    expect(cfg.worker.pollIntervalMs).toBe(2500)
    expect(cfg.retry.maxAttempts).toBe(4)
    expect(cfg.retry.maxDelayMs).toBe(60000)
    expect(cfg.odoo.mode).toBe('stub')
    expect(cfg.hubspot.clientSecret).toBe('client-secret-hex')
    expect(cfg.hubspot.signatureTimestampToleranceMs).toBe(5 * 60 * 1000)
  })

  it('exposes cfg.hubspot.clientSecret as parsed string', () => {
    const env = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      HUBSPOT_CLIENT_SECRET: 'my-secret'
    }
    const cfg = load({ env })
    expect(cfg.hubspot.clientSecret).toBe('my-secret')
  })

  it('parses HUBSPOT_WEBHOOK_TS_TOLERANCE_MS when provided', () => {
    const env = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      HUBSPOT_CLIENT_SECRET: 'my-secret',
      HUBSPOT_WEBHOOK_TS_TOLERANCE_MS: '120000'
    }
    const cfg = load({ env })
    expect(cfg.hubspot.signatureTimestampToleranceMs).toBe(120000)
  })

  it('defaults signatureTimestampToleranceMs to 5 minutes when missing', () => {
    const env = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      HUBSPOT_CLIENT_SECRET: 'my-secret'
    }
    const cfg = load({ env })
    expect(cfg.hubspot.signatureTimestampToleranceMs).toBe(300000)
  })

  it('accepts custom HubSpot property names', () => {
    const env = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      HUBSPOT_CLIENT_SECRET: 'my-secret',
      HS_PROPERTY_ODOO_CUSTOMER_ID: 'cust',
      HS_PROPERTY_ODOO_ORDER_ID: 'order'
    }
    const cfg = load({ env })
    expect(cfg.hubspot.propertyOdooCustomerId).toBe('cust')
    expect(cfg.hubspot.propertyOdooOrderId).toBe('order')
  })

  it('accepts HS_PROPERTY_ODOO_QUOTE_ID and defaults propertyOdooQuoteId to id_presupuesto_odoo', () => {
    const cfg = load({
      env: {
        MONGODB_URI: 'mongodb://localhost:27017/x',
        HUBSPOT_ACCESS_TOKEN: 'tok',
        HUBSPOT_CLIENT_SECRET: 'my-secret',
        HS_PROPERTY_ODOO_QUOTE_ID: 'id_quote_custom'
      }
    })
    expect(cfg.hubspot.propertyOdooQuoteId).toBe('id_quote_custom')
  })

  it('defaults propertyOdooQuoteId to id_presupuesto_odoo when env var missing', () => {
    const cfg = load({
      env: {
        MONGODB_URI: 'mongodb://localhost:27017/x',
        HUBSPOT_ACCESS_TOKEN: 'tok',
        HUBSPOT_CLIENT_SECRET: 'my-secret'
      }
    })
    expect(cfg.hubspot.propertyOdooQuoteId).toBe('id_presupuesto_odoo')
  })

  it('parses ODOO_DB and ODOO_LOGIN when provided', () => {
    const env = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      HUBSPOT_CLIENT_SECRET: 'my-secret',
      ODOO_CLIENT_MODE: 'http',
      ODOO_BASE_URL: 'https://bsalas.odoo.com/',
      ODOO_DB: 'bsalas',
      ODOO_LOGIN: 'admin@example.com',
      ODOO_API_KEY: 'abc123hex'
    }
    const cfg = load({ env })
    expect(cfg.odoo.mode).toBe('http')
    expect(cfg.odoo.db).toBe('bsalas')
    expect(cfg.odoo.login).toBe('admin@example.com')
    expect(cfg.odoo.apiKey).toBe('abc123hex')
  })

  it('defaults cfg.odoo.db and cfg.odoo.login to empty string when missing', () => {
    const env = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      HUBSPOT_CLIENT_SECRET: 'my-secret',
      ODOO_CLIENT_MODE: 'stub'
    }
    const cfg = load({ env })
    expect(cfg.odoo.db).toBe('')
    expect(cfg.odoo.login).toBe('')
  })

  it('exposes cfg.odoo.defaultCustomerId as parsed string when provided', () => {
    const env = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      HUBSPOT_CLIENT_SECRET: 'my-secret',
      ODOO_DEFAULT_CUSTOMER_ID: '42'
    }
    const cfg = load({ env })
    expect(cfg.odoo.defaultCustomerId).toBe('42')
  })

  it('defaults cfg.odoo.defaultCustomerId to empty string when missing', () => {
    const env = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      HUBSPOT_CLIENT_SECRET: 'my-secret'
    }
    const cfg = load({ env })
    expect(cfg.odoo.defaultCustomerId).toBe('')
  })

  it('normalizes trailing slashes in ODOO_BASE_URL', () => {
    const env = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      HUBSPOT_CLIENT_SECRET: 'my-secret',
      ODOO_BASE_URL: 'https://bsalas.odoo.com/'
    }
    const cfg = load({ env })
    expect(cfg.odoo.baseUrl).toBe('https://bsalas.odoo.com')
  })

  it('auto-loads .env from cwd when called without envFile', () => {
    const saved = {
      MONGODB_URI: process.env.MONGODB_URI,
      HUBSPOT_ACCESS_TOKEN: process.env.HUBSPOT_ACCESS_TOKEN,
      HUBSPOT_CLIENT_SECRET: process.env.HUBSPOT_CLIENT_SECRET
    }
    process.env.HUBSPOT_ACCESS_TOKEN = 'dummy-hubspot'
    process.env.HUBSPOT_CLIENT_SECRET = 'dummy-client-secret'
    delete process.env.MONGODB_URI
    try {
      const cfg = load()
      expect(cfg.mongodbUri).toBe('mongodb://localhost:27017/smartflow')
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  describe('deals allowlist (Pipeline Comercial Visual Branding)', () => {
    const baseEnv = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      HUBSPOT_CLIENT_SECRET: 'my-secret'
    }

    it('defaults cfg.deals.allowedStageIds to ["1409249445"] (Cierre Ganado)', () => {
      const cfg = load({ env: baseEnv })
      expect(cfg.deals.allowedStageIds).toEqual(['1409249445'])
    })

    it('defaults cfg.deals.allowedPipelineIds to Comercial Visual Branding pipeline id', () => {
      const cfg = load({ env: baseEnv })
      expect(cfg.deals.allowedPipelineIds).toEqual([
        't_5728252902aef7e9938dfcbb6cdc2af8'
      ])
    })

    it('defaults cfg.deals.rejectUnknownPipeline to true', () => {
      const cfg = load({ env: baseEnv })
      expect(cfg.deals.rejectUnknownPipeline).toBe(true)
    })

    it('parses HS_ALLOWED_STAGE_IDS as CSV', () => {
      const cfg = load({
        env: { ...baseEnv, HS_ALLOWED_STAGE_IDS: '1409249445,999999' }
      })
      expect(cfg.deals.allowedStageIds).toEqual(['1409249445', '999999'])
    })

    it('parses HS_ALLOWED_PIPELINE_IDS as CSV', () => {
      const cfg = load({
        env: {
          ...baseEnv,
          HS_ALLOWED_PIPELINE_IDS: 't_5728252902aef7e9938dfcbb6cdc2af8,other'
        }
      })
      expect(cfg.deals.allowedPipelineIds).toEqual([
        't_5728252902aef7e9938dfcbb6cdc2af8',
        'other'
      ])
    })

    it('parses HS_REJECT_UNKNOWN_PIPELINE=false to disable strict rejection', () => {
      const cfg = load({ env: { ...baseEnv, HS_REJECT_UNKNOWN_PIPELINE: 'false' } })
      expect(cfg.deals.rejectUnknownPipeline).toBe(false)
    })

    it('ignores whitespace tokens in CSV env vars', () => {
      const cfg = load({
        env: {
          ...baseEnv,
          HS_ALLOWED_STAGE_IDS: '1409249445 , 999999 '
        }
      })
      expect(cfg.deals.allowedStageIds).toEqual(['1409249445', '999999'])
    })
  })

  describe('auto-confirm + MO write-back (Fase 4 — docs/plan-cambios-2026-08-05.md)', () => {
    const baseEnv = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      HUBSPOT_CLIENT_SECRET: 'my-secret'
    }

    it('defaults cfg.odoo.autoConfirmQuotes to false', () => {
      const cfg = load({ env: baseEnv })
      expect(cfg.odoo.autoConfirmQuotes).toBe(false)
    })

    it('parses ODOO_AUTO_CONFIRM_QUOTES=true', () => {
      const cfg = load({ env: { ...baseEnv, ODOO_AUTO_CONFIRM_QUOTES: 'true' } })
      expect(cfg.odoo.autoConfirmQuotes).toBe(true)
    })

    it('defaults cfg.hubspot.propertyManufacturingOrder to numero_orden_fabricacion', () => {
      const cfg = load({ env: baseEnv })
      expect(cfg.hubspot.propertyManufacturingOrder).toBe('numero_orden_fabricacion')
    })

    it('parses HS_PROPERTY_MANUFACTURING_ORDER override', () => {
      const cfg = load({ env: { ...baseEnv, HS_PROPERTY_MANUFACTURING_ORDER: 'numero_mo_custom' } })
      expect(cfg.hubspot.propertyManufacturingOrder).toBe('numero_mo_custom')
    })

    it('defaults cfg.hubspot.propertyQuoteState/propertyQuoteInvoiceStatus (Fase 6)', () => {
      const cfg = load({ env: baseEnv })
      expect(cfg.hubspot.propertyQuoteState).toBe('estado_presupuesto_odoo')
      expect(cfg.hubspot.propertyQuoteInvoiceStatus).toBe('estado_facturacion_odoo')
    })

    it('parses HS_PROPERTY_QUOTE_STATE/HS_PROPERTY_QUOTE_INVOICE_STATUS overrides (Fase 6)', () => {
      const cfg = load({ env: { ...baseEnv, HS_PROPERTY_QUOTE_STATE: 'estado_custom', HS_PROPERTY_QUOTE_INVOICE_STATUS: 'facturacion_custom' } })
      expect(cfg.hubspot.propertyQuoteState).toBe('estado_custom')
      expect(cfg.hubspot.propertyQuoteInvoiceStatus).toBe('facturacion_custom')
    })
  })

  describe('productSync (Fase 3 — docs/plan-cambios-2026-08-05.md continuous job loop)', () => {
    const baseEnv = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      HUBSPOT_CLIENT_SECRET: 'my-secret'
    }

    it('defaults to disabled with a 60s tick interval and 30min orphan watchdog', () => {
      const cfg = load({ env: baseEnv })
      expect(cfg.productSync.jobEnabled).toBe(false)
      expect(cfg.productSync.tickIntervalMs).toBe(60000)
      expect(cfg.productSync.orphanWatchdogMs).toBe(30 * 60 * 1000)
      expect(cfg.productSync.includeNoSku).toBe(false)
    })

    it('parses PRODUCT_SYNC_JOB_ENABLED=true to enable the continuous job loop', () => {
      const cfg = load({ env: { ...baseEnv, PRODUCT_SYNC_JOB_ENABLED: 'true' } })
      expect(cfg.productSync.jobEnabled).toBe(true)
    })

    it('parses PRODUCT_SYNC_TICK_INTERVAL_MS and PRODUCT_SYNC_ORPHAN_WATCHDOG_MS overrides', () => {
      const cfg = load({
        env: { ...baseEnv, PRODUCT_SYNC_TICK_INTERVAL_MS: '15000', PRODUCT_SYNC_ORPHAN_WATCHDOG_MS: '900000' }
      })
      expect(cfg.productSync.tickIntervalMs).toBe(15000)
      expect(cfg.productSync.orphanWatchdogMs).toBe(900000)
    })
  })

  describe('saleOrderStatusSync (Fase 6 — docs/plan-cambios-2026-08-05.md bidireccionalidad)', () => {
    const baseEnv = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      HUBSPOT_CLIENT_SECRET: 'my-secret'
    }

    it('defaults to disabled with a 60s tick interval and 30min orphan watchdog', () => {
      const cfg = load({ env: baseEnv })
      expect(cfg.saleOrderStatusSync.jobEnabled).toBe(false)
      expect(cfg.saleOrderStatusSync.tickIntervalMs).toBe(60000)
      expect(cfg.saleOrderStatusSync.orphanWatchdogMs).toBe(30 * 60 * 1000)
    })

    it('parses SALE_ORDER_STATUS_SYNC_JOB_ENABLED=true to enable the continuous job loop', () => {
      const cfg = load({ env: { ...baseEnv, SALE_ORDER_STATUS_SYNC_JOB_ENABLED: 'true' } })
      expect(cfg.saleOrderStatusSync.jobEnabled).toBe(true)
    })

    it('parses SALE_ORDER_STATUS_SYNC_TICK_INTERVAL_MS and SALE_ORDER_STATUS_SYNC_ORPHAN_WATCHDOG_MS overrides', () => {
      const cfg = load({
        env: { ...baseEnv, SALE_ORDER_STATUS_SYNC_TICK_INTERVAL_MS: '15000', SALE_ORDER_STATUS_SYNC_ORPHAN_WATCHDOG_MS: '900000' }
      })
      expect(cfg.saleOrderStatusSync.tickIntervalMs).toBe(15000)
      expect(cfg.saleOrderStatusSync.orphanWatchdogMs).toBe(900000)
    })
  })

  describe('manufacturingOrderRetrySync (Fase 6 — reintento de MO tardía)', () => {
    const baseEnv = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      HUBSPOT_CLIENT_SECRET: 'my-secret'
    }

    it('defaults to disabled with a 60s tick interval and 30min orphan watchdog', () => {
      const cfg = load({ env: baseEnv })
      expect(cfg.manufacturingOrderRetrySync.jobEnabled).toBe(false)
      expect(cfg.manufacturingOrderRetrySync.tickIntervalMs).toBe(60000)
      expect(cfg.manufacturingOrderRetrySync.orphanWatchdogMs).toBe(30 * 60 * 1000)
    })

    it('parses MANUFACTURING_ORDER_RETRY_SYNC_JOB_ENABLED=true to enable the continuous job loop', () => {
      const cfg = load({ env: { ...baseEnv, MANUFACTURING_ORDER_RETRY_SYNC_JOB_ENABLED: 'true' } })
      expect(cfg.manufacturingOrderRetrySync.jobEnabled).toBe(true)
    })

    it('parses MANUFACTURING_ORDER_RETRY_SYNC_TICK_INTERVAL_MS and _ORPHAN_WATCHDOG_MS overrides', () => {
      const cfg = load({
        env: { ...baseEnv, MANUFACTURING_ORDER_RETRY_SYNC_TICK_INTERVAL_MS: '15000', MANUFACTURING_ORDER_RETRY_SYNC_ORPHAN_WATCHDOG_MS: '900000' }
      })
      expect(cfg.manufacturingOrderRetrySync.tickIntervalMs).toBe(15000)
      expect(cfg.manufacturingOrderRetrySync.orphanWatchdogMs).toBe(900000)
    })
  })
})
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

  it('accepts custom header name and HubSpot property names', () => {
    const env = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      HUBSPOT_CLIENT_SECRET: 'my-secret',
      WEBHOOK_SHARED_SECRET_HEADER_NAME: 'X-Custom-Secret',
      HS_PROPERTY_ODOO_CUSTOMER_ID: 'cust',
      HS_PROPERTY_ODOO_ORDER_ID: 'order'
    }
    const cfg = load({ env })
    expect(cfg.webhook.headerName).toBe('x-custom-secret')
    expect(cfg.hubspot.propertyOdooCustomerId).toBe('cust')
    expect(cfg.hubspot.propertyOdooOrderId).toBe('order')
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

  it('does not require WEBHOOK_SHARED_SECRET (legacy/optional)', () => {
    const env = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      HUBSPOT_CLIENT_SECRET: 'my-secret'
    }
    expect(() => load({ env })).not.toThrow()
    const cfg = load({ env })
    expect(cfg.webhook.sharedSecret).toBe('')
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
})
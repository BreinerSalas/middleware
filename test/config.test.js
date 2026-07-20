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

  it('returns parsed config when env is valid', () => {
    const env = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      WEBHOOK_SHARED_SECRET: 's',
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
    expect(cfg.webhook.headerName).toBe('x-smartflow-secret')
  })

  it('accepts custom header name and HubSpot property names', () => {
    const env = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      WEBHOOK_SHARED_SECRET: 's',
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
      WEBHOOK_SHARED_SECRET: 's',
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
      WEBHOOK_SHARED_SECRET: 's',
      ODOO_CLIENT_MODE: 'stub'
    }
    const cfg = load({ env })
    expect(cfg.odoo.db).toBe('')
    expect(cfg.odoo.login).toBe('')
  })

  it('normalizes trailing slashes in ODOO_BASE_URL', () => {
    const env = {
      MONGODB_URI: 'mongodb://localhost:27017/x',
      HUBSPOT_ACCESS_TOKEN: 'tok',
      WEBHOOK_SHARED_SECRET: 's',
      ODOO_BASE_URL: 'https://bsalas.odoo.com/'
    }
    const cfg = load({ env })
    expect(cfg.odoo.baseUrl).toBe('https://bsalas.odoo.com')
  })
})

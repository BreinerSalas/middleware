#!/usr/bin/env node
'use strict'

/**
 * Read-only staging probes for the "product image URL → HubSpot" feature.
 * Implements I1-I9 from docs/plan-cambios-2026-08-05.md § Fase 1.
 *
 * Strictly read-only against Odoo (search/search_count/search_read/fields_get/read
 * plus anonymous HTTP GETs on /web/image/...). Against HubSpot it only reads
 * property schemas, UNLESS --provision is passed, in which case I7 creates the
 * url_imagen_odoo custom property on products (idempotent: skipped if it exists).
 *
 * Reuses buildOdooRpc / buildHubspotHttpClient exported from hubspot-quote-readiness.js
 * so we keep one canonical JSON-RPC and HTTP client shape.
 *
 * Run: node scripts/probes/product-image-readiness.js [--out=PATH] [--provision]
 *
 * Compuerta (exit 1 on any fail): I1, I3, I5, I6.
 */

const path = require('node:path')
const axios = require('axios')
const { load } = require('../../src/config')
const { parseArgs } = require('../sync-products.lib')
const { buildOdooRpc, buildHubspotHttpClient } = require('./hubspot-quote-readiness')

const REQUIRED_PROBE_IDS = ['I1', 'I3', 'I5', 'I6']
const WARN_TOLERATED_PROBE_IDS = []

function isFatalFailure(result) {
  if (result.status !== 'fail') return false
  if (WARN_TOLERATED_PROBE_IDS.includes(result.id)) return false
  return true
}

function bytesFromBase64(b64) {
  return typeof b64 === 'string' && b64.length > 0 ? Math.floor((b64.length * 3) / 4) : 0
}

function percentileStats(values) {
  if (values.length === 0) return { p50: 0, max: 0, avg: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const p50 = sorted[Math.floor(sorted.length / 2)]
  const max = sorted[sorted.length - 1]
  const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length)
  return { p50, max, avg }
}

async function probeI1_ImageFieldShape({ exec }) {
  const filterImageFields = (fields) => Object.entries(fields || {})
    .filter(([name]) => /^image/i.test(name))
    .map(([name, def]) => ({ name, type: (def && def.type) || null, string: (def && def.string) || null, store: (def && def.store) === true }))

  const templateFields = await exec('product.template', 'fields_get', [[]], { attributes: ['type', 'string', 'store'] })
  const productFields = await exec('product.product', 'fields_get', [[]], { attributes: ['type', 'string', 'store'] })
  const templateImageFields = filterImageFields(templateFields)
  const productImageFields = filterImageFields(productFields)
  const hasImage1920OnTemplate = templateImageFields.some((f) => f.name === 'image_1920' && f.store)
  const secondFieldOnProduct = productImageFields.find((f) => f.name !== 'image_1920') || null
  const productImage1920Stored = productImageFields.find((f) => f.name === 'image_1920')
  const productImage1920IsComputed = !!productImage1920Stored && productImage1920Stored.store === false

  return {
    id: 'I1',
    status: hasImage1920OnTemplate ? 'pass' : 'fail',
    summary: hasImage1920OnTemplate
      ? `product.template exposes image_1920 as a STORED field (${templateImageFields.length} image field(s)); product.product exposes ${productImageFields.length} image field(s), second field = ${secondFieldOnProduct ? secondFieldOnProduct.name : '∅'}.${productImage1920IsComputed ? ' ⚠️ product.product.image_1920 is a COMPUTED, non-stored field — domain search on it is unreliable (matches everything); always filter via product.template.image_1920 and map to product.product via product_tmpl_id.' : ''}`
      : 'product.template does not expose image_1920 as a stored field on this instance — schema differs from expectation, replan before proceeding',
    data: { templateImageFields, productImageFields, productImage1920IsComputed }
  }
}

async function probeI2_ImageCoverage({ exec }) {
  const templateWithImageIds = await exec('product.template', 'search', [[['image_1920', '!=', false]]])
  const templateTotal = await exec('product.template', 'search_count', [[]])
  const templateWithImage = Array.isArray(templateWithImageIds) ? templateWithImageIds.length : 0
  // product.product.image_1920 is a non-stored computed field (see I1) — a domain search on it
  // matches everything and cannot be trusted. Derive real product.product coverage by joining
  // on product_tmpl_id (a stored field) against the template ids we already know have an image.
  const productWithImage = templateWithImage > 0
    ? await exec('product.product', 'search_count', [[['product_tmpl_id', 'in', templateWithImageIds]]])
    : 0
  const productTotal = await exec('product.product', 'search_count', [[]])
  return {
    id: 'I2',
    status: 'pass',
    summary: `product.template: ${templateWithImage}/${templateTotal} with image; product.product: ${productWithImage}/${productTotal} whose template has an image (derived via product_tmpl_id join — a direct domain on product.product.image_1920 is unreliable, see I1)`,
    data: {
      template: { withImage: templateWithImage, total: templateTotal },
      product: { withImage: productWithImage, total: productTotal }
    }
  }
}

async function selectProductIdsByTemplateImage({ exec, hasImage, limit }) {
  // product.product.image_1920 is a non-stored computed field (see I1): a domain search on it
  // matches everything and cannot be trusted to pick real image-bearing/image-less products.
  // Select reliably via product.template.image_1920 (stored) then map to product.product ids
  // via product_tmpl_id (also stored).
  const tmplIds = await exec('product.template', 'search', [[['image_1920', hasImage ? '!=' : '=', false]]], { limit })
  if (!Array.isArray(tmplIds) || tmplIds.length === 0) return []
  const rows = await exec('product.product', 'search_read', [[['product_tmpl_id', 'in', tmplIds]]], { fields: ['id'], limit })
  return (Array.isArray(rows) ? rows : []).map((r) => Number(r.id))
}

async function probeI3_AnonymousImageUrl({ exec, baseUrl }) {
  const withImageIds = await selectProductIdsByTemplateImage({ exec, hasImage: true, limit: 5 })
  const withoutImageIds = await selectProductIdsByTemplateImage({ exec, hasImage: false, limit: 1 })

  if (!Array.isArray(withImageIds) || withImageIds.length === 0) {
    return {
      id: 'I3',
      status: 'fail',
      summary: 'no product.product with an image found to test anonymous access against.',
      data: { withImageIds, withoutImageIds }
    }
  }

  const anon = axios.create({ timeout: 15000, validateStatus: () => true, maxRedirects: 0, responseType: 'arraybuffer' })
  const cleanBaseUrl = (baseUrl || '').replace(/\/+$/, '')

  async function fetchImage(id) {
    const url = `${cleanBaseUrl}/web/image/product.product/${id}/image_1920`
    const res = await anon.get(url)
    const contentType = res.headers['content-type'] || null
    const contentLength = res.data ? res.data.length : (res.headers['content-length'] ? Number(res.headers['content-length']) : null)
    const location = res.headers.location || null
    return { id, url, status: res.status, contentType, contentLength, location }
  }

  const samples = []
  for (const id of withImageIds) samples.push(await fetchImage(id))
  const baseline = (Array.isArray(withoutImageIds) && withoutImageIds.length > 0) ? await fetchImage(withoutImageIds[0]) : null

  const allOk = samples.every((s) => s.status === 200 && /^image\//.test(s.contentType || ''))
  if (!allOk) {
    const failing = samples.find((s) => !(s.status === 200 && /^image\//.test(s.contentType || '')))
    return {
      id: 'I3',
      status: 'fail',
      summary: `anonymous GET on product.product/${failing.id}/image_1920 returned ${failing.status} (${failing.contentType || '∅'})${failing.location ? `, redirect to ${failing.location}` : ''} — image is not publicly reachable without Odoo credentials.`,
      data: { samples, baseline }
    }
  }

  const looksLikePlaceholder = !!baseline && baseline.status === 200 &&
    samples.every((s) => s.contentLength != null && s.contentLength === baseline.contentLength)
  if (looksLikePlaceholder) {
    return {
      id: 'I3',
      status: 'fail',
      summary: `anonymous GET returns HTTP 200 for every sampled id but ALL return the identical ${samples[0].contentLength}-byte payload — including the no-image baseline. This is Odoo's placeholder image, not the real product photo; the 200 status is a false positive. Anonymous access does NOT serve real images on this instance — Approach A is ruled out, build Approach B (middleware proxy).`,
      data: { samples, baseline }
    }
  }

  return {
    id: 'I3',
    status: 'pass',
    summary: `anonymous GET on ${samples.length} product image(s) all returned 200 with image/* content-type, distinct from the no-image baseline (${baseline ? baseline.contentLength : '∅'} bytes). Approach A (direct Odoo URL) is viable.`,
    data: { samples, baseline }
  }
}

async function probeI4_PublishedAcl({ exec }) {
  const fields = await exec('product.template', 'fields_get', [['website_published']], { attributes: ['type', 'string'] })
  const hasField = !!(fields && fields.website_published)
  if (!hasField) {
    return {
      id: 'I4',
      status: 'warn',
      summary: 'product.template has no website_published field on this instance (eCommerce/website module likely not installed) — cannot explain an I3 failure via ACL/publish state.',
      data: { hasField }
    }
  }

  const templateIds = await exec('product.template', 'search', [[['image_1920', '!=', false]]], { limit: 5 })
  const rows = Array.isArray(templateIds) && templateIds.length > 0
    ? await exec('product.template', 'read', [templateIds], { fields: ['id', 'name', 'website_published'] })
    : []
  const publishedCount = (Array.isArray(rows) ? rows : []).filter((r) => r.website_published === true).length

  return {
    id: 'I4',
    status: 'pass',
    summary: `${publishedCount}/${rows.length} sampled templates have website_published=true`,
    data: { hasField, rows }
  }
}

async function probeI5_HubspotProductScopes({ hubspot }) {
  const checks = [
    { name: 'crm.objects.products.read', method: 'get', url: '/crm/v3/objects/products?limit=1' },
    { name: 'crm.schemas.products.read', method: 'get', url: '/crm/v3/properties/products?limit=1' }
  ]
  const results = []
  for (const c of checks) {
    try {
      await hubspot.request({ method: c.method, url: c.url })
      results.push({ scope: c.name, status: 'ok' })
    } catch (err) {
      const http = err.response && err.response.status
      results.push({ scope: c.name, status: http === 403 ? 'missing' : 'warn', httpStatus: http })
    }
  }
  const missing = results.filter((r) => r.status === 'missing').map((r) => r.scope)
  return {
    id: 'I5',
    status: missing.length === 0 ? 'pass' : 'fail',
    summary: missing.length === 0
      ? 'product read/schema scopes are present on the token.'
      : `missing scopes: ${missing.join(', ')}. Re-issue the Private App with crm.objects.products.read/write and crm.schemas.products.read/write.`,
    data: { results, missing }
  }
}

async function probeI6_NativeImageProperty({ hubspot }) {
  const res = await hubspot.get('/crm/v3/properties/products')
  const properties = (res.data && res.data.results) || []
  const hsImages = properties.find((p) => p.name === 'hs_images') || null
  const fileProps = properties
    .filter((p) => p.type === 'file')
    .map((p) => ({ name: p.name, label: p.label, fieldType: p.fieldType }))

  return {
    id: 'I6',
    status: hsImages ? 'pass' : 'warn',
    summary: hsImages
      ? `hs_images exists (type=${hsImages.type}/${hsImages.fieldType}) — still verify the quote template actually renders it before assuming a URL-only property is enough. ${fileProps.length} file-type propert(y/ies) also present: ${fileProps.map((p) => p.name).join(', ') || '∅'}`
      : `hs_images not found on products (${properties.length} properties total). A plain text/URL custom property may be insufficient to render an image on the quote — verify against a real quote template before building the sync.`,
    data: { hsImages, fileProps, propertyCount: properties.length }
  }
}

async function probeI7_CustomPropertyState({ hubspot, provision }) {
  const propertyName = 'url_imagen_odoo'
  const url = `/crm/v3/properties/products/${propertyName}`
  try {
    const res = await hubspot.get(url)
    return {
      id: 'I7',
      status: 'pass',
      summary: `${propertyName} already exists (type=${res.data.type}/${res.data.fieldType}) — do not re-create.`,
      data: { exists: true, property: { name: res.data.name, type: res.data.type, fieldType: res.data.fieldType } }
    }
  } catch (err) {
    const status = err.response && err.response.status
    if (status !== 404) {
      return {
        id: 'I7',
        status: 'warn',
        summary: `GET ${url} returned HTTP ${status}; cannot confirm property state.`,
        data: { exists: null, error: err.message }
      }
    }
  }

  if (!provision) {
    return {
      id: 'I7',
      status: 'pass',
      summary: `${propertyName} does not exist yet (expected). Re-run with --provision to create it.`,
      data: { exists: false, provisioned: false }
    }
  }

  try {
    await hubspot.post('/crm/v3/properties/products', {
      name: propertyName,
      label: 'URL Imagen (Odoo)',
      type: 'string',
      fieldType: 'text',
      groupName: 'productinformation'
    })
    return {
      id: 'I7',
      status: 'pass',
      summary: `${propertyName} created.`,
      data: { exists: false, provisioned: true }
    }
  } catch (err) {
    return {
      id: 'I7',
      status: 'fail',
      summary: `failed to create ${propertyName}: ${err.message}`,
      data: { error: err.message, httpStatus: err.response && err.response.status }
    }
  }
}

async function probeI8_ImageWeight({ exec }) {
  const ids = await selectProductIdsByTemplateImage({ exec, hasImage: true, limit: 10 })
  if (!Array.isArray(ids) || ids.length === 0) {
    return { id: 'I8', status: 'skip', summary: 'no products with images found to sample.', data: {} }
  }

  const rows1920 = await exec('product.product', 'read', [ids], { fields: ['id', 'image_1920'] })
  const rows512 = await exec('product.product', 'read', [ids], { fields: ['id', 'image_512'] })
  const sizes1920 = (Array.isArray(rows1920) ? rows1920 : []).map((r) => bytesFromBase64(r.image_1920)).filter((n) => n > 0)
  const sizes512 = (Array.isArray(rows512) ? rows512 : []).map((r) => bytesFromBase64(r.image_512)).filter((n) => n > 0)
  const stats1920 = percentileStats(sizes1920)
  const stats512 = percentileStats(sizes512)
  const projectedTotalMbAt512 = ((stats512.p50 * 11400) / (1024 * 1024)).toFixed(0)

  return {
    id: 'I8',
    status: 'pass',
    summary: `sampled ${sizes1920.length} image_1920 (p50=${Math.round(stats1920.p50 / 1024)}KB, max=${Math.round(stats1920.max / 1024)}KB) and image_512 (p50=${Math.round(stats512.p50 / 1024)}KB) — projected total at ~11,400 products using image_512: ~${projectedTotalMbAt512}MB`,
    data: { sampleCount: ids.length, image1920: stats1920, image512: stats512, projectedTotalMbAt512: Number(projectedTotalMbAt512) }
  }
}

async function probeI9_WriteDateAvailability({ exec }) {
  const rows = await exec('product.product', 'search_read', [[]], { fields: ['id', 'write_date'], limit: 1, order: 'write_date desc' })
  const mostRecent = Array.isArray(rows) && rows[0] ? rows[0] : null
  const hasWriteDate = !!(mostRecent && mostRecent.write_date)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
  const recentCount = hasWriteDate
    ? await exec('product.product', 'search_count', [[['write_date', '>', sevenDaysAgo]]])
    : null

  return {
    id: 'I9',
    status: hasWriteDate ? 'pass' : 'warn',
    summary: hasWriteDate
      ? `write_date available; ${recentCount} product(s) changed in the last 7 days — incremental sync is viable on this field.`
      : 'write_date not returned by product.product on this instance — incremental sync cannot be built on this field.',
    data: { hasWriteDate, recentCount, mostRecent }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true || args.h === true) {
    process.stdout.write([
      'Usage: node scripts/probes/product-image-readiness.js [--out=PATH] [--provision]',
      '',
      'Read-only staging probes I1-I9 for the product-image-URL feature (Fase 1 of',
      'docs/plan-cambios-2026-08-05.md). Reads Odoo image fields/counts, does anonymous',
      'HTTP GETs against /web/image/product.product/<id>/image_1920 to check public',
      'reachability, and inspects the HubSpot products property schema (hs_images).',
      '--provision additionally creates the url_imagen_odoo custom property if missing.',
      'Writes JSON to --out (default: docs/testing/<UTC-date>-product-image-readiness.json).',
      ''
    ].join('\n'))
    return
  }

  const cfg = load()
  const hubspot = buildHubspotHttpClient({
    baseUrl: cfg.hubspot.apiBase,
    accessToken: cfg.hubspot.accessToken
  })
  const odoo = buildOdooRpc({
    baseUrl: cfg.odoo.baseUrl,
    db: cfg.odoo.db,
    login: cfg.odoo.login,
    apiKey: cfg.odoo.apiKey
  })

  const provision = args.provision === true
  const utcDate = new Date().toISOString().slice(0, 10)
  const defaultOut = `docs/testing/${utcDate}-product-image-readiness.json`
  const outPath = typeof args.out === 'string' ? args.out : defaultOut

  const startedAt = new Date().toISOString()
  const probes = [
    ['I1', () => probeI1_ImageFieldShape({ exec: odoo.executeKw })],
    ['I2', () => probeI2_ImageCoverage({ exec: odoo.executeKw })],
    ['I3', () => probeI3_AnonymousImageUrl({ exec: odoo.executeKw, baseUrl: cfg.odoo.baseUrl })],
    ['I4', () => probeI4_PublishedAcl({ exec: odoo.executeKw })],
    ['I5', () => probeI5_HubspotProductScopes({ hubspot })],
    ['I6', () => probeI6_NativeImageProperty({ hubspot })],
    ['I7', () => probeI7_CustomPropertyState({ hubspot, provision })],
    ['I8', () => probeI8_ImageWeight({ exec: odoo.executeKw })],
    ['I9', () => probeI9_WriteDateAvailability({ exec: odoo.executeKw })]
  ]

  const results = []
  for (const [id, fn] of probes) {
    const t0 = Date.now()
    try {
      const r = await fn()
      r.durationMs = Date.now() - t0
      results.push(r)
      process.stderr.write(`[${r.status.toUpperCase()}] ${id}: ${r.summary}\n`)
    } catch (err) {
      results.push({
        id,
        status: 'fail',
        summary: `probe crashed: ${err.message}`,
        durationMs: Date.now() - t0,
        error: { message: err.message, code: err.code, httpStatus: err.httpStatus, responseData: err.response && err.response.data }
      })
      process.stderr.write(`[FAIL] ${id}: crashed — ${err.message}\n`)
    }
  }

  const blocking = results.filter(isFatalFailure).length
  const passes = results.filter((r) => r.status === 'pass').length
  const warnings = results.filter((r) => r.status === 'warn').length
  const skipped = results.filter((r) => r.status === 'skip').length

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    target: { odooBase: cfg.odoo.baseUrl, odooDb: cfg.odoo.db, hubspotBase: cfg.hubspot.apiBase },
    args: { provision },
    compuerta: { requiredProbeIds: REQUIRED_PROBE_IDS, warnToleratedProbeIds: WARN_TOLERATED_PROBE_IDS },
    summary: { total: results.length, pass: passes, warn: warnings, fail: blocking, skip: skipped },
    results
  }

  const fs = require('node:fs/promises')
  const absOut = path.resolve(outPath)
  await fs.mkdir(path.dirname(absOut), { recursive: true })
  await fs.writeFile(absOut, JSON.stringify(report, null, 2), 'utf8')
  process.stderr.write(`\nwrote ${absOut}\n`)
  process.stderr.write(`summary: pass=${passes} warn=${warnings} fail=${blocking} skip=${skipped}\n`)
  if (blocking > 0) process.exit(1)
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify({ level: 'error', msg: 'probe.fatal', error: err.message, stack: err.stack }) + '\n')
    process.exit(2)
  })
}

module.exports = {
  REQUIRED_PROBE_IDS,
  WARN_TOLERATED_PROBE_IDS,
  isFatalFailure,
  bytesFromBase64,
  percentileStats,
  selectProductIdsByTemplateImage,
  probeI1_ImageFieldShape,
  probeI2_ImageCoverage,
  probeI3_AnonymousImageUrl,
  probeI4_PublishedAcl,
  probeI5_HubspotProductScopes,
  probeI6_NativeImageProperty,
  probeI7_CustomPropertyState,
  probeI8_ImageWeight,
  probeI9_WriteDateAvailability
}

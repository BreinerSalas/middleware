#!/usr/bin/env node
'use strict'

/**
 * Syncs the dropdown of the HubSpot Quote property
 * (HS_PROPERTY_QUOTE_INCOTERM, default 'incoterm_cotizacion') to mirror the
 * live account.incoterms catalog in Odoo: one option per record, keyed by the
 * record's numeric id, labeled "CODE — name" (e.g. "DDP — DELIVERED DUTY PAID").
 *
 * Reads:
 *   - config (HS_PROPERTY_QUOTE_INCOTERM, ODOO_*, HUBSPOT_*)
 *   - Odoo: listIncoterms()
 *   - HubSpot: GET /crm/v3/properties/quotes/<prop>
 *
 * Writes:
 *   - HubSpot: PATCH /crm/v3/properties/quotes/<prop> with the new options[].
 *
 * Run: node scripts/sync-quote-incoterm-options.js [--dry-run]
 *      node scripts/sync-quote-incoterm-options.js --incoterm-prop=incoterm_cotizacion
 */

const { load } = require('../src/config')
const { createLogger } = require('../src/lib/logger')
const { createOdooApiClient } = require('../src/adapters/outbound/odoo/odooApiClient')
const { createHubspotApiClient } = require('../src/adapters/outbound/hubspot/hubspotApiClient')
const { parseArgs } = require('./sync-products.lib')

function compareOptionRecords(a, b) {
  if (a.label < b.label) return -1
  if (a.label > b.label) return 1
  return a.id - b.id
}

function buildLabel(rec, id) {
  const code = rec.code != null && String(rec.code).trim() !== '' ? String(rec.code).trim() : null
  const name = rec.name != null && String(rec.name).trim() !== '' ? String(rec.name).trim() : null
  if (code && name) return `${code} — ${name}`
  if (code) return code
  if (name) return name
  return `account.incoterms #${id}`
}

function buildOptions({ records }) {
  const options = [{ label: 'Sin definir', value: 'sin_definir', displayOrder: 0 }]

  const seenIds = new Set()
  const candidates = []
  for (const rec of (Array.isArray(records) ? records : [])) {
    if (!rec) continue
    const id = Number(rec.id)
    if (!Number.isInteger(id) || id <= 0) continue
    if (seenIds.has(id)) continue
    seenIds.add(id)
    candidates.push({ id, label: buildLabel(rec, id) })
  }

  // HubSpot rejects a property update outright when two options share a
  // label ("Property option labels must be unique") — see
  // scripts/sync-quote-country-options.js for the same safety net.
  const labelCounts = new Map()
  for (const { label } of candidates) {
    labelCounts.set(label, (labelCounts.get(label) || 0) + 1)
  }

  candidates.sort(compareOptionRecords)

  for (const { id, label } of candidates) {
    const finalLabel = labelCounts.get(label) > 1 ? `${label} (${id})` : label
    options.push({ label: finalLabel, value: String(id), displayOrder: options.length })
  }
  return options
}

async function planOptions({ apiClient, hubspot, propertyName, logger }) {
  const incoterms = await apiClient.listIncoterms()
  const records = Array.isArray(incoterms) ? incoterms : []

  if (records.length === 0) {
    const err = new Error(
      'sync-quote-incoterm-options: Odoo returned no account.incoterms records — ' +
      'refusing to publish an empty catalog. Check ODOO_CLIENT_MODE=http and connectivity.'
    )
    err.code = 'EMPTY_INCOTERMS'
    throw err
  }

  const options = buildOptions({ records })

  if (options.length <= 1) {
    const err = new Error(
      'sync-quote-incoterm-options: none of the account.incoterms records produced a valid option ' +
      '(all lacked a positive integer id) — refusing to publish a placeholder-only dropdown.'
    )
    err.code = 'EMPTY_INCOTERM_OPTIONS'
    throw err
  }

  const labelCounts = new Map()
  for (const rec of records) {
    if (!rec) continue
    const id = Number(rec.id)
    if (!Number.isInteger(id) || id <= 0) continue
    const label = buildLabel(rec, id)
    labelCounts.set(label, (labelCounts.get(label) || 0) + 1)
  }
  const duplicateLabels = [...labelCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([label]) => label)
    .sort()
  if (duplicateLabels.length > 0 && logger) {
    logger.warn('sync-quote-incoterm-options: duplicate account.incoterms names detected', { duplicateLabels })
  }

  let currentProperty = null
  let propertyLookupFailed = false
  try {
    currentProperty = await hubspot.getCustomProperty('quotes', propertyName)
  } catch (err) {
    propertyLookupFailed = true
    if (logger) logger.warn('sync-quote-incoterm-options: property lookup failed', { propertyName, error: err.message })
  }

  return { options, records, duplicateLabels, currentProperty, propertyLookupFailed }
}

async function applyOptions({ hubspot, propertyName, options, currentProperty, propertyLookupFailed = false, dryRun, logger }) {
  if (dryRun) {
    if (logger) logger.info('sync-quote-incoterm-options.dry-run', { propertyName, proposed: options, current: currentProperty && currentProperty.options ? currentProperty.options : null })
    return { changed: false, dryRun: true }
  }
  if (propertyLookupFailed || !currentProperty) {
    const err = new Error(
      `sync-quote-incoterm-options: refusing to write "${propertyName}" without a successful property read ` +
      '(label/groupName would silently revert to hardcoded defaults). Re-run once the read succeeds, or pass --dry-run to preview.'
    )
    err.code = 'PROPERTY_LOOKUP_FAILED'
    throw err
  }
  const body = {
    label: (currentProperty && currentProperty.label) || 'Incoterm',
    type: 'enumeration',
    fieldType: 'select',
    groupName: (currentProperty && currentProperty.groupName) || 'quoteinformation',
    options
  }
  await hubspot.updateCustomProperty('quotes', propertyName, body)
  if (logger) logger.info('sync-quote-incoterm-options.updated', { propertyName, optionsCount: options.length })
  return { changed: true, dryRun: false }
}

function resolveDryRun(args) {
  const raw = args && args['dry-run']
  return raw === true || raw === 'true' || raw === 1 || raw === '1'
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true || args.h === true) {
    process.stdout.write([
      'Usage: node scripts/sync-quote-incoterm-options.js [--dry-run] [--incoterm-prop=<name>]',
      '',
      'Syncs the HubSpot Quote Incoterm property dropdown to mirror the live',
      'account.incoterms catalog in Odoo, one option per record.',
      ''
    ].join('\n'))
    return
  }
  const dryRun = resolveDryRun(args)
  const explicitProp = typeof args['incoterm-prop'] === 'string' ? args['incoterm-prop'] : null
  const cfg = load()
  const logger = createLogger({ level: cfg.logging.level })
  const propertyName = explicitProp || cfg.hubspot.propertyQuoteIncoterm || 'incoterm_cotizacion'

  const apiClient = createOdooApiClient({
    mode: cfg.odoo.mode,
    baseUrl: cfg.odoo.baseUrl,
    db: cfg.odoo.db,
    login: cfg.odoo.login,
    apiKey: cfg.odoo.apiKey
  })
  const hubspot = createHubspotApiClient({
    baseUrl: cfg.hubspot.apiBase,
    accessToken: cfg.hubspot.accessToken
  })

  try {
    const plan = await planOptions({ apiClient, hubspot, propertyName, logger })
    const result = await applyOptions({
      hubspot, propertyName, options: plan.options,
      currentProperty: plan.currentProperty, propertyLookupFailed: plan.propertyLookupFailed,
      dryRun, logger
    })
    const out = {
      propertyName,
      dryRun,
      recordCount: plan.records.length,
      duplicateLabels: plan.duplicateLabels,
      options: plan.options,
      currentOptions: plan.currentProperty && plan.currentProperty.options ? plan.currentProperty.options : null,
      result
    }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  } catch (err) {
    process.stderr.write(JSON.stringify({ level: 'error', msg: 'sync-quote-incoterm-options.failed', error: err.message, stack: err.stack }) + '\n')
    process.exit(1)
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify({ level: 'error', msg: 'sync-quote-incoterm-options.fatal', error: err.message, stack: err.stack }) + '\n')
    process.exit(2)
  })
}

module.exports = { planOptions, applyOptions, buildOptions, resolveDryRun }

#!/usr/bin/env node
'use strict'

/**
 * Syncs the dropdown of the HubSpot Quote property
 * (HS_PROPERTY_QUOTE_COUNTRY, default 'pais_de_destino') to mirror the live
 * operation.costs catalog in Odoo: one option per record, keyed by the
 * record's numeric id, labeled with its literal name (e.g. "DDP Costa Rica").
 *
 * Reads:
 *   - config (HS_PROPERTY_QUOTE_COUNTRY, ODOO_*, HUBSPOT_*)
 *   - Odoo: listOperationCosts()
 *   - HubSpot: GET /crm/v3/properties/quotes/<prop>
 *
 * Writes:
 *   - HubSpot: PATCH /crm/v3/properties/quotes/<prop> with the new options[].
 *
 * Run: node scripts/sync-quote-country-options.js [--dry-run]
 *      node scripts/sync-quote-country-options.js --country-prop=pais_de_destino
 */

const path = require('node:path')
const { load } = require('../src/config')
const { createLogger } = require('../src/lib/logger')
const { createOdooApiClient } = require('../src/adapters/outbound/odoo/odooApiClient')
const { createHubspotApiClient } = require('../src/adapters/outbound/hubspot/hubspotApiClient')
const { parseArgs } = require('./sync-products.lib')

// Raw codepoint compare (NOT localeCompare — locale-dependent collation is
// non-deterministic across CI/runtime ICU builds). Ties (identical labels)
// break on ascending numeric id so output ordering is fully deterministic.
function compareOptionRecords(a, b) {
  if (a.label < b.label) return -1
  if (a.label > b.label) return 1
  return a.id - b.id
}

function buildOptions({ records }) {
  // HubSpot rejects enumeration options with a blank ('') value on both create
  // and update ("cannot have options with blank values") — a real, non-empty
  // sentinel is required even for the "no answer yet" placeholder.
  //
  // displayOrder is sent explicitly on every option: when a PATCH omits it,
  // HubSpot auto-assigns it alphabetically by label — confirmed live, where
  // "Sin definir" landed between SX and TT instead of staying first. Pinning
  // it to 0 keeps the placeholder first regardless of which labels
  // alphabetically surround it.
  const options = [{ label: 'Sin definir', value: 'sin_definir', displayOrder: 0 }]

  const seenIds = new Set()
  const candidates = []
  for (const rec of (Array.isArray(records) ? records : [])) {
    if (!rec) continue
    const id = Number(rec.id)
    if (!Number.isInteger(id) || id <= 0) continue
    if (seenIds.has(id)) continue
    seenIds.add(id)
    const rawName = rec.name
    const label = rawName != null && String(rawName).trim() !== ''
      ? String(rawName).trim()
      : `operation.costs #${id}`
    candidates.push({ id, label })
  }
  // HubSpot rejects a property update outright when two options share a
  // label ("Property option labels must be unique") — the operation.costs
  // catalog does have literal-name collisions (e.g. two "DDP Panamá" records
  // for different rollout dates), so a colliding label gets its id appended
  // to stay unique without touching the ones that don't collide.
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
  const ocs = await apiClient.listOperationCosts()
  const records = Array.isArray(ocs) ? ocs : []

  // The catalog is the only source of truth: whatever live operation.costs
  // records Odoo returns is exactly what gets published — the dropdown needs
  // no code change when Odoo gains, loses, or renames a record.
  if (records.length === 0) {
    const err = new Error(
      'sync-quote-country-options: Odoo returned no operation.costs records — ' +
      'refusing to publish an empty catalog. Check ODOO_CLIENT_MODE=http and connectivity.'
    )
    err.code = 'EMPTY_OPERATION_COSTS'
    throw err
  }

  const options = buildOptions({ records })

  // A non-empty operation.costs whose records all lack a valid positive
  // integer id means every record was filtered out during buildOptions — the
  // placeholder alone is not a usable dropdown. Refuse rather than silently
  // publishing just "Sin definir".
  if (options.length <= 1) {
    const err = new Error(
      'sync-quote-country-options: none of the operation.costs records produced a valid option ' +
      '(all lacked a positive integer id) — refusing to publish a placeholder-only dropdown.'
    )
    err.code = 'EMPTY_OPERATION_COSTS_OPTIONS'
    throw err
  }

  const labelCounts = new Map()
  for (const rec of records) {
    if (!rec) continue
    const id = Number(rec.id)
    if (!Number.isInteger(id) || id <= 0) continue
    const rawName = rec.name
    const label = rawName != null && String(rawName).trim() !== ''
      ? String(rawName).trim()
      : `operation.costs #${id}`
    labelCounts.set(label, (labelCounts.get(label) || 0) + 1)
  }
  const duplicateLabels = [...labelCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([label]) => label)
    .sort()
  if (duplicateLabels.length > 0 && logger) {
    logger.warn('sync-quote-country-options: duplicate operation.costs names detected', { duplicateLabels })
  }

  let currentProperty = null
  let propertyLookupFailed = false
  try {
    currentProperty = await hubspot.getCustomProperty('quotes', propertyName)
  } catch (err) {
    propertyLookupFailed = true
    if (logger) logger.warn('sync-quote-country-options: property lookup failed', { propertyName, error: err.message })
  }

  return { options, records, duplicateLabels, currentProperty, propertyLookupFailed }
}

async function applyOptions({ hubspot, propertyName, options, currentProperty, propertyLookupFailed = false, dryRun, logger }) {
  if (dryRun) {
    if (logger) logger.info('sync-quote-country-options.dry-run', { propertyName, proposed: options, current: currentProperty && currentProperty.options ? currentProperty.options : null })
    return { changed: false, dryRun: true }
  }
  // Without a successful read we don't know the real label/groupName, so a
  // write here would silently clobber them with hardcoded defaults. Abort
  // loudly instead of writing blind — this is the one path that mutates a
  // live HubSpot property schema.
  if (propertyLookupFailed || !currentProperty) {
    const err = new Error(
      `sync-quote-country-options: refusing to write "${propertyName}" without a successful property read ` +
      '(label/groupName would silently revert to hardcoded defaults). Re-run once the read succeeds, or pass --dry-run to preview.'
    )
    err.code = 'PROPERTY_LOOKUP_FAILED'
    throw err
  }
  const body = {
    label: (currentProperty && currentProperty.label) || 'País de destino',
    type: 'enumeration',
    fieldType: 'select',
    groupName: (currentProperty && currentProperty.groupName) || 'quoteinformation',
    options
  }
  await hubspot.updateCustomProperty('quotes', propertyName, body)
  if (logger) logger.info('sync-quote-country-options.updated', { propertyName, optionsCount: options.length })
  return { changed: true, dryRun: false }
}

// parseArgs turns `--dry-run=true`/`--dry-run=1` into the string 'true' or the
// number 1 (only bare `--dry-run` yields the boolean true) — match all of
// them, so a mistyped `=true` never silently performs a real write.
function resolveDryRun(args) {
  const raw = args && args['dry-run']
  return raw === true || raw === 'true' || raw === 1 || raw === '1'
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help === true || args.h === true) {
    process.stdout.write([
      'Usage: node scripts/sync-quote-country-options.js [--dry-run] [--country-prop=<name>]',
      '',
      'Syncs the HubSpot Quote property dropdown to mirror the live',
      'operation.costs catalog in Odoo, one option per record.',
      ''
    ].join('\n'))
    return
  }
  const dryRun = resolveDryRun(args)
  const explicitProp = typeof args['country-prop'] === 'string' ? args['country-prop'] : null
  const cfg = load()
  const logger = createLogger({ level: cfg.logging.level })
  const propertyName = explicitProp || cfg.hubspot.propertyQuoteCountry || 'pais_de_destino'

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
    process.stderr.write(JSON.stringify({ level: 'error', msg: 'sync-quote-country-options.failed', error: err.message, stack: err.stack }) + '\n')
    process.exit(1)
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(JSON.stringify({ level: 'error', msg: 'sync-quote-country-options.fatal', error: err.message, stack: err.stack }) + '\n')
    process.exit(2)
  })
}

module.exports = { planOptions, applyOptions, buildOptions, resolveDryRun }

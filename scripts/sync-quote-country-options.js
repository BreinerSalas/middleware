#!/usr/bin/env node
'use strict'

/**
 * Syncs the dropdown of countries on the HubSpot Quote property
 * (HS_PROPERTY_QUOTE_COUNTRY, default 'pais_de_destino') from the set of
 * res.country records that have an operation.costs configured in Odoo.
 *
 * Reads:
 *   - config (HS_PROPERTY_QUOTE_COUNTRY, ODOO_*, HUBSPOT_*)
 *   - Odoo: listOperationCosts() + readCountriesByIds(country ids)
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

function buildOptions({ countries, countriesWithOpCosts, usedIsos }) {
  const seen = new Set()
  // HubSpot rejects enumeration options with a blank ('') value on both create
  // and update ("cannot have options with blank values") — a real, non-empty
  // sentinel is required even for the "no answer yet" placeholder.
  //
  // displayOrder is sent explicitly on every option: when a PATCH omits it,
  // HubSpot auto-assigns it alphabetically by label — confirmed live, where
  // "Sin definir" landed between SX and TT instead of staying first. Pinning
  // it to 0 keeps the placeholder first regardless of which country labels
  // alphabetically surround it.
  const options = [{ label: 'Sin definir', value: 'sin_definir', displayOrder: 0 }]
  for (const iso of usedIsos) {
    if (seen.has(iso)) continue
    seen.add(iso)
    const country = countries && countries[iso]
    const label = country && country.name ? `${iso} — ${country.name}` : iso
    options.push({ label, value: iso, displayOrder: options.length })
  }
  return options
}

async function planOptions({ apiClient, hubspot, propertyName, logger }) {
  const ocs = await apiClient.listOperationCosts()
  const countryIdsWithOc = new Set()
  for (const oc of (Array.isArray(ocs) ? ocs : [])) {
    if (oc && oc.countryId != null) countryIdsWithOc.add(Number(oc.countryId))
  }

  // No fixed ISO allow-list: whatever countries operation.costs actually has
  // configured in Odoo is what gets published — the dropdown is exactly as
  // wide (or narrow) as the real business data, and needs no code change
  // when Odoo gains or loses a country.
  if (countryIdsWithOc.size === 0) {
    const err = new Error(
      'sync-quote-country-options: Odoo returned no operation.costs records with a country — ' +
      'refusing to publish an empty country list. Check ODOO_CLIENT_MODE=http and connectivity.'
    )
    err.code = 'EMPTY_OPERATION_COSTS'
    throw err
  }

  const countriesById = await apiClient.readCountriesByIds([...countryIdsWithOc]) || {}
  const countryMap = {}
  for (const id of countryIdsWithOc) {
    const entry = countriesById[id]
    if (entry && entry.code) countryMap[entry.code] = { id, name: entry.name }
  }

  // A non-empty operation.costs with country ids but nothing resolved means
  // the id->country lookup itself came back empty (stub mode, or a swallowed
  // connectivity failure), not "Odoo genuinely has zero of these countries" —
  // refuse rather than silently publishing a blind list.
  if (Object.keys(countryMap).length === 0) {
    const err = new Error(
      'sync-quote-country-options: Odoo returned no res.country rows for the countries used in operation.costs — ' +
      'refusing to publish a blind country list. Check ODOO_CLIENT_MODE=http and connectivity.'
    )
    err.code = 'EMPTY_COUNTRY_MAP'
    throw err
  }

  const usedIsos = Object.keys(countryMap).sort()

  let currentProperty = null
  let propertyLookupFailed = false
  try {
    currentProperty = await hubspot.getCustomProperty('quotes', propertyName)
  } catch (err) {
    propertyLookupFailed = true
    if (logger) logger.warn('sync-quote-country-options: property lookup failed', { propertyName, error: err.message })
  }

  const options = buildOptions({ countries: countryMap, countriesWithOpCosts: new Set(usedIsos), usedIsos })
  return { options, usedIsos, countryMap, currentProperty, propertyLookupFailed }
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
    label: (currentProperty && currentProperty.label) || 'País de destino (ISO-2)',
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
      'Syncs the dropdown of countries on the HubSpot Quote property',
      'with the set of res.country records that have operation.costs configured.',
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
      usedIsos: plan.usedIsos,
      resolvedCountries: plan.countryMap,
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

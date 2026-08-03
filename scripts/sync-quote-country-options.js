#!/usr/bin/env node
'use strict'

/**
 * Syncs the dropdown of countries on the HubSpot Quote property
 * (HS_PROPERTY_QUOTE_COUNTRY, default 'pais_de_destino') from the set of
 * res.country records that have an operation.costs configured in Odoo.
 *
 * Reads:
 *   - config (HS_PROPERTY_QUOTE_COUNTRY, ODOO_*, HUBSPOT_*)
 *   - Odoo: listOperationCosts() + searchCountryIdsByCodes(ISO codes)
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

const ISO_CODES = ['CR', 'GT', 'HN', 'SV', 'NI', 'PA', 'MX']

function buildOptions({ countries, countriesWithOpCosts, usedIsos }) {
  const seen = new Set()
  const options = [{ label: 'Sin definir', value: '' }]
  for (const iso of usedIsos) {
    if (seen.has(iso)) continue
    seen.add(iso)
    const country = countries && countries[iso]
    const label = country && country.name ? `${iso} — ${country.name}` : iso
    options.push({ label, value: iso })
  }
  return options
}

async function planOptions({ apiClient, hubspot, propertyName, logger }) {
  const ocs = await apiClient.listOperationCosts()
  const countryIdsWithOc = new Set()
  for (const oc of (Array.isArray(ocs) ? ocs : [])) {
    if (oc && oc.countryId != null) countryIdsWithOc.add(Number(oc.countryId))
  }

  const countryMap = await apiClient.searchCountryIdsByCodes(ISO_CODES) || {}
  const usedIsos = []
  for (const iso of ISO_CODES) {
    const country = countryMap[iso]
    if (country && country.id != null && countryIdsWithOc.has(Number(country.id))) {
      usedIsos.push(iso)
    }
  }

  if (usedIsos.length === 0) {
    if (logger) logger.warn('sync-quote-country-options: no operation.costs found for any configured ISO, falling back to all ISOs')
  }

  const finalIsos = usedIsos.length > 0 ? usedIsos : ISO_CODES

  let currentProperty = null
  try {
    currentProperty = await hubspot.getCustomProperty('quotes', propertyName)
  } catch (err) {
    if (logger) logger.warn('sync-quote-country-options: property lookup failed', { propertyName, error: err.message })
  }

  const options = buildOptions({ countries: countryMap, countriesWithOpCosts: new Set(usedIsos), usedIsos: finalIsos })
  return { options, usedIsos: finalIsos, countryMap, currentProperty }
}

async function applyOptions({ hubspot, propertyName, options, currentProperty, dryRun, logger }) {
  if (dryRun) {
    if (logger) logger.info('sync-quote-country-options.dry-run', { propertyName, proposed: options, current: currentProperty && currentProperty.options ? currentProperty.options : null })
    return { changed: false, dryRun: true }
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
  const dryRun = args['dry-run'] === true
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
      currentProperty: plan.currentProperty, dryRun, logger
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

module.exports = { planOptions, applyOptions, buildOptions }

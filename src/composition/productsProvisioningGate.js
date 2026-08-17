'use strict'

const { provisionProperties } = require('./provisionProperties')
const { buildProductPropertyDefinitions } = require('./productPropertyDefinitions')

// Fail-loud provisioning gate for the products custom property
// (openspec/hubspot-product-odoo-id-key design D7). `provisionProperties` swallows per-property
// failures and would otherwise log-and-continue; we MUST throw so the boot halts rather than
// silently degrade to SKU-based matching. Exported here (not from server.js) so it is unit-testable
// in isolation without booting the whole server.
async function runProductsProvisioningGate({ api, hubspotCfg = {}, logger = null } = {}) {
  const productsToProvision = buildProductPropertyDefinitions(hubspotCfg)
  const summary = await provisionProperties({ api, objectType: 'products', properties: productsToProvision, logger })
  const failed = summary.filter((s) => s.status === 'failed')
  if (failed.length > 0) {
    const names = failed.map((f) => f.name).join(', ')
    const err = new Error(`products provisioning failed for: ${names}`)
    err.code = 'PRODUCTS_PROVISIONING_FAILED'
    err.failed = failed
    throw err
  }
  return summary
}

module.exports = { runProductsProvisioningGate }

'use strict'

async function provisionDealProperties({ api, properties = [], logger = null } = {}) {
  if (!api || typeof api.ensureCustomProperty !== 'function') {
    throw new Error('provisionDealProperties requires api with ensureCustomProperty')
  }
  if (!Array.isArray(properties)) {
    throw new Error('provisionDealProperties requires properties to be an array')
  }

  const summary = []
  for (const def of properties) {
    const entry = { name: def.name, label: def.label, created: false, status: 'pending' }
    try {
      const result = await api.ensureCustomProperty('deals', def.name, def)
      entry.created = !!result.created
      entry.status = entry.created ? 'created' : 'existing'
      if (logger && logger.info) {
        logger.info(`hubspot.provision.${entry.status}.${def.name}`, { objectType: 'deals', name: def.name, label: def.label, created: entry.created })
      }
    } catch (err) {
      entry.status = 'failed'
      entry.error = err.message
      if (logger && logger.warn) {
        logger.warn(`hubspot.provision.failed for ${def.name}: ${err.message}`, {
          objectType: 'deals',
          name: def.name,
          error: err.message,
          httpStatus: err.httpStatus,
          code: err.code
        })
      }
    }
    summary.push(entry)
  }
  return summary
}

module.exports = { provisionDealProperties }
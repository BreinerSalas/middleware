'use strict'

async function provisionProperties({ api, objectType, properties = [], logger = null } = {}) {
  if (!api || typeof api.ensureCustomProperty !== 'function') {
    throw new Error('provisionProperties requires api with ensureCustomProperty')
  }
  if (!objectType || typeof objectType !== 'string') {
    throw new Error('provisionProperties requires objectType (string)')
  }
  if (!Array.isArray(properties)) {
    throw new Error('provisionProperties requires properties to be an array')
  }

  const summary = []
  for (const def of properties) {
    const entry = { name: def.name, label: def.label, objectType, created: false, status: 'pending' }
    try {
      const result = await api.ensureCustomProperty(objectType, def.name, def)
      entry.created = !!result.created
      entry.status = entry.created ? 'created' : 'existing'
      if (logger && logger.info) {
        logger.info(`hubspot.provision.${entry.status}.${def.name}`, { objectType, name: def.name, label: def.label, created: entry.created })
      }
    } catch (err) {
      entry.status = 'failed'
      entry.error = err.message
      if (logger && logger.warn) {
        logger.warn(`hubspot.provision.failed for ${def.name}: ${err.message}`, {
          objectType,
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

module.exports = { provisionProperties }

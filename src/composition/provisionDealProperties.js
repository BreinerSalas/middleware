'use strict'

const { provisionProperties } = require('./provisionProperties')

async function provisionDealProperties({ api, properties = [], logger = null } = {}) {
  return provisionProperties({ api, objectType: 'deals', properties, logger })
}

module.exports = { provisionDealProperties, provisionProperties }
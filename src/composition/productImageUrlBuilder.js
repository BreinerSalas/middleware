'use strict'

const { signProductImageToken } = require('../core/shared/mediaSignature')

function buildProductImageUrlBuilder({ urlSecret, publicBaseUrl } = {}) {
  if (!urlSecret || !publicBaseUrl) return null

  return function imageUrlBuilder(odooProduct) {
    const id = odooProduct && Number(odooProduct.id)
    if (!Number.isFinite(id) || id <= 0) return ''
    const token = signProductImageToken(id, urlSecret)
    return `${publicBaseUrl}/media/products/${token}/image`
  }
}

module.exports = { buildProductImageUrlBuilder }

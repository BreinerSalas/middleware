'use strict'

const fp = require('fastify-plugin')
const { verifyProductImageToken } = require('../../../core/shared/mediaSignature')
const { createRateLimiter } = require('../../../core/shared/rateLimiter')

const MAGIC = [
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { type: 'image/bmp', bytes: [0x42, 0x4d] }
]

function sniffImageContentType(buf) {
  if (Buffer.isBuffer(buf) && buf.length >= 12 &&
      buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  for (const m of MAGIC) {
    if (buf.length >= m.bytes.length && m.bytes.every((b, i) => buf[i] === b)) return m.type
  }
  return 'application/octet-stream'
}

function etagFor(writeDate) {
  if (!writeDate) return null
  return `"${Buffer.from(String(writeDate)).toString('base64url')}"`
}

async function mediaRoutesImpl(fastify, opts) {
  const { odooApiClient, mediaConfig, rateLimiter = null, logger = null } = opts || {}
  if (!odooApiClient) throw new Error('createMediaRoutes requires odooApiClient')
  if (!mediaConfig || !mediaConfig.urlSecret) throw new Error('createMediaRoutes requires mediaConfig.urlSecret')

  const limiter = rateLimiter || createRateLimiter({ rps: 5, burst: 10 })

  fastify.get('/media/products/:token/image', async (req, reply) => {
    const odooId = verifyProductImageToken(req.params.token, mediaConfig.urlSecret)
    if (odooId == null) {
      return reply.code(404).send({ ok: false, error: 'not_found' })
    }

    const etag = req.headers['if-none-match']

    await limiter.take()

    let image
    try {
      image = await odooApiClient.readProductImage(odooId)
    } catch (err) {
      if (logger && logger.warn) logger.warn('media.image.fetch_failed', { odooId, error: err.message })
      return reply.code(502).send({ ok: false, error: 'upstream_error' })
    }
    if (!image) {
      return reply.code(404).send({ ok: false, error: 'not_found' })
    }

    const computedEtag = etagFor(image.writeDate)
    if (computedEtag && etag === computedEtag) {
      reply.header('Cache-Control', 'public, max-age=86400')
      reply.header('ETag', computedEtag)
      return reply.code(304).send()
    }

    const buf = Buffer.from(image.base64, 'base64')
    reply.header('Cache-Control', 'public, max-age=86400')
    if (computedEtag) reply.header('ETag', computedEtag)
    reply.type(sniffImageContentType(buf))
    return reply.send(buf)
  })
}

module.exports = fp(mediaRoutesImpl, { name: 'media-routes' })
module.exports.createMediaRoutes = module.exports
module.exports.sniffImageContentType = sniffImageContentType

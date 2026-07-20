'use strict'

function createHealthRoutes({ mongo }) {
  return async function healthRoutes(app) {
    app.get('/health', async (req, reply) => {
      let mongoState = 'down'
      try {
        if (mongo && typeof mongo.ping === 'function') {
          await mongo.ping()
          mongoState = 'up'
        } else if (mongo && typeof mongo.readyState === 'number') {
          mongoState = mongo.readyState === 1 ? 'up' : 'down'
        }
      } catch (_) {
        mongoState = 'down'
      }
      const code = mongoState === 'up' ? 200 : 503
      return reply.code(code).send({ ok: mongoState === 'up', mongo: mongoState, ts: new Date().toISOString() })
    })
  }
}

module.exports = { createHealthRoutes }

'use strict'

function createHealthRoutes({ mongo }) {
  return async function healthRoutes(app) {
    app.get('/health', async (req, reply) => {
      let mongoState = 'down'
      try {
        if (mongo && typeof mongo.readyState === 'number') {
          mongoState = mongo.readyState === 1 ? 'up' : 'down'
        }
        if (mongoState === 'up' && mongo && typeof mongo.db === 'function' && mongo.db()) {
          await mongo.db().admin().ping()
        } else if (mongoState === 'up' && mongo && typeof mongo.admin === 'function') {
          await mongo.admin().ping()
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

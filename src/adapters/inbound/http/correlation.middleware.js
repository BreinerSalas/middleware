'use strict'

const { v4: uuidv4 } = require('uuid')

function createCorrelationMiddleware({ headerName = 'x-correlation-id' } = {}) {
  return async function correlationMiddleware(req, reply) {
    const incoming = req.headers && req.headers[headerName.toLowerCase()]
    const id = incoming ? String(incoming) : uuidv4()
    req.correlationId = id
    reply.header(headerName, id)
  }
}

module.exports = { createCorrelationMiddleware }

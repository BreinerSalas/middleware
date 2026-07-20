'use strict'

const mongoose = require('mongoose')

async function connectMongo({ uri, logger = null } = {}) {
  if (!uri) throw new Error('connectMongo requires uri')
  mongoose.set('strictQuery', true)
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 })
  if (logger) logger.info('mongo.connected')
  return mongoose.connection
}

async function disconnectMongo({ logger = null } = {}) {
  try {
    await mongoose.disconnect()
    if (logger) logger.info('mongo.disconnected')
  } catch (err) {
    if (logger) logger.warn('mongo.disconnect failed', { error: err.message })
  }
}

module.exports = { connectMongo, disconnectMongo, mongoose }

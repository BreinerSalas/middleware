'use strict'

const { Schema, model } = require('mongoose')

const SyncCursorSchema = new Schema({
  key: { type: String, required: true, unique: true, index: true },
  watermark: { type: String, default: null },
  updatedAt: { type: Date, default: () => new Date() }
}, { versionKey: false })

module.exports = { SyncCursorSchema, SyncCursorModel: model('SyncCursor', SyncCursorSchema) }

'use strict'

const { Schema, model } = require('mongoose')

const DedupeSchema = new Schema({
  key: { type: String, required: true, unique: true, index: true },
  createdAt: { type: Date, default: () => new Date(), expires: 300 }
}, { versionKey: false })

module.exports = { DedupeSchema, DedupeModel: model('Dedupe', DedupeSchema) }

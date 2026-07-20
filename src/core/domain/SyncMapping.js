'use strict'

const { createHash } = require('node:crypto')

function hashPayload(payload) {
  if (payload == null) return null
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return createHash('sha256').update(serialized).digest('hex').slice(0, 32)
}

class SyncMapping {
  constructor({
    sourceId,
    targetId = null,
    targetRef = null,
    payloadHash = null,
    lastSyncedAt = null,
    metadata = {},
    _id = null,
    createdAt = null,
    updatedAt = null
  } = {}) {
    if (!sourceId) throw new Error('SyncMapping requires sourceId')
    this._id = _id
    this.sourceId = sourceId
    this.targetId = targetId
    this.targetRef = targetRef
    this.payloadHash = payloadHash
    this.lastSyncedAt = lastSyncedAt || new Date()
    this.metadata = metadata
    this.createdAt = createdAt || new Date()
    this.updatedAt = updatedAt || new Date()
  }

  applyUpsert({ targetId = this.targetId, targetRef = this.targetRef, payloadHash = this.payloadHash, metadata = this.metadata, now = new Date() } = {}) {
    this.targetId = targetId
    this.targetRef = targetRef
    this.payloadHash = payloadHash != null ? payloadHash : this.payloadHash
    this.metadata = { ...this.metadata, ...metadata }
    this.lastSyncedAt = now
    this.updatedAt = now
    return this
  }

  toJSON() {
    return {
      _id: this._id,
      sourceId: this.sourceId,
      targetId: this.targetId,
      targetRef: this.targetRef,
      payloadHash: this.payloadHash,
      lastSyncedAt: this.lastSyncedAt,
      metadata: this.metadata,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt
    }
  }
}

module.exports = { SyncMapping, hashPayload }

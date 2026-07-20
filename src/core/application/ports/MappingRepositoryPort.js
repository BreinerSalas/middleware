'use strict'

/**
 * Port: MappingRepositoryPort
 *
 * @typedef {Object} SyncMappingDoc
 * @property {string|null} _id
 * @property {string} sourceId
 * @property {string|null} targetId
 * @property {string|null} targetRef
 * @property {string|null} payloadHash
 * @property {Date|null} lastSyncedAt
 * @property {Object} metadata
 */

/**
 * @typedef {Object} MappingRepositoryPort
 * @property {(sourceId: string) => Promise<SyncMappingDoc|null>} findBySourceId
 * @property {(doc: SyncMappingDoc) => Promise<SyncMappingDoc>} upsert
 */

module.exports = {
  name: 'MappingRepositoryPort',
  description: 'Persistent mapping from sourceId -> targetId/Ref'
}

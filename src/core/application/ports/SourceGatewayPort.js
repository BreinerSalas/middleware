'use strict'

/**
 * Port: SourceGatewayPort
 *
 * The system-of-record (HubSpot in this project). Responsible for fetching
 * the canonical record, resolving associated references, and writing the
 * target identifier back to the source.
 *
 * @typedef {Object} SourceRecord
 * @property {string} id
 * @property {Object} properties
 * @property {Object} [associations]
 */

/**
 * @typedef {Object} SourceGatewayPort
 * @property {(sourceId: string) => Promise<SourceRecord>} fetchRecord
 * @property {(record: SourceRecord) => Promise<{[key: string]: any}>} resolveReferences
 * @property {(sourceId: string, properties: {[propertyName: string]: any}) => Promise<void>} writeBack
 */

module.exports = {
  name: 'SourceGatewayPort',
  description: 'System-of-record gateway (HubSpot)'
}

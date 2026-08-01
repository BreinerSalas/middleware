'use strict'

/**
 * Port: TargetGatewayPort
 *
 * The downstream system (Odoo in this project). Performs UPSERT semantics:
 * when `existingTargetId` is provided the implementation must update; when
 * null it must create. Implementations are responsible for translating the
 * generic record/references into the target's native payload — the use case
 * stays generic.
 *
 * @typedef {Object} UpsertResult
 * @property {string} targetId
 * @property {string|null} targetRef
 * @property {string|null} syncToken
 * @property {Object} [raw]
 * @property {string} salesOrderId  Deprecated alias for targetId (kept for backwards compat).
 * @property {Object} [metadata]    Free-form, persisted into mapping.metadata. Example shape:
 *                                  { countryExpense: { status, id, countryId, countryName, reason, matches, ambiguous } }
 */

/**
 * @typedef {Object} UpsertInput
 * @property {string|null} existingTargetId
 * @property {any} record
 * @property {{[key: string]: any}} references
 * @property {string|null} correlationId
 */

/**
 * @typedef {Object} TargetGatewayPort
 * @property {(input: UpsertInput) => Promise<UpsertResult>} upsert
 */

module.exports = {
  name: 'TargetGatewayPort',
  description: 'Downstream UPSERT gateway (Odoo)'
}

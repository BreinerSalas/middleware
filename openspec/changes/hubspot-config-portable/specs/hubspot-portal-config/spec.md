# Delta for Hubspot Portal Config

## Purpose

Deployment-supplied HubSpot portal identifiers (deal stage allowlist, pipeline allowlist, closed-won stage ID) required at boot, with zero code-embedded tenant defaults.

## ADDED Requirements

### Requirement: Required Portal Config Keys, No Literal Fallback

The system MUST source `config.deals.allowedStageIds`, `config.deals.allowedPipelineIds`, and `config.deals.closedWonStageId` exclusively from the env vars `HS_ALLOWED_STAGE_IDS`, `HS_ALLOWED_PIPELINE_IDS`, and `HS_CLOSED_WON_STAGE_ID` respectively. All three MUST be required keys, independent of which sync flows a given deployment composes. No source file MUST contain a literal portal stage/pipeline ID as a fallback value.

#### Scenario: Boot succeeds when all three keys are set

- GIVEN `HS_ALLOWED_STAGE_IDS`, `HS_ALLOWED_PIPELINE_IDS`, and `HS_CLOSED_WON_STAGE_ID` are all present in the environment
- WHEN the config loader runs
- THEN `config.deals.allowedStageIds`, `config.deals.allowedPipelineIds`, and `config.deals.closedWonStageId` are populated from those env vars, with no literal substituted

#### Scenario: Boot refuses to start when any key is missing

- GIVEN one or more of `HS_ALLOWED_STAGE_IDS`, `HS_ALLOWED_PIPELINE_IDS`, `HS_CLOSED_WON_STAGE_ID` is absent or empty
- WHEN the config loader runs
- THEN it throws an error with `code: 'CONFIG_MISSING'` naming every missing key, and no `HubspotSourceGateway` is constructed

### Requirement: Closed-Won Stage ID Is Its Own Config Field

`config.deals.closedWonStageId` MUST be a single string sourced from `HS_CLOSED_WON_STAGE_ID`. It MUST NOT be derived from `config.deals.allowedStageIds` (e.g. `allowedStageIds[0]`); the two are semantically distinct (one ID vs. an array of allowed stages for validation).

#### Scenario: Closed-won ID is independent of the allowed-stages array

- GIVEN `HS_CLOSED_WON_STAGE_ID` differs from every entry in `HS_ALLOWED_STAGE_IDS`
- WHEN config loads
- THEN `config.deals.closedWonStageId` equals `HS_CLOSED_WON_STAGE_ID` exactly, unaffected by the contents or order of `config.deals.allowedStageIds`

### Requirement: Single Source of Truth Across Consumers

`src/server.js`, `src/composition/dealSyncModule.js`, and `src/adapters/outbound/hubspot/HubspotSourceGateway.js` MUST all obtain the closed-won stage ID via `config.deals.closedWonStageId`. No file MUST import the constant `DEAL_STAGE_CLOSED_WON_ID`, and `HubspotSourceGateway` MUST NOT contain an embedded default stage ID.

#### Scenario: No direct constant imports remain

- GIVEN the codebase after this change
- WHEN `DEAL_STAGE_CLOSED_WON_ID` is searched for as an import
- THEN no file outside `config/index.js`'s own required-key wiring imports it, and `HubspotSourceGateway.js` has no `DEFAULT_CLOSED_WON_STAGE_ID`-style literal

### Requirement: `revertDealStage` Fails Loud on an Invalid Closed-Won ID

`HubspotSourceGateway.revertDealStage` MUST validate that `this.closedWonStageId` is a non-empty configured value before comparing it against the deal's current stage. If it is missing, `undefined`, or empty, `revertDealStage` MUST throw an explicit error instead of silently performing `currentStage !== this.closedWonStageId` against an unset value and returning early.

#### Scenario: Missing closed-won ID throws instead of silently no-op-ing the guard

- GIVEN a `HubspotSourceGateway` instance whose `closedWonStageId` was never configured
- WHEN `revertDealStage(sourceId)` is called
- THEN it throws an explicit error before evaluating the stage-history comparison, and the anti-ping-pong guard is never silently bypassed

#### Scenario: Valid closed-won ID reverts as before

- GIVEN a `HubspotSourceGateway` instance constructed with a valid `closedWonStageId` matching the deal's current stage in history
- WHEN `revertDealStage(sourceId)` is called
- THEN it proceeds to resolve and write back the previous stage, unchanged from current behavior

### Requirement: Validation Is Point-of-Use, Not Constructor-Wide

Constructing a `HubspotSourceGateway` without `closedWonStageId` MUST NOT throw. The requirement to have a valid `closedWonStageId` applies only at the moment `revertDealStage` is invoked, so instances that never call it remain valid without the value.

#### Scenario: Instance without closedWonStageId works normally when revertDealStage is never called

- GIVEN a `HubspotSourceGateway` instance built for manufacturing-order-retry, with no `closedWonStageId` passed and no caller ever invoking `revertDealStage`
- WHEN that instance is constructed and used for `fetchRecord`/`writeBack`
- THEN construction succeeds and normal operations are unaffected by the missing value

#### Scenario: Same kind of instance throws only if revertDealStage is later called

- GIVEN a `HubspotSourceGateway` instance with no `closedWonStageId`
- WHEN some caller invokes `revertDealStage` on it
- THEN it throws per the previous requirement, rather than the construction step

### Requirement: No Functional Regression for the Existing Single Deployment

Once `HS_CLOSED_WON_STAGE_ID` is added alongside the existing `HS_ALLOWED_STAGE_IDS`/`HS_ALLOWED_PIPELINE_IDS`, boot and the deal webhook → job → Odoo sale-order flow MUST behave identically to before this change.

#### Scenario: Deal webhook flow is unaffected

- GIVEN local `.env` sets all three required keys to the values matching today's deployed portal
- WHEN a deal webhook is processed end-to-end
- THEN the resulting job, validators, and Odoo sale-order creation behave exactly as before the literals were removed

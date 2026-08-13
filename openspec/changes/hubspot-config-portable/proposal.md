# Proposal: HubSpot Portal Config Portable (coupling #3)

> Prior analysis: `openspec/changes/archive/2026-08-13-toolkit-generico/exploration.md` (coupling #3). Not re-explored; findings still hold.

## Intent

`ARQUITECTURA.md` §11.2 #3: one HubSpot portal's stage/pipeline IDs are hardcoded in **three** files (`config/constants.js`, `HubspotSourceGateway`'s own `DEFAULT_CLOSED_WON_STAGE_ID`, plus two call sites bypassing `config.deals`). A second portal cannot be configured, and a missing env var silently falls back to another tenant's IDs. No production deployment exists yet and local `.env` already sets both allowlists, so the migration risk that deferred this is gone.

## Scope

### In Scope
- Remove both portal literals from `config/constants.js`.
- Make `HS_ALLOWED_STAGE_IDS`, `HS_ALLOWED_PIPELINE_IDS` and a new `HS_CLOSED_WON_STAGE_ID` **required** — boot fails with `CONFIG_MISSING` naming them.
- Add `config.deals.closedWonStageId` (single ID, distinct from the `allowedStageIds` array).
- Route `server.js` and `dealSyncModule.js` through it; delete the gateway's embedded default and make `revertDealStage` throw when the ID is absent.
- Rewrite tests pinning `'1409249445'` as an expected default.

### Out of Scope
- Coupling #5 (`PlanDealSyncUseCase`), validator internals, Mongoose singleton.
- Making other portal-shaped values (quote statuses, property names) required.

## Capabilities

### New Capabilities
- `hubspot-portal-config`: deployment-supplied HubSpot portal identifiers, required at boot, no code-embedded tenant defaults.

### Modified Capabilities
- None.

## Approach

Single source of truth in `config.deals`; fail-fast at load; consumers read config only. Same philosophy as coupling #1 (`buildWriteBackPayload` now throws). Strict TDD: red tests for `CONFIG_MISSING` and the gateway guard first, then delete literals and stale default assertions.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/config/constants.js` | Removed | Both portal literals and their exports |
| `src/config/index.js` | Modified | 3 keys → `REQUIRED_KEYS`; add `closedWonStageId`; drop array fallbacks |
| `src/server.js`, `src/composition/dealSyncModule.js` | Modified | Consume config instead of the constant |
| `src/adapters/outbound/hubspot/HubspotSourceGateway.js` | Modified | Drop embedded default; guard `revertDealStage` |
| `test/config.test.js`, `test/adapters/hubspot/HubspotSourceGateway.test.js` | Modified | Replace default assertions with fail-fast ones |
| `.env`, deploy notes | Modified | Document `HS_CLOSED_WON_STAGE_ID` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `revertDealStage` silently stops reverting when ID unset | Med | Throw, never compare against `undefined` |
| Every `load()` test baseEnv must add 3 keys | High | Mechanical; shared helper |
| Non-deal flows also blocked from booting | Med | Accepted (single deployment); open question below |
| Local `.env` value ≠ removed literal | Low | Assert equality manually before merge |

## Rollback Plan

Revert the branch commits; literals return with the old fallbacks. No data migration, no deployed state.

## Dependencies

- `HS_CLOSED_WON_STAGE_ID=1409249445` added to local `.env` before the app can boot.

## Manual Verification

- Boot with a key removed → refuses to start, error names the key.
- Boot with all keys → deal webhook → job → Odoo sale order, unchanged.
- Cancel the Odoo order → deal stage reverts once (anti-ping-pong guard intact).

## Success Criteria

- [ ] No `1409249445` / `t_5728252902aef7e9938dfcbb6cdc2af8` outside tests and docs
- [ ] Missing any of the 3 keys → `CONFIG_MISSING` at boot
- [ ] `npm test` green; deal flow manually verified against real HubSpot

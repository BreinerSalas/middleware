# Tasks: HubSpot Portal Config Portable

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 150-200 |
| 400-line budget risk | Low |
| Chained PRs recommended | No |
| Suggested split | Single PR |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Single atomic change (config, gateway, consumers, constants, docs) | PR 1 | `npm test` | Boot with each key unset → `CONFIG_MISSING`; full boot → deal webhook → job → Odoo sale order → cancel → single revert | `git revert` of one merge; no schema/data touched |

Design decision #6: files form a dependency cycle, no disjoint slicing exists.

## Phase 1: RED — Required Config Keys (`test/config.test.js`)

- [x] 1.1 Add module-level `PORTAL_ENV` const (3 keys).
- [x] 1.2 Test: missing 3 keys → `CONFIG_MISSING` naming each.
- [x] 1.3 Test: `closedWonStageId` equals `HS_CLOSED_WON_STAGE_ID` exactly, independent of `allowedStageIds`.
- [x] 1.4 Test: whitespace-only `HS_ALLOWED_STAGE_IDS` (→ `[]`) also throws.
- [x] 1.5 Confirm 1.2-1.4 RED (current defaults still win).

## Phase 2: GREEN — Config Validation (`src/config/index.js`)

- [x] 2.1 Add 3 keys to `REQUIRED_KEYS`; remove from `OPTIONAL_KEYS`.
- [x] 2.2 Hoist CSV parsing above missing-key check; flag empty-parsed arrays as missing.
- [x] 2.3 Delete `require('./constants')` destructure (~54-57).
- [x] 2.4 Add `config.deals.closedWonStageId` from `HS_CLOSED_WON_STAGE_ID`.
- [x] 2.5 Run config tests: Phase 1 GREEN; 17 fixtures + process-env test temporarily fail (fixed Phase 5).

## Phase 3: RED — revertDealStage Guard (`HubspotSourceGateway.test.js`)

- [x] 3.1 Delete stale default test (~193-198).
- [x] 3.2 Test: gateway without `closedWonStageId` → `revertDealStage` throws before `parseSourceId`/`getDealStageHistory`.
- [x] 3.3 Confirm RED (embedded default still lets it proceed silently).

## Phase 4: GREEN — Gateway Guard (`HubspotSourceGateway.js`)

- [x] 4.1 Delete `DEFAULT_CLOSED_WON_STAGE_ID` entirely.
- [x] 4.2 Constructor: `this.closedWonStageId = closedWonStageId || null`.
- [x] 4.3 `revertDealStage` (~233-244): throw as first statement if invalid — point-of-use only, no constructor guard (preserves `server.js:145` moRetry path).
- [x] 4.4 Confirm Phase 3 GREEN; existing revert-success test unaffected.

## Phase 5: GREEN — Fixture Sweep (`test/config.test.js`, mechanical)

- [x] 5.1 Spread `PORTAL_ENV` into 12 inline env objects (lines 23,46,56,67,77,91,103,113,131,143,154,164).
- [x] 5.2 Spread into 5 `baseEnv` fixtures (lines 193,253,293,322,350).
- [x] 5.3 Extend save/restore idiom in "auto-loads .env" test (~172) with 3 keys.
- [x] 5.4 Run full file: GREEN.

## Phase 6: Consumer Rewiring

- [x] 6.1 `server.js:104` (`saleOrderHubspotGateway`): `DEAL_STAGE_CLOSED_WON_ID` → `config.deals.closedWonStageId`; drop import (~30).
- [x] 6.2 Confirm `server.js:145` (`moRetryHubspotGateway`) unchanged (never set it).
- [x] 6.3 `dealSyncModule.js:62,75` (`_sourceGateway`): rewire via hoisted `_defaultDealsConfig`; drop constant from `:25` destructure.
- [x] 6.4 `dealSyncModule.test.js`: add NEW test not injecting `sourceGateway`, exercising real gateway construction, asserting `closedWonStageId` wiring (existing `:39-53` pass is accidental, not a contract).
- [x] 6.5 Run affected suites: GREEN.

## Phase 7: Cleanup — Dead Constants

- [x] 7.1 Grep `src/`/`test/` for both constants; confirm no consumers outside `constants.js`.
- [x] 7.2 Delete both constants + exports from `src/config/constants.js`.
- [x] 7.3 Run full `npm test`: GREEN.
- [x] 7.4 Grep `src/` for the literal values: zero hits outside tests/docs.

## Phase 8: Documentation

- [x] 8.1 `README.md` (~130): document `HS_CLOSED_WON_STAGE_ID`.
- [x] 8.2 `ARQUITECTURA.md` §11.2 #3 (~94-95,372,459-461): mark closed.

# Design: HubSpot portal config portable (coupling #3)

## Technical Approach

`config.deals` becomes the single source of truth for the three portal identifiers.
`HS_ALLOWED_STAGE_IDS`, `HS_ALLOWED_PIPELINE_IDS` and the new `HS_CLOSED_WON_STAGE_ID` join
`REQUIRED_KEYS`, so a wrong/absent portal config is a boot-time `CONFIG_MISSING`, never a silent
fallback to another tenant's IDs. The gateway keeps no embedded default; `revertDealStage` refuses to
run without a usable `closedWonStageId`. One atomic change, no migration, no runtime data touched.

## Architecture Decisions

| # | Decision | Alternatives rejected | Rationale |
|---|----------|----------------------|-----------|
| 1 | `HS_CLOSED_WON_STAGE_ID` is its own required env var | Derive from `allowedStageIds[0]` | The allowlist is a *set of stages the validator accepts*; closed-won is *one* stage the revert guard compares against. Deriving couples two unrelated meanings and silently breaks the day the allowlist grows or is reordered |
| 2 | All 3 keys required globally in `REQUIRED_KEYS`, for every deployment | Require them only when `deals`/`saleOrderStatusSync` is composed | One deployment runs all 4 flows today. Conditional requirements need a composition-aware config loader — more machinery than the coupling it removes. Revisit only when a deal-less deployment actually exists |
| 3 | Fail-fast guard lives **at point of use inside `revertDealStage`**, before any API call | (a) constructor guard on `HubspotSourceGateway`; (b) keep `\|\| DEFAULT_...`; (c) `config.deals.closedWonStageId \|\| null` and compare | (a) breaks `server.js:145` `moRetryHubspotGateway`, which legitimately never passes it and never reverts; (b) is the coupling being deleted; (c) is the exact silent failure the proposal flagged — `currentStage !== null` is always true, the anti-ping-pong guard stops firing with no error and no red test |
| 4 | Empty-after-parse CSV also raises `CONFIG_MISSING` | Only check the raw string is non-blank | `HS_ALLOWED_STAGE_IDS=" , "` passes a non-blank check and yields `[]`, i.e. a validator that rejects every deal. Same failure class, same error |
| 5 | `dealSyncModule` reads through the hoisted `_defaultDealsConfig` guard, not `config.deals.closedWonStageId` | Direct member access at line 75 | `test/composition/dealSyncModule.test.js:39` passes a config with **no `deals` key**; direct access survives only by `sourceGateway \|\|` short-circuit accident. Hoisting the existing `_defaultDealsConfig` (today line 98) above the gateway keeps the file's own defensive idiom |
| 6 | Single atomic change / single PR | Slices like the previous change | The required-key commit and the fallback-deletion commit are mutually dependent: either order leaves a state where boot demands a key nobody reads, or a consumer reads a key nobody requires. Forecast ≈150–200 changed lines, well inside the 400-line budget |

## `config/index.js` shape

```js
const REQUIRED_KEYS = [
  'MONGODB_URI', 'HUBSPOT_ACCESS_TOKEN', 'HUBSPOT_CLIENT_SECRET',
  'HS_ALLOWED_STAGE_IDS', 'HS_ALLOWED_PIPELINE_IDS', 'HS_CLOSED_WON_STAGE_ID'
]
// remove HS_ALLOWED_STAGE_IDS / HS_ALLOWED_PIPELINE_IDS from OPTIONAL_KEYS
// delete the `require('./constants')` destructure at :54-57

function load(...) {
  loadEnvFile(...)
  const stageIds = parseCsvList(env.HS_ALLOWED_STAGE_IDS)      // hoisted above the check
  const pipelineIds = parseCsvList(env.HS_ALLOWED_PIPELINE_IDS)
  const closedWonStageId = String(env.HS_CLOSED_WON_STAGE_ID || '').trim()
  const missing = REQUIRED_KEYS.filter((k) => !env[k] || String(env[k]).trim() === '')
  if (stageIds.length === 0 && !missing.includes('HS_ALLOWED_STAGE_IDS')) missing.push('HS_ALLOWED_STAGE_IDS')
  if (pipelineIds.length === 0 && !missing.includes('HS_ALLOWED_PIPELINE_IDS')) missing.push('HS_ALLOWED_PIPELINE_IDS')
  if (missing.length > 0) { /* unchanged CONFIG_MISSING throw */ }
  ...
  deals: { allowedStageIds: stageIds, allowedPipelineIds: pipelineIds, closedWonStageId,
           rejectUnknownPipeline: /* unchanged */ }
}
```

## `revertDealStage` guard

```js
async revertDealStage(sourceId) {
  if (typeof this.closedWonStageId !== 'string' || this.closedWonStageId.trim() === '') {
    throw new Error('HubspotSourceGateway.revertDealStage requires closedWonStageId')
  }
  const { dealId } = parseSourceId(sourceId)      // unchanged from here down
  ...
}
```

Constructor becomes `this.closedWonStageId = closedWonStageId || null`; `DEFAULT_CLOSED_WON_STAGE_ID`
(`:23`) is deleted. The guard precedes `getDealStageHistory`, so a mis-wired gateway performs zero
HubSpot I/O. In production it is unreachable (config is required at boot) — it is a wiring assertion
whose only job is to make silence impossible.

## Consumer rewiring (verified against current source)

| File | Before | After |
|---|---|---|
| `src/config/constants.js:29,31,38,39` | `DEAL_STAGE_CLOSED_WON_ID`, `DEAL_PIPELINE_COMMERCIAL_VISUAL_BRANDING` + both exports | Deleted. Grep confirms the only non-test consumers are `config/index.js:55-56,116-117`, `server.js:30,114`, `dealSyncModule.js:25,75` — all rewired here |
| `src/server.js:30` | `const { DEAL_STAGE_CLOSED_WON_ID } = require('./config/constants')` | Line deleted (no other use in the file) |
| `src/server.js:114` (`saleOrderHubspotGateway`) | `closedWonStageId: DEAL_STAGE_CLOSED_WON_ID` | `closedWonStageId: cfg.deals.closedWonStageId` |
| `src/server.js:145` (`moRetryHubspotGateway`) | no `closedWonStageId`, no import | **Unchanged** — it never calls `revertDealStage` |
| `src/composition/dealSyncModule.js:25` | `const { JOB_KIND, DEAL_STAGE_CLOSED_WON_ID } = ...` | `const { JOB_KIND } = ...` |
| `src/composition/dealSyncModule.js:75` | `closedWonStageId: DEAL_STAGE_CLOSED_WON_ID` | `closedWonStageId: _defaultDealsConfig.closedWonStageId \|\| null`, with the `_defaultDealsConfig` const (today `:98`) hoisted above `:62` |
| `src/adapters/.../HubspotSourceGateway.js:23,132` | embedded default | default deleted; `\|\| null` |

Note: the brief said "both `server.js` instances that use `closedWonStageId`". Verified — `server.js`
constructs only **two** gateways (`:104`, `:145`); exactly one (`:104`) uses the ID. The third live
instance is the deal flow's, built inside `dealSyncModule.js:62`.

## Test ripple (must not be under-scoped)

`test/config.test.js` — **17 env fixtures + 1 process-env test** all start failing once 3 keys become
required. Add a module-level `const PORTAL_ENV = { HS_ALLOWED_STAGE_IDS: '1409249445',
HS_ALLOWED_PIPELINE_IDS: 't_5728252902aef7e9938dfcbb6cdc2af8', HS_CLOSED_WON_STAGE_ID: '1409249445' }`
and spread it into:

- 12 inline env objects: `:21, :44, :54, :65, :75, :88, :100, :111, :129, :141, :152, :162`
- 5 `baseEnv` fixtures: `:193, :253, :293, :322, :350`
- `:172 'auto-loads .env from cwd'` calls `load()` against real `process.env`/`.env` — it needs the 3
  keys set on `process.env` inside the test (same save/restore idiom already there), otherwise it
  starts depending on an untracked `.env`
- `:5, :11` (`load({ env: {} })`) stay as-is and strengthen for free via `arrayContaining(REQUIRED_KEYS)`
- Rewrite `:199-209` (default-fallback assertions) into fail-fast assertions; `:216-249` (CSV parsing)
  keep their explicit overrides

`test/adapters/hubspot/HubspotSourceGateway.test.js:193-198` (`defaults closedWonStageId to the real
Cierre Ganado stage id`) asserts the removed behaviour — deleted and replaced by the throw test.
`test/e2e/full-flow.test.js:45-49` and `test/inbound/http/webhook.routes.test.js:21-22` build config
objects by hand (not via `load()`); add `closedWonStageId: '1409249445'` for realism — not required
to pass.

## TDD Sequencing (red → green, one commit per step)

1. **RED** — `REQUIRED_KEYS` contains the 3 keys; `load({ env: baseEnvWithoutThem })` throws
   `CONFIG_MISSING` naming each; `cfg.deals.closedWonStageId` equals the env value; whitespace-only
   CSV also throws. Fails today (defaults win).
2. **RED** — `revertDealStage` throws `/requires closedWonStageId/` when the gateway was built without
   it, and `updateDeal`/`getDealStageHistory` were never called. Fails today (embedded default).
3. **GREEN** — `config/index.js` (required keys + `closedWonStageId`, drop the array fallbacks and the
   `constants` require).
4. **GREEN** — gateway: delete `DEFAULT_CLOSED_WON_STAGE_ID`, add the guard, delete the stale
   `:193-198` default test in the same commit (deliberate behaviour inversion, stated in the message).
5. **GREEN** — mechanical fixture sweep (`PORTAL_ENV` into all 17 + the `load()` test).
6. **GREEN** — rewire `server.js` and `dealSyncModule.js`.
7. **CLEANUP** — delete both literals from `constants.js`; gate on
   `rg '1409249445|t_5728252902aef7e9938dfcbb6cdc2af8' src/` returning zero hits.
8. Docs: `README.md:130` env table, `ARQUITECTURA.md:94-95,372,459-461` (§11.2 #3 closed).

Steps 1–2 must be genuinely red before 3–4; the current suite has **no** test that pins the
`config/index.js` array fallback other than `:199-209`, and the gateway default is pinned only by
`:193-198`, so both removals are visible behaviour changes, not test-fixing.

## Rollback Boundary

**One atomic change, one revert.** Files touched form a dependency cycle (see decision #6), so no
file-disjoint slicing exists. `git revert` of the single merge restores the literals and their
fallbacks; nothing persisted, no in-flight job affected, no schema. The only external residue is
`HS_CLOSED_WON_STAGE_ID` in `.env`, which becomes inert after a revert.

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or
process-integration boundary. Env-var reads at boot only.

## Manual Verification (against the real instance, before merge)

1. **Before touching code**: confirm the running `.env` values equal the literals being deleted
   (`HS_ALLOWED_STAGE_IDS` contains `1409249445`, `HS_ALLOWED_PIPELINE_IDS` contains
   `t_5728252902aef7e9938dfcbb6cdc2af8`), then add `HS_CLOSED_WON_STAGE_ID=1409249445`.
2. Boot with `HS_CLOSED_WON_STAGE_ID` unset → expect an **immediate** `CONFIG_MISSING` crash naming
   the key, before Mongo connects — not a silent partial start with the worker running.
3. Repeat for `HS_ALLOWED_STAGE_IDS` and `HS_ALLOWED_PIPELINE_IDS` (also with a whitespace-only value).
4. Boot with all keys → HubSpot deal at Cierre Ganado → job → Odoo sale order created, write-back
   unchanged.
5. Cancel that Odoo order → next `saleOrderStatusSync` tick reverts the deal stage **exactly once**;
   subsequent ticks do nothing (anti-ping-pong guard intact).

## Open Questions

- [ ] None blocking. Decision #2 (global requirement) is deliberately stricter than strictly needed
      and should be revisited if a deal-less deployment ever ships.

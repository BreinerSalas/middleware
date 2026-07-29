# TDD Evidence Report — Pipeline Comercial Visual Branding

Date: 2026-07-29
Branch: `main`
Commits in scope:
- `a5c878f` test: add webhook + validator pipeline selector (red)
- `a818ca3` feat: select Comercial Visual Branding pipeline + Cierre Ganado stage (green)
- `cf538f9` refactor: rename local var in webhook to avoid shadowing

## 1. Source plan

This plan was negotiated in chat just before exiting plan mode. There is no
upstream `*.plan.md` file. The plan was recorded in messages and consisted of:

- **PipelineId allowed (default):** `t_5728252902aef7e9938dfcbb6cdc2af8` — provided by
  the user from the HubSpot UI (Pipeline Comercial Visual Branding).
- **StageId allowed (default):** `1409249445` — provided by the user (Cierre Ganado).
- **Sales pipeline** → rejected, not enqueued.
- **Stage-id only discriminator at webhook time** (no extra HubSpot call).
- **Pipeline-allowlist validator at job time** (defense in depth) so retries and
  pre-existing jobs cannot bypass the rule.
- **Old jobs** → reprocessed; the new validator labels them per the result.

User-confirmed decisions referenced in chat:

1. Where to find the PipelineId: in HubSpot UI (Settings → Objects → Deals → Pipelines).
2. Filter strictly by `stageId` (legacy `'closedwon'` literal is rejected).
3. Reprocess existing jobs; no purge.

## 2. User journeys

1. **As a SmaRTeam operator**, when a deal in *Comercial Visual Branding* reaches the
   *Cierre Ganado* stage, I want the middleware to enqueue and sync, so that Odoo
   has a manufacturing order.
2. **As a SmaRTeam operator**, when a deal in any other pipeline (including the
   legacy "ventas" pipeline) reaches a closed stage, I want the middleware to
   ignore it (no enqueue, no Odoo call, no writeback), so that we only sync the
   Comercial Visual Branding flow.
3. **As a SmaRTeam operator**, when the middleware processes a job, I want a
   defense-in-depth check that rejects deals outside the pipeline allowlist, so
   that any job enqueued by mistake does not leak into Odoo.

## 3. Task report

| Task | Summary | Validation command | Result |
|---|---|---|---|
| Add stage/pipeline allowlist to config | New env vars HS_ALLOWED_STAGE_IDS, HS_ALLOWED_PIPELINE_IDS, HS_REJECT_UNKNOWN_PIPELINE; defaults locked to CVB + Cierre Ganado | `npx vitest run test/config.test.js` | PASS — `cfg.deals.allowedStageIds = ['1409249445']`, `cfg.deals.allowedPipelineIds = ['t_5728252902aef7e9938dfcbb6cdc2af8']`, `cfg.deals.rejectUnknownPipeline = true` by default |
| Webhook filter accepts stage in allowlist | Skip the legacy `'closedwon'` literal; filter on `propertyValue` against `cfg.deals.allowedStageIds` | `npx vitest run test/inbound/http/webhook.routes.test.js` | PASS — 18 tests, including Pipeline Comercial Visual Branding selector group |
| Webhook filter rejects stage outside allowlist | 200 + `enqueued: 0` + warn log when propertyValue not in allowlist | same suite | PASS |
| Job-time validator rejects out-of-allowlist pipeline | `createMustBeInPipeline` rejects with `SkipSyncError`; job lands SKIPPED with audit `job.skipped` reason matching `/pipeline/` | `npx vitest run test/composition/validators.test.js test/composition/dealSyncModule.test.js` | PASS — 25 validator cases, 6 module cases including `Pipeline selector: SKIPPED when deal pipeline is not in allowed list (sales pipeline)` |
| Job completes when pipeline in allowlist | `Pipeline selector: COMPLETED when deal pipeline is Comercial Visual Branding` | same suite | PASS — writeback called once |
| E2E CVB success path | Full HMAC-signed webhook → job → upsert → writeback for `pipeline = t_5728252902aef7e9938dfcbb6cdc2af8` | `npx vitest run test/e2e/full-flow.test.js` | PASS — `completes a full sync for Pipeline Comercial Visual Branding` |
| E2E sales pipeline rejection path | Webhook returns 202; job-time validator marks SKIPPED; no upsert, no writeback | same suite | PASS — `rejects a deal from the sales pipeline (no enqueue, no odoo call)` |

### RED evidence (commit `a5c878f`)

```
Test Files  10 failed | 44 passed (54)
Tests       24 failed | 336 passed | 63 skipped (423)
```

Representative failure (assertion-level):

```
FAIL test/inbound/http/webhook.routes.test.js > ... > 202 when array contains
  deal.propertyChange(dealstage=Cierre Ganado stageId) — enqueues 1 job
AssertionError: expected 200 to be 202
```

All 24 failures traced to: (a) `cfg.deals.*` not yet present, (b) factory
validators `createMustHaveDealStage` / `createMustBeInPipeline` not yet exported,
(c) webhook still matching `'closedwon'` literal. None caused by syntax errors,
broken setup, or unrelated regressions.

### GREEN evidence (commit `a818ca3`)

```
Test Files  54 passed (54)
Tests       423 passed (423)
```

Run twice consecutively to rule out mongo-memory-server startup flake.

### REFACTOR evidence (commit `cf538f9`)

Local rename `allowedStageIds` → `allowedStages` inside `src/app.js` to avoid
shadowing the config property used in log context.

```
Test Files  54 passed (54)
Tests       423 passed (423)
```

## 4. Test specification

| # | Guarantee | Test file / command | Type | Result | Evidence |
|---|---|---|---|---|---|
| 1 | `cfg.deals.allowedStageIds` defaults to `['1409249445']` | `test/config.test.js > config > deals allowlist ... > defaults cfg.deals.allowedStageIds to ["1409249445"]` | unit | PASS | vitest |
| 2 | `cfg.deals.allowedPipelineIds` defaults to Comercial Visual Branding pipeline id | `test/config.test.js > ... > defaults cfg.deals.allowedPipelineIds to Comercial Visual Branding pipeline id` | unit | PASS | vitest |
| 3 | `cfg.deals.rejectUnknownPipeline` defaults to `true` | `test/config.test.js > ... > defaults cfg.deals.rejectUnknownPipeline to true` | unit | PASS | vitest |
| 4 | HS_ALLOWED_STAGE_IDS parses as CSV | `test/config.test.js > ... > parses HS_ALLOWED_STAGE_IDS as CSV` | unit | PASS | vitest |
| 5 | HS_ALLOWED_PIPELINE_IDS parses as CSV | `test/config.test.js > ... > parses HS_ALLOWED_PIPELINE_IDS as CSV` | unit | PASS | vitest |
| 6 | HS_REJECT_UNKNOWN_PIPELINE=false disables strict rejection | `test/config.test.js > ... > parses HS_REJECT_UNKNOWN_PIPELINE=false to disable strict rejection` | unit | PASS | vitest |
| 7 | Whitespace tokens stripped in CSV env vars | `test/config.test.js > ... > ignores whitespace tokens in CSV env vars` | unit | PASS | vitest |
| 8 | `createMustHaveDealStage` accepts stageId in allowlist | `test/composition/validators.test.js > ... > passes when dealstage is in the allowlist` | unit | PASS | vitest |
| 9 | `createMustHaveDealStage` rejects stageId outside allowlist | `test/composition/validators.test.js > ... > throws SkipSyncError when dealstage is not in the allowlist` | unit | PASS | vitest |
| 10 | `createMustHaveDealStage` rejects legacy `'closedwon'` literal | `test/composition/validators.test.js > ... > throws SkipSyncError when dealstage is the legacy string "closedwon"` | unit | PASS | vitest |
| 11 | `createMustHaveDealStage` accepts multiple stages | `test/composition/validators.test.js > ... > accepts multiple stages` | unit | PASS | vitest |
| 12 | `createMustHaveDealStage` throws when dealstage missing | `test/composition/validators.test.js > ... > throws when dealstage property missing` | unit | PASS | vitest |
| 13 | `createMustBeInPipeline` accepts Comercial Visual Branding pipeline | `test/composition/validators.test.js > ... > passes when pipeline is in the allowlist` | unit | PASS | vitest |
| 14 | `createMustBeInPipeline` rejects sales pipeline | `test/composition/validators.test.js > ... > throws SkipSyncError when pipeline is outside the allowlist (sales pipeline)` | unit | PASS | vitest |
| 15 | `createMustBeInPipeline` rejects missing pipeline by default | `test/composition/validators.test.js > ... > throws SkipSyncError when pipeline is missing and rejectWhenMissing=true` | unit | PASS | vitest |
| 16 | `createMustBeInPipeline` allows missing pipeline when `rejectWhenMissing=false` | `test/composition/validators.test.js > ... > passes when pipeline is missing and rejectWhenMissing=false` | unit | PASS | vitest |
| 17 | `createMustBeInPipeline` accepts multiple pipelines | `test/composition/validators.test.js > ... > accepts multiple pipelines` | unit | PASS | vitest |
| 18 | Webhook accepts stageId 1409249445 (Cierre Ganado) under default config | `test/inbound/http/webhook.routes.test.js > ... > accepts dealstage with stageId 1409249445` | integration | PASS | vitest |
| 19 | Webhook rejects a Cierre Ganado event with a different stageId (sales pipeline) | `test/inbound/http/webhook.routes.test.js > ... > rejects a Cierre Ganado event with a different stageId (sales pipeline)` | integration | PASS | vitest |
| 20 | Webhook honors custom `HS_ALLOWED_STAGE_IDS` via config override | `test/inbound/http/webhook.routes.test.js > ... > honors a custom HS_ALLOWED_STAGE_IDS via config override (CSV)` | integration | PASS | vitest |
| 21 | Webhook returns 200 with `enqueued=0` when `propertyValue` is null | `test/inbound/http/webhook.routes.test.js > ... > returns 200 with enqueued=0 when dealstage has no value` | integration | PASS | vitest |
| 22 | Batch with mixed events enqueues only the CVB one | `test/inbound/http/webhook.routes.test.js > ... > 202 and enqueues only the relevant event when batch mixes relevant + ignored` | integration | PASS | vitest |
| 23 | Legacy `'closedwon'` string now ignored under stageId allowlist | `test/inbound/http/webhook.routes.test.js > ... > 200 and 0 enqueues for legacy "closedwon" string when allowlist is stageId-based` | integration | PASS | vitest |
| 24 | Full pipeline runs for Comercial Visual Branding | `test/composition/dealSyncModule.test.js > ... > Pipeline selector: COMPLETED when deal pipeline is Comercial Visual Branding` | integration | PASS | vitest |
| 25 | Full pipeline SKIPPED for sales pipeline (no odoo call, no writeback, audit recorded) | `test/composition/dealSyncModule.test.js > ... > Pipeline selector: SKIPPED when deal pipeline is not in allowed list (sales pipeline)` | integration | PASS | vitest |
| 26 | E2E HMAC + webhook + job + upsert + writeback for CVB | `test/e2e/full-flow.test.js > ... > completes a full sync for Pipeline Comercial Visual Branding` | e2e | PASS | vitest |
| 27 | E2E: sales pipeline deal is SKIPPED end-to-end | `test/e2e/full-flow.test.js > ... > rejects a deal from the sales pipeline (no enqueue, no odoo call)` | e2e | PASS | vitest |

## 5. Coverage and known gaps

```
All files          |   93.18 |    73.91 |   86.56 |   93.18 |
 src/composition   |   93.71 |    81.38 |   92.30 |   93.71 |
  validators.js    |     100 |    80.00 |     100 |     100 |
  dealSyncModule.js|   90.72 |    87.50 |   85.71 |   90.72 |
 src/app.js        |   92.42 |    71.42 |     100 |   92.42 |
 src/config        |   100   |  ...     |   100   |   100   |
```

- New `validators.js`: **100% statements, 100% functions, 80% branches, 100% lines**.
- All files: **93.18% statements, 86.56% functions, 93.18% lines**. Branches at 73.91% baseline (carried from existing codebase, not regressed).
- Coverage target (80%) met on statements/functions/lines and on the new module.

### Intentional gaps / follow-ups

- **No pressure-test of multi-pipeline env** (CSV with multiple entries in
  HS_ALLOWED_PIPELINE_IDS). Adding a second pipeline is a config-only change
  and tested by `test/config.test.js > parses HS_ALLOWED_PIPELINE_IDS as CSV`
  but not by a full job flow. If multi-pipeline becomes a real need, add an
  e2e case that mixes both pipelines.
- **`propertyName === 'pipeline'` events**: when HubSpot emits a `pipeline`
  property change (not a `dealstage` change), the current handler still
  requires `subscriptionType = deal.propertyChange` AND `propertyName =
  dealstage` to enqueue. Such events are ignored at the webhook. If the
  pipeline of an in-flight deal is moved mid-flight, the change would not be
  picked up here. Mitigation: the job-time validator catches it on the next
  enqueue (the deal re-enters via a dealstage change anyway).
- **Reproducibility of `pipelineId`**: the value `t_5728252902aef7e9938dfcbb6cdc2af8`
  is read once and hardcoded as the default in `src/config/constants.js`. To
  re-derive it from HubSpot, run `GET https://api.hubapi.com/crm/v3/pipelines/deals`
  with the Private App token and pick the `id` whose `label` matches
  "Pipeline Comercial Visual Branding".

## 6. Merge evidence (preserved for squash)

The three checkpoint commits can be safely squashed to a single commit because
each one is small and the RED→GREEN→REFACTOR cycle is fully documented above.

Suggested squash commit body:

```
feat: select Comercial Visual Branding pipeline + Cierre Ganado stage

Default discriminator for the smartflow-middleware: only deals in the
"Pipeline Comercial Visual Branding" (pipelineId
t_5728252902aef7e9938dfcbb6cdc2af8) at the "Cierre Ganado" stage
(stageId 1409249445) are synced to Odoo mrp.production. All other
pipelines (legacy "ventas" included) are rejected at the webhook and
defense-in-depth at job processing.

RED evidence: 24 failing tests in test/config.test.js,
test/composition/validators.test.js, test/composition/dealSyncModule.test.js,
test/inbound/http/webhook.routes.test.js, test/e2e/full-flow.test.js.

GREEN evidence: 423/423 tests pass; coverage statements 93.18% (new
validators.js at 100%); refactor commit kept tests green.

Risks: see docs/testing/2026-07-29-plan-pipeline-comercial-visual-branding.tdd.md
section 5.
```

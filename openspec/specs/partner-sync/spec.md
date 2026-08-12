# Partner Sync Specification

## Purpose

One-way, scheduled sync of Odoo `res.partner` into HubSpot Contacts, mirroring the product-sync capability's conventions (full backfill + incremental cursor, shared retry taxonomy, shared rate limiter).

## Requirements

### Requirement: Partner Eligibility Scope Filter

The system MUST sync only active (`active = true`) top-level partners (`parent_id` unset) and contact-type child partners, and MUST exclude address-only child partners (`type` in delivery/invoice/other) from the candidate set.

#### Scenario: Eligible partners are included

- GIVEN a top-level or contact-type child partner with `active = true`
- WHEN candidates are selected
- THEN the partner is included

#### Scenario: Address-only child is excluded

- GIVEN a child partner with `type = delivery` or `type = invoice`
- WHEN candidates are selected
- THEN the partner is excluded

### Requirement: Full Backfill (`runOnce`)

The system MUST support a `runOnce` mode that pages through every eligible partner, independent of any cursor, and upserts each into HubSpot.

#### Scenario: Backfill covers all eligible partners

- GIVEN eligible partners spanning multiple pages
- WHEN `runOnce` executes
- THEN every eligible partner is upserted exactly once, and ineligible partners are never fetched

### Requirement: Incremental Sync by Write-Date Cursor (`runIncremental`)

The system MUST fetch only eligible partners changed since the stored cursor watermark, using a 60-second overlap, and MUST advance the watermark only when the whole page loop completed with zero failures.

#### Scenario: Watermark advances on a clean run

- GIVEN zero failures across the page loop
- WHEN `runIncremental` completes
- THEN the watermark advances to the new high-water `write_date` minus 60s

#### Scenario: Watermark holds after a partial failure

- GIVEN at least one upsert failure in the page loop
- WHEN `runIncremental` completes
- THEN the watermark is unchanged and affected partners are reprocessed next tick

### Requirement: Idempotent Upsert by Odoo Partner ID

The system MUST key HubSpot contact upserts on a dedicated custom property (`id_contacto_odoo_v2`) holding the Odoo partner id, auto-provisioned on HubSpot at boot if absent.

#### Scenario: Property auto-provisioned at boot

- GIVEN `id_contacto_odoo_v2` does not exist in HubSpot
- WHEN the service starts
- THEN the property is created before the flow reports ready

#### Scenario: Repeat sync updates, never duplicates

- GIVEN a partner already mapped via `id_contacto_odoo_v2`
- WHEN it is synced again
- THEN the existing contact is updated, not duplicated

### Requirement: Unconditional Field Ownership

The system MUST overwrite mapped HubSpot contact fields with current Odoo values on every tick; no merge or last-write-wins logic against manual HubSpot edits is applied.

#### Scenario: Odoo value overwrites a manual HubSpot edit

- GIVEN a mapped field was manually edited in HubSpot after the last sync
- WHEN the next tick processes that partner
- THEN the field is overwritten with the current Odoo value

### Requirement: Archive Semantics Are Not Propagated

The system MUST NOT propagate `res.partner.active = false` to HubSpot; the linked contact MUST remain untouched (no delete/archive/flag) once the partner is deactivated in Odoo.

#### Scenario: Deactivated partner's contact stays untouched

- GIVEN a synced partner becomes `active = false`
- WHEN it is excluded from later eligible-candidate queries
- THEN its HubSpot contact remains unchanged indefinitely

### Requirement: No Email-Based Duplicate Reconciliation

The system MUST NOT look up or merge against an existing HubSpot contact by email; identity is determined solely by `id_contacto_odoo_v2`.

#### Scenario: New partner creates a second contact despite a matching email

- GIVEN a HubSpot contact already exists with the same email but no `id_contacto_odoo_v2`
- WHEN a new matching Odoo partner is synced for the first time
- THEN a new, separate HubSpot contact is created keyed by `id_contacto_odoo_v2`

### Requirement: Error Classification and Retry

The system MUST classify failures using the shared `SkipSyncError`/`TransientSyncError` taxonomy: transient errors MUST retry per `RetryPolicy`, and skip-classified errors MUST NOT halt the rest of the page loop.

#### Scenario: Transient error retries per policy

- GIVEN a call fails with a transient error
- WHEN the job processes that item
- THEN it retries per `RetryPolicy` backoff before being marked failed

#### Scenario: Skip error does not block the batch

- GIVEN one partner raises `SkipSyncError`
- WHEN the page loop continues
- THEN remaining partners in the page are still processed

### Requirement: Rate-Limited HubSpot Requests

All HubSpot calls from this flow MUST go through the shared `requestWithRateLimit` token-bucket limiter, honoring `Retry-After` on HTTP 429.

#### Scenario: 429 pauses further requests

- GIVEN HubSpot returns 429 with `Retry-After`
- WHEN the flow issues its next call
- THEN the shared limiter pauses requests for that duration before resuming

### Requirement: Explicit Non-Goals

The system MUST NOT route `is_company` partners to HubSpot Companies, MUST NOT share a job `kind` with product sync, and MUST NOT write partner data back from HubSpot into Odoo.

#### Scenario: Company partner still syncs as a Contact

- GIVEN a partner with `is_company = true` passes the scope filter
- WHEN it is synced
- THEN it is upserted as a Contact, never a Company

#### Scenario: Independent job kind and cursor

- GIVEN partner sync and product sync are both enabled
- WHEN either flow ticks
- THEN each uses its own `JOB_KIND` and cursor, unaffected by the other's failures

'use strict'

// (sdd/hubspot-product-reverse-discovery, design D1) Moved from
// scripts/backfill-product-odoo-id.js so src/ never depends on scripts/. The CLI script
// re-exports `reconcileOrphans` for backward compatibility (same call shape as before).
//
// Staged decision pipeline per design "Decision pipeline (per orphan)":
//
//   orphan {hubspotId, name, price}
//     no name                    -> quarantine no_name
//     S1 Odoo side (odooMap[key])
//       matches === 1            -> odooId = entry.id                    (existing D6)
//       matches === 0            -> quarantine not_found_in_odoo
//       matches >= 2             -> TRACK A: cents(price) vs list_price over entry.ids
//                                     1 hit -> odooId
//                                     0     -> quarantine price_no_match_in_odoo
//                                     >=2   -> quarantine ambiguous_after_price
//     S2 HubSpot side (name EQ re-search)
//       1 result                 -> PROMOTE (findByOdooId collision -> odoo_id_already_claimed)
//       0 results                -> quarantine hubspot_self_missing
//       >=2 results               -> TRACK B: mapped sibling = other result with
//                                   id_producto_odoo set AND same normalized name AND same cents
//                                     none            -> quarantine ambiguous_in_hubspot
//                                     referenced      -> quarantine referenced_by_line_item
//                                     else            -> ARCHIVE + audit row
//
// Quarantine/archive Mongo persistence (`orphanRepo`) is Phase 3's scope — this module accepts
// an optional `orphanRepo` per the design's interface contract and calls it defensively (no-op
// when absent), so Phase 3 can wire real Mongo-backed persistence without touching this file.

const { normalizeProductName } = require('../adapters/outbound/odoo/productNameKey')
const { pricesMatchInCents } = require('../core/shared/priceCents')

// Kept as an alias of the shared name-comparison key so both HubSpot and Odoo name lookups
// collapse to the exact same key (see productNameKey.js).
const normalizeName = normalizeProductName

const ORPHAN_FILTER_GROUPS = [{
  filters: [
    { propertyName: 'hs_sku', operator: 'NOT_HAS_PROPERTY' },
    { propertyName: 'id_producto_odoo', operator: 'NOT_HAS_PROPERTY' }
  ]
}]
const ORPHAN_SORT = [{ propertyName: 'hs_object_id', direction: 'ASCENDING' }]

function createProductOrphanReconcileModule({
  hubspotApi,
  odooApi,
  mappingRepo,
  orphanRepo = null,
  logger = null,
  trackAEnabled = true,
  trackBEnabled = true
} = {}) {
  if (!hubspotApi || typeof hubspotApi.searchProducts !== 'function') {
    throw new Error('createProductOrphanReconcileModule requires hubspotApi with searchProducts')
  }
  if (!odooApi || typeof odooApi.searchProductIdsByNames !== 'function') {
    throw new Error('createProductOrphanReconcileModule requires odooApi with searchProductIdsByNames')
  }
  if (!mappingRepo || typeof mappingRepo.upsert !== 'function') {
    throw new Error('createProductOrphanReconcileModule requires mappingRepo with upsert')
  }

  const log = (level, msg, extra) => {
    if (logger && typeof logger[level] === 'function') logger[level](msg, extra)
  }

  async function fetchAllOrphans({ pageSize = 100, limit = null } = {}) {
    const all = []
    let after
    while (true) {
      const res = await hubspotApi.searchProducts({
        filterGroups: ORPHAN_FILTER_GROUPS,
        properties: ['name', 'price', 'id_producto_odoo'],
        limit: pageSize,
        after,
        sorts: ORPHAN_SORT
      })
      const page = (res && res.results) || []
      all.push(...page)
      if (limit != null && all.length >= limit) return all.slice(0, limit)
      if (!res || !res.paging || !res.paging.next) break
      after = res.paging.next.after
    }
    return all
  }

  // Track A: compare the orphan's HubSpot price against each Odoo candidate's list_price,
  // counting matches (0/1/2+) — never guess on zero or multiple hits (design D4).
  function resolveTrackA(hsPrice, candidateIds, odooPriceMap) {
    const hits = candidateIds.filter((id) => pricesMatchInCents(hsPrice, odooPriceMap[id]))
    return hits
  }

  // Track B: a mapped sibling is another S2 result carrying id_producto_odoo, matching the
  // orphan's normalized name and HubSpot price in cents (design "Decision pipeline").
  function findMappedSibling(hubResults, hubspotId, normalizedKey, hsPrice) {
    return hubResults.find((r) => {
      if (!r || String(r.id) === String(hubspotId)) return false
      const props = r.properties || {}
      if (!props.id_producto_odoo) return false
      if (normalizeName(props.name) !== normalizedKey) return false
      return pricesMatchInCents(hsPrice, props.price)
    })
  }

  async function run({ dryRun = false, limit = null, nameBatchSize = 50 } = {}) {
    const orphans = await fetchAllOrphans({ limit })
    log('info', 'reconcile.orphans.scanned', { count: orphans.length, dryRun })

    const namesByKey = new Map()
    for (const o of orphans) {
      const name = o.properties && o.properties.name
      if (!name) continue
      const key = normalizeName(name)
      if (!namesByKey.has(key)) namesByKey.set(key, name)
    }
    const uniqueNames = Array.from(namesByKey.values())
    let odooMap = {}
    for (let i = 0; i < uniqueNames.length; i += nameBatchSize) {
      const batch = uniqueNames.slice(i, i + nameBatchSize)
      const partial = await odooApi.searchProductIdsByNames(batch)
      odooMap = { ...odooMap, ...partial }
    }

    // Single batched price read for every Track-A-eligible candidate across the whole run
    // (design data flow: "readProductPrices(all candidate ids) [Odoo, batched]").
    let odooPriceMap = {}
    if (trackAEnabled) {
      const candidateIds = []
      for (const entry of Object.values(odooMap)) {
        if (entry && entry.matches >= 2 && Array.isArray(entry.ids)) candidateIds.push(...entry.ids)
      }
      if (candidateIds.length > 0 && typeof odooApi.readProductPrices === 'function') {
        odooPriceMap = await odooApi.readProductPrices(candidateIds)
      }
    }

    const promoted = []
    const archived = []
    const quarantined = []

    for (const o of orphans) {
      const hubspotId = o.id
      const name = o.properties && o.properties.name
      const hsPrice = o.properties && o.properties.price

      if (!name) {
        quarantined.push({ hubspotId, reason: 'no_name' })
        continue
      }

      const key = normalizeName(name)
      const odooEntry = odooMap[key]
      const odooMatches = odooEntry ? odooEntry.matches : 0

      let odooId = null
      if (odooMatches === 1) {
        odooId = odooEntry.id
      } else if (odooMatches === 0) {
        quarantined.push({ hubspotId, name, reason: 'not_found_in_odoo' })
        continue
      } else {
        // odooMatches >= 2 -> Track A
        if (!trackAEnabled) {
          quarantined.push({ hubspotId, name, reason: 'ambiguous_after_price' })
          continue
        }
        const hits = resolveTrackA(hsPrice, odooEntry.ids, odooPriceMap)
        if (hits.length === 1) {
          odooId = hits[0]
        } else if (hits.length === 0) {
          quarantined.push({ hubspotId, name, reason: 'price_no_match_in_odoo' })
          continue
        } else {
          quarantined.push({ hubspotId, name, reason: 'ambiguous_after_price' })
          continue
        }
      }

      // S2: HubSpot-side re-search by exact name, requesting price/id_producto_odoo so
      // Track B can identify an already-mapped sibling without a second round-trip.
      let hubResults = []
      try {
        const searchValue = name.replace(/"/g, '\\"')
        const hubResp = await hubspotApi.searchProducts({
          filterGroups: [{ filters: [{ propertyName: 'name', operator: 'EQ', value: searchValue }] }],
          properties: ['name', 'price', 'id_producto_odoo'],
          limit: 5
        })
        hubResults = (hubResp && hubResp.results) || []
      } catch (err) {
        log('warn', 'reconcile.lookup_failed', { hubspotId, error: err.message })
        quarantined.push({ hubspotId, name, reason: 'lookup_error' })
        continue
      }

      if (hubResults.length === 0) {
        quarantined.push({ hubspotId, name, reason: 'hubspot_self_missing' })
        continue
      }

      if (hubResults.length === 1) {
        // PROMOTE path (D6, unchanged decision — only the write order changed, see below)
        if (typeof mappingRepo.findByOdooId === 'function') {
          const existing = await mappingRepo.findByOdooId(odooId)
          if (existing && String(existing.hubspotId) !== String(hubspotId)) {
            quarantined.push({ hubspotId, name, reason: 'odoo_id_already_claimed' })
            continue
          }
        }
        if (!dryRun) {
          // (design D6) Mongo-first: HubSpot-first + a Mongo failure would set
          // id_producto_odoo with no mapping row (permanent silent drift). Mongo-first
          // failure is self-healing — the mapping stays and a later HubSpot retry passes
          // the collision guard above.
          await mappingRepo.upsert({ odooId, hsSku: null, hubspotId: String(hubspotId), action: 'backfilled' })
          try {
            await hubspotApi.batchUpdateProducts({
              inputs: [{ id: String(hubspotId), properties: { id_producto_odoo: String(odooId) } }]
            })
          } catch (err) {
            log('warn', 'reconcile.write_failed', { hubspotId, odooId, error: err.message })
            quarantined.push({ hubspotId, name, reason: 'hubspot_write_pending' })
            continue
          }
        }
        promoted.push({ odooId, hubspotId, name })
        continue
      }

      // hubResults.length >= 2 -> Track B
      if (!trackBEnabled) {
        quarantined.push({ hubspotId, name, reason: 'ambiguous_in_hubspot' })
        continue
      }

      const sibling = findMappedSibling(hubResults, hubspotId, key, hsPrice)
      if (!sibling) {
        quarantined.push({ hubspotId, name, reason: 'ambiguous_in_hubspot' })
        continue
      }

      let referenced = { total: 0 }
      try {
        referenced = await hubspotApi.searchLineItemsByProductId(hubspotId)
      } catch (err) {
        log('warn', 'reconcile.referenced_check_failed', { hubspotId, error: err.message })
        quarantined.push({ hubspotId, name, reason: 'lookup_error' })
        continue
      }

      if (referenced && referenced.total > 0) {
        quarantined.push({ hubspotId, name, reason: 'referenced_by_line_item' })
        continue
      }

      const siblingHubspotId = sibling.id
      const siblingOdooId = (sibling.properties && sibling.properties.id_producto_odoo) || null

      if (!dryRun) {
        // (design: "never archive without a durable reversible record") The audit write is
        // not optional polish — it's the precondition for the real archive call. Without a
        // repo able to record it, defer to quarantine instead of archiving blind; Phase 3
        // wiring a real orphanRepo is what turns this decision into an actual archive.
        if (!orphanRepo || typeof orphanRepo.recordArchivePending !== 'function') {
          quarantined.push({ hubspotId, name, reason: 'archive_deferred_no_audit_repo' })
          continue
        }
        await orphanRepo.recordArchivePending({ hubspotId, name, price: hsPrice, siblingHubspotId, siblingOdooId })
        try {
          await hubspotApi.batchArchiveProducts({ inputs: [{ id: String(hubspotId) }] })
        } catch (err) {
          log('warn', 'reconcile.archive_failed', { hubspotId, error: err.message })
          if (typeof orphanRepo.markArchiveFailed === 'function') {
            await orphanRepo.markArchiveFailed({ hubspotId, error: err.message })
          }
          quarantined.push({ hubspotId, name, reason: 'archive_failed' })
          continue
        }
        if (typeof orphanRepo.markArchived === 'function') {
          await orphanRepo.markArchived({ hubspotId })
        }
      }
      archived.push({ hubspotId, name, siblingHubspotId, siblingOdooId })
    }

    if (!dryRun && orphanRepo && typeof orphanRepo.upsertQuarantine === 'function') {
      for (const q of quarantined) {
        await orphanRepo.upsertQuarantine(q)
      }
    }

    log('info', 'reconcile.done', {
      dryRun,
      scanned: orphans.length,
      promoted: promoted.length,
      archived: archived.length,
      quarantined: quarantined.length
    })

    return { scanned: orphans.length, promoted, archived, quarantined }
  }

  return { run }
}

// Backward-compatible functional wrapper — same call shape as the original
// scripts/backfill-product-odoo-id.js `reconcileOrphans` (design D1). The CLI script
// re-exports this so all prior callers/tests keep working unchanged.
async function reconcileOrphans({
  hubspotApi,
  odooApi,
  mappingRepo,
  orphanRepo = null,
  logger = null,
  dryRun = false,
  limit = null,
  nameBatchSize = 50,
  trackAEnabled = true,
  trackBEnabled = true
} = {}) {
  const mod = createProductOrphanReconcileModule({
    hubspotApi, odooApi, mappingRepo, orphanRepo, logger, trackAEnabled, trackBEnabled
  })
  return mod.run({ dryRun, limit, nameBatchSize })
}

module.exports = { createProductOrphanReconcileModule, reconcileOrphans, normalizeName }

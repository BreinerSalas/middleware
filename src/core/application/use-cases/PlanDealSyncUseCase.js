'use strict'

const { parseSourceId, listEligibleQuotes } = require('../../../adapters/outbound/hubspot/HubspotSourceGateway')
const { mustHaveLineItems } = require('../../../composition/validators')
const { SkipSyncError } = require('../../domain/errors')

async function defaultListEligibleQuotes({ dealId, sourceGateway }) {
  if (!sourceGateway || !sourceGateway.apiClient || typeof sourceGateway.apiClient.getDealQuotes !== 'function') {
    // Back-compat: a sourceGateway without the new method -> no eligible quotes,
    // the planner falls back to the legacy processSyncJob path. Same guard pattern
    // that OdooTargetGateway uses on readPartnerCountries / listOperationCosts.
    return { eligible: [], skipped: [], currencies: [] }
  }
  return listEligibleQuotes({ dealId, sourceGateway })
}

class PlanDealSyncUseCase {
  constructor({
    sourceGateway,
    enqueueSyncJobUseCase,
    jobRepository,
    auditTrail,
    validators = [],
    listEligibleQuotes: listEligibleQuotesFn = null,
    logger = null
  } = {}) {
    if (!sourceGateway) throw new Error('PlanDealSyncUseCase requires sourceGateway')
    if (!enqueueSyncJobUseCase) throw new Error('PlanDealSyncUseCase requires enqueueSyncJobUseCase')
    if (!jobRepository) throw new Error('PlanDealSyncUseCase requires jobRepository')
    if (!auditTrail) throw new Error('PlanDealSyncUseCase requires auditTrail')
    this.sourceGateway = sourceGateway
    this.enqueueSyncJobUseCase = enqueueSyncJobUseCase
    this.jobRepository = jobRepository
    this.auditTrail = auditTrail
    // mustHaveLineItems is a per-quote check; running it at the deal-planning
    // stage would force the deal to have line items even when the actual
    // line items belong to the eligible quotes. The composition is expected
    // to pass only stage/pipeline validators here.
    this.validators = (Array.isArray(validators) ? validators : [validators]).filter(
      (v) => v !== mustHaveLineItems
    )
    this.listEligibleQuotesFn = listEligibleQuotesFn || ((args) => defaultListEligibleQuotes({ ...args, sourceGateway }))
    this.logger = logger
  }

  async execute({ job }) {
    if (!job || !job._id) throw new Error('PlanDealSyncUseCase requires a persisted job')
    const { _id: jobId, sourceId, correlationId, payload: rawPayload } = job
    const { dealId, quoteId } = parseSourceId(sourceId)
    if (quoteId) {
      throw new Error('PlanDealSyncUseCase called on a quote job (sourceId already has :q...)')
    }
    const dealIdFinal = dealId || sourceId

    const record = await this.sourceGateway.fetchRecord(dealIdFinal)
    let validatorError = null
    for (const validator of this.validators) {
      if (typeof validator !== 'function') continue
      try {
        const result = validator({ record, references: {}, job })
        if (result && typeof result.then === 'function') await result
      } catch (err) {
        validatorError = err
        break
      }
    }
    if (validatorError) {
      if (validatorError instanceof SkipSyncError) {
        await this.jobRepository.markSkipped(jobId, validatorError)
        await this.auditTrail.record({
          jobId, sourceId: dealIdFinal, correlationId,
          event: 'job.skipped', success: false,
          detail: { reason: validatorError.reason || validatorError.message, phase: 'plan.preflight' }
        })
        return { mode: 'skipped', error: validatorError, reason: validatorError.reason || validatorError.message }
      }
      // Non-SkipSyncError: re-raise so the poller records the error normally.
      // The job stays in PROCESSING and the retry policy handles it.
      throw validatorError
    }
    await this.auditTrail.record({
      jobId, sourceId: dealIdFinal, correlationId,
      event: 'validators.passed', success: true
    })

    const partition = await this.listEligibleQuotesFn({ dealId: dealIdFinal })
    const { eligible, skipped, currencies } = partition

    if (eligible.length === 0) {
      // The deal genuinely has zero quotes: no quote-based origin will ever be
      // computed for it, so falling back to the legacy per-deal path is safe.
      if (skipped.length === 0) {
        return { mode: 'fallback', eligibleCount: 0, skippedCount: 0, skipped, currencies }
      }
      // The deal DOES have quotes, just none currently eligible (missing
      // country/incoterm/document-type, or not yet approved). Falling back
      // here would (a) silently guess via the legacy DDP-default/partner-walk
      // heuristics instead of respecting the mandatory-fields contract, and
      // (b) create a Sale Order under the deal-only origin (`hs:<dealId>`)
      // that becomes an orphaned duplicate once the quote becomes eligible
      // and gets its own origin (`hs:<dealId>:q<quoteId>`) later. Skip instead.
      const err = new SkipSyncError(
        `Deal has ${skipped.length} quote(s), none currently eligible (${skipped.map((s) => s.reason).join(', ')})`,
        { detail: { sourceId: dealIdFinal, skipped } }
      )
      await this.jobRepository.markSkipped(jobId, err)
      await this.auditTrail.record({
        jobId, sourceId: dealIdFinal, correlationId,
        event: 'job.skipped', success: false,
        detail: { reason: err.reason || err.message, phase: 'plan.no_eligible_quotes', skipped }
      })
      return { mode: 'skipped', error: err, reason: err.reason || err.message, skipped }
    }

    if (currencies.length > 1) {
      if (this.logger) this.logger.warn('planDealSync mixed currencies across eligible quotes', {
        dealId: dealIdFinal, currencies, correlationId
      })
    }

    const enqueued = []
    for (const q of eligible) {
      const childRawPayload = rawPayload && typeof rawPayload === 'object'
        ? { ...rawPayload, quoteId: q.id }
        : { quoteId: q.id }
      const childSourceId = `${dealIdFinal}:q${q.id}`
      const result = await this.enqueueSyncJobUseCase.execute({
        sourceId: childSourceId,
        correlationId,
        rawPayload: childRawPayload,
        kind: 'quote'
      })
      enqueued.push({
        sourceId: childSourceId,
        jobId: result && result.job ? result.job._id : null,
        deduped: result ? !!result.deduped : false
      })
    }

    await this.auditTrail.record({
      jobId, sourceId: dealIdFinal, correlationId,
      event: 'deal.expanded', success: true,
      detail: {
        eligibleCount: eligible.length,
        eligible: eligible.map((q) => ({ id: q.id, country: q.properties && q.properties.pais_de_destino })),
        skippedCount: skipped.length,
        skipped,
        currencies,
        enqueued
      }
    })

    await this.jobRepository.markCompleted(jobId)

    return {
      mode: 'expanded',
      eligibleCount: eligible.length,
      skippedCount: skipped.length,
      skipped,
      currencies,
      enqueued
    }
  }
}

module.exports = { PlanDealSyncUseCase }

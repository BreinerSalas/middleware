'use strict'

const JOB_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  RETRY_PENDING: 'RETRY_PENDING',
  COMPLETED: 'COMPLETED',
  SKIPPED: 'SKIPPED',
  DEAD_LETTER: 'DEAD_LETTER'
})

const SOURCES = Object.freeze({
  HUBSPOT: 'hubspot'
})

const ENTITIES = Object.freeze({
  DEAL: 'deal'
})

module.exports = { JOB_STATUS, SOURCES, ENTITIES }

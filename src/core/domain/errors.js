'use strict'

class AppError extends Error {
  constructor(message, { code = 'APP_ERROR', cause = null } = {}) {
    super(message)
    this.name = this.constructor.name
    this.code = code
    if (cause) this.cause = cause
  }
}

class SkipSyncError extends AppError {
  constructor(reason, { detail = null } = {}) {
    super(reason, { code: 'SKIP_SYNC' })
    this.reason = reason
    this.detail = detail
  }
}

class TransientSyncError extends AppError {
  constructor(message, { httpStatus = null, code = null, cause = null } = {}) {
    super(message, { code: code || 'TRANSIENT_SYNC', cause })
    this.httpStatus = httpStatus
    this.transient = true
  }
}

module.exports = { AppError, SkipSyncError, TransientSyncError }

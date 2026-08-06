'use strict'

const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'])

function isRetryableError(err) {
  if (!err) return false
  if (err.transient === true) return true
  const status = err.httpStatus || err.status || (err.response && err.response.status)
  if (status && RETRYABLE_HTTP_STATUSES.has(Number(status))) return true
  const code = err.code || (err.cause && err.cause.code)
  if (code && RETRYABLE_ERROR_CODES.has(String(code))) return true
  if (err.name === 'TransientSyncError') return true
  return false
}

function isPermanentHttpError(err) {
  if (!err) return false
  if (err.transient === true) return false
  if (err.transient === false) return true
  const status = Number(err.httpStatus || err.status || (err.response && err.response.status))
  if (!status) return false
  return status >= 400 && status < 500 && !RETRYABLE_HTTP_STATUSES.has(status)
}

function calculateNextRetry({ attempts, baseMs = 1000, maxDelayMs = 300000, jitter = true, now = Date.now() } = {}) {
  const exp = Math.pow(2, Math.max(0, Number(attempts) || 0))
  const raw = baseMs * exp
  const bounded = Math.min(raw, maxDelayMs)
  const j = jitter ? Math.floor(Math.random() * baseMs) : 0
  return new Date(now + bounded + j)
}

function shouldDeadLetter({ attempts, maxAttempts, error }) {
  if (Number(attempts) >= Number(maxAttempts)) return true
  if (error && error.transient === false) return true
  return false
}

module.exports = { isRetryableError, isPermanentHttpError, calculateNextRetry, shouldDeadLetter, RETRYABLE_HTTP_STATUSES, RETRYABLE_ERROR_CODES }

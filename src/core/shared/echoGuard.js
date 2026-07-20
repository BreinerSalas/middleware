'use strict'

function createEchoGuard({ ttlMs = 10000, clock = () => Date.now() } = {}) {
  const seen = new Map()

  function purgeExpired(nowValue) {
    const t = nowValue()
    for (const [key, expiresAt] of seen.entries()) {
      if (expiresAt <= t) seen.delete(key)
    }
  }

  function shouldSuppress(key, nowValue = clock()) {
    purgeExpired(() => nowValue)
    if (seen.has(key)) return true
    seen.set(key, nowValue + ttlMs)
    return false
  }

  function clear() { seen.clear() }

  function size() { return seen.size }

  return { shouldSuppress, clear, size }
}

module.exports = { createEchoGuard }

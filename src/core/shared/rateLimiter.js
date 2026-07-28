'use strict'

function createRateLimiter({ rps = 9, burst = 15, clock = () => Date.now(), setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  const intervalMs = 1000 / Math.max(1, rps)
  const capacity = Math.max(1, burst)
  let tokens = capacity
  let lastRefillMs = clock()
  const queue = []
  let timer = null

  function refill() {
    const now = clock()
    if (now < lastRefillMs) return
    const elapsed = now - lastRefillMs
    const newTokens = Math.floor(elapsed / intervalMs)
    if (newTokens <= 0) return
    tokens = Math.min(capacity, tokens + newTokens)
    lastRefillMs += newTokens * intervalMs
  }

  function drain() {
    refill()
    while (tokens > 0 && queue.length > 0) {
      tokens -= 1
      const next = queue.shift()
      next.resolve()
    }
    if (timer) {
      clearTimeoutFn(timer)
      timer = null
    }
    if (queue.length > 0) {
      const waitMs = (lastRefillMs + intervalMs) - clock()
      if (waitMs <= 0) {
        timer = setTimeoutFn(drain, 0)
      } else {
        timer = setTimeoutFn(drain, waitMs)
      }
    }
  }

  function take() {
    return new Promise((resolve, reject) => {
      drain()
      if (tokens > 0) {
        tokens -= 1
        resolve()
        return
      }
      const entry = { resolve, reject, done: false }
      queue.push(entry)
      drain()
      if (!entry.done) {
        const waitMs = (lastRefillMs + intervalMs) - clock()
        timer = setTimeoutFn(drain, Math.max(0, waitMs))
      }
    })
  }

  function pause(ms) {
    lastRefillMs = clock() + Math.max(0, ms)
    if (timer) {
      clearTimeoutFn(timer)
      timer = null
    }
  }

  return {
    take,
    pause,
    drain,
    get tokens() {
      refill()
      return tokens
    },
    get queueSize() {
      return queue.length
    }
  }
}

module.exports = { createRateLimiter }

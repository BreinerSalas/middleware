'use strict'

function createLogger({ level = 'info', base = {} } = {}) {
  const order = ['error', 'warn', 'info', 'debug']
  const thresholdIdx = Math.max(0, order.indexOf(level))
  function safe(obj) {
    const seen = new WeakSet()
    return JSON.parse(JSON.stringify(obj, (k, v) => {
      if (typeof v === 'bigint') return v.toString()
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack, code: v.code }
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[Circular]'
        seen.add(v)
      }
      return v
    }))
  }
  function emit(lvl, msg, meta) {
    if (order.indexOf(lvl) > thresholdIdx) return
    const line = { ts: new Date().toISOString(), level: lvl, msg, ...safe(base), ...safe(meta || {}) }
    const out = lvl === 'error' ? process.stderr : process.stdout
    try { out.write(JSON.stringify(line) + '\n') } catch (_) { /* swallow */ }
  }
  return {
    error: (msg, meta) => emit('error', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    debug: (msg, meta) => emit('debug', msg, meta)
  }
}

module.exports = { createLogger }

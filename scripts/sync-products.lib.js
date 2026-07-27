'use strict'

function parseArgs(argv) {
  const opts = {}
  for (const arg of argv) {
    const m = /^--([a-zA-Z][a-zA-Z0-9_-]*)(?:=(.*))?$/.exec(arg)
    if (!m) continue
    const [, key, val] = m
    if (val === undefined) opts[key] = true
    else if (val === '' || isNaN(Number(val))) opts[key] = val
    else opts[key] = Number(val)
  }
  return opts
}

function resolveIntervalMs(args, env) {
  if (args.interval === true) return null
  if (typeof args.interval === 'number') return args.interval
  if (args.once === true) return 0
  const fromEnv = env && env.PRODUCT_SYNC_INTERVAL_MS
  const n = fromEnv == null ? NaN : Number(fromEnv)
  if (Number.isFinite(n) && n > 0) return n
  return 60000
}

function shouldRunOnce(args) {
  return args.once === true || Number(resolveIntervalMs(args, {})) === 0
}

module.exports = { parseArgs, resolveIntervalMs, shouldRunOnce }

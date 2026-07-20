'use strict'

function runSequentially(key, fn) {
  const previous = runSequentially._chains.get(key) || Promise.resolve()
  const safePrev = typeof previous.then === 'function' ? previous : Promise.resolve()
  const next = safePrev.then(() => fn())
  // Store a swallowed chain so subsequent callers don't observe a rejection
  // from this call (the caller of THIS call still observes `next` and must
  // handle its rejection). Replace any previous chain pointer.
  const tracked = next.then(() => undefined, () => undefined)
  runSequentially._chains.set(key, tracked)
  tracked.finally(() => {
    if (runSequentially._chains.get(key) === tracked) {
      runSequentially._chains.delete(key)
    }
  })
  return next
}
runSequentially._chains = new Map()

function size() {
  return runSequentially._chains.size
}

function clear() {
  runSequentially._chains.clear()
}

module.exports = { runSequentially, size, clear }

import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createLogger } = require('../../src/lib/logger.js')

describe('createLogger', () => {
  it('emits json line with level and msg', () => {
    const writes = []
    const log = createLogger({ level: 'info', base: { svc: 'x' } })
    const origStdout = process.stdout.write
    process.stdout.write = (s) => { writes.push(s); return true }
    log.info('hello', { a: 1 })
    process.stdout.write = origStdout
    expect(writes).toHaveLength(1)
    const line = JSON.parse(writes[0])
    expect(line.level).toBe('info')
    expect(line.msg).toBe('hello')
    expect(line.svc).toBe('x')
    expect(line.a).toBe(1)
    expect(line.ts).toBeTruthy()
  })

  it('filters messages above threshold', () => {
    const stdoutWrites = []
    const stderrWrites = []
    const log = createLogger({ level: 'error' })
    const origStdout = process.stdout.write
    const origStderr = process.stderr.write
    process.stdout.write = (s) => { stdoutWrites.push(s); return true }
    process.stderr.write = (s) => { stderrWrites.push(s); return true }
    log.info('hidden')
    log.warn('hidden')
    log.error('shown')
    process.stdout.write = origStdout
    process.stderr.write = origStderr
    expect(stdoutWrites).toHaveLength(0)
    expect(stderrWrites).toHaveLength(1)
    expect(JSON.parse(stderrWrites[0]).level).toBe('error')
  })

  it('safeReplacer handles errors and circular refs', () => {
    const writes = []
    const log = createLogger({ level: 'info' })
    const origStdout = process.stdout.write
    process.stdout.write = (s) => { writes.push(s); return true }
    const err = new Error('boom')
    err.code = 'CUSTOM'
    const obj = { err }
    obj.self = obj
    log.info('test', obj)
    process.stdout.write = origStdout
    const line = JSON.parse(writes[0])
    expect(line.err.message).toBe('boom')
    expect(line.err.code).toBe('CUSTOM')
    expect(line.self).toBe('[Circular]')
  })

  it('error level writes to stderr', () => {
    const writes = []
    const log = createLogger({ level: 'error' })
    const origStderr = process.stderr.write
    process.stderr.write = (s) => { writes.push(s); return true }
    log.error('boom')
    process.stderr.write = origStderr
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]).level).toBe('error')
  })
})

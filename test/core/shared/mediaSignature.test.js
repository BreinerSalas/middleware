import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { signProductImageToken, verifyProductImageToken } = require('../../../src/core/shared/mediaSignature.js')

describe('mediaSignature', () => {
  const secret = 'test-secret-value'

  it('round-trips a valid odooId through sign/verify', () => {
    const token = signProductImageToken(16488, secret)
    expect(verifyProductImageToken(token, secret)).toBe(16488)
  })

  it('rejects a token signed with a different secret', () => {
    const token = signProductImageToken(16488, secret)
    expect(verifyProductImageToken(token, 'wrong-secret')).toBeNull()
  })

  it('rejects a tampered payload (changed odooId, same signature)', () => {
    const token = signProductImageToken(16488, secret)
    const [, sig] = token.split('.')
    const tampered = `${Buffer.from('99999').toString('base64url')}.${sig}`
    expect(verifyProductImageToken(tampered, secret)).toBeNull()
  })

  it('rejects malformed tokens', () => {
    expect(verifyProductImageToken('not-a-token', secret)).toBeNull()
    expect(verifyProductImageToken('', secret)).toBeNull()
    expect(verifyProductImageToken(null, secret)).toBeNull()
    expect(verifyProductImageToken(undefined, secret)).toBeNull()
  })

  it('rejects when secret is empty', () => {
    const token = signProductImageToken(16488, secret)
    expect(verifyProductImageToken(token, '')).toBeNull()
  })

  it('throws on sign with missing secret or invalid odooId', () => {
    expect(() => signProductImageToken(16488, '')).toThrow()
    expect(() => signProductImageToken(0, secret)).toThrow()
    expect(() => signProductImageToken(-5, secret)).toThrow()
    expect(() => signProductImageToken('not-a-number', secret)).toThrow()
  })

  it('produces different tokens for different ids', () => {
    const a = signProductImageToken(1, secret)
    const b = signProductImageToken(2, secret)
    expect(a).not.toBe(b)
  })
})

import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { JOB_KIND } = require('../../src/config/constants.js')

describe('JOB_KIND (sdd/hubspot-contact-inbound-sync)', () => {
  it('defines CONTACT_INBOUND as the job kind for HubSpot contact.creation inbound sync', () => {
    expect(JOB_KIND.CONTACT_INBOUND).toBe('contact_inbound')
  })

  it('does not collide with any existing job kind value', () => {
    const values = Object.values(JOB_KIND)
    const unique = new Set(values)
    expect(unique.size).toBe(values.length)
  })
})

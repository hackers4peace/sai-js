import { agentId, buildOidcSession } from '@elfpavlik/sai-components'
import { describe, expect, test } from 'vitest'

const agents = [
  'https://id/alice',
  'https://id/bob',
  'https://id/kim',
  'https://id/acme',
  'https://id/yoyo',
]

describe('agents', () => {
  for (const agent of agents) {
    test(agent, async (): Promise<void> => {
      const session = await buildOidcSession(agents[0])
      const response = await session.authFetch(agentId(agent), { method: 'HEAD' })
      expect(response.status).toBe(200)
    })
  }
})

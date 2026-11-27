import type { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent'
import { describe, expect, test } from 'vitest'

import { getApplications } from '../src/services/ApplicationRegistry.js'
import type { ResolvedContext } from '../src/services/Context.js'
import { getSocialAgentInvitations } from '../src/services/InvitationRegistry.js'
import { responseUrl } from './response-url.ts'

// ──────────────────────────
// Fixtures
// ──────────────────────────

const ORG_WEBID = 'https://yoyo.example/profile/card#me'
const ORG_AA = 'https://yoyo.example/.sai/agents/zzzz'
const USER_WEBID = 'https://dan.example/profile/card#me'
const SOCIAL_AGENT_REGISTRY = 'https://registry/yoyo/social-agent/'
const APPLICATION_REGISTRY = 'https://registry/yoyo/application/'
const INVITATION_REGISTRY = 'https://registry/yoyo/invitation/'
const APP_REG = 'https://registry/yoyo/p9xnub'
const APP_WEBID = 'https://projectron.example/#app'

/** The registration body served for the application's graph (CONSTRUCT → application/ld+json). */
const appRegistrationDoc = [
  {
    '@id': APP_REG,
    '@type': ['http://www.w3.org/ns/solid/interop#ApplicationRegistration'],
    'http://www.w3.org/ns/solid/interop#registeredAgent': [{ '@id': APP_WEBID }],
  },
]

/** The app's client-id document (webid/client-id profiles stay HTTP). */
const clientIdDocument = {
  '@context': [
    'https://www.w3.org/ns/solid/oidc-context.jsonld',
    { interop: 'http://www.w3.org/ns/solid/interop#' },
  ],
  client_id: APP_WEBID,
  client_name: 'Projectron',
  logo_uri: 'https://projectron.example/logo.png',
  // node references — bare strings would expand as literals and drop under
  // the `@type: '@id'`-coerced terms (docs/jsonld.md)
  'interop:hasAccessNeedGroup': { '@id': 'https://projectron.example/needs' },
  'interop:hasAuthorizationCallbackEndpoint': { '@id': 'https://projectron.example/callback' },
}

const orgProfileDoc = {
  '@id': ORG_WEBID,
  'http://www.w3.org/ns/solid/interop#hasAuthorizationAgent': { '@id': ORG_AA },
}

function mockResponse(
  body: unknown,
  status = 200,
  contentType = 'application/ld+json',
  url = responseUrl(body)
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
    },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

/** Minimal resolved org context (webId ≠ userWebId routes via /sparql-admin). */
function orgCtx(session: AuthorizationAgent): ResolvedContext {
  return {
    session,
    webId: ORG_WEBID,
    userWebId: USER_WEBID,
    registrySet: {
      hasSocialAgentRegistry: { id: SOCIAL_AGENT_REGISTRY },
      hasApplicationRegistry: { id: APPLICATION_REGISTRY },
      hasInvitationRegistry: { id: INVITATION_REGISTRY },
    },
  } as unknown as ResolvedContext
}

const sparqlAdminUrl = `${new URL(ORG_AA).origin}/.sai/sparql-admin/${Buffer.from(ORG_WEBID).toString('base64url')}`

// ──────────────────────────
// getApplications — application registrations via SPARQL (docs/sparql.md step 3)
// ──────────────────────────

describe('getApplications — org context lists applications via /sparql-admin', () => {
  test('ldp:contains listing + per-registration body; profile from the client-id document', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const session = {
      fetch: async (url: string, init?: RequestInit) => {
        requests.push({ url, init })
        if (url === ORG_WEBID) {
          return mockResponse(orgProfileDoc)
        }
        if (url === APP_WEBID) {
          return mockResponse(clientIdDocument, 200, 'application/ld+json', APP_WEBID)
        }
        if (url !== sparqlAdminUrl) {
          throw new Error(`unexpected request: ${url}`)
        }
        const query = String(init?.body ?? '')
        if (query.includes('SELECT')) {
          // the flat registry listing must read lws:contains
          // of the dedicated application registry container
          expect(query).toContain('lws#contains')
          return mockResponse(
            {
              head: { vars: ['child'] },
              results: { bindings: [{ child: { type: 'uri', value: APP_REG } }] },
            },
            200,
            'application/sparql-results+json'
          )
        }
        if (query.includes('CONSTRUCT')) {
          return mockResponse(appRegistrationDoc, 200, 'application/ld+json')
        }
        throw new Error(`unexpected sparql-admin query: ${query}`)
      },
    } as unknown as AuthorizationAgent

    const applications = await getApplications(orgCtx(session))

    expect(applications).toEqual([
      {
        id: APP_WEBID,
        name: 'Projectron',
        logo: 'https://projectron.example/logo.png',
        accessNeedGroup: 'https://projectron.example/needs',
        callbackEndpoint: 'https://projectron.example/callback',
      },
    ])
    // profile dereferences the client-id document over HTTP — one webid
    // profile + one ldp:contains listing + one body read
    expect(requests.filter((request) => request.url === sparqlAdminUrl)).toHaveLength(2)
  })
})

// ──────────────────────────
// getSocialAgentInvitations — invitations via SPARQL (docs/sparql.md, candidate)
// ──────────────────────────

describe('getSocialAgentInvitations — org context lists invitations via /sparql-admin', () => {
  const INVITE_IRI = 'https://registry/yoyo/zi1nic'
  const SETTLED_IRI = 'https://registry/yoyo/settled'
  const CAPABILITY = 'https://yoyo.example/invitations/zi1nic'

  const inviteDoc = (iri: string, registeredAgent?: string) => [
    {
      '@id': iri,
      '@type': ['http://www.w3.org/ns/solid/interop#SocialAgentInvitation'],
      'http://www.w3.org/ns/solid/interop#hasCapabilityUrl': [{ '@id': CAPABILITY }],
      'http://www.w3.org/2004/02/skos/core#prefLabel': [{ '@value': 'Invite' }],
      'http://www.w3.org/2004/02/skos/core#note': [{ '@value': 'A note' }],
      ...(registeredAgent
        ? {
            'http://www.w3.org/ns/solid/interop#registeredAgent': [{ '@id': registeredAgent }],
          }
        : {}),
    },
  ]

  test('ldp:contains listing + per-invitation body; settled invitations excluded', async () => {
    const session = {
      fetch: async (url: string, init?: RequestInit) => {
        if (url === ORG_WEBID) {
          return mockResponse(orgProfileDoc)
        }
        if (url !== sparqlAdminUrl) {
          throw new Error(`unexpected request: ${url}`)
        }
        const query = String(init?.body ?? '')
        if (query.includes('SELECT')) {
          // the flat invitation registry listing must read lws:contains
          expect(query).toContain('lws#contains')
          return mockResponse(
            {
              head: { vars: ['child'] },
              results: {
                bindings: [INVITE_IRI, SETTLED_IRI].map((iri) => ({
                  child: { type: 'uri', value: iri },
                })),
              },
            },
            200,
            'application/sparql-results+json'
          )
        }
        if (query.includes('CONSTRUCT')) {
          return mockResponse(
            query.includes(`GRAPH <${INVITE_IRI}>`)
              ? inviteDoc(INVITE_IRI)
              : inviteDoc(SETTLED_IRI, 'https://dan.example/profile/card#me'),
            200,
            'application/ld+json'
          )
        }
        throw new Error(`unexpected sparql-admin query: ${query}`)
      },
    } as unknown as AuthorizationAgent

    const invitations = await getSocialAgentInvitations(orgCtx(session))

    // only the invitation without registeredAgent survives
    expect(invitations).toEqual([
      {
        id: INVITE_IRI,
        capabilityUrl: CAPABILITY,
        label: 'Invite',
        note: 'A note',
      },
    ])
  })
})

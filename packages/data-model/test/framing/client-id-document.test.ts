import { describe, test } from 'vitest'

import { ClientIdDocument } from '../../src'
import { expect } from '../expect'
import { docFromGraphs } from './helpers'

const CLIENT_ID_IRI = 'https://data/test-client/public/id'

// The client-id-document node lives inside the application registration graph
// (meta:https://registry/alice/cvmsa4 in the local framing fixture) together with
// the registration node; framing the id node must ignore the registration.
describe('ClientIdDocument framing', () => {
  test('frames the client id node into ClientIdDocumentData', async () => {
    const doc = await docFromGraphs(['meta:https://registry/alice/cvmsa4'])
    const data = await ClientIdDocument.fromJsonLd(doc, CLIENT_ID_IRI)
    expect(data).toEqual({
      id: CLIENT_ID_IRI,
      type: [],
      callbackEndpoint: 'https://test-client',
      hasAccessNeedGroup: 'https://data/test-client/public/access-needs#need-group-pm',
      clientName: 'Test client',
      logoUri: undefined,
    })
  })
})

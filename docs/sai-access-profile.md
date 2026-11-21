# SAI access profile

The SAI access request/grant wire profile builds on the LWS ODRL Access Profile
and follows the shape proposed in
[w3c/lws-protocol#303](https://github.com/w3c/lws-protocol/issues/303):

- the LWS envelope is `AccessRequest` / `AccessGrant` (`lws:` types),
- `access[]` holds ODRL policies: `Request` for requests, `Agreement` for
  grants,
- every policy has `uid`, `profile`, and `permission[]`,
- a permission carries `assigner`, `assignee`, `action`, and `target`,
- `target` uses ODRL `Asset` / `AssetCollection` types with `source` (and
  optionally `partOf`).

## Profile identity

| URI | Role |
| --- | --- |
| `https://www.w3.org/ns/lws#AccessProfile` | base LWS ODRL access profile |
| `http://www.w3.org/ns/solid/interop#AccessProfile` | SAI sub-profile: adds the access-need model and the SAI scope terms |

The `AccessRequestService` advertises both URIs in `service[].conformsTo`; the
`AccessGrantService` advertises only the SAI profile today (it does not accept
plain-LWS-created grants).

## SAI extension terms

The SAI sub-profile adds, without changing the ODRL policy frame:

- `interop:accessNeedGroup`, `interop:AccessNeed`,
  `interop:inheritsFromNeed`, `interop:accessNecessity`
- `interop:registeredShapeTree`
- `interop:hasDataRegistration`, `interop:hasDataInstance`
- `interop:scopeOfGrant` (`SelectedFromRegistry`, `AllFromRegistry`,
  `Inherited`, `AllFromAgent`, `AllFromRole`)
- `interop:satisfiesAccessNeed`, `interop:satisfiesAccessRequest`
- `interop:requester` / `interop:grantedBy`
- target types `st:ShapeTree` and `interop:DataRegistration` (additional
  ODRL target matchers, as permitted by the LWS profile)

## Specific-instance requests

A specific-instance need is expressed with one `Asset` permission per requested
instance:

```json
{
  "type": ["Request", "AccessNeed", "AccessRequired"],
  "uid": "urn:uuid:need-project",
  "profile": "AccessProfile",
  "accessNeedGroup": "urn:uuid:group",
  "registeredShapeTree": "https://data/shapetrees/trees/Project",
  "scopeOfGrant": "SelectedFromRegistry",
  "permission": [
    {
      "uid": "urn:uuid:p1",
      "assigner": "https://id/bob",
      "assignee": "https://id/bob",
      "action": ["read"],
      "target": {
        "uid": "urn:uuid:t1",
        "owner": "https://id/alice",
        "type": ["Asset"],
        "source": ["https://data/alice-home/j4t7lm"],
        "partOf": ["https://data/alice-home/x1n3cm"]
      }
    }
  ]
}
```

The owner approval turns this into a `SelectedFromRegistry`
`DataAuthorization`; the generated grant carries one `Asset` permission per
instance, so the request and grant use the same ODRL target convention.

## Plain LWS requests

The owner-scoped access request endpoint also accepts the plain LWS ODRL
request shape (an `AccessRequest` document whose policies have no SAI
`accessNeedGroup`/`registeredShapeTree`). The owner resolves the targets to
SAI need scope:

- `Asset` → instance-scoped need (source instances; containing registration),
- `AssetCollection` + `DataRegistration` → registration-scoped need,
- `AssetCollection` + `st:ShapeTree` → shape-tree need.

This compatibility path keeps the SAI request preconditions:

- the authenticated client must be the requester's authorization agent (UAS),
- the requester must be a registered social agent of the owner.

These are server authorization policies; LWS does not forbid them. Plain LWS
requests receive `202` with a `Location` header. `GET`/`DELETE` of the minted
request by the requester remain owner-only in the current facade, so plain LWS
compatibility is POST-only.

## Rejected for now

- ODRL `constraint` on an access request is rejected with `400`; the SAI need
  model has no constraint representation yet.
- Plain LWS `AssetCollection` targets that only name a container/storage cannot
  be mapped to a shape tree; they are rejected with `400`.
- The envelope-level LWS `storage` and `inbox` properties are accepted but not
  used (the owner resolves the target; notifications are not implemented).

## Status

Implemented in the request/approval/grant path. The OpenWiki design page still
needs regeneration from this source.

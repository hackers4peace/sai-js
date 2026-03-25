# Authorization Agent

[![CI](https://github.com/janeirodigital/sai-js/actions/workflows/ci.yml/badge.svg)](https://github.com/janeirodigital/sai-js/actions/workflows/ci.yml)
[![Matrix chat](https://badges.gitter.im/gitterHQ/gitter.png)](https://app.gitter.im/#/room/#solid_specification:gitter.im)
[![npm version](https://badge.fury.io/js/%40janeirodigital%2Finterop-application.svg)](https://www.npmjs.com/package/@janeirodigital/interop-authorization-agent)
[![MIT license](https://img.shields.io/github/license/janeirodigital/sai-js)](https://github.com/janeirodigital/sai-js/blob/main/LICENSE)

## Early access

[Specifications](https://github.com/solid/data-interoperability-panel#solid-application-interoperability)
this library implements are still a work in progress. While we track changes
to the public API of this library with semver, the underlying data will be slightly changing
for the rest of 2021. We are commited to keep this implementation up to date.
If you plan to use your application in production please ask the specification editors
on the [public chatroom](https://app.gitter.im/#/room/#solid_specification:gitter.im)
about the stability of the data model.

## Creating Authorization Agent instance

Authorization Agent class provides a static `build` method to create instances.
It expects:

- `webId` - WebID of the user which this instance will be an authorization agent of.
- `agentId` - Unique IRI denoting this instance. The user will add it to their `WebID` and it will be used
  as `client_id` in Solid-OIDC
- dependencies
  - `fetch` - an authenticated fetch, for example [solid-client-authn-node](https://docs.inrupt.com/developer-tools/api/javascript/solid-client-authn-node/classes/Session.html#fetch)
  - `randomUUID()` - random UUID generator conforming to the [specification](https://wicg.github.io/uuid/)

```ts
import { randomUUID } from 'crypto';
import { getSessionFromStorage, Session } from '@inrupt/solid-client-authn-node';
import { AuthorizationAgent } from '@janeirodigital/interop-authorization-agent';

import { storage } from './oidc-storage';

const webId = 'https://alice.example/#id';
const agentId = 'https://authz.alice.example/';
const registryId = 'https://reg.example/alice';

// we assume that webId was used as sessionId the when session was created
const session = await getSessionFromStorage(webId, storage);

const agent = AuthorizationAgent.build(webId, clientId, registryId, {
  fetch: oidcSession.fetch,
  randomUUID
});
```

## Agent Registry

An instance of Authorization Agent provides a useful method for accessing agent registrations

### Application Registrations

`applicationRegistrations(): AsyncIterable<CRUDApplicationRegistration`
is an async iterable over all the application registrations

```ts
for await (const registration of agent.applicationRegistrations) {
  // do something with the application registration
}
```

`async findApplicationRegistration(iri: string): Promise<CRUDApplicationRegistration | undefined>`
finds an application registration based on `client_id`, if one exists

```ts
const clientId = 'https://projectron.example/#app';
const registration = await agent.findApplicationRegistration(clientId);
```

### Social Agent Registrations

`socialAgentRegistrations(): AsyncIterable<CRUDSocialAgentRegistration>`
is an async iterable over all the social agent registrations

```ts
for await (const registration of agent.socialAgentRegistrations) {
  // do something with the social agent registration
}
```

`findSocialAgentRegistration(iri: string): Promise<CRUDSocialAgentRegistration | undefined>`
finds a social registration based on `webid`, if one exists

```ts
const webId = 'https://alice.example/#id';
const registration = await agent.findSocialAgentRegistration(webId);
```

## Access Authorization

Creating Access Authorizations is the primary responsibility of an Authorization Agent.

`async recordAccessAuthorization(authorization: AccessAuthorizationStructure): Promise<ReadableAccessAuthorization>`

Since access authorization is immutable, it is required to create a new one to replace the old one.

```ts
type AccessAuthorizationStructure = {
  grantee: string; // webid or clientid
  hasAccessNeedGroup: string; // iri
  dataAuthorizations: DataAuthorizationData[];
};
```

```ts
type DataAuthorizationData = {
  grantee: string; // webid or clientid
  registeredShapeTree: string;
  scopeOfAuthorization: string;
  accessMode: string[];
  dataOwner?: string; // webid
  hasDataRegistration?: string;
  inheritsFromAuthorization?: string;
  creatorAccessMode?: string[];
  hasDataInstance?: string[];
};
```

## Access Grant

Based on existing Access Authorization an Access Grant can be created

`async generateAccessGrant(accessAuthorizationIri: string): Promise<void>`

This method updates the appropriate agent registration to reference the newly created access grant.

```ts
const authorizationData: AccessAuthorizationStructure = {
  /* all the data */
};
const authorization = await agent.recordAccessAuthorization(authorizationData);
await agent.generateAccessGrant(authorization.iri);
```

## Funding

This project is funded through the [NGI Zero Entrust Fund](https://nlnet.nl/entrust), a fund established by [NLnet](https://nlnet.nl) with financial support from the European Commission's [Next Generation Internet](https://ngi.eu) program. Learn more at the [NLnet project page](https://nlnet.nl/project/SolidInterop3).

[<img src="https://nlnet.nl/logo/banner.png" alt="NLnet foundation logo" width="20%" />](https://nlnet.nl)

[<img src="https://nlnet.nl/image/logos/NGI0Entrust_tag.svg" alt="NGI Zero Entrust Logo" width="20%" />](https://nlnet.nl/entrust)

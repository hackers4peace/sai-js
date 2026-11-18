import type { MultiPermissionMap, PermissionReaderInput } from '@solid/community-server'
import { IdentifierMap, PermissionReader } from '@solid/community-server'
import { PERMISSIONS } from '@solidlab/policy-engine'
import { getLoggerFor } from 'global-logger-factory'

import type { SaiPermissionsEngine } from './SaiPermissionsEngine.js'

/**
 * Public grants are credential-independent (D24): a request with no token or
 * with any valid token gets the public read, even when an `access` claim or a
 * `scope` does not cover the target. This reader is the only request-time
 * grant lookup left on a data storage, and it is read-only.
 *
 * It is a separate reader from the token engine so a public grant can never
 * become a fallback for a claim, and an owner/admin scope never masks a
 * public read.
 */
export class PublicPermissionReader extends PermissionReader {
  protected readonly logger = getLoggerFor(this)

  public constructor(private readonly engine: SaiPermissionsEngine) {
    super()
  }

  public async canHandle(): Promise<void> {
    // Public grants apply to every request.
  }

  public async handle(input: PermissionReaderInput): Promise<MultiPermissionMap> {
    const result: MultiPermissionMap = new IdentifierMap()
    for (const identifier of input.requestedModes.distinctKeys()) {
      const permissions = await this.engine.getPublicPermissions(identifier.path)
      if (permissions[PERMISSIONS.Read] === true) {
        result.set(identifier, { [PERMISSIONS.Read]: true })
      }
    }
    return result
  }
}

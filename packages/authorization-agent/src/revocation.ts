/**
 * Typed revocation errors (C4 / D11).
 *
 * The grant boundary (`revokeGrantsClosure`) refuses a request before any
 * mutation; the refusal is a machine-readable code, never a message
 * substring. The grant boundary is HTTP-only (the owner `RevokeGrants` RPC was
 * deleted, D18): the handler maps the code to a status + JSON body. The
 * authorization leg's RPC maps its own `AuthorizationRevocationFailure`. No
 * `err.message.includes(...)` matching anywhere.
 */
export type RevocationErrorCode =
  /** the grant IRI resolves to no known registry pod (unknown resource) */
  | 'unknown'
  /** the listed grants do not belong to the revocation target's registry */
  | 'wrong-data-owner'
  /** the requester is neither the grantor nor the data owner (the grant boundary is grantor/owner only, D17) */
  | 'unauthorized'
  /** the chain predicate cannot derive a delegation for the grant */
  | 'not-delegable'
  /** the requested grants span more than one data owner's registry (B2) */
  | 'mixed-owner'

/**
 * A refusal at the grant boundary. `grants` carries the offending IRIs (the
 * whole requested set for `mixed-owner`, the specific grant otherwise) so
 * callers can echo a precise, machine-readable failure.
 */
export class RevocationError extends Error {
  readonly code: RevocationErrorCode
  readonly grants: Array<string>

  constructor(code: RevocationErrorCode, grants: ReadonlyArray<string>, message: string) {
    super(message)
    this.name = 'RevocationError'
    this.code = code
    this.grants = [...grants]
  }
}

export function isRevocationError(value: unknown): value is RevocationError {
  return value instanceof RevocationError
}

/**
 * Verifies a URI claim is secured over TLS
 *
 * Currently restricts to HTTPS URIs and localhost.
 * TODO: Check if we can restrict to HTTP over TLS if/when in the future it is allowed or allow other protocols
 *
 * See also: https://solid.github.io/solid-oidc/#security-tls & https://github.com/solid/authentication-panel/issues/114#issuecomment-751867437
 */
export declare function verifySecureUriClaim(uri: string, claim: string): void;

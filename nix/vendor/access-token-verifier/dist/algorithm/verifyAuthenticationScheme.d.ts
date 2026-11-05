/**
 * Verify the authentication scheme
 *
 * Currently, Bearer tokens DPoP bound or not are supported.
 *
 * > HTTP provides a simple challenge-response authentication framework that can be used by a server to challenge a client request and by a client to provide authentication information. It uses a case-insensitive token as a means to identify the authentication scheme, followed by additional information necessary for achieving authentication via that scheme.
 * > -- https://datatracker.ietf.org/doc/html/rfc7235#section-2.1
 *
 * > credentials = "Bearer" 1*SP b64token
 * > -- https://datatracker.ietf.org/doc/html/rfc6750#section-2.1
 *
 * > credentials = "DPoP" 1*SP token68
 * > -- https://datatracker.ietf.org/doc/html/draft-ietf-oauth-dpop-04#section-7.1
 *
 * @param authorizationHeader The authorization header used for the request.
 */
export declare function verifyAuthenticationScheme(authorizationHeader: string): void;

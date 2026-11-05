/**
 * Verify the number of JWT segments
 *
 * Currently, only JWS are supported.
 *
 * > If the object is using the JWS Compact Serialization or the JWE Compact Serialization, the number of base64url-encoded segments separated by period ('.') characters differs for JWSs and JWEs. JWSs have three segments separated by two period ('.') characters. JWEs have five segments separated by four period ('.') characters.
 * > -- https://datatracker.ietf.org/doc/html/rfc7516#section-9
 *
 * @param authorizationHeader The authorization header used for the request.
 */
export declare function verifyJwtSegments(authorizationHeader: string): void;

/**
 * Verify each segment is a Base 64 token
 *
 * > b64token = 1*( ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/" ) *"="
 * > -- https://datatracker.ietf.org/doc/html/rfc6750#section-2.1
 *
 * @param authorizationHeader The authorization header used for the request.
 */
export declare function verifyBase64TokenSegments(authorizationHeader: string): void;

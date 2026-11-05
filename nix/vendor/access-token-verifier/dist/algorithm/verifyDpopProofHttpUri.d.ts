/**
 * Verifies the DPoP proof HTTP URI
 *
 * > "htu": The HTTP URI used for the request, without query and fragment parts (REQUIRED).
 * > -- https://datatracker.ietf.org/doc/html/draft-ietf-oauth-dpop-03#section-4.2
 *
 * @param uri The HTTP URI used for the request
 * @param htu The DPoP proof htu parameter
 */
export declare function verifyDpopProofHttpUri(uri: string, htu: string): void;

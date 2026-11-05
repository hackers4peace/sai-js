import type { SolidJwt } from "../type";
/**
 * Parse an authorization header used in Solid
 *
 * @param authorizationHeader The authorization header used for the request.
 * @return {SolidJwt} A representation of the authorization header.
 */
export declare function parseSolidAuthorizationHeader(authorizationHeader: string): SolidJwt;

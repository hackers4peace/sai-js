import type { SolidAccessTokenPayload, AuthenticationOptions, DPoPOptions } from "../type";
/**
 * Verify Solid access token
 *
 * @param authorization The authorization header and optional key and trusted issuer retrieval functions
 * @param dpopOptions The DPoP proof header and associated verifiable claims
 * @returns Access token payload
 */
export declare function verifySolidAccessToken(authorization: AuthenticationOptions, dpopOptions?: DPoPOptions): Promise<SolidAccessTokenPayload>;

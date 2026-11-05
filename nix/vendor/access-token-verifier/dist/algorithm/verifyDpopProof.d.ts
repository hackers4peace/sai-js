import type { SolidAccessToken, JTICheckFunction, RequestMethod } from "../type";
/**
 * Verify DPoP Proof
 * - Signature of DPoP JWT/JWS matches the key embedded in its header
 * - DPoP max age 60 seconds
 * - Claims:
 *    - algorithm 'alg' is an asymetric cryptographic algorithm
 *    - 'iat' is not too far in the future (clockTolerance) or in the past (maxTokenAge)
 *    - 'typ' is 'dpop+jwt'
 * Note:
 * - The maxTokenAge option makes the iat claim mandatory
 * - DPoP tokens can rely on iat+maxTokenAge to be invalidated since they are specific to a request
 *   (so the exp claim which is not required in DPoP tokens' bodys is also redundant)
 */
export declare function verifyDpopProof(dpopHeader: string, accessToken: SolidAccessToken, accessTokenValue: string, httpMethod: RequestMethod, uri: string, isDuplicateJTI?: JTICheckFunction): Promise<void>;

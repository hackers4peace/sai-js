import type { ECPublicJWK } from "./ECPublicJWK";
import type { RSAPublicJWK } from "./RSAPublicJWK";
/**
 * DPoP JWK as defined in https://tools.ietf.org/html/draft-fett-oauth-dpop-04
 * - Must be an Elliptic Curve or RSA public key
 */
export type DPoPPublicJWK = ECPublicJWK | RSAPublicJWK;

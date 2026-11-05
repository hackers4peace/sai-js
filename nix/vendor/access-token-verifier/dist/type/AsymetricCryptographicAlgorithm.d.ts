import type { ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM } from "../constant/ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM";
/**
 * Digital Signature Asymetric Cryptographic Algorithm
 * Note:
 * - ES256 & RS256 are both recommended implementations in JWA libraries
 * - ES256 is likely to become required
 * - Web Cryptography API support (no RSA1_5)
 * See also:
 * - JSON Web Algorithms RFC7518 https://tools.ietf.org/html/rfc7518#section-3
 * - DPoP draft https://tools.ietf.org/html/draft-fett-oauth-dpop-04#section-4.1
 */
export type AsymetricCryptographicAlgorithm = typeof ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM extends Set<infer T> ? T : never;

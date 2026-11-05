import type { JWK } from "jose";
import type { PrivateKeyProperties } from "./PrivateKeyProperties";
/**
 * RSA JSON Web Key
 * - Must have kid, kty, crv, x, y & d
 * - d is the private part of the key, it must be ommited from the public embedded DPoP JWK
 */
type RSAJWK = Required<Pick<JWK, "kty" | "alg" | "n" | "e" | "d" | "p" | "q" | "dp" | "dq" | "qi">>;
export type RSAPublicJWK = Omit<RSAJWK, PrivateKeyProperties>;
export {};

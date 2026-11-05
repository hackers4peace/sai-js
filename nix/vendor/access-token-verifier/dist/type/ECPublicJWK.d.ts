import type { JWK } from "jose";
import type { PrivateKeyProperties } from "./PrivateKeyProperties";
/**
 * Elliptic Curve JSON Web Key
 * - Must have kid, kty, crv, x, y & d
 * - d is the private part of the key, it must be ommited from the public embedded DPoP JWK
 */
type ECJWK = Required<Pick<JWK, "kty" | "crv" | "x" | "y" | "d">>;
export type ECPublicJWK = Omit<ECJWK, PrivateKeyProperties>;
export {};

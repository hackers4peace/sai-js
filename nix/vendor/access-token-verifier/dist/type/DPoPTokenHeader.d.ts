import type { AsymetricCryptographicAlgorithm } from "./AsymetricCryptographicAlgorithm";
import type { DPoPPublicJWK } from "./DPoPPublicJWK";
export interface DPoPTokenHeader {
    alg: AsymetricCryptographicAlgorithm;
    jwk: DPoPPublicJWK;
    typ: "dpop+jwt";
}

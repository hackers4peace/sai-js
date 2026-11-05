import type { AsymetricCryptographicAlgorithm } from "./AsymetricCryptographicAlgorithm";
export interface SolidAccessTokenHeader {
    kid: string;
    alg: AsymetricCryptographicAlgorithm;
}

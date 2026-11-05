import type { createRemoteJWKSet } from "jose";
export interface RetrieveIssuerKeySetFunction {
    (iss: string): Promise<ReturnType<typeof createRemoteJWKSet>>;
}

import type { createRemoteJWKSet } from "jose";
import LRUCache from "lru-cache";
import type { RetrieveIssuerKeySetFunction } from "../type";
export declare class IssuerKeySetCache extends LRUCache<string, ReturnType<typeof createRemoteJWKSet>> {
    constructor();
    getKeySet(iss: string): ReturnType<RetrieveIssuerKeySetFunction>;
}

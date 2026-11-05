import LRUCache from "lru-cache";
import type { RetrieveOidcIssuersFunction } from "../type";
export declare class IdDocumentIssuersCache extends LRUCache<string, Array<string>> {
    constructor();
    getIssuers(identifier: string): ReturnType<RetrieveOidcIssuersFunction>;
}

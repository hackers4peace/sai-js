import type { SolidAccessTokenPayload, DPoPOptions } from "../type";
import { DPoPJTICache } from "./DPoPJTICache";
import { IssuerKeySetCache } from "./IssuerKeySetCache";
import { WebIDIssuersCache } from "./WebIDIssuersCache";
export declare class SolidTokenVerifier {
    private dpopJtiCache;
    private issuerKeySetCache;
    private webIDIssuersCache;
    constructor(dpopJtiCache?: DPoPJTICache, issuerKeySetCache?: IssuerKeySetCache, webIDIssuersCache?: WebIDIssuersCache);
    verify(authorizationHeader: string, dpop?: DPoPOptions): Promise<SolidAccessTokenPayload>;
}

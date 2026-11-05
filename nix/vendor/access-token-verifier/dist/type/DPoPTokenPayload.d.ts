import type { RequestMethod } from "./RequestMethod";
export interface DPoPTokenPayload {
    htm: RequestMethod;
    htu: string;
    iat: number;
    jti: string;
    ath?: string;
}

import type { DPoPTokenHeader } from "./DPoPTokenHeader";
import type { DPoPTokenPayload } from "./DPoPTokenPayload";
/**
 * DPoP as defined in https://tools.ietf.org/html/draft-fett-oauth-dpop-04
 */
export interface DPoPToken {
    header: DPoPTokenHeader;
    payload: DPoPTokenPayload;
    signature: string;
}

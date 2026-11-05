import type { SolidAccessTokenHeader } from "./SolidAccessTokenHeader";
import type { SolidDpopBoundAccessTokenPayload } from "./SolidDpopBoundAccessTokenPayload";
export interface SolidDpopBoundAccessToken {
    header: SolidAccessTokenHeader;
    payload: SolidDpopBoundAccessTokenPayload;
    signature: string;
}

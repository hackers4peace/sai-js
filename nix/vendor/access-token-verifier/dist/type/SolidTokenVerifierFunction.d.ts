import type { DPoPOptions } from "./DPoPOptions";
import type { SolidAccessTokenPayload } from "./SolidAccessTokenPayload";
export interface SolidTokenVerifierFunction {
    (authorizationHeader: string, dpop?: DPoPOptions): Promise<SolidAccessTokenPayload>;
}

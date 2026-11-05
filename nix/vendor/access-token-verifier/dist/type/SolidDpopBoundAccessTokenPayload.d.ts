import type { SolidAccessTokenPayload } from "./SolidAccessTokenPayload";
export interface SolidDpopBoundAccessTokenPayload extends SolidAccessTokenPayload {
    cnf: {
        jkt: string;
    };
}

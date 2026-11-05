import type { SolidAuthenticationScheme } from "./SolidAuthenticationScheme";
export interface SolidJwt {
    authenticationScheme: SolidAuthenticationScheme;
    joseHeader: string;
    jwsPayload: string;
    jwsSignature: string;
    value: string;
}

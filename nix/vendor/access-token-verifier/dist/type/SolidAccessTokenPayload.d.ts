export interface SolidAccessTokenPayload {
    aud: "solid" | string[];
    client_id?: string;
    cnf?: {
        jkt: string;
    };
    exp: number;
    iat: number;
    iss: string;
    webid: string;
}

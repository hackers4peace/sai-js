import type { RetrieveIssuerKeySetFunction } from "./RetrieveIssuerKeySetFunction";
import type { RetrieveOidcIssuersFunction } from "./RetrieveOidcIssuersFunction";
export interface AuthenticationOptions {
    header: string;
    issuers?: RetrieveOidcIssuersFunction;
    keySet?: RetrieveIssuerKeySetFunction;
}

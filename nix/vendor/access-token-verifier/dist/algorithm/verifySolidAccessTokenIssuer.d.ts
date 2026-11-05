/**
 * Verifies the Solid access token issuer is trusted
 *
 * > The RS MUST check the WebID document for the existence of a statement matching ?webid <http://www.w3.org/ns/solid/terms#oidcIssuer> ?iss., where ?webid and ?iss are the values of the webid and iss claims respectively.
 * > -- https://solid.github.io/solid-oidc/#resource-access-validation
 *
 * @param issuers The OIDC issuers listed in the WebID claimed by the access token
 * @param iss The access token iss parameter
 */
export declare function verifySolidAccessTokenIssuer(issuers: string[], iss: string): void;

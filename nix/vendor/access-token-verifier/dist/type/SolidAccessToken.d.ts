import type { SolidAccessTokenHeader } from "./SolidAccessTokenHeader";
import type { SolidAccessTokenPayload } from "./SolidAccessTokenPayload";
/**
 * Solid Access Token
 *
 * See also: https://solid.github.io/authentication-panel/solid-oidc/#tokens-access
 */
export interface SolidAccessToken {
    header: SolidAccessTokenHeader;
    payload: SolidAccessTokenPayload;
    signature: string;
}

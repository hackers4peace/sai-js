"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifySecureUriClaim = void 0;
const SecureUriClaimVerificationError_1 = require("../error/SecureUriClaimVerificationError");
/**
 * Verifies a URI claim is secured over TLS
 *
 * Currently restricts to HTTPS URIs and localhost.
 * TODO: Check if we can restrict to HTTP over TLS if/when in the future it is allowed or allow other protocols
 *
 * See also: https://solid.github.io/solid-oidc/#security-tls & https://github.com/solid/authentication-panel/issues/114#issuecomment-751867437
 */
function verifySecureUriClaim(uri, claim) {
    const url = new URL(uri);
    if (url.protocol !== "https:" &&
        !(url.protocol === "http:" && url.hostname.split(".").pop() === "localhost")) {
        throw new SecureUriClaimVerificationError_1.SecureUriClaimVerificationError(uri, claim);
    }
}
exports.verifySecureUriClaim = verifySecureUriClaim;
//# sourceMappingURL=verifySecureUriClaim.js.map
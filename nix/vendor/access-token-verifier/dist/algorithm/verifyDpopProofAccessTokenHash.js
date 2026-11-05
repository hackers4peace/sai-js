"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyDpopProofAccessTokenHash = void 0;
const crypto_1 = require("crypto");
const jose_1 = require("jose");
const AccessTokenHashVerificationError_1 = require("../error/AccessTokenHashVerificationError");
/**
 * Verifies the DPoP proof access token hash
 *
 * > "ath": hash of the access token (REQUIRED). The value MUST be the result of a base64url encoding (with no padding) the SHA-256 hash of the ASCII encoding of the associated access token's value.
 * > -- https://datatracker.ietf.org/doc/html/draft-ietf-oauth-dpop-03#section-4.2
 *
 * @param accessToken The value of the access token associated with the DPoP proof
 * @param ath The DPoP proof ath parameter
 */
function verifyDpopProofAccessTokenHash(accessToken, ath) {
    const actual = jose_1.base64url.encode((0, crypto_1.createHash)("sha256").update(Buffer.from(accessToken, "ascii")).digest());
    if (actual !== ath) {
        throw new AccessTokenHashVerificationError_1.AccessTokenHashVerificationError(actual, ath);
    }
}
exports.verifyDpopProofAccessTokenHash = verifyDpopProofAccessTokenHash;
//# sourceMappingURL=verifyDpopProofAccessTokenHash.js.map
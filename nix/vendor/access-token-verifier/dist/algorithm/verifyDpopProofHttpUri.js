"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyDpopProofHttpUri = void 0;
const HttpUriVerificationError_1 = require("../error/HttpUriVerificationError");
/**
 * Verifies the DPoP proof HTTP URI
 *
 * > "htu": The HTTP URI used for the request, without query and fragment parts (REQUIRED).
 * > -- https://datatracker.ietf.org/doc/html/draft-ietf-oauth-dpop-03#section-4.2
 *
 * @param uri The HTTP URI used for the request
 * @param htu The DPoP proof htu parameter
 */
function verifyDpopProofHttpUri(uri, htu) {
    const rawUri = uri.replace(/[?#].*/, "");
    if (htu !== rawUri) {
        throw new HttpUriVerificationError_1.HttpUriVerificationError(rawUri, htu);
    }
}
exports.verifyDpopProofHttpUri = verifyDpopProofHttpUri;
//# sourceMappingURL=verifyDpopProofHttpUri.js.map
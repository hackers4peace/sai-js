"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyDpopProofHttpMethod = void 0;
const HttpMethodVerificationError_1 = require("../error/HttpMethodVerificationError");
/**
 * Verifies the DPoP proof HTTP method
 *
 * > "htm": The HTTP method for the request to which the JWT is attached, as defined in [RFC7231] (REQUIRED).
 * > -- https://datatracker.ietf.org/doc/html/draft-ietf-oauth-dpop-03#section-4.2
 *
 * @param method The HTTP request method
 * @param htm The DPoP proof htm parameter
 */
function verifyDpopProofHttpMethod(method, htm) {
    if (method !== htm) {
        throw new HttpMethodVerificationError_1.HttpMethodVerificationError(method, htm);
    }
}
exports.verifyDpopProofHttpMethod = verifyDpopProofHttpMethod;
//# sourceMappingURL=verifyDpopProofHttpMethod.js.map
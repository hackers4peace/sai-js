"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccessTokenHashVerificationError = void 0;
class AccessTokenHashVerificationError extends Error {
    constructor(actual, expected) {
        super(`The DPoP proof ath parameter doesn't match the base64 URL encoded SHA256 hash of the ASCII encoded associated access token's value.\nActual: ${actual}\nExpected: ${expected}`);
    }
}
exports.AccessTokenHashVerificationError = AccessTokenHashVerificationError;
//# sourceMappingURL=AccessTokenHashVerificationError.js.map
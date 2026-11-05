"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecureUriClaimVerificationError = void 0;
class SecureUriClaimVerificationError extends Error {
    constructor(actual, expected) {
        super(`The URI claim could not be verified as secure.\nActual: ${actual}\nExpected: The ${expected} claim to be an HTTPS URI or a localhost with port number HTTP URI`);
    }
}
exports.SecureUriClaimVerificationError = SecureUriClaimVerificationError;
//# sourceMappingURL=SecureUriClaimVerificationError.js.map
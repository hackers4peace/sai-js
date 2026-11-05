"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequiredClaimVerificationError = void 0;
class RequiredClaimVerificationError extends Error {
    constructor(actual, expected) {
        super(`The Solid access token payload is missing a required claim.\nActual: ${actual}\nExpected: ${expected}`);
    }
}
exports.RequiredClaimVerificationError = RequiredClaimVerificationError;
//# sourceMappingURL=RequiredClaimVerificationError.js.map
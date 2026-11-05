"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpUriVerificationError = void 0;
class HttpUriVerificationError extends Error {
    constructor(actual, expected) {
        super(`The DPoP proof htu parameter must be the HTTP request URI without query and fragment parts.\nActual: ${actual}\nExpected: ${expected}`);
    }
}
exports.HttpUriVerificationError = HttpUriVerificationError;
//# sourceMappingURL=HttpUriVerificationError.js.map
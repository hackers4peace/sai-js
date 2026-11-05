"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpMethodVerificationError = void 0;
class HttpMethodVerificationError extends Error {
    constructor(actual, expected) {
        super(`The DPoP proof htm parameter doesn't match the HTTP request method.\nActual: ${actual}\nExpected: ${expected}`);
    }
}
exports.HttpMethodVerificationError = HttpMethodVerificationError;
//# sourceMappingURL=HttpMethodVerificationError.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JwkThumbprintVerificationError = void 0;
class JwkThumbprintVerificationError extends Error {
    constructor(actual, expected) {
        super(`The DPoP proof JWK thumbprint doesn't match the access token cnf jkt parameter.\nActual: ${actual}\nExpected: ${expected}`);
    }
}
exports.JwkThumbprintVerificationError = JwkThumbprintVerificationError;
//# sourceMappingURL=JwkThumbprintVerificationError.js.map
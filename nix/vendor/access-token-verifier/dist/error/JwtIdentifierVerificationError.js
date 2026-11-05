"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JwtIdentifierVerificationError = void 0;
class JwtIdentifierVerificationError extends Error {
    constructor(actual) {
        super(`The DPoP proof jti parameter matched a previously used identifier.\nActual: ${actual} was previously used\nExpected: A unique JWT identifier`);
    }
}
exports.JwtIdentifierVerificationError = JwtIdentifierVerificationError;
//# sourceMappingURL=JwtIdentifierVerificationError.js.map
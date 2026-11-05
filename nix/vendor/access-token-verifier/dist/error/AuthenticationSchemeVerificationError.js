"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthenticationSchemeVerificationError = void 0;
class AuthenticationSchemeVerificationError extends Error {
    constructor(actual) {
        super(`The Authentication scheme must be DPoP or Bearer.\nActual: ${actual}`);
    }
}
exports.AuthenticationSchemeVerificationError = AuthenticationSchemeVerificationError;
//# sourceMappingURL=AuthenticationSchemeVerificationError.js.map
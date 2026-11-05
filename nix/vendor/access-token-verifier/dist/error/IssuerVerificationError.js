"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IssuerVerificationError = void 0;
class IssuerVerificationError extends Error {
    constructor(actual, expected) {
        super(`The access token issuer doesn't match its associated identity document's trusted OIDC issuers.\nActual: ${actual}\nExpected: ${expected}`);
    }
}
exports.IssuerVerificationError = IssuerVerificationError;
//# sourceMappingURL=IssuerVerificationError.js.map
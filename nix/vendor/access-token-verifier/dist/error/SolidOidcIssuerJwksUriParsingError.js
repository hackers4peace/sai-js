"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SolidOidcIssuerJwksUriParsingError = void 0;
class SolidOidcIssuerJwksUriParsingError extends Error {
    constructor(actual) {
        super(`The OIDC Identity Provider well-known configuration parsing failed.\nActual: ${actual}\nExpected: A well-known config with a jwks_uri field containing a valid URL`);
    }
}
exports.SolidOidcIssuerJwksUriParsingError = SolidOidcIssuerJwksUriParsingError;
//# sourceMappingURL=SolidOidcIssuerJwksUriParsingError.js.map
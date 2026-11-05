"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IssuerConfigurationDereferencingError = void 0;
class IssuerConfigurationDereferencingError extends Error {
    constructor(actual, expected) {
        super(`The Issuer openid configuration could not be dereferenced.\nActual: HTTP status code ${actual}\nExpected: A dereferenceable resource at ${expected}`);
    }
}
exports.IssuerConfigurationDereferencingError = IssuerConfigurationDereferencingError;
//# sourceMappingURL=IssuerConfigurationDereferencingError.js.map
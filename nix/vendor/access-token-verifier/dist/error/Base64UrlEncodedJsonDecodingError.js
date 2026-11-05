"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Base64UrlEncodedJsonDecodingError = void 0;
class Base64UrlEncodedJsonDecodingError extends Error {
    constructor(actual) {
        super(`The string could not be parsed as a base 64 URL encoded JSON object.\nActual: ${actual}\nExpected: A base 64 encoded JSON object`);
    }
}
exports.Base64UrlEncodedJsonDecodingError = Base64UrlEncodedJsonDecodingError;
//# sourceMappingURL=Base64UrlEncodedJsonDecodingError.js.map
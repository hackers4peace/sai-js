"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JwtStructureError = void 0;
class JwtStructureError extends Error {
    constructor(actual) {
        super(`The Authorization header token should be a JWT consisting of three parts (JWS): a JOSE header; a JWS payload; and a JWS signature.\nActual: ${actual}\nExpected: 3`);
    }
}
exports.JwtStructureError = JwtStructureError;
//# sourceMappingURL=JwtStructureError.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Base64TokenSegmentError = void 0;
class Base64TokenSegmentError extends Error {
    constructor(actual) {
        super(`Token segments should be Base 64 encoded strings.\nActual: ${actual}\nExpected: A base 64 encoded token segment`);
    }
}
exports.Base64TokenSegmentError = Base64TokenSegmentError;
//# sourceMappingURL=Base64TokenSegmentError.js.map
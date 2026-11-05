"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebidIriError = void 0;
class WebidIriError extends Error {
    constructor(actual) {
        super(`The identifier could not be parsed as a URL.\nActual: ${actual}\nExpected: A valid URL`);
    }
}
exports.WebidIriError = WebidIriError;
//# sourceMappingURL=WebidIriError.js.map
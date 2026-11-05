"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebidDereferencingError = void 0;
class WebidDereferencingError extends Error {
    constructor(actual) {
        super(`The identity document could not be dereferenced.\nActual: ${actual}\nExpected: A dereferenceable resource`);
    }
}
exports.WebidDereferencingError = WebidDereferencingError;
//# sourceMappingURL=WebidDereferencingError.js.map
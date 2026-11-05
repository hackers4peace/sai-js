"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebidParsingError = void 0;
class WebidParsingError extends Error {
    constructor() {
        super(`The identity document could not be parsed.\nActual: Invalid document\nExpected: A valid Turtle WebID or JSON controlled identifier document`);
    }
}
exports.WebidParsingError = WebidParsingError;
//# sourceMappingURL=WebidParsingError.js.map
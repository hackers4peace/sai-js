"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isObjectPropertyOf = void 0;
function isObjectPropertyOf(
// eslint-disable-next-line @typescript-eslint/ban-types
x, property) {
    return property in x;
}
exports.isObjectPropertyOf = isObjectPropertyOf;
//# sourceMappingURL=isObjectPropertyOf.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isECPublicJWK = void 0;
const ts_guards_1 = require("ts-guards");
/*
 * export function isECJWK(x: unknown): asserts x is ECJWK {
 *   isECPublicJWK(x);
 *   asserts.isObjectPropertyOf(x, "d");
 *   asserts.isString(x.d);
 * }
 */
function isECPublicJWK(x) {
    ts_guards_1.asserts.areObjectPropertiesOf(x, ["kty", "crv", "x", "y"]);
    ts_guards_1.asserts.isLiteral(x.kty, "EC");
    ts_guards_1.asserts.isLiteralType(x.crv, new Set(["P-256", "P-384", "P-521"]));
    ts_guards_1.asserts.isString(x.x);
    ts_guards_1.asserts.isString(x.y);
}
exports.isECPublicJWK = isECPublicJWK;
//# sourceMappingURL=isECPublicJWK.js.map
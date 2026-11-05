"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRSAPublicJWK = void 0;
const ts_guards_1 = require("ts-guards");
const RSA_ALGORITHM_1 = require("../constant/RSA_ALGORITHM");
/*
 * export function isRSAJWK(x: unknown): asserts x is RSAJWK {
 *   isRSAPublicJWK(x);
 *   asserts.areObjectPropertiesOf(x, ["d", "p", "q", "dp", "dq", "qi"]);
 *   asserts.isString(x.d);
 *   asserts.isString(x.p);
 *   asserts.isString(x.q);
 *   asserts.isString(x.dp);
 *   asserts.isString(x.dq);
 *   asserts.isString(x.qi);
 * }
 */
function isRSAPublicJWK(x) {
    ts_guards_1.asserts.areObjectPropertiesOf(x, ["alg", "kty", "n", "e"]);
    ts_guards_1.asserts.isLiteralType(x.alg, RSA_ALGORITHM_1.RSA_ALGORITHM);
    ts_guards_1.asserts.isLiteral(x.kty, "RSA");
    ts_guards_1.asserts.isString(x.n);
    ts_guards_1.asserts.isString(x.e);
}
exports.isRSAPublicJWK = isRSAPublicJWK;
//# sourceMappingURL=isRSAPublicJWK.js.map
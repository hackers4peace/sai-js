"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDPoPToken = void 0;
const ts_guards_1 = require("ts-guards");
const ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM_1 = require("../constant/ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM");
const REQUEST_METHOD_1 = require("../constant/REQUEST_METHOD");
const isDPoPPublicJWK_1 = require("./isDPoPPublicJWK");
/**
 * Check valid DPoP JWT
 */
function isDPoPTokenHeader(x) {
    ts_guards_1.asserts.areObjectPropertiesOf(x, ["alg", "jwk", "typ"]);
    ts_guards_1.asserts.isLiteralType(x.alg, ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM_1.ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM);
    (0, isDPoPPublicJWK_1.isDPoPPublicJWK)(x.jwk);
    ts_guards_1.asserts.isLiteral(x.typ, "dpop+jwt");
}
function isDPoPTokenBody(x) {
    ts_guards_1.asserts.areObjectPropertiesOf(x, ["htm", "htu", "iat", "jti"]);
    ts_guards_1.asserts.isLiteralType(x.htm, REQUEST_METHOD_1.REQUEST_METHOD);
    ts_guards_1.asserts.isString(x.htu);
    ts_guards_1.asserts.isNumber(x.iat);
    ts_guards_1.asserts.isString(x.jti);
}
function isDPoPToken(x) {
    ts_guards_1.asserts.areObjectPropertiesOf(x, ["header", "payload", "signature"]);
    isDPoPTokenHeader(x.header);
    isDPoPTokenBody(x.payload);
    ts_guards_1.asserts.isString(x.signature);
}
exports.isDPoPToken = isDPoPToken;
//# sourceMappingURL=isDPoPToken.js.map
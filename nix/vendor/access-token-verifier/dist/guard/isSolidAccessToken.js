"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSolidAccessToken = void 0;
const ts_guards_1 = require("ts-guards");
const standard_object_1 = require("ts-guards/dist/standard-object");
const ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM_1 = require("../constant/ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM");
/**
 * Check valid Access Token
 */
function isSolidAccessTokenHeader(x) {
    ts_guards_1.asserts.areObjectPropertiesOf(x, ["alg", "kid"]);
    ts_guards_1.asserts.isLiteralType(x.alg, ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM_1.ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM);
    ts_guards_1.asserts.isString(x.kid);
}
function isSolidAccessTokenPayload(x) {
    ts_guards_1.asserts.areObjectPropertiesOf(x, ["aud", "exp", "iat", "iss", "webid"]);
    ts_guards_1.asserts.isLiteral(ts_guards_1.literalType.isLiteral(x.aud, "solid") ||
        (ts_guards_1.standardObject.isArray(x.aud) && x.aud.includes("solid")), true);
    ts_guards_1.asserts.isNumber(x.exp);
    ts_guards_1.asserts.isNumber(x.iat);
    ts_guards_1.asserts.isString(x.iss);
    ts_guards_1.asserts.isString(x.webid);
    // TODO: Increase coverage
    /* istanbul ignore next */
    if ((0, standard_object_1.isObjectPropertyOf)(x, "cnf")) {
        ts_guards_1.asserts.isObjectPropertyOf(x.cnf, "jkt");
        ts_guards_1.asserts.isString(x.cnf.jkt);
    }
}
function isSolidAccessToken(x) {
    ts_guards_1.asserts.areObjectPropertiesOf(x, ["header", "payload", "signature"]);
    isSolidAccessTokenHeader(x.header);
    isSolidAccessTokenPayload(x.payload);
    ts_guards_1.asserts.isString(x.signature);
}
exports.isSolidAccessToken = isSolidAccessToken;
//# sourceMappingURL=isSolidAccessToken.js.map
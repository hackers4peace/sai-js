"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDPoPPublicJWK = void 0;
const ts_guards_1 = require("ts-guards");
const isECPublicJWK_1 = require("./isECPublicJWK");
const isRSAPublicJWK_1 = require("./isRSAPublicJWK");
/**
 * JWK Validation
 */
/* eslint-disable no-use-before-define */
/*
 * export function isDPoPJWK(x: unknown): asserts x is DPoPJWK {
 *   asserts.isObjectPropertyOf(x, "kty");
 *   if (x.kty === "EC") {
 *     isECJWK(x);
 *   } else if (x.kty === "RSA") {
 *     isRSAJWK(x);
 *   } else {
 *     asserts.error("EC or RSA", x.kty);
 *   }
 * }
 */
function isDPoPPublicJWK(x) {
    ts_guards_1.asserts.isObjectPropertyOf(x, "kty");
    if (x.kty === "EC") {
        (0, isECPublicJWK_1.isECPublicJWK)(x);
    }
    else if (x.kty === "RSA") {
        (0, isRSAPublicJWK_1.isRSAPublicJWK)(x);
    }
    else {
        ts_guards_1.asserts.error("EC or RSA", x.kty);
    }
}
exports.isDPoPPublicJWK = isDPoPPublicJWK;
//# sourceMappingURL=isDPoPPublicJWK.js.map
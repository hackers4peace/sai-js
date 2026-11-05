"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM = void 0;
const RSA_ALGORITHM_1 = require("./RSA_ALGORITHM");
exports.ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM = new Set([
    "ES256",
    "ES384",
    "ES512",
    "PS256",
    "PS384",
    "PS512",
    ...Array.from(RSA_ALGORITHM_1.RSA_ALGORITHM),
]);
//# sourceMappingURL=ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM.js.map
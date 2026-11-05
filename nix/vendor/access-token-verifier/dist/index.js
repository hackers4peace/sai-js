"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSolidTokenVerifier = void 0;
const SolidTokenVerifier_1 = require("./class/SolidTokenVerifier");
// Functions
function createSolidTokenVerifier(dpopJtiCache, issuerKeySetCache, webIDIssuersCache) {
    const cache = new SolidTokenVerifier_1.SolidTokenVerifier(dpopJtiCache, issuerKeySetCache, webIDIssuersCache);
    return cache.verify.bind(cache);
}
exports.createSolidTokenVerifier = createSolidTokenVerifier;
//# sourceMappingURL=index.js.map
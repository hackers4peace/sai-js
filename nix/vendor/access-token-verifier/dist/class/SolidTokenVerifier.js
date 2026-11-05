"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SolidTokenVerifier = void 0;
const primitive_type_1 = require("ts-guards/dist/primitive-type");
const verifySolidAccessToken_1 = require("../algorithm/verifySolidAccessToken");
const DPoPJTICache_1 = require("./DPoPJTICache");
const IssuerKeySetCache_1 = require("./IssuerKeySetCache");
const WebIDIssuersCache_1 = require("./WebIDIssuersCache");
class SolidTokenVerifier {
    dpopJtiCache;
    issuerKeySetCache;
    webIDIssuersCache;
    constructor(dpopJtiCache, issuerKeySetCache, webIDIssuersCache) {
        this.dpopJtiCache = dpopJtiCache ?? new DPoPJTICache_1.DPoPJTICache();
        this.issuerKeySetCache = issuerKeySetCache ?? new IssuerKeySetCache_1.IssuerKeySetCache();
        this.webIDIssuersCache = webIDIssuersCache ?? new WebIDIssuersCache_1.WebIDIssuersCache();
    }
    async verify(authorizationHeader, dpop) {
        let dpopArgs;
        if ((0, primitive_type_1.isNotNullOrUndefined)(dpop)) {
            dpopArgs = {
                header: dpop.header,
                method: dpop.method,
                url: dpop.url,
                isDuplicateJTI: (dpop.isDuplicateJTI ?? this.dpopJtiCache.isDuplicateJTI).bind(this.dpopJtiCache),
            };
        }
        return (0, verifySolidAccessToken_1.verifySolidAccessToken)({
            header: authorizationHeader,
            issuers: this.webIDIssuersCache.getIssuers.bind(this.webIDIssuersCache),
            keySet: this.issuerKeySetCache.getKeySet.bind(this.issuerKeySetCache),
        }, dpopArgs);
    }
}
exports.SolidTokenVerifier = SolidTokenVerifier;
//# sourceMappingURL=SolidTokenVerifier.js.map
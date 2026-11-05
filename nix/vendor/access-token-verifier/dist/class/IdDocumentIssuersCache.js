"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdDocumentIssuersCache = void 0;
const lru_cache_1 = __importDefault(require("lru-cache"));
const retrieveWebidTrustedOidcIssuers_1 = require("../algorithm/retrieveWebidTrustedOidcIssuers");
const config_1 = require("../config");
class IdDocumentIssuersCache extends lru_cache_1.default {
    constructor() {
        super({ max: config_1.maxRequestsPerSecond, maxAge: config_1.maxAgeInMilliseconds });
    }
    async getIssuers(identifier) {
        const cachedValue = this.get(identifier);
        if (cachedValue === undefined) {
            const issuersValue = await (0, retrieveWebidTrustedOidcIssuers_1.retrieveIdDocumentTrustedOidcIssuers)(identifier);
            this.set(identifier, issuersValue);
            return issuersValue;
        }
        return cachedValue;
    }
}
exports.IdDocumentIssuersCache = IdDocumentIssuersCache;
//# sourceMappingURL=IdDocumentIssuersCache.js.map
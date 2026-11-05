"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IssuerKeySetCache = void 0;
const lru_cache_1 = __importDefault(require("lru-cache"));
const retrieveAccessTokenIssuerKeySet_1 = require("../algorithm/retrieveAccessTokenIssuerKeySet");
const config_1 = require("../config");
class IssuerKeySetCache extends lru_cache_1.default {
    constructor() {
        super({ max: config_1.maxRequestsPerSecond, maxAge: config_1.maxAgeInMilliseconds });
    }
    async getKeySet(iss) {
        const cachedValue = this.get(iss.toString());
        if (cachedValue === undefined) {
            const keySetValue = await (0, retrieveAccessTokenIssuerKeySet_1.retrieveAccessTokenIssuerKeySet)(iss);
            this.set(iss.toString(), keySetValue);
            return keySetValue;
        }
        return cachedValue;
    }
}
exports.IssuerKeySetCache = IssuerKeySetCache;
//# sourceMappingURL=IssuerKeySetCache.js.map
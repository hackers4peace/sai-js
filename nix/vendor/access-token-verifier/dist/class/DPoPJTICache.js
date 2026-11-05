"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DPoPJTICache = void 0;
const lru_cache_1 = __importDefault(require("lru-cache"));
const config_1 = require("../config");
class DPoPJTICache extends lru_cache_1.default {
    constructor() {
        super({
            max: (config_1.maxRequestsPerSecond * config_1.maxAgeInMilliseconds) / 1000,
            maxAge: config_1.maxAgeInMilliseconds,
        });
    }
    isDuplicateJTI(jti) {
        if (this.get(jti) === undefined) {
            this.set(jti, true);
            return false;
        }
        return true;
    }
}
exports.DPoPJTICache = DPoPJTICache;
//# sourceMappingURL=DPoPJTICache.js.map
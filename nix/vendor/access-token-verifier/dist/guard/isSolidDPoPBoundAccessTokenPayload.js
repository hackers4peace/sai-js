"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSolidDPoPBoundAccessTokenPayload = void 0;
const ts_guards_1 = require("ts-guards");
function isSolidDPoPBoundAccessTokenPayload(x) {
    ts_guards_1.asserts.isObjectPropertyOf(x, "cnf");
    ts_guards_1.asserts.isObjectPropertyOf(x.cnf, "jkt");
    ts_guards_1.asserts.isString(x.cnf.jkt);
}
exports.isSolidDPoPBoundAccessTokenPayload = isSolidDPoPBoundAccessTokenPayload;
//# sourceMappingURL=isSolidDPoPBoundAccessTokenPayload.js.map
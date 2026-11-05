"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyJwtSegments = void 0;
const JwtStructureError_1 = require("../error/JwtStructureError");
/**
 * Verify the number of JWT segments
 *
 * Currently, only JWS are supported.
 *
 * > If the object is using the JWS Compact Serialization or the JWE Compact Serialization, the number of base64url-encoded segments separated by period ('.') characters differs for JWSs and JWEs. JWSs have three segments separated by two period ('.') characters. JWEs have five segments separated by four period ('.') characters.
 * > -- https://datatracker.ietf.org/doc/html/rfc7516#section-9
 *
 * @param authorizationHeader The authorization header used for the request.
 */
function verifyJwtSegments(authorizationHeader) {
    const segments = authorizationHeader
        .replace(/^(DPoP|Bearer) +/i, "")
        .split(".");
    if (segments.length !== 3) {
        throw new JwtStructureError_1.JwtStructureError(`${segments.length}`);
    }
}
exports.verifyJwtSegments = verifyJwtSegments;
//# sourceMappingURL=verifyJwtSegments.js.map
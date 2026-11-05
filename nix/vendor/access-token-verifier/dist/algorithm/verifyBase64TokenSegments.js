"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyBase64TokenSegments = void 0;
const Base64TokenSegmentError_1 = require("../error/Base64TokenSegmentError");
/**
 * Verify each segment is a Base 64 token
 *
 * > b64token = 1*( ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/" ) *"="
 * > -- https://datatracker.ietf.org/doc/html/rfc6750#section-2.1
 *
 * @param authorizationHeader The authorization header used for the request.
 */
function verifyBase64TokenSegments(authorizationHeader) {
    const segments = authorizationHeader
        .replace(/^(DPoP|Bearer) +/i, "")
        .split(".");
    segments.forEach((x, key) => {
        // Last segments can end with 0 or more "="
        if (key === segments.length - 1) {
            if (!/^[\w\-~+/]+(=+)?$/.test(x)) {
                throw new Base64TokenSegmentError_1.Base64TokenSegmentError(x);
            }
        }
        else if (!/^[\w\-~+/]+$/.test(x)) {
            throw new Base64TokenSegmentError_1.Base64TokenSegmentError(x);
        }
    });
}
exports.verifyBase64TokenSegments = verifyBase64TokenSegments;
//# sourceMappingURL=verifyBase64TokenSegments.js.map
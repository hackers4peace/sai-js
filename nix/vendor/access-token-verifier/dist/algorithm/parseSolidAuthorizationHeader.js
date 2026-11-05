"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseSolidAuthorizationHeader = void 0;
const verifyAuthenticationScheme_1 = require("./verifyAuthenticationScheme");
const verifyBase64TokenSegments_1 = require("./verifyBase64TokenSegments");
const verifyJwtSegments_1 = require("./verifyJwtSegments");
/**
 * Parse an authorization header used in Solid
 *
 * @param authorizationHeader The authorization header used for the request.
 * @return {SolidJwt} A representation of the authorization header.
 */
function parseSolidAuthorizationHeader(authorizationHeader) {
    const [match, joseHeader, jwsPayload, jwsSignature] = /^(?:DPoP|Bearer) +([\w\-~+/]+)\.([\w\-~+/]+)\.([\w\-~+/]+)(?:=+)?$/i.exec(authorizationHeader) ?? [];
    if (!match) {
        // Verify the authentication scheme is supported
        (0, verifyAuthenticationScheme_1.verifyAuthenticationScheme)(authorizationHeader);
        // Verify the token is composed of the right number of segments
        (0, verifyJwtSegments_1.verifyJwtSegments)(authorizationHeader);
        // Verify each segment is a Base 64 encoded token
        (0, verifyBase64TokenSegments_1.verifyBase64TokenSegments)(authorizationHeader);
    }
    return {
        authenticationScheme: /^DPoP/i.test(authorizationHeader)
            ? "DPoP"
            : "Bearer",
        joseHeader,
        jwsPayload,
        jwsSignature,
        value: `${joseHeader}.${jwsPayload}.${jwsSignature}`,
    };
}
exports.parseSolidAuthorizationHeader = parseSolidAuthorizationHeader;
//# sourceMappingURL=parseSolidAuthorizationHeader.js.map
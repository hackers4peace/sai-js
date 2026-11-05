"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decodeBase64UrlEncodedJson = void 0;
const util_1 = require("util");
const jose_1 = require("jose");
const Base64UrlEncodedJsonDecodingError_1 = require("../error/Base64UrlEncodedJsonDecodingError");
/**
 * Decodes base 64 URL encoded JSON objects
 *
 * See also: https://datatracker.ietf.org/doc/html/rfc7519#section-7.2
 *
 * @param encodedJson The base64 URL encoded JSON
 * @returns The access token as a JSON
 */
function decodeBase64UrlEncodedJson(encodedJson) {
    try {
        return JSON.parse(new util_1.TextDecoder().decode(jose_1.base64url.decode(encodedJson)));
    }
    catch {
        throw new Base64UrlEncodedJsonDecodingError_1.Base64UrlEncodedJsonDecodingError(encodedJson);
    }
}
exports.decodeBase64UrlEncodedJson = decodeBase64UrlEncodedJson;
//# sourceMappingURL=decodeBase64UrlEncodedJson.js.map
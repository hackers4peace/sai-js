/**
 * Decodes base 64 URL encoded JSON objects
 *
 * See also: https://datatracker.ietf.org/doc/html/rfc7519#section-7.2
 *
 * @param encodedJson The base64 URL encoded JSON
 * @returns The access token as a JSON
 */
export declare function decodeBase64UrlEncodedJson(encodedJson: string): unknown;

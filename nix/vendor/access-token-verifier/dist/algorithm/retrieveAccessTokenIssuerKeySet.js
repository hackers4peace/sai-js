"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.retrieveAccessTokenIssuerKeySet = void 0;
const jose_1 = require("jose");
const node_fetch_1 = __importDefault(require("node-fetch"));
const primitive_type_1 = require("ts-guards/dist/primitive-type");
const standard_object_1 = require("ts-guards/dist/standard-object");
const IssuerConfigurationDereferencingError_1 = require("../error/IssuerConfigurationDereferencingError");
const SolidOidcIssuerJwksUriParsingError_1 = require("../error/SolidOidcIssuerJwksUriParsingError");
function getWellKnownOpenidConfigurationUrl(iss) {
    return iss.replace(/\/$/, "").concat("/.well-known/openid-configuration");
}
async function dereferenceIssuerConfiguration(iss) {
    const configUrl = getWellKnownOpenidConfigurationUrl(iss);
    const response = await (0, node_fetch_1.default)(configUrl, {
        method: "GET",
        // eslint-disable-next-line @typescript-eslint/naming-convention
        headers: { Accept: "application/json" },
    });
    if (response.ok) {
        return (await response.json());
    }
    throw new IssuerConfigurationDereferencingError_1.IssuerConfigurationDereferencingError(response.status.toString(), configUrl);
}
async function getJwksUri(iss) {
    const issuerConfig = await dereferenceIssuerConfiguration(iss);
    if (!(0, standard_object_1.isObjectPropertyOf)(issuerConfig, "jwks_uri")) {
        throw new SolidOidcIssuerJwksUriParsingError_1.SolidOidcIssuerJwksUriParsingError(`JWKS URI field missing in issuer configuration at ${iss.toString()}`);
    }
    if (!(0, primitive_type_1.isString)(issuerConfig.jwks_uri)) {
        throw new SolidOidcIssuerJwksUriParsingError_1.SolidOidcIssuerJwksUriParsingError(`JWKS URI field is not a string in issuer configuration at ${iss.toString()}`);
    }
    try {
        return new URL(issuerConfig.jwks_uri);
    }
    catch (_) {
        throw new SolidOidcIssuerJwksUriParsingError_1.SolidOidcIssuerJwksUriParsingError(`JWKS URI field could not be parsed as a valid URL in issuer configuration at ${iss.toString()}`);
    }
}
async function retrieveAccessTokenIssuerKeySet(iss, getKeySet) {
    if (typeof getKeySet !== "undefined" && getKeySet !== null) {
        return getKeySet(iss);
    }
    return (0, jose_1.createRemoteJWKSet)(await getJwksUri(iss));
}
exports.retrieveAccessTokenIssuerKeySet = retrieveAccessTokenIssuerKeySet;
//# sourceMappingURL=retrieveAccessTokenIssuerKeySet.js.map
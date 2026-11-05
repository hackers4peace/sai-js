"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.retrieveWebidTrustedOidcIssuers = exports.retrieveIdDocumentTrustedOidcIssuers = void 0;
const jsonld_1 = require("jsonld");
const n3_1 = require("n3");
const node_fetch_1 = __importDefault(require("node-fetch"));
const IdDocumentDereferencingError_1 = require("../error/IdDocumentDereferencingError");
const IdDocumentParsingError_1 = require("../error/IdDocumentParsingError");
const IdentifierIriError_1 = require("../error/IdentifierIriError");
const OIDC_ISSUER = "http://www.w3.org/ns/solid/terms#oidcIssuer";
const OPENID_PROVIDER = "https://www.w3.org/ns/lws#OpenIdProvider";
const CID_CONTEXT = "https://www.w3.org/ns/cid/v1";
async function dereferenceIdDocument(identifier) {
    try {
        const response = await (0, node_fetch_1.default)(identifier, {
            headers: {
                accept: "text/turtle, application/cid, application/ld+json, application/json",
            },
        });
        return {
            document: await response.text(),
            baseIRI: response.url,
            contentType: response.headers.get("content-type") ?? "",
        };
    }
    catch (e) {
        throw new IdDocumentDereferencingError_1.IdDocumentDereferencingError(identifier);
    }
}
function parseRdf(rdf, baseIRI) {
    try {
        const store = new n3_1.Store();
        store.addQuads(new n3_1.Parser({ baseIRI }).parse(rdf));
        return store;
    }
    catch (e) {
        throw new IdDocumentParsingError_1.IdDocumentParsingError();
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseControlledIdentifierDocument(value, identifier) {
    if (!isRecord(value) || value.id !== identifier) {
        throw new IdDocumentParsingError_1.IdDocumentParsingError();
    }
    const services = Array.isArray(value.service)
        ? value.service
        : [value.service];
    return services.flatMap((service) => {
        if (!isRecord(service)) {
            return [];
        }
        const types = Array.isArray(service.type) ? service.type : [service.type];
        if (!types.includes(OPENID_PROVIDER)) {
            return [];
        }
        const endpoints = Array.isArray(service.serviceEndpoint)
            ? service.serviceEndpoint
            : [service.serviceEndpoint];
        return endpoints.filter((endpoint) => typeof endpoint === "string");
    });
}
function isControlledIdentifierJsonLd(value) {
    if (!isRecord(value)) {
        return false;
    }
    const context = value["@context"];
    const contexts = Array.isArray(context) ? context : [context];
    return (contexts.includes(CID_CONTEXT) || ("id" in value && "service" in value));
}
function getRdfIssuers(store, identifier) {
    return store
        .getObjects(n3_1.DataFactory.namedNode(identifier), n3_1.DataFactory.namedNode(OIDC_ISSUER), n3_1.DataFactory.defaultGraph())
        .map((x) => x.value);
}
async function parseJsonLdWebId(value, baseIRI, identifier) {
    const nquads = await (0, jsonld_1.toRDF)(value, {
        base: baseIRI,
        format: "application/n-quads",
    });
    return getRdfIssuers(parseRdf(nquads, baseIRI), identifier);
}
async function parseIdDocument(document, baseIRI, contentType, identifier) {
    const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
    if (mediaType === "application/cid" || mediaType === "application/json") {
        try {
            return parseControlledIdentifierDocument(JSON.parse(document), identifier);
        }
        catch (e) {
            if (e instanceof IdDocumentParsingError_1.IdDocumentParsingError) {
                throw e;
            }
            throw new IdDocumentParsingError_1.IdDocumentParsingError();
        }
    }
    if (mediaType === "application/ld+json") {
        try {
            const value = JSON.parse(document);
            if (isControlledIdentifierJsonLd(value)) {
                return parseControlledIdentifierDocument(value, identifier);
            }
            return await parseJsonLdWebId(value, baseIRI, identifier);
        }
        catch (e) {
            if (e instanceof IdDocumentParsingError_1.IdDocumentParsingError) {
                throw e;
            }
            throw new IdDocumentParsingError_1.IdDocumentParsingError();
        }
    }
    if (mediaType !== "text/turtle") {
        throw new IdDocumentParsingError_1.IdDocumentParsingError();
    }
    return getRdfIssuers(parseRdf(document, baseIRI), identifier);
}
async function retrieveIdDocumentTrustedOidcIssuers(identifier, getIssuers) {
    try {
        // eslint-disable-next-line no-new
        new URL(identifier);
    }
    catch (e) {
        throw new IdentifierIriError_1.IdentifierIriError(identifier);
    }
    if (typeof getIssuers !== "undefined" && getIssuers !== null) {
        return getIssuers(identifier);
    }
    const { document, baseIRI, contentType } = await dereferenceIdDocument(identifier);
    return parseIdDocument(document, baseIRI, contentType, identifier);
}
exports.retrieveIdDocumentTrustedOidcIssuers = retrieveIdDocumentTrustedOidcIssuers;
exports.retrieveWebidTrustedOidcIssuers = retrieveIdDocumentTrustedOidcIssuers;
//# sourceMappingURL=retrieveWebidTrustedOidcIssuers.js.map
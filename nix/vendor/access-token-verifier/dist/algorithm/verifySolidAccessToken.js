"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifySolidAccessToken = void 0;
const jose_1 = require("jose");
const ts_guards_1 = require("ts-guards");
const standard_object_1 = require("ts-guards/dist/standard-object");
const config_1 = require("../config");
const ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM_1 = require("../constant/ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM");
const isSolidAccessToken_1 = require("../guard/isSolidAccessToken");
const decodeBase64UrlEncodedJson_1 = require("./decodeBase64UrlEncodedJson");
const parseSolidAuthorizationHeader_1 = require("./parseSolidAuthorizationHeader");
const retrieveAccessTokenIssuerKeySet_1 = require("./retrieveAccessTokenIssuerKeySet");
const retrieveWebidTrustedOidcIssuers_1 = require("./retrieveWebidTrustedOidcIssuers");
const verifyDpopProof_1 = require("./verifyDpopProof");
const verifySecureUriClaim_1 = require("./verifySecureUriClaim");
const verifySolidAccessTokenIssuer_1 = require("./verifySolidAccessTokenIssuer");
const verifySolidAccessTokenRequiredClaims_1 = require("./verifySolidAccessTokenRequiredClaims");
/**
 * Verify Solid access token
 *
 * @param authorization The authorization header and optional key and trusted issuer retrieval functions
 * @param dpopOptions The DPoP proof header and associated verifiable claims
 * @returns Access token payload
 */
async function verifySolidAccessToken(authorization, dpopOptions) {
    const solidJwt = (0, parseSolidAuthorizationHeader_1.parseSolidAuthorizationHeader)(authorization.header);
    // Decode Solid access token payload
    const accessTokenPayload = (0, decodeBase64UrlEncodedJson_1.decodeBase64UrlEncodedJson)(solidJwt.jwsPayload);
    // Verify the Solid access token includes all required claims
    (0, verifySolidAccessTokenRequiredClaims_1.verifySolidAccessTokenRequiredClaims)(accessTokenPayload);
    // Check WebID claim is a secure URI
    (0, verifySecureUriClaim_1.verifySecureUriClaim)(accessTokenPayload.webid, "webid");
    // Check Issuer claim is a secure URI
    (0, verifySecureUriClaim_1.verifySecureUriClaim)(accessTokenPayload.iss, "iss");
    // Retrieve the issuers listed in the identity document
    const issuers = await (0, retrieveWebidTrustedOidcIssuers_1.retrieveWebidTrustedOidcIssuers)(accessTokenPayload.webid, authorization.issuers);
    // Check the issuer claim matches one of the identity document's trusted issuers
    (0, verifySolidAccessTokenIssuer_1.verifySolidAccessTokenIssuer)(issuers, accessTokenPayload.iss);
    /**
     * Verify Access Token
     * - Signature of Access Token JWT/JWS matches a key in the remote jwks
     * - Access Token max age 1 day
     * - Claims:
     *    - audience 'aud' is solid
     *    - algorithm 'alg' is an asymetric cryptographic algorithm
     *    - expiration 'exp' is not in the past
     *    - 'iat' is not in the future
     */
    const { payload, protectedHeader } = await (0, jose_1.jwtVerify)(solidJwt.value, await (0, retrieveAccessTokenIssuerKeySet_1.retrieveAccessTokenIssuerKeySet)(accessTokenPayload.iss, authorization.keySet), {
        audience: "solid",
        algorithms: Array.from(ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM_1.ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM),
        maxTokenAge: `${config_1.maxAccessTokenAgeInSeconds}s`,
        clockTolerance: `${config_1.clockToleranceInSeconds}s`,
    });
    // Get JWT value for either DPoP or Bearer tokens
    const accessToken = {
        header: protectedHeader,
        payload,
        signature: solidJwt.jwsSignature,
    };
    (0, isSolidAccessToken_1.isSolidAccessToken)(accessToken);
    if (solidJwt.authenticationScheme === "DPoP" ||
        (0, standard_object_1.isObjectPropertyOf)(accessToken.payload, "cnf")) {
        try {
            ts_guards_1.asserts.isNotNullOrUndefined(dpopOptions);
        }
        catch (_) {
            // TODO: Increase test coverage
            /* istanbul ignore next */
            throw new Error("SolidIdentityDPoPError DPoP options missing for DPoP bound access token verification");
        }
        await (0, verifyDpopProof_1.verifyDpopProof)(dpopOptions.header, accessToken, solidJwt.value, dpopOptions.method, dpopOptions.url, dpopOptions.isDuplicateJTI);
    }
    return accessToken.payload;
}
exports.verifySolidAccessToken = verifySolidAccessToken;
//# sourceMappingURL=verifySolidAccessToken.js.map
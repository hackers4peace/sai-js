"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyDpopProof = void 0;
const jose_1 = require("jose");
const ts_guards_1 = require("ts-guards");
const config_1 = require("../config");
const ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM_1 = require("../constant/ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM");
const isDPoPToken_1 = require("../guard/isDPoPToken");
const isSolidDPoPBoundAccessTokenPayload_1 = require("../guard/isSolidDPoPBoundAccessTokenPayload");
const verifyDpopProofAccessTokenHash_1 = require("./verifyDpopProofAccessTokenHash");
const verifyDpopProofHttpMethod_1 = require("./verifyDpopProofHttpMethod");
const verifyDpopProofHttpUri_1 = require("./verifyDpopProofHttpUri");
const verifyDpopProofJwkThumbprint_1 = require("./verifyDpopProofJwkThumbprint");
const verifyDpopProofJwtIdentifier_1 = require("./verifyDpopProofJwtIdentifier");
/**
 * Verify DPoP Proof
 * - Signature of DPoP JWT/JWS matches the key embedded in its header
 * - DPoP max age 60 seconds
 * - Claims:
 *    - algorithm 'alg' is an asymetric cryptographic algorithm
 *    - 'iat' is not too far in the future (clockTolerance) or in the past (maxTokenAge)
 *    - 'typ' is 'dpop+jwt'
 * Note:
 * - The maxTokenAge option makes the iat claim mandatory
 * - DPoP tokens can rely on iat+maxTokenAge to be invalidated since they are specific to a request
 *   (so the exp claim which is not required in DPoP tokens' bodys is also redundant)
 */
async function verifyDpopProof(dpopHeader, accessToken, accessTokenValue, httpMethod, uri, isDuplicateJTI) {
    const { payload, protectedHeader } = await (0, jose_1.jwtVerify)(dpopHeader, jose_1.EmbeddedJWK, {
        typ: "dpop+jwt",
        algorithms: Array.from(ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM_1.ASYMMETRIC_CRYPTOGRAPHIC_ALGORITHM),
        maxTokenAge: `${config_1.maxAgeInMilliseconds / 1000}s`,
        clockTolerance: `${config_1.clockToleranceInSeconds}s`,
    });
    const dpop = {
        header: protectedHeader,
        payload,
        signature: dpopHeader.split(".")[2],
    };
    (0, isDPoPToken_1.isDPoPToken)(dpop);
    ts_guards_1.asserts.isObjectPropertyOf(accessToken.payload, "cnf");
    (0, isSolidDPoPBoundAccessTokenPayload_1.isSolidDPoPBoundAccessTokenPayload)(accessToken.payload);
    await (0, verifyDpopProofJwkThumbprint_1.verifyDpopProofJwkThumbprint)(dpop.header.jwk, accessToken.payload.cnf.jkt);
    (0, verifyDpopProofHttpMethod_1.verifyDpopProofHttpMethod)(httpMethod, dpop.payload.htm);
    (0, verifyDpopProofHttpUri_1.verifyDpopProofHttpUri)(uri, dpop.payload.htu);
    (0, verifyDpopProofJwtIdentifier_1.verifyDpopProofJwtIdentifier)(dpop.payload.jti, isDuplicateJTI);
    // TODO: Phased-in ath becomes enforced
    if (typeof dpop.payload.ath === "string" && dpop.payload.ath) {
        (0, verifyDpopProofAccessTokenHash_1.verifyDpopProofAccessTokenHash)(accessTokenValue, dpop.payload.ath);
    }
}
exports.verifyDpopProof = verifyDpopProof;
//# sourceMappingURL=verifyDpopProof.js.map
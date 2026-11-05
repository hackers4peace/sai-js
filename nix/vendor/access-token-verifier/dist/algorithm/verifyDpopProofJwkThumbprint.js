"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyDpopProofJwkThumbprint = void 0;
const jose_1 = require("jose");
const JwkThumbprintVerificationError_1 = require("../error/JwkThumbprintVerificationError");
/**
 * Verifies the access token is bound to the DPoP public key
 *
 * > "jkt": JWK SHA-256 Thumbprint Confirmation Method.  The value of the "jkt" member MUST be the base64url encoding (as defined in [RFC7515]) of the JWK SHA-256 Thumbprint (according to [RFC7638]) of the DPoP public key (in JWK format) to which the access token is bound.
 * > -- https://datatracker.ietf.org/doc/html/draft-ietf-oauth-dpop-03#section-6.1
 *
 * @param jwk The DPoP proof header jwk parameter
 * @param jkt The access token cnf jkt parameter
 */
async function verifyDpopProofJwkThumbprint(jwk, jkt) {
    // TODO find out what the unsafe assignment is about
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    const actual = await (0, jose_1.calculateJwkThumbprint)(jwk);
    if (actual !== jkt) {
        throw new JwkThumbprintVerificationError_1.JwkThumbprintVerificationError(actual, jkt);
    }
}
exports.verifyDpopProofJwkThumbprint = verifyDpopProofJwkThumbprint;
//# sourceMappingURL=verifyDpopProofJwkThumbprint.js.map
"use strict";

/**
 * Authentificateur WebAuthn LOGICIEL, pour les tests uniquement.
 *
 * Il fait ce que fait le système (iOS, Android, Windows) après avoir vérifié
 * le visage ou le doigt : générer une paire de clés P-256, produire les
 * données d'authentification (drapeaux UP + UV), signer le défi. Les
 * réponses sont vérifiées par la VRAIE bibliothèque serveur
 * (@simplewebauthn/server) : rien n'est simulé côté serveur.
 */

const crypto = require("crypto");

// ── CBOR minimal (entiers, octets, texte, tableaux, maps) ───────────────
function tete(majeur, n) {
  if (n < 24) return Buffer.from([(majeur << 5) | n]);
  if (n < 256) return Buffer.from([(majeur << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (majeur << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (majeur << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cbor(v) {
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.concat([tete(2, v.length), Buffer.from(v)]);
  if (typeof v === "number") return v >= 0 ? tete(0, v) : tete(1, -1 - v);
  if (typeof v === "string") { const b = Buffer.from(v, "utf8"); return Buffer.concat([tete(3, b.length), b]); }
  if (Array.isArray(v)) return Buffer.concat([tete(4, v.length), ...v.map(cbor)]);
  const entrees = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([tete(5, entrees.length), ...entrees.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

const b64u = (b) => Buffer.from(b).toString("base64url");

class AuthentificateurLogiciel {
  constructor({ origine, rpId }) {
    this.origine = origine;
    this.rpId = rpId;
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.clePrivee = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.x = Buffer.from(jwk.x, "base64url");
    this.y = Buffer.from(jwk.y, "base64url");
    this.idCredential = crypto.randomBytes(32);
    this.compteur = 0;
  }

  donneesClient(type, defi, origine) {
    return Buffer.from(JSON.stringify({ type, challenge: defi, origin: origine || this.origine, crossOrigin: false }));
  }

  /** Réponse à navigator.credentials.create() */
  creer(options, { origine } = {}) {
    const clePublique = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, this.x], [-3, this.y]]));
    const idLongueur = Buffer.alloc(2);
    idLongueur.writeUInt16BE(this.idCredential.length);
    const authData = Buffer.concat([
      crypto.createHash("sha256").update(options.rp.id).digest(),
      Buffer.from([0x01 | 0x04 | 0x40]), // présence + vérification + données de credential
      Buffer.alloc(4),
      Buffer.alloc(16), idLongueur, this.idCredential, clePublique,
    ]);
    return {
      id: b64u(this.idCredential), rawId: b64u(this.idCredential), type: "public-key",
      response: {
        clientDataJSON: b64u(this.donneesClient("webauthn.create", options.challenge, origine)),
        attestationObject: b64u(cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]))),
        transports: ["internal"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }

  /** Réponse à navigator.credentials.get() */
  obtenir(options, { origine, sansVerification } = {}) {
    this.compteur += 1;
    const compteur = Buffer.alloc(4);
    compteur.writeUInt32BE(this.compteur);
    const authData = Buffer.concat([
      crypto.createHash("sha256").update(options.rpId).digest(),
      Buffer.from([sansVerification ? 0x01 : 0x05]),
      compteur,
    ]);
    const client = this.donneesClient("webauthn.get", options.challenge, origine);
    const signature = crypto.sign("sha256",
      Buffer.concat([authData, crypto.createHash("sha256").update(client).digest()]), this.clePrivee);
    return {
      id: b64u(this.idCredential), rawId: b64u(this.idCredential), type: "public-key",
      response: { clientDataJSON: b64u(client), authenticatorData: b64u(authData), signature: b64u(signature) },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    };
  }
}

module.exports = { AuthentificateurLogiciel, cbor };

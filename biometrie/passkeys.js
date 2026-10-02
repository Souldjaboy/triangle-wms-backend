"use strict";

/**
 * PASSKEYS (WebAuthn) — Face ID, Touch ID, Windows Hello, empreinte Android,
 * clés de sécurité.
 *
 * La biométrie ne quitte JAMAIS l'appareil : c'est le système (iOS, Android,
 * Windows, macOS) qui vérifie le visage ou le doigt, puis signe un défi avec
 * une clé privée qui ne sort pas de l'appareil. Le serveur ne reçoit ni
 * empreinte ni modèle facial : il ne garde qu'une clé publique, un compteur,
 * les transports et quelques métadonnées.
 *
 * Limite à connaître : une passkey prouve que LE TITULAIRE DE L'APPAREIL l'a
 * déverrouillé — pas QUI il est (un téléphone peut porter les empreintes de
 * plusieurs personnes). Excellente pour la connexion et la validation
 * renforcée, elle ne remplace pas une vérification biométrique de la
 * personne pour un pointage.
 *
 * Configuration obligatoire (sinon refus 503) :
 *   WEBAUTHN_RP_ID      domaine (ex. malilinkglobal.com)
 *   WEBAUTHN_ORIGINS    origines autorisées, séparées par des virgules
 *                       (ex. https://malilinkglobal.com,https://www.malilinkglobal.com)
 *   WEBAUTHN_RP_NAME    nom affiché (facultatif)
 */

const crypto = require("crypto");
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");
const { BiometrieError } = require("./core/erreurs");

const DUREE_DEFI_MS = 5 * 60 * 1000;
const DUREE_STEP_UP_MS = 5 * 60 * 1000;
const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

function configuration(env = process.env) {
  const rpID = String(env.WEBAUTHN_RP_ID || "").trim();
  const origines = String(env.WEBAUTHN_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
  if (!rpID || !origines.length) {
    throw new BiometrieError("Passkeys non configurées (WEBAUTHN_RP_ID et WEBAUTHN_ORIGINS).", "PASSKEYS_NON_CONFIGUREES", 503);
  }
  return { rpID, origines, rpName: String(env.WEBAUTHN_RP_NAME || "MaliLink Global").slice(0, 60) };
}

/** Le défi annoncé par le navigateur, lu dans clientDataJSON (vérifié ensuite par la bibliothèque). */
function defiDeLaReponse(reponse) {
  try {
    const client = JSON.parse(Buffer.from(String(reponse?.response?.clientDataJSON || ""), "base64url").toString("utf8"));
    return typeof client.challenge === "string" ? client.challenge : "";
  } catch {
    return "";
  }
}

function passkeyPublique(p) {
  return {
    id: p.id,
    name: p.name,
    device_type: p.device_type,
    backed_up: p.backed_up,
    transports: p.transports,
    created_at: p.created_at,
    last_used_at: p.last_used_at,
  };
}

function creerPasskeys({ pool, env = process.env }) {
  async function poserDefi(objet, { purpose, userId, tenantId, scope }) {
    const { rpID } = configuration(env);
    await pool.query(
      `INSERT INTO auth_passkey_challenges (purpose, user_id, tenant_id, challenge, rp_id, scope, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' milliseconds')::interval)`,
      [purpose, userId || null, tenantId || null, objet.challenge, rpID, scope || "", String(DUREE_DEFI_MS)]);
    return objet;
  }

  /** Consomme le défi une seule fois ; un défi rejoué ou expiré est refusé. */
  async function consommerDefi(defi, { purpose, userId, scope }) {
    if (!defi) throw new BiometrieError("Réponse de passkey illisible.", "PASSKEY_INVALIDE", 400);
    const { rows } = await pool.query(
      `UPDATE auth_passkey_challenges SET used_at = now()
        WHERE challenge = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
          AND ($3::int IS NULL OR user_id = $3) AND ($4::text IS NULL OR scope = $4)
        RETURNING *`,
      [defi, purpose, userId || null, scope ?? null]);
    if (rows[0]) return rows[0];
    const { rows: etat } = await pool.query(`SELECT used_at FROM auth_passkey_challenges WHERE challenge = $1`, [defi]);
    if (etat[0]?.used_at) throw new BiometrieError("Défi déjà utilisé : rejeu refusé.", "DEFI_REJOUE", 409);
    throw new BiometrieError("Défi expiré ou invalide : recommencez.", "DEFI_INVALIDE", 400);
  }

  async function actives(userId) {
    const { rows } = await pool.query(
      `SELECT * FROM auth_passkeys WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at`, [userId]);
    return rows;
  }

  // ─────────────────────────────────────────────────────── ENREGISTREMENT

  async function optionsEnregistrement(user, tenantId) {
    const { rpID, rpName } = configuration(env);
    const existantes = await actives(user.id);
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: String(user.email || `utilisateur-${user.id}`),
      userDisplayName: String(user.fullname || user.email || "Utilisateur"),
      userID: Buffer.from(`malilink-user:${user.id}`),
      attestationType: "none",
      excludeCredentials: existantes.map((p) => ({ id: p.credential_id, transports: p.transports })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      supportedAlgorithmIDs: [-7, -257],
    });
    return poserDefi(options, { purpose: "enregistrement", userId: user.id, tenantId });
  }

  async function verifierEnregistrement(user, reponse, nom, { companyId, tenantId } = {}) {
    const { rpID, origines } = configuration(env);
    const defi = defiDeLaReponse(reponse);
    await consommerDefi(defi, { purpose: "enregistrement", userId: user.id });
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: reponse, expectedChallenge: defi, expectedOrigin: origines, expectedRPID: rpID,
        requireUserVerification: true,
      });
    } catch (e) {
      throw new BiometrieError(`Passkey refusée : ${e.message}`, "PASSKEY_INVALIDE", 400);
    }
    if (!verification.verified || !verification.registrationInfo) {
      throw new BiometrieError("Passkey refusée.", "PASSKEY_INVALIDE", 400);
    }
    const info = verification.registrationInfo;
    try {
      const { rows } = await pool.query(
        `INSERT INTO auth_passkeys
           (user_id, company_id, tenant_id, credential_id, public_key, counter, transports, device_type,
            backed_up, aaguid, name, rp_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [user.id, companyId || null, tenantId || null, info.credential.id,
          Buffer.from(info.credential.publicKey).toString("base64url"), Number(info.credential.counter || 0),
          info.credential.transports || reponse?.response?.transports || [], info.credentialDeviceType || "",
          info.credentialBackedUp === true, info.aaguid || "", String(nom || "Mon appareil").trim().slice(0, 60) || "Mon appareil",
          rpID]);
      return passkeyPublique(rows[0]);
    } catch (e) {
      if (e.code === "23505") throw new BiometrieError("Cette passkey est déjà enregistrée.", "PASSKEY_EXISTANTE", 409);
      throw e;
    }
  }

  // ────────────────────────────────────────────── CONNEXION / STEP-UP

  async function optionsAuthentification({ purpose, userId, tenantId, scope }) {
    const { rpID } = configuration(env);
    // Connexion : passkey « découvrable », sans révéler si un compte existe.
    const autorisees = userId ? (await actives(userId)).map((p) => ({ id: p.credential_id, transports: p.transports })) : undefined;
    if (userId && !autorisees.length) {
      throw new BiometrieError("Aucune passkey enregistrée pour ce compte.", "PASSKEY_ABSENTE", 404);
    }
    const options = await generateAuthenticationOptions({ rpID, allowCredentials: autorisees, userVerification: "required" });
    return poserDefi(options, { purpose, userId, tenantId, scope });
  }

  async function verifierAuthentification(reponse, { purpose, userId, scope }) {
    const { rpID, origines } = configuration(env);
    const defi = defiDeLaReponse(reponse);
    await consommerDefi(defi, { purpose, userId, scope });
    const { rows } = await pool.query(
      `SELECT * FROM auth_passkeys WHERE credential_id = $1 AND revoked_at IS NULL`, [String(reponse?.id || "")]);
    const passkey = rows[0];
    if (!passkey || (userId && passkey.user_id !== Number(userId))) {
      throw new BiometrieError("Passkey inconnue ou révoquée.", "PASSKEY_INCONNUE", 401);
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: reponse, expectedChallenge: defi, expectedOrigin: origines, expectedRPID: rpID,
        requireUserVerification: true,
        credential: { id: passkey.credential_id, publicKey: Buffer.from(passkey.public_key, "base64url"),
          counter: Number(passkey.counter), transports: passkey.transports },
      });
    } catch (e) {
      throw new BiometrieError(`Passkey refusée : ${e.message}`, "PASSKEY_INVALIDE", 401);
    }
    if (!verification.verified) throw new BiometrieError("Passkey refusée.", "PASSKEY_INVALIDE", 401);
    await pool.query(`UPDATE auth_passkeys SET counter = $2, last_used_at = now() WHERE id = $1`,
      [passkey.id, Number(verification.authenticationInfo.newCounter || 0)]);
    return passkey;
  }

  // ─────────────────────────────────────────────────── VALIDATION RENFORCÉE

  async function accorderStepUp({ userId, companyId, methode, scope }) {
    const jeton = crypto.randomBytes(32).toString("base64url");
    const { rows } = await pool.query(
      `INSERT INTO auth_stepup_grants (user_id, company_id, method, scope, token_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' milliseconds')::interval) RETURNING expires_at`,
      [userId, companyId || null, methode, String(scope || "").slice(0, 60), sha256(jeton), String(DUREE_STEP_UP_MS)]);
    return { step_up_token: jeton, expires_at: rows[0].expires_at, method: methode };
  }

  async function stepUpValide(userId, jeton, scope) {
    if (!jeton) return false;
    const { rows } = await pool.query(
      `SELECT 1 FROM auth_stepup_grants WHERE token_hash = $1 AND user_id = $2 AND expires_at > now()
          AND (scope = '' OR scope = $3) LIMIT 1`,
      [sha256(jeton), userId, String(scope || "")]);
    return Boolean(rows[0]);
  }

  async function aDesPasskeys(userId) {
    const { rows } = await pool.query(`SELECT 1 FROM auth_passkeys WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1`, [userId]);
    return Boolean(rows[0]);
  }

  // ──────────────────────────────────────────────────────────── GESTION

  async function lister(userId) {
    return (await actives(userId)).map(passkeyPublique);
  }

  async function renommer(userId, id, nom) {
    const n = String(nom || "").trim().slice(0, 60);
    if (!n) throw new BiometrieError("Nom obligatoire.", "NOM_REQUIS", 400);
    const { rows } = await pool.query(
      `UPDATE auth_passkeys SET name = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING *`,
      [Number(id), userId, n]);
    if (!rows[0]) throw new BiometrieError("Passkey introuvable.", "PASSKEY_INTROUVABLE", 404);
    return passkeyPublique(rows[0]);
  }

  async function supprimer(userId, id) {
    const { rows } = await pool.query(
      `UPDATE auth_passkeys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
      [Number(id), userId]);
    if (!rows[0]) throw new BiometrieError("Passkey introuvable.", "PASSKEY_INTROUVABLE", 404);
    return { ok: true };
  }

  return {
    configuration: () => configuration(env),
    optionsEnregistrement,
    verifierEnregistrement,
    optionsAuthentification,
    verifierAuthentification,
    accorderStepUp,
    stepUpValide,
    aDesPasskeys,
    lister,
    renommer,
    supprimer,
  };
}

module.exports = { creerPasskeys, configuration, DUREE_STEP_UP_MS };

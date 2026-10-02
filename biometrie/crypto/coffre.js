"use strict";

/**
 * COFFRE BIOMÉTRIQUE — chiffrement authentifié des gabarits et secrets
 * d'appareils.
 *
 * Règles non négociables :
 *   • clé DÉDIÉE : BIOMETRIC_ENC_KEY (32 octets, hex 64 ou base64). Jamais
 *     JWT_SECRET, jamais une valeur codée en dur ;
 *   • sans clé : REFUS (503 CLE_BIOMETRIQUE_ABSENTE). Aucun repli en clair,
 *     contrairement au coffre des webhooks ;
 *   • AES-256-GCM, IV aléatoire de 12 octets, étiquette vérifiée ;
 *   • clé par société dérivée par HKDF : un gabarit d'une société ne se
 *     déchiffre pas avec le contexte d'une autre ;
 *   • données associées (AAD) = société + contexte (personne, modalité,
 *     doigt) : un gabarit recopié sur une autre ligne ne se déchiffre plus ;
 *   • identifiant de clé (kid) dans chaque valeur, pour la rotation :
 *       BIOMETRIC_ENC_KEYS='{"k1":"…","k2":"…"}' et BIOMETRIC_ENC_KEY_ID=k2
 *     chiffrent avec k2 et déchiffrent encore ce qui l'a été avec k1 ;
 *     `rechiffrer` fait migrer une valeur vers la clé active.
 *
 * Format stocké : bv1.<kid>.<iv>.<tag>.<chiffré>   (base64url)
 * Une contrainte SQL refuse toute valeur qui ne commence pas par « bv1. ».
 */

const crypto = require("crypto");
const { BiometrieError } = require("../core/erreurs");

const PREFIXE = "bv1";
const KID_DEFAUT = "k1";

function decoderCle(brut, nom) {
  const valeur = String(brut || "").trim();
  let cle;
  if (/^[0-9a-fA-F]{64}$/.test(valeur)) cle = Buffer.from(valeur, "hex");
  else cle = Buffer.from(valeur, "base64");
  if (cle.length !== 32) {
    throw new BiometrieError(`${nom} doit faire 32 octets (64 caractères hexadécimaux ou base64).`,
      "CLE_BIOMETRIQUE_INVALIDE", 503);
  }
  return cle;
}

/** Les clés disponibles et celle qui chiffre. Lu à chaque appel : une rotation ne demande qu'un redémarrage. */
function trousseau(env = process.env) {
  const cles = new Map();
  if (env.BIOMETRIC_ENC_KEYS) {
    let objet;
    try {
      objet = JSON.parse(env.BIOMETRIC_ENC_KEYS);
    } catch {
      throw new BiometrieError("BIOMETRIC_ENC_KEYS n'est pas un JSON valide.", "CLE_BIOMETRIQUE_INVALIDE", 503);
    }
    for (const [kid, brut] of Object.entries(objet || {})) {
      if (!/^[A-Za-z0-9_-]{1,16}$/.test(kid)) {
        throw new BiometrieError("Identifiant de clé biométrique invalide.", "CLE_BIOMETRIQUE_INVALIDE", 503);
      }
      cles.set(kid, decoderCle(brut, `BIOMETRIC_ENC_KEYS.${kid}`));
    }
  }
  if (env.BIOMETRIC_ENC_KEY && !cles.has(env.BIOMETRIC_ENC_KEY_ID || KID_DEFAUT)) {
    cles.set(env.BIOMETRIC_ENC_KEY_ID || KID_DEFAUT, decoderCle(env.BIOMETRIC_ENC_KEY, "BIOMETRIC_ENC_KEY"));
  }
  if (cles.size === 0) return { cles, active: null };
  const active = env.BIOMETRIC_ENC_KEY_ID || (cles.has(KID_DEFAUT) ? KID_DEFAUT : [...cles.keys()][0]);
  if (!cles.has(active)) {
    throw new BiometrieError("BIOMETRIC_ENC_KEY_ID désigne une clé absente.", "CLE_BIOMETRIQUE_INVALIDE", 503);
  }
  // La clé biométrique ne doit jamais être celle des jetons de session.
  const jwt = env.JWT_SECRET ? Buffer.from(String(env.JWT_SECRET)) : null;
  for (const cle of cles.values()) {
    if (jwt && (cle.equals(jwt) || cle.toString("hex") === String(env.JWT_SECRET))) {
      throw new BiometrieError("La clé biométrique ne peut pas être JWT_SECRET.", "CLE_BIOMETRIQUE_INVALIDE", 503);
    }
  }
  return { cles, active };
}

function disponible(env = process.env) {
  try {
    return trousseau(env).active !== null;
  } catch {
    return false;
  }
}

function exigerCle(env = process.env) {
  const t = trousseau(env);
  if (!t.active) {
    throw new BiometrieError(
      "Chiffrement biométrique non configuré (BIOMETRIC_ENC_KEY absente) : aucun gabarit ni secret ne peut être enregistré.",
      "CLE_BIOMETRIQUE_ABSENTE", 503);
  }
  return t;
}

function cleSociete(maitre, companyId, kid) {
  if (!Number.isInteger(Number(companyId)) || Number(companyId) <= 0) {
    throw new BiometrieError("Société obligatoire pour le chiffrement.", "SOCIETE_REQUISE", 400);
  }
  return Buffer.from(crypto.hkdfSync("sha256", maitre, Buffer.from(`malilink-biometrie:${companyId}`),
    Buffer.from(`gabarit:${kid}`), 32));
}

const b64 = (b) => Buffer.from(b).toString("base64url");
const deB64 = (t) => Buffer.from(String(t), "base64url");

function aad(companyId, contexte) {
  return Buffer.from(`${Number(companyId)}|${String(contexte || "")}`);
}

/** Chiffre un Buffer (ou une chaîne) pour une société et un contexte donnés. */
function chiffrer(donnees, { companyId, contexte }, env = process.env) {
  const { cles, active } = exigerCle(env);
  const cle = cleSociete(cles.get(active), companyId, active);
  const iv = crypto.randomBytes(12);
  const chiffreur = crypto.createCipheriv("aes-256-gcm", cle, iv);
  chiffreur.setAAD(aad(companyId, contexte));
  const corps = Buffer.concat([chiffreur.update(Buffer.isBuffer(donnees) ? donnees : Buffer.from(String(donnees))), chiffreur.final()]);
  return [PREFIXE, active, b64(iv), b64(chiffreur.getAuthTag()), b64(corps)].join(".");
}

function estChiffre(valeur) {
  return typeof valeur === "string" && valeur.startsWith(`${PREFIXE}.`) && valeur.split(".").length === 5;
}

/** Déchiffre ; toute altération (valeur, société, contexte) lève INTEGRITE. */
function dechiffrer(valeur, { companyId, contexte }, env = process.env) {
  if (!estChiffre(valeur)) throw new BiometrieError("Valeur biométrique illisible.", "GABARIT_ILLISIBLE", 500);
  const [, kid, iv, tag, corps] = valeur.split(".");
  const { cles } = exigerCle(env);
  const maitre = cles.get(kid);
  if (!maitre) throw new BiometrieError("Clé de déchiffrement indisponible pour ce gabarit.", "CLE_INCONNUE", 503);
  try {
    const dechiffreur = crypto.createDecipheriv("aes-256-gcm", cleSociete(maitre, companyId, kid), deB64(iv));
    dechiffreur.setAAD(aad(companyId, contexte));
    dechiffreur.setAuthTag(deB64(tag));
    return Buffer.concat([dechiffreur.update(deB64(corps)), dechiffreur.final()]);
  } catch {
    throw new BiometrieError("Gabarit altéré ou déplacé : déchiffrement refusé.", "INTEGRITE", 500);
  }
}

function kidDe(valeur) {
  return estChiffre(valeur) ? valeur.split(".")[1] : null;
}

/** Rotation : renvoie la valeur chiffrée avec la clé active (inchangée si déjà le cas). */
function rechiffrer(valeur, ctx, env = process.env) {
  const { active } = exigerCle(env);
  if (kidDe(valeur) === active) return valeur;
  return chiffrer(dechiffrer(valeur, ctx, env), ctx, env);
}

module.exports = { PREFIXE, disponible, exigerCle, chiffrer, dechiffrer, estChiffre, rechiffrer, kidDe, trousseau };

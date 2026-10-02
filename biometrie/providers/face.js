"use strict";

/**
 * FOURNISSEURS DE RECONNAISSANCE FACIALE.
 *
 * Interface commune (FaceRecognitionProvider) :
 *
 *   nom                     identifiant stable (« local », « terminal », « mock »)
 *   correspondanceServeur   true  : le fournisseur produit un gabarit que le
 *                                   noyau stocke CHIFFRÉ et compare lui-même ;
 *                           false : la comparaison se fait sur l'appareil
 *                                   (terminal), qui envoie un événement signé ;
 *                                   le serveur ne détient AUCUN gabarit.
 *   detectionVivant         le fournisseur sait-il dire si la capture vient
 *                           d'un visage vivant (et non d'une photo/vidéo) ?
 *   async extraire(capture) → { gabarit: Buffer, format, qualite, vivant: {evalue, ok, score} }
 *   comparer(a, b)          → score de similarité 0..1
 *
 * Aucune image n'est conservée : la capture ne traverse le noyau que le
 * temps d'en extraire le gabarit, et n'apparaît dans aucun journal.
 */

const crypto = require("crypto");
const { BiometrieError } = require("../core/erreurs");

/** Similarité cosinus ramenée à 0..1 sur deux vecteurs float32 sérialisés. */
function similariteCosinus(a, b) {
  const va = new Float32Array(a.buffer, a.byteOffset, Math.floor(a.byteLength / 4));
  const vb = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
  if (va.length === 0 || va.length !== vb.length) return 0;
  let p = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < va.length; i += 1) {
    p += va[i] * vb[i];
    na += va[i] * va[i];
    nb += vb[i] * vb[i];
  }
  if (na === 0 || nb === 0) return 0;
  return Math.max(0, Math.min(1, p / (Math.sqrt(na) * Math.sqrt(nb))));
}

function versBuffer(vecteur) {
  const f = Float32Array.from(vecteur.map(Number));
  return Buffer.from(f.buffer);
}

class FaceRecognitionProvider {
  constructor(nom) {
    this.nom = nom;
    this.correspondanceServeur = true;
    this.detectionVivant = false;
  }

  // eslint-disable-next-line no-unused-vars
  async extraire(capture) {
    throw new BiometrieError("Fournisseur facial non implémenté.", "FOURNISSEUR_INDISPONIBLE", 501);
  }

  comparer(a, b) {
    return similariteCosinus(a, b);
  }
}

/**
 * Moteur LOCAL auto-hébergé, joint par HTTP (FACE_ENGINE_URL).
 *
 * Contrat attendu du moteur (à déployer séparément, sur le serveur ou le
 * réseau de l'entreprise — rien ne part vers un cloud) :
 *
 *   POST {FACE_ENGINE_URL}/v1/embeddings
 *   Authorization: Bearer {FACE_ENGINE_TOKEN}
 *   { "image": "<jpeg base64>", "liveness": true }
 *   → 200 { "embedding": [float…], "quality": 0..1, "model": "…",
 *           "liveness": { "passed": bool, "score": 0..1 } | null }
 *
 * Tant que FACE_ENGINE_URL n'est pas défini, ce fournisseur refuse : la
 * reconnaissance faciale par navigateur n'est PAS active.
 */
class LocalHttpFaceProvider extends FaceRecognitionProvider {
  constructor(env = process.env) {
    super("local");
    this.url = String(env.FACE_ENGINE_URL || "").replace(/\/$/, "");
    this.jeton = env.FACE_ENGINE_TOKEN || "";
    this.delaiMs = Number(env.FACE_ENGINE_TIMEOUT_MS || 8000);
    this.detectionVivant = true;
  }

  get configure() {
    return Boolean(this.url);
  }

  async extraire(capture) {
    if (!this.configure) {
      throw new BiometrieError("Aucun moteur de reconnaissance faciale n'est configuré (FACE_ENGINE_URL).",
        "FOURNISSEUR_NON_CONFIGURE", 503);
    }
    const image = String(capture?.image_base64 || "").replace(/^data:image\/[a-z]+;base64,/, "");
    if (!image || image.length > 2_800_000) {
      throw new BiometrieError("Image de visage absente ou trop lourde (2 Mo max).", "CAPTURE_INVALIDE", 400);
    }
    const controleur = new AbortController();
    const minuterie = setTimeout(() => controleur.abort(), this.delaiMs);
    let reponse;
    try {
      reponse = await fetch(`${this.url}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.jeton ? { Authorization: `Bearer ${this.jeton}` } : {}) },
        body: JSON.stringify({ image, liveness: true }),
        signal: controleur.signal,
      });
    } catch {
      throw new BiometrieError("Moteur de reconnaissance faciale injoignable.", "FOURNISSEUR_ERREUR", 502);
    } finally {
      clearTimeout(minuterie);
    }
    if (!reponse.ok) {
      throw new BiometrieError(`Le moteur facial a refusé la capture (${reponse.status}).`, "FOURNISSEUR_ERREUR", 502);
    }
    const d = await reponse.json().catch(() => null);
    const vecteur = Array.isArray(d?.embedding) ? d.embedding : null;
    if (!vecteur || vecteur.length < 64 || vecteur.length > 4096 || vecteur.some((x) => !Number.isFinite(Number(x)))) {
      throw new BiometrieError("Réponse du moteur facial invalide.", "FOURNISSEUR_ERREUR", 502);
    }
    return {
      gabarit: versBuffer(vecteur),
      format: `local-f32-${vecteur.length}${d.model ? `-${String(d.model).slice(0, 40)}` : ""}`,
      qualite: Number(d.quality ?? 0),
      vivant: d.liveness
        ? { evalue: true, ok: d.liveness.passed === true, score: Number(d.liveness.score ?? 0) }
        : { evalue: false, ok: false, score: 0 },
    };
  }
}

/**
 * Terminal biométrique (Hikvision, ZKTeco, Suprema…) : capture, détection du
 * vivant et comparaison se font SUR l'appareil. Le serveur ne reçoit que des
 * événements signés (voir devices/evenements) et ne stocke aucun gabarit :
 * le profil ne porte que la référence de la personne dans le terminal.
 */
class TerminalFaceProvider extends FaceRecognitionProvider {
  constructor() {
    super("terminal");
    this.correspondanceServeur = false;
    this.detectionVivant = true;
  }

  async extraire() {
    throw new BiometrieError("Avec un terminal, l'enrôlement et la vérification se font sur l'appareil.",
      "MODE_TERMINAL", 400);
  }
}

/**
 * SIMULATEUR — TESTS AUTOMATISÉS UNIQUEMENT.
 *
 * Refusé hors NODE_ENV=test et sans BIOMETRIC_ALLOW_MOCK=1 (voir registre).
 * Une « capture » est { mock_identite, variation, vivant } : la même identité
 * produit des gabarits proches, deux identités des gabarits sans rapport.
 * Ne simule AUCUNE reconnaissance réelle.
 */
class MockFaceProvider extends FaceRecognitionProvider {
  constructor() {
    super("mock");
    this.detectionVivant = true;
  }

  async extraire(capture) {
    if (capture?.mock_erreur) throw new BiometrieError("Erreur simulée du fournisseur.", "FOURNISSEUR_ERREUR", 502);
    const identite = String(capture?.mock_identite || "");
    if (!identite) throw new BiometrieError("Capture de test invalide.", "CAPTURE_INVALIDE", 400);
    const graine = crypto.createHash("sha512").update(`visage:${identite}`).digest();
    const bruit = crypto.createHash("sha512").update(`bruit:${identite}:${capture.variation || 0}`).digest();
    const v = [];
    for (let i = 0; i < 128; i += 1) {
      const base = (graine[i % 64] - 127.5) / 127.5;
      const alea = ((bruit[i % 64] - 127.5) / 127.5) * Math.min(Number(capture.variation || 0), 1) * 0.15;
      v.push(base + alea);
    }
    return {
      gabarit: versBuffer(v),
      format: "mock-f32-128",
      qualite: Number(capture.qualite ?? 0.9),
      vivant: { evalue: true, ok: capture.vivant !== false, score: capture.vivant === false ? 0.05 : 0.97 },
    };
  }
}

module.exports = {
  FaceRecognitionProvider,
  LocalHttpFaceProvider,
  TerminalFaceProvider,
  MockFaceProvider,
  similariteCosinus,
  versBuffer,
};

"use strict";

/**
 * SERVICE BIOMÉTRIQUE — le cœur, indépendant du système hôte.
 *
 * Le système hôte (MaliLink, Triangle, HAFIYA) fournit un adaptateur
 * (`hote`) : qui est du personnel, comment écrire un pointage. Tout le reste
 * — consentement, appareil, défi, gabarit chiffré, seuil, journal — est
 * décidé ici, de la même façon pour les trois systèmes.
 *
 * Ce que ce service ne fait JAMAIS :
 *   • stocker une image ou un gabarit en clair ;
 *   • écrire un gabarit, une image ou un secret dans un journal ;
 *   • enrôler sans consentement actif ;
 *   • vérifier sur un appareil inconnu quand la politique l'exige ;
 *   • accepter deux fois le même défi ou le même événement d'appareil ;
 *   • viser une autre société ou un compte qui n'est pas du personnel.
 */

const crypto = require("crypto");
const { BiometrieError } = require("./erreurs");
const coffre = require("../crypto/coffre");
const registre = require("../providers/registre");

const TYPES = new Set(["face", "fingerprint"]);
const FINALITES = new Set(["pointage", "controle_acces", "connexion", "action_sensible", "identification"]);
const QUALITE_MIN = 0.5;
const MAX_CANDIDATS_IDENTIFICATION = 1000;
const FENETRE_SIGNATURE_MS = 5 * 60 * 1000;

/* Texte de consentement versionné : son empreinte est enregistrée avec
   chaque consentement, pour prouver ce qui a été accepté. */
const TEXTES_CONSENTEMENT = {
  v1: [
    "J'accepte que mon entreprise enregistre un gabarit biométrique (visage et/ou empreinte) à mon nom,",
    "uniquement pour les finalités cochées. Aucune photo n'est conservée : seul un gabarit chiffré l'est,",
    "ou rien du tout lorsque la comparaison se fait sur un terminal. Je peux retirer ce consentement à",
    "tout moment ; mes gabarits sont alors effacés. Une méthode sans biométrie (badge QR ou pointage",
    "manuel) reste toujours disponible.",
  ].join(" "),
};

function texteConsentement(version) {
  const texte = TEXTES_CONSENTEMENT[version] || TEXTES_CONSENTEMENT.v1;
  return { version: TEXTES_CONSENTEMENT[version] ? version : "v1", texte,
    hash: crypto.createHash("sha256").update(texte).digest("hex") };
}

const REGLAGES_DEFAUT = {
  face_enabled: false,
  fingerprint_enabled: false,
  face_provider: "",
  fingerprint_provider: "",
  face_threshold: 0.85,
  fingerprint_threshold: 0.85,
  require_liveness: true,
  require_known_device: true,
  require_challenge: true,
  allow_identification: false,
  self_enrollment: false,
  stepup_required: false,
  challenge_ttl_seconds: 120,
  profile_validity_days: 730,
  event_retention_days: 365,
  consent_text_version: "v1",
};

const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

function verifierType(type) {
  if (!TYPES.has(type)) throw new BiometrieError("Modalité biométrique inconnue.", "TYPE_INVALIDE", 400);
}

function cleSujet(sujet) {
  return sujet.type === "employee" ? `employee:${sujet.employeeId}` : `user:${sujet.userId}`;
}

function contexteGabarit(sujet, type, doigt) {
  return `profil:${cleSujet(sujet)}:${type}:${doigt ?? "-"}`;
}

function profilPublic(p) {
  if (!p) return null;
  return {
    id: p.id,
    subject_type: p.subject_type,
    user_id: p.user_id,
    employee_id: p.employee_id,
    biometric_type: p.biometric_type,
    provider: p.provider,
    finger_index: p.finger_index,
    template_format: p.template_format,
    has_server_template: Boolean(p.template_encrypted),
    external_reference: p.external_reference ? "•••" + String(p.external_reference).slice(-3) : "",
    device_id: p.device_id,
    quality: p.quality === null || p.quality === undefined ? null : Number(p.quality),
    status: p.status,
    consent_id: p.consent_id,
    enrolled_at: p.enrolled_at,
    expires_at: p.expires_at,
    last_verified_at: p.last_verified_at,
    revoked_at: p.revoked_at,
    revoke_reason: p.revoke_reason,
  };
}

function creerServiceBiometrie({ pool, hote, env = process.env }) {
  if (!pool || !hote) throw new Error("creerServiceBiometrie : pool et hote obligatoires.");

  // ════════════════════════════════════════════════════════════ JOURNAL

  async function journaliser(client, e) {
    const { rows } = await (client || pool).query(
      `INSERT INTO biometric_events
         (company_id, tenant_id, subject_type, user_id, employee_id, profile_id, biometric_type,
          action, purpose, result, reason_code, confidence, threshold, provider, device_id,
          challenge_id, device_event_ref, performed_by, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING id`,
      [e.companyId || null, e.tenantId || null, e.sujet?.type || null, e.sujet?.userId || null,
        e.sujet?.employeeId || null, e.profileId || null, e.type || null, e.action, e.finalite || "",
        e.resultat, e.code || "", e.score ?? null, e.seuil ?? null, e.fournisseur || "",
        e.deviceId || null, e.defiId || null, e.refAppareil || null, e.par || null,
        String(e.ip || "").slice(0, 80)]
    );
    return rows[0].id;
  }

  // ═══════════════════════════════════════════════════════════ RÉGLAGES

  async function reglages(companyId) {
    const { rows } = await pool.query(`SELECT * FROM biometric_settings WHERE company_id = $1`, [companyId]);
    const r = { ...REGLAGES_DEFAUT, ...(rows[0] || {}), company_id: companyId };
    r.face_threshold = Number(r.face_threshold);
    r.fingerprint_threshold = Number(r.fingerprint_threshold);
    return r;
  }

  async function majReglages(companyId, tenantId, patch, par, ip) {
    const actuels = await reglages(companyId);
    const suivant = { ...actuels };
    const bools = ["face_enabled", "fingerprint_enabled", "require_liveness", "require_known_device",
      "require_challenge", "allow_identification", "self_enrollment", "stepup_required"];
    for (const k of bools) if (typeof patch[k] === "boolean") suivant[k] = patch[k];
    for (const k of ["face_provider", "fingerprint_provider"]) {
      if (patch[k] !== undefined) suivant[k] = String(patch[k] || "").trim();
    }
    const nombre = (k, min, max) => {
      if (patch[k] === undefined) return;
      const n = Number(patch[k]);
      if (!Number.isFinite(n) || n < min || n > max) {
        throw new BiometrieError(`Valeur hors bornes pour ${k} (${min}–${max}).`, "REGLAGE_INVALIDE", 400);
      }
      suivant[k] = n;
    };
    nombre("face_threshold", 0.5, 0.9999);
    nombre("fingerprint_threshold", 0.5, 0.9999);
    nombre("challenge_ttl_seconds", 15, 900);
    nombre("profile_validity_days", 1, 3650);
    nombre("event_retention_days", 30, 3650);
    // Un fournisseur choisi doit exister et être permis dans cet environnement.
    if (suivant.face_provider) registre.fournisseur("face", suivant.face_provider, env);
    if (suivant.fingerprint_provider) registre.fournisseur("fingerprint", suivant.fingerprint_provider, env);
    if (suivant.face_enabled && !suivant.face_provider) {
      throw new BiometrieError("Choisissez un fournisseur avant d'activer le visage.", "FOURNISSEUR_NON_CONFIGURE", 400);
    }
    if (suivant.fingerprint_enabled && !suivant.fingerprint_provider) {
      throw new BiometrieError("Choisissez un fournisseur avant d'activer l'empreinte.", "FOURNISSEUR_NON_CONFIGURE", 400);
    }
    // Activer une modalité suppose de pouvoir chiffrer : refus sans clé.
    if (suivant.face_enabled || suivant.fingerprint_enabled) coffre.exigerCle(env);

    await pool.query(
      `INSERT INTO biometric_settings
         (company_id, tenant_id, face_enabled, fingerprint_enabled, face_provider, fingerprint_provider,
          face_threshold, fingerprint_threshold, require_liveness, require_known_device, require_challenge,
          allow_identification, self_enrollment, stepup_required, challenge_ttl_seconds,
          profile_validity_days, event_retention_days, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
       ON CONFLICT (company_id) DO UPDATE SET
         face_enabled = EXCLUDED.face_enabled, fingerprint_enabled = EXCLUDED.fingerprint_enabled,
         face_provider = EXCLUDED.face_provider, fingerprint_provider = EXCLUDED.fingerprint_provider,
         face_threshold = EXCLUDED.face_threshold, fingerprint_threshold = EXCLUDED.fingerprint_threshold,
         require_liveness = EXCLUDED.require_liveness, require_known_device = EXCLUDED.require_known_device,
         require_challenge = EXCLUDED.require_challenge, allow_identification = EXCLUDED.allow_identification,
         self_enrollment = EXCLUDED.self_enrollment, stepup_required = EXCLUDED.stepup_required,
         challenge_ttl_seconds = EXCLUDED.challenge_ttl_seconds,
         profile_validity_days = EXCLUDED.profile_validity_days,
         event_retention_days = EXCLUDED.event_retention_days,
         updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [companyId, tenantId || null, suivant.face_enabled, suivant.fingerprint_enabled, suivant.face_provider,
        suivant.fingerprint_provider, suivant.face_threshold, suivant.fingerprint_threshold,
        suivant.require_liveness, suivant.require_known_device, suivant.require_challenge,
        suivant.allow_identification, suivant.self_enrollment, suivant.stepup_required,
        suivant.challenge_ttl_seconds, suivant.profile_validity_days, suivant.event_retention_days, par || null]
    );
    await journaliser(null, { companyId, tenantId, action: "reglages", resultat: "accepte", par, ip });
    return reglages(companyId);
  }

  function modaliteActive(r, type) {
    const active = type === "face" ? r.face_enabled : r.fingerprint_enabled;
    if (!active) {
      throw new BiometrieError(type === "face" ? "La reconnaissance faciale n'est pas activée pour cette entreprise."
        : "L'empreinte digitale n'est pas activée pour cette entreprise.", "MODALITE_INACTIVE", 403);
    }
    return registre.fournisseur(type, type === "face" ? r.face_provider : r.fingerprint_provider, env);
  }

  // ═══════════════════════════════════════════════════════ CONSENTEMENTS

  async function donnerConsentement({ companyId, tenantId, sujet, modalites, finalites, methode,
    referencePapier, par, ip }) {
    const mods = [...new Set((modalites || []).map(String))];
    const fins = [...new Set((finalites || []).map(String))];
    if (!mods.length || mods.some((m) => !TYPES.has(m))) {
      throw new BiometrieError("Choisissez au moins une modalité (visage, empreinte).", "CONSENTEMENT_INVALIDE", 400);
    }
    if (!fins.length || fins.some((f) => !FINALITES.has(f))) {
      throw new BiometrieError("Choisissez au moins une finalité valide.", "CONSENTEMENT_INVALIDE", 400);
    }
    if (!["ecran", "papier"].includes(methode)) {
      throw new BiometrieError("Méthode de recueil invalide.", "CONSENTEMENT_INVALIDE", 400);
    }
    if (methode === "papier" && !String(referencePapier || "").trim()) {
      throw new BiometrieError("Un consentement papier exige sa référence (formulaire signé).", "CONSENTEMENT_INVALIDE", 400);
    }
    const p = await hote.verifierPersonnel(pool, companyId, sujet);
    const r = await reglages(companyId);
    const t = texteConsentement(r.consent_text_version);
    const { rows } = await pool.query(
      `INSERT INTO biometric_consents
         (company_id, tenant_id, subject_type, user_id, employee_id, modalities, purposes,
          text_version, text_hash, method, paper_reference, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [companyId, tenantId || null, p.type, p.userId || null, p.employeeId || null, mods, fins,
        t.version, t.hash, methode, String(referencePapier || "").slice(0, 120), par || null]
    );
    await journaliser(null, { companyId, tenantId, sujet: p, action: "consentement", resultat: "accepte", par, ip });
    return rows[0];
  }

  async function consentementActif(companyId, sujet, type, finalite) {
    const { rows } = await pool.query(
      `SELECT * FROM biometric_consents
        WHERE company_id = $1 AND subject_type = $2
          AND COALESCE(user_id, 0) = COALESCE($3::int, 0) AND COALESCE(employee_id, 0) = COALESCE($4::int, 0)
          AND withdrawn_at IS NULL AND $5 = ANY(modalities)
          AND ($6::text IS NULL OR $6 = ANY(purposes))
        ORDER BY id DESC LIMIT 1`,
      [companyId, sujet.type, sujet.userId || null, sujet.employeeId || null, type, finalite || null]
    );
    return rows[0] || null;
  }

  async function retirerConsentement({ companyId, tenantId, consentId, par, motif, ip }) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `UPDATE biometric_consents SET withdrawn_at = now(), withdrawn_by = $3, withdrawal_reason = $4
          WHERE id = $1 AND company_id = $2 AND withdrawn_at IS NULL RETURNING *`,
        [consentId, companyId, par || null, String(motif || "").slice(0, 300)]
      );
      const c = rows[0];
      if (!c) throw new BiometrieError("Consentement introuvable ou déjà retiré.", "CONSENTEMENT_INTROUVABLE", 404);
      const sujet = { type: c.subject_type, userId: c.user_id, employeeId: c.employee_id };
      // Retirer le consentement efface les gabarits concernés : immédiatement.
      const { rows: revoques } = await client.query(
        `UPDATE biometric_profiles
            SET status = 'revoque', template_encrypted = NULL, revoked_at = now(), revoked_by = $5,
                revoke_reason = 'retrait_consentement', updated_at = now()
          WHERE company_id = $1 AND subject_type = $2 AND COALESCE(user_id, 0) = COALESCE($3::int, 0)
            AND COALESCE(employee_id, 0) = COALESCE($4::int, 0) AND biometric_type = ANY($6)
            AND status <> 'revoque'
          RETURNING id, biometric_type`,
        [companyId, sujet.type, sujet.userId, sujet.employeeId, par || null, c.modalities]
      );
      await journaliser(client, { companyId, tenantId, sujet, action: "retrait_consentement", resultat: "accepte", par, ip });
      for (const p of revoques) {
        await journaliser(client, { companyId, tenantId, sujet, profileId: p.id, type: p.biometric_type,
          action: "revocation", code: "RETRAIT_CONSENTEMENT", resultat: "accepte", par, ip });
      }
      await client.query("COMMIT");
      return { consentement: c, profils_revoques: revoques.length };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  // ═══════════════════════════════════════════════════════════ APPAREILS

  const TYPES_APPAREIL = new Set(["terminal_visage", "terminal_empreinte", "kiosque", "pc_local", "mobile"]);

  function appareilPublic(a) {
    if (!a) return null;
    const { secret_encrypted, ...reste } = a; // eslint-disable-line no-unused-vars
    return reste;
  }

  async function enregistrerAppareil({ companyId, tenantId, siteId, nom, type, serial, fournisseur, par, ip }) {
    if (!TYPES_APPAREIL.has(type)) throw new BiometrieError("Type d'appareil invalide.", "APPAREIL_INVALIDE", 400);
    const n = String(nom || "").trim().slice(0, 120);
    const s = String(serial || "").trim().slice(0, 120);
    if (!n || !s) throw new BiometrieError("Nom et numéro de série obligatoires.", "APPAREIL_INVALIDE", 400);
    const secret = crypto.randomBytes(32).toString("base64url");
    const chiffre = coffre.chiffrer(secret, { companyId, contexte: `appareil:${s}` }, env);
    try {
      const { rows } = await pool.query(
        `INSERT INTO biometric_devices
           (company_id, tenant_id, site_id, name, provider, device_type, serial, secret_encrypted, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [companyId, tenantId || null, siteId || null, n, String(fournisseur || "").slice(0, 40), type, s, chiffre, par || null]
      );
      await journaliser(null, { companyId, tenantId, action: "appareil", code: "ENREGISTRE", resultat: "accepte",
        deviceId: rows[0].id, par, ip });
      // Le secret n'est montré qu'UNE fois : il n'est jamais relisible ensuite.
      return { appareil: appareilPublic(rows[0]), secret };
    } catch (e) {
      if (e.code === "23505") throw new BiometrieError("Ce numéro de série est déjà déclaré.", "APPAREIL_EXISTANT", 409);
      throw e;
    }
  }

  async function regenererSecret({ companyId, tenantId, deviceId, par, ip }) {
    const { rows } = await pool.query(`SELECT * FROM biometric_devices WHERE id = $1 AND company_id = $2`, [deviceId, companyId]);
    if (!rows[0]) throw new BiometrieError("Appareil introuvable.", "APPAREIL_INCONNU", 404);
    const secret = crypto.randomBytes(32).toString("base64url");
    await pool.query(`UPDATE biometric_devices SET secret_encrypted = $1, updated_at = now() WHERE id = $2`,
      [coffre.chiffrer(secret, { companyId, contexte: `appareil:${rows[0].serial}` }, env), deviceId]);
    await journaliser(null, { companyId, tenantId, action: "appareil", code: "SECRET_REGENERE", resultat: "accepte", deviceId, par, ip });
    return { secret };
  }

  async function activerAppareil({ companyId, tenantId, deviceId, actif, par, ip }) {
    const { rows } = await pool.query(
      `UPDATE biometric_devices SET enabled = $3, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *`,
      [deviceId, companyId, actif === true]);
    if (!rows[0]) throw new BiometrieError("Appareil introuvable.", "APPAREIL_INCONNU", 404);
    await journaliser(null, { companyId, tenantId, action: "appareil", code: actif ? "ACTIVE" : "DESACTIVE",
      resultat: "accepte", deviceId, par, ip });
    return appareilPublic(rows[0]);
  }

  async function listerAppareils(companyId) {
    const { rows } = await pool.query(
      `SELECT * FROM biometric_devices WHERE company_id = $1 ORDER BY enabled DESC, name`, [companyId]);
    return rows.map(appareilPublic);
  }

  function secretAppareil(appareil) {
    return coffre.dechiffrer(appareil.secret_encrypted, { companyId: appareil.company_id,
      contexte: `appareil:${appareil.serial}` }, env).toString();
  }

  function egal(a, b) {
    const x = Buffer.from(String(a || ""));
    const y = Buffer.from(String(b || ""));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
  }

  /**
   * Appareil présent dans un navigateur (kiosque, poste d'enrôlement) :
   * identifiant + clé secrète reçue à la déclaration. Refus si inconnu,
   * désactivé ou d'une autre société.
   */
  async function authentifierAppareil(companyId, deviceId, cle) {
    const id = Number(deviceId);
    if (!Number.isInteger(id) || id <= 0) return null;
    const { rows } = await pool.query(
      `SELECT * FROM biometric_devices WHERE id = $1 AND company_id = $2 AND enabled = TRUE`, [id, companyId]);
    const a = rows[0];
    if (!a || !egal(secretAppareil(a), cle)) return null;
    await pool.query(`UPDATE biometric_devices SET last_seen_at = now() WHERE id = $1`, [a.id]);
    return a;
  }

  async function exigerAppareil(r, companyId, deviceId, cle) {
    if (!r.require_known_device && !deviceId) return null;
    const a = await authentifierAppareil(companyId, deviceId, cle);
    if (!a) throw new BiometrieError("Appareil inconnu, désactivé ou non autorisé.", "APPAREIL_INCONNU", 403);
    return a;
  }

  /**
   * Requête d'un terminal ou d'un agent : signature HMAC-SHA256 de
   * `<horodatage>.<corps brut>` avec le secret de l'appareil.
   *   X-Biometric-Device: <id>    X-Biometric-Timestamp: <ms epoch>
   *   X-Biometric-Signature: <hex>
   * Horodatage à ±5 minutes ; chaque événement porte une référence unique
   * par appareil (rejeu refusé par la base).
   */
  async function authentifierRequeteAppareil({ deviceId, horodatage, signature, corpsBrut }) {
    const id = Number(deviceId);
    const ts = Number(horodatage);
    if (!Number.isInteger(id) || !Number.isFinite(ts) || !signature || !corpsBrut) {
      throw new BiometrieError("Requête d'appareil non signée.", "SIGNATURE_ABSENTE", 401);
    }
    if (Math.abs(Date.now() - ts) > FENETRE_SIGNATURE_MS) {
      throw new BiometrieError("Horodatage hors fenêtre : requête expirée ou rejouée.", "SIGNATURE_EXPIREE", 401);
    }
    const { rows } = await pool.query(`SELECT * FROM biometric_devices WHERE id = $1 AND enabled = TRUE`, [id]);
    const a = rows[0];
    if (!a) throw new BiometrieError("Appareil inconnu ou désactivé.", "APPAREIL_INCONNU", 401);
    const attendu = crypto.createHmac("sha256", secretAppareil(a))
      .update(`${ts}.`).update(corpsBrut).digest("hex");
    if (!egal(attendu, String(signature).toLowerCase())) {
      throw new BiometrieError("Signature d'appareil invalide.", "SIGNATURE_INVALIDE", 401);
    }
    await pool.query(`UPDATE biometric_devices SET last_seen_at = now() WHERE id = $1`, [a.id]);
    return a;
  }

  // ═════════════════════════════════════════════════════════════ DÉFIS

  async function creerDefi({ companyId, tenantId, demandePar, sujet, deviceId, type, finalite, action }) {
    verifierType(type);
    if (!FINALITES.has(finalite)) throw new BiometrieError("Finalité invalide.", "FINALITE_INVALIDE", 400);
    const r = await reglages(companyId);
    const nonce = crypto.randomBytes(32).toString("base64url");
    const { rows } = await pool.query(
      `INSERT INTO biometric_challenges
         (company_id, tenant_id, requested_by, subject_type, subject_user_id, subject_employee_id,
          device_id, biometric_type, purpose, action, nonce_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + ($12 || ' seconds')::interval)
       RETURNING id, expires_at`,
      [companyId, tenantId || null, demandePar || null, sujet?.type || null, sujet?.userId || null,
        sujet?.employeeId || null, deviceId || null, type, finalite, String(action || "").slice(0, 40),
        sha256(nonce), String(r.challenge_ttl_seconds)]
    );
    return { challenge_id: rows[0].id, nonce, expires_at: rows[0].expires_at };
  }

  /** Consomme un défi : une seule fois, avant expiration, pour le même sujet, appareil, modalité et finalité. */
  async function consommerDefi(client, { companyId, defiId, nonce, sujet, deviceId, type, finalite }) {
    const id = Number(defiId);
    if (!Number.isInteger(id) || id <= 0 || !nonce) {
      throw new BiometrieError("Défi anti-rejeu absent.", "DEFI_REQUIS", 400);
    }
    const { rows } = await client.query(
      `UPDATE biometric_challenges SET used_at = now()
        WHERE id = $1 AND company_id = $2 AND nonce_hash = $3 AND used_at IS NULL AND expires_at > now()
          AND biometric_type = $4 AND purpose = $5
          AND COALESCE(device_id, 0) = COALESCE($6::int, 0)
          AND (subject_type IS NULL OR (subject_type = $7
               AND COALESCE(subject_user_id, 0) = COALESCE($8::int, 0)
               AND COALESCE(subject_employee_id, 0) = COALESCE($9::int, 0)))
        RETURNING id`,
      [id, companyId, sha256(nonce), type, finalite, deviceId || null, sujet?.type || null,
        sujet?.userId || null, sujet?.employeeId || null]
    );
    if (rows[0]) return rows[0].id;
    const { rows: etat } = await client.query(
      `SELECT used_at, expires_at FROM biometric_challenges WHERE id = $1 AND company_id = $2 AND nonce_hash = $3`,
      [id, companyId, sha256(nonce)]);
    if (etat[0]?.used_at) throw new BiometrieError("Défi déjà utilisé : tentative de rejeu refusée.", "DEFI_REJOUE", 409);
    if (etat[0] && new Date(etat[0].expires_at) <= new Date()) {
      throw new BiometrieError("Défi expiré : recommencez la capture.", "DEFI_EXPIRE", 410);
    }
    throw new BiometrieError("Défi invalide pour cette personne, cet appareil ou cette finalité.", "DEFI_INVALIDE", 400);
  }

  // ═════════════════════════════════════════════════════════ ENRÔLEMENT

  async function profilActif(client, companyId, sujet, type, doigt) {
    const { rows } = await client.query(
      `SELECT * FROM biometric_profiles
        WHERE company_id = $1 AND subject_type = $2 AND COALESCE(user_id, 0) = COALESCE($3::int, 0)
          AND COALESCE(employee_id, 0) = COALESCE($4::int, 0) AND biometric_type = $5
          AND COALESCE(finger_index, -1) = COALESCE($6::int, -1) AND status = 'actif'
        LIMIT 1`,
      [companyId, sujet.type, sujet.userId || null, sujet.employeeId || null, type, doigt ?? null]
    );
    return rows[0] || null;
  }

  function verifierVivant(r, fournisseur, extraction) {
    if (!r.require_liveness) return;
    if (!fournisseur.detectionVivant || !extraction.vivant?.evalue) {
      throw new BiometrieError("Ce fournisseur ne vérifie pas que le visage est vivant : refus (politique de la société).",
        "VIVANT_NON_EVALUE", 422);
    }
    if (!extraction.vivant.ok) {
      throw new BiometrieError("Capture refusée : le visage ne semble pas vivant (photo ou vidéo ?).", "VIVANT_REFUSE", 422);
    }
  }

  async function enroler({ companyId, tenantId, sujet, type, capture, doigt, deviceId, cleAppareil,
    referenceExterne, renouveler, par, ip }) {
    verifierType(type);
    const r = await reglages(companyId);
    const fournisseur = modaliteActive(r, type);
    const p = await hote.verifierPersonnel(pool, companyId, sujet);
    const indexDoigt = type === "fingerprint" ? Number(doigt) : null;
    if (type === "fingerprint" && !(Number.isInteger(indexDoigt) && indexDoigt >= 0 && indexDoigt <= 9)) {
      throw new BiometrieError("Doigt invalide (0 à 9).", "DOIGT_INVALIDE", 400);
    }
    const ctxJournal = { companyId, tenantId, sujet: p, type, action: "enrolement", fournisseur: fournisseur.nom, par, ip };
    const refuser = async (err) => {
      await journaliser(null, { ...ctxJournal, resultat: err.code === "FOURNISSEUR_ERREUR" ? "erreur" : "refuse", code: err.code, deviceId });
      throw err;
    };

    const consent = await consentementActif(companyId, p, type, null);
    if (!consent) {
      return refuser(new BiometrieError("Consentement biométrique absent : enrôlement refusé.", "CONSENTEMENT_ABSENT", 403));
    }
    let appareil = null;
    try {
      appareil = await exigerAppareil(r, companyId, deviceId, cleAppareil);
    } catch (e) {
      return refuser(e);
    }

    let gabarit = null;
    let format = "";
    let qualite = null;
    let reference = "";
    if (fournisseur.correspondanceServeur) {
      coffre.exigerCle(env); // refus AVANT toute capture si l'on ne peut pas chiffrer
      let extraction;
      try {
        extraction = await fournisseur.extraire(capture);
      } catch (e) {
        return refuser(e instanceof BiometrieError ? e
          : new BiometrieError("Erreur du fournisseur biométrique.", "FOURNISSEUR_ERREUR", 502));
      }
      if (type === "face") {
        try {
          verifierVivant(r, fournisseur, extraction);
        } catch (e) {
          return refuser(e);
        }
      }
      if (Number(extraction.qualite) < QUALITE_MIN) {
        return refuser(new BiometrieError("Qualité de capture insuffisante : recommencez.", "QUALITE_INSUFFISANTE", 422));
      }
      gabarit = coffre.chiffrer(extraction.gabarit, { companyId, contexte: contexteGabarit(p, type, indexDoigt) }, env);
      extraction.gabarit.fill(0);
      format = extraction.format;
      qualite = Math.min(1, Math.max(0, Number(extraction.qualite)));
    } else {
      reference = String(referenceExterne || "").trim().slice(0, 120);
      if (!reference) {
        return refuser(new BiometrieError("Référence de la personne dans le terminal obligatoire.", "REFERENCE_REQUISE", 400));
      }
      if (!appareil) {
        return refuser(new BiometrieError("Indiquez le terminal qui détient l'enrôlement.", "APPAREIL_REQUIS", 400));
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existant = await profilActif(client, companyId, p, type, indexDoigt);
      if (existant && !renouveler) {
        throw new BiometrieError("Un profil actif existe déjà : utilisez « Remplacer ».", "PROFIL_EXISTANT", 409);
      }
      if (existant) {
        await client.query(
          `UPDATE biometric_profiles SET status = 'revoque', template_encrypted = NULL, revoked_at = now(),
                  revoked_by = $2, revoke_reason = 'remplace', updated_at = now() WHERE id = $1`,
          [existant.id, par || null]);
        await journaliser(client, { ...ctxJournal, profileId: existant.id, action: "revocation", code: "REMPLACE", resultat: "accepte" });
      }
      const { rows } = await client.query(
        `INSERT INTO biometric_profiles
           (company_id, tenant_id, subject_type, user_id, employee_id, biometric_type, provider, finger_index,
            template_format, template_encrypted, template_key_id, external_reference, device_id, quality,
            consent_id, enrolled_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now() + ($17 || ' days')::interval)
         RETURNING *`,
        [companyId, tenantId || null, p.type, p.userId || null, p.employeeId || null, type, fournisseur.nom,
          indexDoigt, format, gabarit, coffre.kidDe(gabarit), reference, appareil?.id || null, qualite,
          consent.id, par || null, String(r.profile_validity_days)]
      );
      await journaliser(client, { ...ctxJournal, profileId: rows[0].id, action: existant ? "renouvellement" : "enrolement",
        resultat: "accepte", deviceId: appareil?.id });
      await client.query("COMMIT");
      return profilPublic(rows[0]);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e instanceof BiometrieError) {
        await journaliser(null, { ...ctxJournal, resultat: "refuse", code: e.code, deviceId });
        throw e;
      }
      if (e.code === "23514") {
        throw new BiometrieError("Seul le personnel de l'entreprise peut être enrôlé.", "PAS_PERSONNEL", 403);
      }
      throw e;
    } finally {
      client.release();
    }
  }

  // ═══════════════════════════════════════════════════════ VÉRIFICATION

  async function verifier({ companyId, tenantId, sujet, type, capture, doigt, defi, deviceId, cleAppareil,
    finalite, par, ip }) {
    verifierType(type);
    if (!FINALITES.has(finalite)) throw new BiometrieError("Finalité invalide.", "FINALITE_INVALIDE", 400);
    const r = await reglages(companyId);
    const fournisseur = modaliteActive(r, type);
    const p = await hote.verifierPersonnel(pool, companyId, sujet);
    const seuil = type === "face" ? r.face_threshold : r.fingerprint_threshold;
    const base = { companyId, tenantId, sujet: p, type, action: "verification", finalite, fournisseur: fournisseur.nom,
      seuil, par, ip };
    const refuser = async (err, extra = {}) => {
      await journaliser(null, { ...base, ...extra, resultat: err.code === "FOURNISSEUR_ERREUR" ? "erreur" : "refuse", code: err.code });
      throw err;
    };

    if (!fournisseur.correspondanceServeur) {
      return refuser(new BiometrieError("Avec un terminal, la vérification se fait sur l'appareil.", "MODE_TERMINAL", 400));
    }
    let appareil;
    try {
      appareil = await exigerAppareil(r, companyId, deviceId, cleAppareil);
    } catch (e) {
      return refuser(e, { deviceId });
    }
    const consent = await consentementActif(companyId, p, type, finalite);
    if (!consent) {
      return refuser(new BiometrieError("Pas de consentement pour cette finalité.", "CONSENTEMENT_ABSENT", 403), { deviceId: appareil?.id });
    }

    let defiId = null;
    if (r.require_challenge) {
      try {
        defiId = await consommerDefi(pool, { companyId, defiId: defi?.challenge_id, nonce: defi?.nonce,
          sujet: p, deviceId: appareil?.id, type, finalite });
      } catch (e) {
        return refuser(e, { deviceId: appareil?.id });
      }
    }

    const indexDoigt = type === "fingerprint" ? (doigt === undefined || doigt === null ? null : Number(doigt)) : null;
    let profil;
    if (type === "fingerprint" && indexDoigt === null) {
      // Plusieurs doigts possibles : on compare à chacun des doigts actifs.
      const { rows } = await pool.query(
        `SELECT * FROM biometric_profiles WHERE company_id = $1 AND subject_type = $2
            AND COALESCE(user_id, 0) = COALESCE($3::int, 0) AND COALESCE(employee_id, 0) = COALESCE($4::int, 0)
            AND biometric_type = 'fingerprint' AND status = 'actif'`,
        [companyId, p.type, p.userId || null, p.employeeId || null]);
      profil = rows;
    } else {
      const un = await profilActif(pool, companyId, p, type, indexDoigt);
      profil = un ? [un] : [];
    }
    if (!profil.length) {
      return refuser(new BiometrieError("Aucun profil biométrique actif pour cette personne.", "PROFIL_ABSENT", 404),
        { deviceId: appareil?.id, defiId });
    }
    const valides = profil.filter((x) => !x.expires_at || new Date(x.expires_at) > new Date());
    if (!valides.length) {
      return refuser(new BiometrieError("Profil biométrique expiré : renouvelez l'enrôlement.", "PROFIL_EXPIRE", 403),
        { deviceId: appareil?.id, defiId, profileId: profil[0].id });
    }

    let extraction;
    try {
      extraction = await fournisseur.extraire(capture);
    } catch (e) {
      return refuser(e instanceof BiometrieError ? e
        : new BiometrieError("Erreur du fournisseur biométrique.", "FOURNISSEUR_ERREUR", 502), { deviceId: appareil?.id, defiId });
    }
    if (type === "face") {
      try {
        verifierVivant(r, fournisseur, extraction);
      } catch (e) {
        return refuser(e, { deviceId: appareil?.id, defiId });
      }
    }

    let meilleur = { score: 0, profil: valides[0] };
    for (const candidat of valides) {
      const ref = coffre.dechiffrer(candidat.template_encrypted, { companyId,
        contexte: contexteGabarit(p, type, candidat.finger_index) }, env);
      const score = fournisseur.comparer(extraction.gabarit, ref);
      ref.fill(0);
      if (score > meilleur.score) meilleur = { score, profil: candidat };
    }
    extraction.gabarit.fill(0);
    const score = Math.round(meilleur.score * 10000) / 10000;
    const ok = score >= seuil;
    if (ok) {
      await pool.query(`UPDATE biometric_profiles SET last_verified_at = now() WHERE id = $1`, [meilleur.profil.id]);
    }
    await journaliser(null, { ...base, profileId: meilleur.profil.id, resultat: ok ? "accepte" : "refuse",
      code: ok ? "" : "NON_CORRESPONDANT", score, deviceId: appareil?.id, defiId });
    return { verifie: ok, score, seuil, profile_id: meilleur.profil.id, sujet: p, appareil, defi_id: defiId };
  }

  // ════════════════════════════════════════════════════ IDENTIFICATION 1:N

  /** 1:N, seulement si la société l'autorise, et limité à ses propres profils. */
  async function identifier({ companyId, tenantId, type, capture, defi, deviceId, cleAppareil, par, ip }) {
    verifierType(type);
    const r = await reglages(companyId);
    const fournisseur = modaliteActive(r, type);
    const base = { companyId, tenantId, type, action: "identification", finalite: "identification",
      fournisseur: fournisseur.nom, par, ip, seuil: type === "face" ? r.face_threshold : r.fingerprint_threshold };
    const refuser = async (err, extra = {}) => {
      await journaliser(null, { ...base, ...extra, resultat: "refuse", code: err.code });
      throw err;
    };
    if (!r.allow_identification) {
      return refuser(new BiometrieError("L'identification 1:N n'est pas autorisée : utilisez badge + vérification 1:1.",
        "IDENTIFICATION_INTERDITE", 403));
    }
    if (!fournisseur.correspondanceServeur) {
      return refuser(new BiometrieError("Avec un terminal, l'identification se fait sur l'appareil.", "MODE_TERMINAL", 400));
    }
    const appareil = await exigerAppareil(r, companyId, deviceId, cleAppareil).catch((e) => refuser(e, { deviceId }));
    let defiId = null;
    if (r.require_challenge) {
      defiId = await consommerDefi(pool, { companyId, defiId: defi?.challenge_id, nonce: defi?.nonce, sujet: null,
        deviceId: appareil?.id, type, finalite: "identification" }).catch((e) => refuser(e, { deviceId: appareil?.id }));
    }
    const { rows } = await pool.query(
      `SELECT p.* FROM biometric_profiles p
        WHERE p.company_id = $1 AND p.biometric_type = $2 AND p.status = 'actif' AND p.template_encrypted IS NOT NULL
          AND (p.expires_at IS NULL OR p.expires_at > now())
          AND EXISTS (SELECT 1 FROM biometric_consents c WHERE c.id = p.consent_id AND c.withdrawn_at IS NULL
                        AND 'identification' = ANY(c.purposes))
        LIMIT $3`,
      [companyId, type, MAX_CANDIDATS_IDENTIFICATION + 1]);
    if (rows.length > MAX_CANDIDATS_IDENTIFICATION) {
      return refuser(new BiometrieError("Trop de profils pour une identification 1:N fiable : utilisez le badge.",
        "IDENTIFICATION_TROP_LARGE", 422));
    }
    const extraction = await fournisseur.extraire(capture).catch((e) => refuser(e));
    if (type === "face") {
      try {
        verifierVivant(r, fournisseur, extraction);
      } catch (e) {
        return refuser(e);
      }
    }
    let meilleur = null;
    for (const c of rows) {
      const sujet = { type: c.subject_type, userId: c.user_id, employeeId: c.employee_id };
      const ref = coffre.dechiffrer(c.template_encrypted, { companyId, contexte: contexteGabarit(sujet, type, c.finger_index) }, env);
      const score = fournisseur.comparer(extraction.gabarit, ref);
      ref.fill(0);
      if (!meilleur || score > meilleur.score) meilleur = { score, profil: c, sujet };
    }
    extraction.gabarit.fill(0);
    const ok = Boolean(meilleur) && meilleur.score >= base.seuil;
    await journaliser(null, { ...base, sujet: ok ? meilleur.sujet : null, profileId: ok ? meilleur.profil.id : null,
      resultat: ok ? "accepte" : "refuse", code: ok ? "" : "NON_IDENTIFIE",
      score: meilleur ? Math.round(meilleur.score * 10000) / 10000 : null, deviceId: appareil?.id, defiId });
    return ok ? { identifie: true, sujet: meilleur.sujet, score: meilleur.score, appareil }
      : { identifie: false };
  }

  // ═══════════════════════════════════════════════════ RÉVOCATION / ÉTAT

  async function changerStatut({ companyId, tenantId, profileId, statut, par, motif, ip }) {
    const id = Number(profileId);
    const { rows: avant } = await pool.query(
      `SELECT * FROM biometric_profiles WHERE id = $1 AND company_id = $2`, [id, companyId]);
    const p = avant[0];
    if (!p) throw new BiometrieError("Profil introuvable.", "PROFIL_INTROUVABLE", 404);
    if (p.status === "revoque") throw new BiometrieError("Profil déjà révoqué.", "PROFIL_REVOQUE", 409);
    let resultat;
    if (statut === "revoque") {
      // Révoquer efface le gabarit : il n'est plus jamais relisible.
      resultat = await pool.query(
        `UPDATE biometric_profiles SET status = 'revoque', template_encrypted = NULL, revoked_at = now(),
                revoked_by = $3, revoke_reason = $4, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *`,
        [id, companyId, par || null, String(motif || "").slice(0, 300)]);
    } else if (statut === "inactif" || statut === "actif") {
      resultat = await pool.query(
        `UPDATE biometric_profiles SET status = $3, updated_at = now() WHERE id = $1 AND company_id = $2 RETURNING *`,
        [id, companyId, statut]);
    } else {
      throw new BiometrieError("Statut invalide.", "STATUT_INVALIDE", 400);
    }
    const { rows } = resultat;
    const sujet = { type: p.subject_type, userId: p.user_id, employeeId: p.employee_id };
    await journaliser(null, { companyId, tenantId, sujet, profileId: id, type: p.biometric_type,
      action: statut === "revoque" ? "revocation" : statut === "inactif" ? "desactivation" : "reactivation",
      resultat: "accepte", code: statut === "revoque" ? "REVOCATION" : "", par, ip });
    return profilPublic(rows[0]);
  }

  async function profilDe(companyId, profileId) {
    const { rows } = await pool.query(`SELECT * FROM biometric_profiles WHERE id = $1 AND company_id = $2`,
      [Number(profileId), companyId]);
    return rows[0] || null;
  }

  async function statut(companyId, sujet) {
    const p = await hote.verifierPersonnel(pool, companyId, sujet);
    const [profils, consentements, evenements] = await Promise.all([
      pool.query(`SELECT * FROM biometric_profiles WHERE company_id = $1 AND subject_type = $2
                    AND COALESCE(user_id, 0) = COALESCE($3::int, 0) AND COALESCE(employee_id, 0) = COALESCE($4::int, 0)
                  ORDER BY status = 'actif' DESC, enrolled_at DESC`,
        [companyId, p.type, p.userId || null, p.employeeId || null]),
      pool.query(`SELECT id, modalities, purposes, text_version, method, given_at, withdrawn_at
                    FROM biometric_consents WHERE company_id = $1 AND subject_type = $2
                    AND COALESCE(user_id, 0) = COALESCE($3::int, 0) AND COALESCE(employee_id, 0) = COALESCE($4::int, 0)
                  ORDER BY id DESC`,
        [companyId, p.type, p.userId || null, p.employeeId || null]),
      pool.query(`SELECT id, biometric_type, action, purpose, result, reason_code, confidence, created_at
                    FROM biometric_events WHERE company_id = $1 AND subject_type = $2
                    AND COALESCE(user_id, 0) = COALESCE($3::int, 0) AND COALESCE(employee_id, 0) = COALESCE($4::int, 0)
                  ORDER BY id DESC LIMIT 20`,
        [companyId, p.type, p.userId || null, p.employeeId || null]),
    ]);
    return {
      personne: { type: p.type, user_id: p.userId || null, employee_id: p.employeeId || null, nom: p.nom },
      profils: profils.rows.map(profilPublic),
      consentements: consentements.rows,
      evenements: evenements.rows,
    };
  }

  /** Noms lisibles des personnes, fournis par l'hôte (comptes ou fiches employé). */
  async function nommer(companyId, liste) {
    const noms = await hote.nomsSujets(companyId, liste.map((x) => ({
      type: x.subject_type, userId: x.user_id, employeeId: x.employee_id })));
    return liste.map((x) => ({ ...x,
      subject_name: noms.get(`${x.subject_type}:${x.subject_type === "employee" ? x.employee_id : x.user_id}`) || "" }));
  }

  async function listerProfils(companyId, { statut: filtre } = {}) {
    const { rows } = await pool.query(
      `SELECT * FROM biometric_profiles WHERE company_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY enrolled_at DESC LIMIT 500`, [companyId, filtre || null]);
    return nommer(companyId, rows.map(profilPublic));
  }

  /** Le personnel de la société, avec son état biométrique (sans aucun gabarit). */
  async function personnes(companyId) {
    const personnel = await hote.listerPersonnel(companyId);
    const [profils, consentements] = await Promise.all([
      pool.query(`SELECT subject_type, user_id, employee_id, biometric_type, count(*)::int AS n
                    FROM biometric_profiles WHERE company_id = $1 AND status = 'actif'
                   GROUP BY 1, 2, 3, 4`, [companyId]),
      pool.query(`SELECT DISTINCT ON (subject_type, user_id, employee_id) subject_type, user_id, employee_id,
                         id, modalities, purposes, method
                    FROM biometric_consents WHERE company_id = $1 AND withdrawn_at IS NULL
                   ORDER BY subject_type, user_id, employee_id, id DESC`, [companyId]),
    ]);
    const cle = (t, u, e) => `${t}:${t === "employee" ? e : u}`;
    const parProfil = new Map();
    for (const r of profils.rows) {
      const k = cle(r.subject_type, r.user_id, r.employee_id);
      const v = parProfil.get(k) || { face: 0, fingerprint: 0 };
      v[r.biometric_type] = r.n;
      parProfil.set(k, v);
    }
    const parConsent = new Map(consentements.rows.map((r) => [cle(r.subject_type, r.user_id, r.employee_id), r]));
    return personnel.map((p) => {
      const k = cle(p.type, p.userId, p.employeeId);
      const c = parConsent.get(k);
      return { subject_type: p.type, user_id: p.userId || null, employee_id: p.employeeId || null, nom: p.nom,
        role: p.role || "", profils: parProfil.get(k) || { face: 0, fingerprint: 0 },
        consentement: c ? { id: c.id, modalities: c.modalities, purposes: c.purposes, method: c.method } : null };
    });
  }

  async function evenements(companyId, { limite = 100, action, resultat } = {}) {
    const { rows: brutes } = await pool.query(
      `SELECT id, subject_type, user_id, employee_id, profile_id, biometric_type, action, purpose, result,
              reason_code, confidence, threshold, provider, device_id, performed_by, created_at
         FROM biometric_events WHERE company_id = $1
          AND ($2::text IS NULL OR action = $2) AND ($3::text IS NULL OR result = $3)
        ORDER BY id DESC LIMIT $4`,
      [companyId, action || null, resultat || null, Math.min(Math.max(Number(limite) || 100, 1), 500)]);
    return nommer(companyId, brutes);
  }

  // ═════════════════════════════════════════════ ÉVÉNEMENTS D'APPAREILS

  const ACTIONS_POINTAGE = new Set(["checkin", "pause_start", "pause_end", "checkout"]);

  /**
   * Lot d'événements envoyés par un terminal ou un agent déjà authentifié
   * (signature vérifiée). Chaque événement :
   *   { ref, type: face|fingerprint, reference, resultat: match|no_match,
   *     score?, doigt?, action?: checkin|pause_start|pause_end|checkout }
   * Un `ref` déjà reçu est ignoré (rejeu) ; une référence inconnue est
   * refusée ; un pointage n'est écrit que pour un « match ».
   */
  async function traiterEvenementsAppareil(appareil, lot, ip) {
    const companyId = appareil.company_id;
    const r = await reglages(companyId);
    const resultats = [];
    for (const e of (Array.isArray(lot) ? lot : []).slice(0, 200)) {
      const ref = String(e?.ref || "").trim().slice(0, 120);
      const type = String(e?.type || "");
      if (!ref || !TYPES.has(type)) {
        resultats.push({ ref, statut: "refuse", code: "EVENEMENT_INVALIDE" });
        continue;
      }
      const active = type === "face" ? r.face_enabled : r.fingerprint_enabled;
      const seuil = type === "face" ? r.face_threshold : r.fingerprint_threshold;
      const score = e.score === undefined || e.score === null ? null : Math.min(1, Math.max(0, Number(e.score)));
      const { rows: profils } = await pool.query(
        `SELECT * FROM biometric_profiles WHERE company_id = $1 AND biometric_type = $2 AND external_reference = $3
            AND status = 'actif' AND (device_id IS NULL OR device_id = $4) LIMIT 1`,
        [companyId, type, String(e.reference || "").slice(0, 120), appareil.id]);
      const profil = profils[0];
      const sujet = profil ? { type: profil.subject_type, userId: profil.user_id, employeeId: profil.employee_id } : null;
      let code = "";
      let accepte = false;
      if (!active) code = "MODALITE_INACTIVE";
      else if (!profil) code = "PROFIL_INCONNU";
      else if (profil.expires_at && new Date(profil.expires_at) <= new Date()) code = "PROFIL_EXPIRE";
      else if (e.resultat !== "match") code = "NON_CORRESPONDANT";
      else if (score !== null && score < seuil) code = "SCORE_INSUFFISANT";
      else accepte = true;

      let evenementId;
      try {
        evenementId = await journaliser(null, { companyId, tenantId: appareil.tenant_id, sujet, profileId: profil?.id,
          type, action: "evenement_appareil", finalite: e.action ? "pointage" : "controle_acces",
          resultat: accepte ? "accepte" : "refuse", code, score, seuil, fournisseur: appareil.provider,
          deviceId: appareil.id, refAppareil: ref, ip });
      } catch (err) {
        if (err.code === "23505") {
          resultats.push({ ref, statut: "doublon", code: "EVENEMENT_REJOUE" });
          continue;
        }
        throw err;
      }
      if (!accepte) {
        resultats.push({ ref, statut: "refuse", code });
        continue;
      }
      await pool.query(`UPDATE biometric_profiles SET last_verified_at = now() WHERE id = $1`, [profil.id]);
      let pointage = null;
      if (e.action && ACTIONS_POINTAGE.has(String(e.action))) {
        try {
          pointage = await hote.enregistrerPointage({
            companyId, tenantId: appareil.tenant_id, sujet, action: e.action,
            methode: type === "face" ? "VISAGE" : "EMPREINTE", deviceId: appareil.id,
            siteId: appareil.site_id, confidence: score, createdBy: null,
            metadata: { biometric_event_id: evenementId },
          });
        } catch (err) {
          resultats.push({ ref, statut: "accepte", pointage: { statut: "refuse", code: err.code || "POINTAGE_ERREUR",
            message: err.message } });
          continue;
        }
      }
      resultats.push({ ref, statut: "accepte", pointage: pointage ? { statut: pointage.statut, action: pointage.action } : null });
    }
    return resultats;
  }

  // ═══════════════════════════════════════════════════════════ PURGE

  /** Conservation : événements au-delà de la durée de la société, défis échus, gabarits expirés depuis 90 jours. */
  async function purger(companyId) {
    const societes = companyId
      ? [{ company_id: companyId }]
      : (await pool.query(`SELECT DISTINCT company_id FROM biometric_events WHERE company_id IS NOT NULL`)).rows;
    let evenementsSupprimes = 0;
    for (const s of societes) {
      const r = await reglages(s.company_id);
      const { rowCount } = await pool.query(
        `DELETE FROM biometric_events WHERE company_id = $1 AND created_at < now() - ($2 || ' days')::interval`,
        [s.company_id, String(r.event_retention_days)]);
      evenementsSupprimes += rowCount;
    }
    const defis = await pool.query(`DELETE FROM biometric_challenges WHERE expires_at < now() - interval '1 day'
                                     ${companyId ? "AND company_id = $1" : ""}`, companyId ? [companyId] : []);
    const gabarits = await pool.query(
      `UPDATE biometric_profiles SET status = 'revoque', template_encrypted = NULL, revoked_at = now(),
              revoke_reason = 'conservation_echue', updated_at = now()
        WHERE status <> 'revoque' AND expires_at < now() - interval '90 days'
          ${companyId ? "AND company_id = $1" : ""}`, companyId ? [companyId] : []);
    return { evenements: evenementsSupprimes, defis: defis.rowCount, gabarits_effaces: gabarits.rowCount };
  }

  return {
    TEXTES_CONSENTEMENT,
    texteConsentement,
    reglages,
    majReglages,
    donnerConsentement,
    consentementActif,
    retirerConsentement,
    enregistrerAppareil,
    regenererSecret,
    activerAppareil,
    listerAppareils,
    authentifierAppareil,
    authentifierRequeteAppareil,
    creerDefi,
    consommerDefi,
    enroler,
    verifier,
    identifier,
    changerStatut,
    profilDe,
    statut,
    listerProfils,
    personnes,
    evenements,
    traiterEvenementsAppareil,
    purger,
    journaliser,
  };
}

module.exports = { creerServiceBiometrie, texteConsentement, TEXTES_CONSENTEMENT, profilPublic, FINALITES };

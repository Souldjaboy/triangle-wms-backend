"use strict";

/**
 * BIOMÉTRIE + PASSKEYS — Triangle WMS (migration 104).
 *
 *   bash scripts/test-biometrie.sh
 *
 * Vrai serveur, vraie base de test. Fournisseurs SIMULÉS (mock), autorisés
 * seulement ici (NODE_ENV=test + BIOMETRIC_ALLOW_MOCK=1). Les passkeys sont
 * signées par un authentificateur logiciel et vérifiées par la vraie
 * bibliothèque WebAuthn. Aucun matériel réel n'est simulé comme tel :
 * l'empreinte « terminal » est éprouvée par ses événements signés.
 *
 *   PHASE=avec_cle : parcours complet.   PHASE=sans_cle : refus sans clé.
 *
 * Sujets : les FICHES EMPLOYÉS du jeu d'essai QR (Bamako, Kati chez
 * Triangle ; Carrière chez FAT & MAT). Le pointage passe par le moteur v2.
 */

const crypto = require("crypto");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const { execFileSync } = require("child_process");
const { AuthentificateurLogiciel } = require("../tests/_webauthn");

const BASE = `http://127.0.0.1:${process.env.PORT || 5050}`;
const SECRET = process.env.JWT_SECRET || "test-secret-durcissement";
const URL_BASE = process.env.DATABASE_URL ||
  "postgresql://postgres:triangle_test_password@127.0.0.1:5433/triangle_wms";
const PHASE = process.env.PHASE || "avec_cle";
const ORIGINE = (process.env.WEBAUTHN_ORIGINS || "http://localhost:3000").split(",")[0];
const RP = process.env.WEBAUTHN_RP_ID || "localhost";

const V = "\x1b[32m", R = "\x1b[31m", G = "\x1b[1m", Z = "\x1b[0m";
let reussis = 0, echoues = 0;
function verifier(titre, condition, detail = "") {
  if (condition) { reussis += 1; console.log(`${V}  ✓${Z} ${titre}`); }
  else { echoues += 1; console.log(`${R}  ✗ ${titre}${Z}${detail ? `  — ${detail}` : ""}`); }
}
const section = (t) => console.log(`\n${G}${t}${Z}`);

const pool = new Pool({ connectionString: URL_BASE });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const jeton = (id, role, companyId) =>
  jwt.sign({ id, fullname: `Compte ${id}`, email: `u${id}@essai.test`, role,
             company_id: companyId, is_super_admin: false }, SECRET, { expiresIn: "3h" });

async function appel(methode, chemin, token, corps, entetes = {}) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...entetes },
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  let data; try { data = JSON.parse(texte); } catch { data = { brut: texte }; }
  return { status: r.status, data, texte };
}

async function signer(appareil, secret, corps, { horodatage, signatureFausse } = {}) {
  const brut = JSON.stringify(corps);
  const ts = String(horodatage || Date.now());
  const signature = signatureFausse ? "00".repeat(32)
    : crypto.createHmac("sha256", secret).update(`${ts}.`).update(brut).digest("hex");
  const r = await fetch(`${BASE}/biometrics/devices/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json",
      "x-biometric-device": String(appareil), "x-biometric-timestamp": ts, "x-biometric-signature": signature },
    body: brut,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}

/** Efface les traces biométriques des essais précédents, puis pose le jeu QR. */
async function poserLeJeu() {
  await q(`DELETE FROM biometric_events`);
  await q(`DELETE FROM biometric_challenges`);
  await q(`DELETE FROM biometric_profiles`);
  await q(`DELETE FROM biometric_consents`);
  await q(`DELETE FROM biometric_devices`);
  await q(`DELETE FROM biometric_settings`);
  await q(`DELETE FROM auth_stepup_grants`);
  await q(`DELETE FROM auth_passkey_challenges`);
  await q(`DELETE FROM auth_passkeys`);
  await q(`DELETE FROM users WHERE email LIKE 'bio-%@essai.test'`);
  const sortie = execFileSync(process.execPath, ["scripts/jeu-essai-badges-qr.js"],
    { env: { ...process.env, DATABASE_URL: URL_BASE }, encoding: "utf8" });
  return JSON.parse(sortie.trim().split("\n").pop());
}

async function compte(email, nom, role, companyId) {
  return (await q(
    `INSERT INTO users (company_id, fullname, email, password, role, is_super_admin, is_active)
     VALUES ($1,$2,$3,'$non-utilisable$',$4,false,true) RETURNING id`,
    [companyId, nom, email, role]))[0].id;
}
const droit = (companyId, userId, module, action, effet = "ALLOW") => q(
  `INSERT INTO user_permission_overrides (company_id, user_id, module_key, action, effect)
   VALUES ($1,$2,$3,$4,$5)`, [companyId, userId, module, action, effet]);

const visage = (identite, extra = {}) => ({ mock_identite: identite, variation: 0.4, ...extra });

async function phaseSansCle() {
  const j = await poserLeJeu();
  const tAdmin = jeton(j.ADMIN_TRIANGLE, "admin", j.TRIANGLE);
  section("SANS BIOMETRIC_ENC_KEY : AUCUN ENREGISTREMENT POSSIBLE");
  const cfg = await appel("GET", "/biometrics/config", tAdmin);
  verifier("la configuration annonce le chiffrement absent", cfg.status === 200 && cfg.data?.chiffrement_configure === false, cfg.texte);
  const r = await appel("PUT", "/biometrics/settings", tAdmin, { face_enabled: true, face_provider: "mock" });
  verifier("activer le visage : 503 CLE_BIOMETRIQUE_ABSENTE", r.status === 503 && r.data?.code === "CLE_BIOMETRIQUE_ABSENTE", r.texte);
  const d = await appel("POST", "/biometrics/devices", tAdmin, { name: "Kiosque", device_type: "kiosque", serial: "K-0" });
  verifier("déclarer un appareil (secret à chiffrer) : 503", d.status === 503 && d.data?.code === "CLE_BIOMETRIQUE_ABSENTE", d.texte);
  await q(`INSERT INTO biometric_settings (company_id, face_enabled, face_provider, require_known_device)
           VALUES ($1, TRUE, 'mock', FALSE)`, [j.TRIANGLE]);
  await appel("POST", "/biometrics/consents", tAdmin, { subject: { employee_id: j.bamako }, accepte: true,
    method: "papier", paper_reference: "FORM-SANS-CLE", modalities: ["face"], purposes: ["pointage"] });
  const e = await appel("POST", "/biometrics/enroll-face", tAdmin, { subject: { employee_id: j.bamako }, capture: visage("bamako") });
  verifier("même forcé en base, l'enrôlement est refusé sans clé", e.status === 503 && e.data?.code === "CLE_BIOMETRIQUE_ABSENTE", e.texte);
  verifier("aucun profil créé", (await q(`SELECT count(*)::int AS n FROM biometric_profiles`))[0].n === 0);
}

async function main() {
  if (PHASE === "sans_cle") return phaseSansCle();

  const j = await poserLeJeu();
  const tAdminT = jeton(j.ADMIN_TRIANGLE, "admin", j.TRIANGLE);
  const tAdminF = jeton(j.ADMIN_FATMAT, "admin", j.FATMAT);
  const tOpT = jeton(j.OPERATEUR_TRIANGLE, "responsable_entrepot", j.TRIANGLE);
  const tOpF = jeton(j.OPERATEUR_FATMAT, "responsable_entrepot", j.FATMAT);

  /* Kati a un compte, rattaché à sa fiche : c'est le parcours « soi-même ».
     Un magasinier sans aucun droit biométrique éprouve les refus. */
  const compteKati = await compte("bio-kati@essai.test", "Essai Kati (compte)", "magasinier", j.TRIANGLE);
  await q(`UPDATE attendance_employees SET user_id = $1 WHERE id = $2`, [compteKati, j.kati]);
  const tKati = jeton(compteKati, "magasinier", j.TRIANGLE);
  const sansDroit = await compte("bio-sans-droit@essai.test", "Essai Sans Droit", "magasinier", j.TRIANGLE);
  const tSansDroit = jeton(sansDroit, "magasinier", j.TRIANGLE);

  /* L'opérateur de Bamako reçoit le pointage biométrique, nommément. */
  for (const a of ["visible", "view", "scan"]) await droit(j.TRIANGLE, j.OPERATEUR_TRIANGLE, "pointage.biometrie", a);
  for (const a of ["visible", "view", "scan"]) await droit(j.FATMAT, j.OPERATEUR_FATMAT, "pointage.biometrie", a);

  // ════════════════════════════════════════════════════════════════════
  section("DROITS");
  {
    const p = await appel("GET", "/biometrics/profiles", tSansDroit);
    verifier("magasinier : liste des profils refusée", p.status === 403 && p.data?.code === "PERMISSION_REFUSEE", p.texte);
    const ev = await appel("GET", "/biometrics/events", tSansDroit);
    verifier("magasinier : journal refusé", ev.status === 403);
    const cfg = await appel("GET", "/biometrics/config", tSansDroit);
    verifier("magasinier : configuration lisible, sans les réglages", cfg.status === 200 && cfg.data?.reglages === undefined
      && cfg.data?.droits?.["biometrie.enroler"] === false, cfg.texte);
    verifier("l'alternative sans biométrie est annoncée", /badge QR et le pointage manuel/.test(cfg.data?.alternative || ""));
    const cfgOp = await appel("GET", "/biometrics/config", tOpT);
    verifier("opérateur : pointage biométrique accordé, enrôlement non",
      cfgOp.data?.droits?.["pointage.biometrie"] === true && cfgOp.data?.droits?.["biometrie.enroler"] === false, cfgOp.texte);
    const cfgA = await appel("GET", "/biometrics/config", tAdminT);
    verifier("admin : tous les droits biométriques (repli des rôles d'administration)",
      Object.values(cfgA.data?.droits || {}).every(Boolean), JSON.stringify(cfgA.data?.droits));
    verifier("modalités fermées par défaut", cfgA.data?.modalites?.face === false && cfgA.data?.modalites?.fingerprint === false);
    const s = await appel("PUT", "/biometrics/settings", tAdminT, { face_enabled: true, face_provider: "mock",
      fingerprint_enabled: true, fingerprint_provider: "mock" });
    verifier("admin : activation visage + empreinte (simulateurs de test)", s.status === 200 && s.data?.reglages?.face_enabled === true, s.texte);
    const s2 = await appel("PUT", "/biometrics/settings", tSansDroit, { face_enabled: false });
    verifier("magasinier : réglages refusés", s2.status === 403);
  }

  // ════════════════════════════════════════════════════════════════════
  const dev = await appel("POST", "/biometrics/devices", tAdminT, { name: "Kiosque Bamako", device_type: "kiosque",
    serial: "K-BKO-1", site_id: j.siteBamako });
  const appareil = { device_id: dev.data?.appareil?.id, device_key: dev.data?.secret };
  section("APPAREILS");
  {
    verifier("appareil déclaré, secret montré une fois", dev.status === 201 && typeof appareil.device_key === "string"
      && appareil.device_key.length >= 40, dev.texte);
    const liste = await appel("GET", "/biometrics/devices", tAdminT);
    verifier("la liste ne contient jamais le secret", liste.status === 200 && !liste.texte.includes(appareil.device_key)
      && !liste.texte.includes("secret_encrypted"));
    const stocke = (await q(`SELECT secret_encrypted FROM biometric_devices WHERE id = $1`, [appareil.device_id]))[0].secret_encrypted;
    verifier("secret stocké chiffré (bv1.)", stocke.startsWith("bv1.") && !stocke.includes(appareil.device_key));
    const m = await appel("POST", "/biometrics/devices", tOpT, { name: "X", device_type: "kiosque", serial: "K-9" });
    verifier("opérateur : déclaration d'appareil refusée", m.status === 403);
  }

  // ════════════════════════════════════════════════════════════════════
  section("CONSENTEMENT");
  {
    const sans = await appel("POST", "/biometrics/enroll-face", tAdminT, { subject: { employee_id: j.bamako },
      capture: visage("bamako"), ...appareil });
    verifier("enrôlement sans consentement : 403 CONSENTEMENT_ABSENT", sans.status === 403
      && sans.data?.code === "CONSENTEMENT_ABSENT", sans.texte);
    const pourAutrui = await appel("POST", "/biometrics/consents", tAdminT, { subject: { employee_id: j.bamako },
      accepte: true, method: "ecran", modalities: ["face"], purposes: ["pointage"] });
    verifier("l'admin ne coche pas « j'accepte » à la place de l'employé", pourAutrui.status === 403
      && pourAutrui.data?.code === "CONSENTEMENT_PERSONNEL", pourAutrui.texte);
    const papier = await appel("POST", "/biometrics/consents", tAdminT, { subject: { employee_id: j.bamako }, accepte: true,
      method: "papier", paper_reference: "FORM-2026-101", modalities: ["face", "fingerprint"], purposes: ["pointage"] });
    verifier("consentement papier référencé, enregistré par l'admin", papier.status === 201, papier.texte);
    const nonAccepte = await appel("POST", "/biometrics/consents", tKati, { modalities: ["face"], purposes: ["pointage"] });
    verifier("consentement sans acceptation explicite : refusé", nonAccepte.status === 400
      && nonAccepte.data?.code === "CONSENTEMENT_NON_ACCEPTE");
    const soi = await appel("POST", "/biometrics/consents", tKati, { accepte: true, modalities: ["face"],
      purposes: ["pointage", "action_sensible"] });
    verifier("Kati consent elle-même à l'écran (fiche rattachée à son compte)", soi.status === 201
      && soi.data?.consentement?.method === "ecran", soi.texte);
    const ligne = (await q(`SELECT subject_type, employee_id, user_id, text_hash FROM biometric_consents WHERE id = $1`,
      [soi.data?.consentement?.id]))[0];
    verifier("… enregistré sur la FICHE employé, avec l'empreinte du texte", ligne?.subject_type === "employee"
      && ligne.employee_id === j.kati && ligne.user_id === null && /^[0-9a-f]{64}$/.test(ligne.text_hash), JSON.stringify(ligne));
    const sansFiche = await appel("POST", "/biometrics/consents", tSansDroit, { accepte: true, modalities: ["face"], purposes: ["pointage"] });
    verifier("compte sans fiche employé : refus explicite", sansFiche.status === 404 && sansFiche.data?.code === "SANS_FICHE_EMPLOYE", sansFiche.texte);
  }

  // ════════════════════════════════════════════════════════════════════
  section("ENRÔLEMENT VISAGE");
  let profilBamako;
  {
    const sansAppareil = await appel("POST", "/biometrics/enroll-face", tAdminT, { subject: { employee_id: j.bamako }, capture: visage("bamako") });
    verifier("sans appareil déclaré : 403 APPAREIL_INCONNU", sansAppareil.status === 403 && sansAppareil.data?.code === "APPAREIL_INCONNU");
    const mauvaiseCle = await appel("POST", "/biometrics/enroll-face", tAdminT, { subject: { employee_id: j.bamako },
      capture: visage("bamako"), device_id: appareil.device_id, device_key: "faux" });
    verifier("clé d'appareil fausse : 403", mauvaiseCle.status === 403 && mauvaiseCle.data?.code === "APPAREIL_INCONNU");
    const auto = await appel("POST", "/biometrics/enroll-face", tKati, { capture: visage("kati"), ...appareil });
    verifier("auto-enrôlement désactivé par défaut : 403", auto.status === 403 && auto.data?.code === "PERMISSION_REFUSEE", auto.texte);
    const e = await appel("POST", "/biometrics/enroll-face", tAdminT, { subject: { employee_id: j.bamako },
      capture: visage("bamako"), ...appareil });
    profilBamako = e.data?.profil;
    verifier("enrôlement par l'admin (mock visage) : 201", e.status === 201 && profilBamako?.status === "actif", e.texte);
    verifier("la réponse ne contient aucun gabarit", !e.texte.includes("bv1.") && profilBamako?.has_server_template === true);
    const g = (await q(`SELECT template_encrypted, employee_id, user_id FROM biometric_profiles WHERE id = $1`, [profilBamako.id]))[0];
    verifier("gabarit stocké chiffré, sur la fiche employé", g.template_encrypted.startsWith("bv1.")
      && g.employee_id === j.bamako && g.user_id === null);
    const encore = await appel("POST", "/biometrics/enroll-face", tAdminT, { subject: { employee_id: j.bamako },
      capture: visage("bamako"), ...appareil });
    verifier("deuxième enrôlement : 409 PROFIL_EXISTANT", encore.status === 409 && encore.data?.code === "PROFIL_EXISTANT");
    const vivant = await appel("POST", "/biometrics/enroll-face", tAdminT, { subject: { employee_id: j.kati },
      capture: visage("kati", { vivant: false }), ...appareil });
    verifier("photo (non vivant) : 422 VIVANT_REFUSE", vivant.status === 422 && vivant.data?.code === "VIVANT_REFUSE", vivant.texte);
    const k = await appel("POST", "/biometrics/enroll-face", tAdminT, { subject: { employee_id: j.kati }, capture: visage("kati"), ...appareil });
    verifier("Kati enrôlée (son consentement écran)", k.status === 201, k.texte);
  }

  const defi = async (corps, token = tAdminT) =>
    (await appel("POST", "/biometrics/challenges", token, { biometric_type: "face", purpose: "pointage", ...appareil, ...corps })).data;

  // ════════════════════════════════════════════════════════════════════
  section("VÉRIFICATION 1:1 ET ANTI-REJEU");
  {
    const d = await defi({ subject: { employee_id: j.bamako } });
    verifier("défi émis (nonce à usage unique)", typeof d?.nonce === "string" && d.challenge_id > 0, JSON.stringify(d));
    const v = await appel("POST", "/biometrics/verify-face", tAdminT, { subject: { employee_id: j.bamako },
      capture: visage("bamako", { variation: 0.8 }), challenge: d, purpose: "pointage", ...appareil });
    verifier("bonne personne : vérifiée, score ≥ seuil", v.status === 200 && v.data?.verified === true
      && v.data.confidence >= v.data.threshold, v.texte);
    const rejeu = await appel("POST", "/biometrics/verify-face", tAdminT, { subject: { employee_id: j.bamako },
      capture: visage("bamako"), challenge: d, purpose: "pointage", ...appareil });
    verifier("défi rejoué : 409 DEFI_REJOUE", rejeu.status === 409 && rejeu.data?.code === "DEFI_REJOUE", rejeu.texte);
    const d2 = await defi({ subject: { employee_id: j.bamako } });
    const faux = await appel("POST", "/biometrics/verify-face", tAdminT, { subject: { employee_id: j.bamako },
      capture: visage("imposteur"), challenge: d2, purpose: "pointage", ...appareil });
    verifier("mauvaise identité : refusée (401, non vérifiée)", faux.status === 401 && faux.data?.verified === false, faux.texte);
    const d3 = await defi({ subject: { employee_id: j.bamako } });
    await q(`UPDATE biometric_challenges SET expires_at = now() - interval '1 second' WHERE id = $1`, [d3.challenge_id]);
    const exp = await appel("POST", "/biometrics/verify-face", tAdminT, { subject: { employee_id: j.bamako },
      capture: visage("bamako"), challenge: d3, purpose: "pointage", ...appareil });
    verifier("défi expiré : 410 DEFI_EXPIRE", exp.status === 410 && exp.data?.code === "DEFI_EXPIRE", exp.texte);
    const d4 = await defi({ subject: { employee_id: j.bamako } });
    const autre = await appel("POST", "/biometrics/verify-face", tAdminT, { subject: { employee_id: j.kati },
      capture: visage("kati"), challenge: d4, purpose: "pointage", ...appareil });
    verifier("défi de Bamako utilisé pour Kati : refusé", autre.status === 400 && autre.data?.code === "DEFI_INVALIDE", autre.texte);
    const inconnu = await appel("POST", "/biometrics/challenges", tAdminT, { biometric_type: "face", purpose: "pointage",
      subject: { employee_id: j.bamako }, device_id: 999999, device_key: appareil.device_key });
    verifier("appareil inconnu : 403 APPAREIL_INCONNU", inconnu.status === 403 && inconnu.data?.code === "APPAREIL_INCONNU", inconnu.texte);
    const collegue = await appel("POST", "/biometrics/challenges", tSansDroit, { biometric_type: "face", purpose: "pointage",
      subject: { employee_id: j.bamako }, ...appareil });
    verifier("magasinier : défi pour un collègue refusé", collegue.status === 403);
  }

  // ════════════════════════════════════════════════════════════════════
  section("EMPREINTE (SIMULATEUR)");
  {
    const f1 = await appel("POST", "/biometrics/enroll-fingerprint", tAdminT, { subject: { employee_id: j.bamako },
      finger_index: 1, capture: { mock_doigt: "bamako-1" }, ...appareil });
    verifier("empreinte enrôlée (mock)", f1.status === 201, f1.texte);
    const d = await defi({ subject: { employee_id: j.bamako }, biometric_type: "fingerprint" });
    const ok = await appel("POST", "/biometrics/verify-fingerprint", tAdminT, { subject: { employee_id: j.bamako },
      capture: { mock_doigt: "bamako-1" }, challenge: d, purpose: "pointage", ...appareil });
    verifier("empreinte valide : vérifiée", ok.status === 200 && ok.data?.verified === true, ok.texte);
    const d2 = await defi({ subject: { employee_id: j.bamako }, biometric_type: "fingerprint" });
    const ko = await appel("POST", "/biometrics/verify-fingerprint", tAdminT, { subject: { employee_id: j.bamako },
      capture: { mock_doigt: "kati-1" }, challenge: d2, purpose: "pointage", ...appareil });
    verifier("empreinte d'une autre personne : refusée", ko.status === 401 && ko.data?.verified === false, ko.texte);
  }

  // ════════════════════════════════════════════════════════════════════
  section("POINTAGE BIOMÉTRIQUE : BADGE v2 + VISAGE, MOTEUR v2");
  {
    const badgeBamako = (await appel("POST", "/attendance-v2/badges", tAdminT, { employee_id: j.bamako })).data.badge;
    const badgeKati = (await appel("POST", "/attendance-v2/badges", tAdminT, { employee_id: j.kati })).data.badge;
    const badgeCarriere = (await appel("POST", "/attendance-v2/badges", tAdminF, { employee_id: j.carriere })).data.badge;
    const jetonDe = async (id) => (await q(`SELECT qr_token FROM attendance_badges WHERE id = $1`, [id]))[0].qr_token;
    const tokBamako = await jetonDe(badgeBamako.id);
    const tokKati = await jetonDe(badgeKati.id);
    const tokCarriere = await jetonDe(badgeCarriere.id);

    const sans = await appel("POST", "/biometrics/challenges", tSansDroit, { biometric_type: "face", purpose: "pointage",
      badge: tokBamako, ...appareil });
    verifier("sans droit pointage.biometrie : défi refusé", sans.status === 403, sans.texte);
    const imprime = await appel("POST", "/biometrics/challenges", tOpT, { biometric_type: "face", purpose: "pointage",
      badge: badgeBamako.badge_code, ...appareil });
    verifier("le code imprimé du badge ne désigne personne", imprime.status === 404 && imprime.data?.code === "BADGE_INCONNU", imprime.texte);

    const d = await defi({ badge: tokBamako }, tOpT);
    verifier("défi lié à l'employé du badge", d?.subject?.employee_id === j.bamako, JSON.stringify(d));
    const p = await appel("POST", "/biometrics/attendance", tOpT, { badge: tokBamako,
      biometric_type: "face", capture: visage("bamako", { variation: 0.6 }), challenge: d, ...appareil });
    verifier("arrivée pointée par le visage (étape déduite)", p.status === 200 && p.data?.success === true
      && p.data?.action === "Arrivée", p.texte);
    verifier("réponse sans gabarit, jeton ni courriel", !/bv1\.|qr_token|password|email/.test(p.texte), p.texte);
    const ev = (await q(`SELECT source, biometric_score::float AS score, biometric_provider, device_id, challenge_id,
                                 performed_by, action_type, metadata
                            FROM attendance_event_log_v2 WHERE employee_id = $1 ORDER BY id DESC LIMIT 1`, [j.bamako]))[0];
    verifier("journal v2 : VISAGE, score, fournisseur, appareil, défi, opérateur", ev?.source === "VISAGE" && ev.score >= 0.85
      && ev.biometric_provider === "mock" && ev.device_id === appareil.device_id && ev.challenge_id === d.challenge_id
      && ev.performed_by === j.OPERATEUR_TRIANGLE && ev.action_type === "CHECK_IN", JSON.stringify(ev));
    verifier("aucun gabarit ni image dans le journal v2", !JSON.stringify(ev.metadata).includes("bv1.")
      && !JSON.stringify(ev.metadata).includes("mock_identite"));
    const jour = (await q(`SELECT check_in, status FROM attendance_day_records_v2 WHERE employee_id = $1`, [j.bamako]))[0];
    verifier("la journée v2 (périodes, paie) porte l'arrivée", Boolean(jour?.check_in) && ["PRESENT", "LATE"].includes(jour.status), JSON.stringify(jour));

    const dBis = await defi({ badge: tokBamako }, tOpT);
    const bis = await appel("POST", "/biometrics/attendance", tOpT, { badge: tokBamako,
      biometric_type: "face", capture: visage("bamako"), challenge: dBis, ...appareil });
    verifier("double pointage immédiat : répétition, aucun second événement", bis.status === 200 && bis.data?.statut === "deja_enregistre"
      && (await q(`SELECT count(*)::int AS n FROM attendance_event_log_v2 WHERE employee_id = $1`, [j.bamako]))[0].n === 1, bis.texte);

    const dK = await defi({ badge: tokKati }, tAdminT);
    const imposteur = await appel("POST", "/biometrics/attendance", tAdminT, { badge: tokKati,
      biometric_type: "face", capture: visage("bamako"), challenge: dK, ...appareil });
    verifier("visage de Bamako sur le badge de Kati : refusé", imposteur.status === 401
      && imposteur.data?.code === "NON_CORRESPONDANT", imposteur.texte);
    verifier("… et aucun pointage pour Kati",
      (await q(`SELECT count(*)::int AS n FROM attendance_event_log_v2 WHERE employee_id = $1`, [j.kati]))[0].n === 0);

    const dK2 = await defi({ badge: tokKati }, tOpT);
    const perimetre = await appel("POST", "/biometrics/attendance", tOpT, { badge: tokKati,
      biometric_type: "face", capture: visage("kati"), challenge: dK2, ...appareil });
    verifier("opérateur de Bamako sur Kati : refusé (site de l'appareil ou périmètre)", perimetre.status === 403
      && ["APPAREIL_HORS_SITE", "ATTENDANCE_SCOPE_DENIED"].includes(perimetre.data?.code), perimetre.texte);

    const devKati = await appel("POST", "/biometrics/devices", tAdminT, { name: "Poste mobile", device_type: "mobile", serial: "M-1" });
    const mobile = { device_id: devKati.data?.appareil?.id, device_key: devKati.data?.secret };
    const dK3 = (await appel("POST", "/biometrics/challenges", tOpT, { biometric_type: "face", purpose: "pointage",
      badge: tokKati, ...mobile })).data;
    const scope = await appel("POST", "/biometrics/attendance", tOpT, { badge: tokKati,
      biometric_type: "face", capture: visage("kati"), challenge: dK3, ...mobile });
    verifier("appareil sans site : le périmètre d'opérateur s'applique (403)", scope.status === 403
      && scope.data?.code === "ATTENDANCE_SCOPE_DENIED", scope.texte);

    const ordre = await appel("POST", "/biometrics/attendance", tAdminT, { badge: tokKati, action: "pause_end",
      biometric_type: "face", capture: visage("kati"),
      challenge: (await appel("POST", "/biometrics/challenges", tAdminT, { biometric_type: "face", purpose: "pointage",
        badge: tokKati, ...mobile })).data, ...mobile });
    verifier("ordre des étapes : retour de pause avant l'arrivée refusé", ordre.status === 409
      && ordre.data?.code === "ATTENDANCE_SEQUENCE_INVALID", ordre.texte);

    const badgeB = await appel("POST", "/biometrics/challenges", tOpT, { biometric_type: "face", purpose: "pointage",
      badge: tokCarriere, ...appareil });
    verifier("badge FAT & MAT présenté chez Triangle : inconnu", badgeB.status === 404 && badgeB.data?.code === "BADGE_INCONNU", badgeB.texte);
  }

  // ════════════════════════════════════════════════════════════════════
  section("ISOLATION ENTRE SOCIÉTÉS");
  {
    const e = await appel("POST", "/biometrics/enroll-face", tAdminF, { subject: { employee_id: j.bamako }, capture: visage("bamako"), ...appareil });
    verifier("admin FAT & MAT : enrôler un employé Triangle → introuvable", e.status === 404 && e.data?.code === "PERSONNE_INTROUVABLE", e.texte);
    await appel("PUT", "/biometrics/settings", tAdminF, { face_enabled: true, face_provider: "mock" });
    await appel("POST", "/biometrics/consents", tAdminF, { subject: { employee_id: j.carriere }, accepte: true,
      method: "papier", paper_reference: "FORM-F-1", modalities: ["face"], purposes: ["pointage"] });
    const appareilDeT = await appel("POST", "/biometrics/enroll-face", tAdminF, { subject: { employee_id: j.carriere },
      capture: visage("carriere"), ...appareil });
    verifier("admin FAT & MAT : appareil de Triangle refusé", appareilDeT.status === 403 && appareilDeT.data?.code === "APPAREIL_INCONNU");
    const pF = await appel("GET", "/biometrics/profiles", tAdminF);
    verifier("FAT & MAT ne voit aucun profil Triangle", pF.status === 200 && pF.data.profils.every((x) => x.employee_id !== j.bamako));
    const st = await appel("GET", `/biometrics/status?employee_id=${j.bamako}`, tAdminF);
    verifier("FAT & MAT : état d'un employé Triangle → introuvable", st.status === 404, st.texte);
    const rv = await appel("POST", "/biometrics/revoke", tAdminF, { profile_id: profilBamako.id });
    verifier("FAT & MAT : révoquer un profil Triangle → introuvable", rv.status === 404, rv.texte);
    const evF = await appel("GET", "/biometrics/events", tAdminF);
    verifier("journal FAT & MAT sans événement Triangle", evF.status === 200
      && evF.data.evenements.every((x) => x.employee_id !== j.bamako && x.employee_id !== j.kati));
  }

  // ════════════════════════════════════════════════════════════════════
  section("GARDE-FOUS EN BASE");
  {
    const consent = (await q(`SELECT id FROM biometric_consents WHERE employee_id = $1 LIMIT 1`, [j.bamako]))[0];
    let compteRefuse = false;
    try {
      await q(`INSERT INTO biometric_profiles (company_id, subject_type, user_id, biometric_type, provider, external_reference, consent_id)
               VALUES ($1, 'user', $2, 'face', 'terminal', 'ref', $3)`, [j.TRIANGLE, j.ADMIN_TRIANGLE, consent.id]);
    } catch (e) { compteRefuse = /seule une fiche employé/.test(e.message); }
    verifier("un compte (users) ne reçoit jamais de profil : refus du déclencheur", compteRefuse);
    let autreSociete = false;
    try {
      await q(`INSERT INTO biometric_profiles (company_id, subject_type, employee_id, biometric_type, provider, external_reference, consent_id)
               VALUES ($1, 'employee', $2, 'face', 'terminal', 'ref', $3)`, [j.TRIANGLE, j.carriere, consent.id]);
    } catch (e) { autreSociete = /n'appartient pas/.test(e.message); }
    verifier("employé d'une autre société : refus du déclencheur", autreSociete);
    let clair = false;
    try {
      await q(`INSERT INTO biometric_profiles (company_id, subject_type, employee_id, biometric_type, provider, template_encrypted, consent_id)
               VALUES ($1, 'employee', $2, 'fingerprint', 'mock', 'gabarit-en-clair', $3)`, [j.TRIANGLE, j.bamako, consent.id]);
    } catch (e) { clair = e.code === "23514"; }
    verifier("gabarit non chiffré : refusé par une contrainte", clair);
    let sansScore = false;
    try {
      const rec = (await q(`SELECT id FROM attendance_day_records_v2 WHERE employee_id = $1 LIMIT 1`, [j.bamako]))[0];
      await q(`INSERT INTO attendance_event_log_v2 (company_id, employee_id, record_id, action_type, event_at, source)
               VALUES ($1,$2,$3,'CHECK_OUT',now(),'VISAGE')`, [j.TRIANGLE, j.bamako, rec.id]);
    } catch (e) { sansScore = e.code === "23514"; }
    verifier("pointage VISAGE sans score : refusé par une contrainte", sansScore);
  }

  // ════════════════════════════════════════════════════════════════════
  section("TERMINAL D'EMPREINTES : ÉVÉNEMENTS SIGNÉS (NON TESTÉ AVEC MATÉRIEL RÉEL)");
  {
    await appel("PUT", "/biometrics/settings", tAdminF, { fingerprint_enabled: true, fingerprint_provider: "terminal" });
    const t = await appel("POST", "/biometrics/devices", tAdminF, { name: "Terminal carrière", device_type: "terminal_empreinte",
      serial: "ZK-001", provider: "zkteco", site_id: j.siteCarriere });
    const term = { id: t.data?.appareil?.id, secret: t.data?.secret };
    await appel("POST", "/biometrics/consents", tAdminF, { subject: { employee_id: j.carriere2 }, accepte: true, method: "papier",
      paper_reference: "FORM-F-2", modalities: ["fingerprint"], purposes: ["pointage"] });
    const e = await appel("POST", "/biometrics/enroll-fingerprint", tAdminF, { subject: { employee_id: j.carriere2 }, finger_index: 1,
      external_reference: "Z-17", device_id: term.id, device_key: term.secret });
    verifier("enrôlement « terminal » : aucun gabarit côté serveur", e.status === 201 && e.data?.profil?.has_server_template === false, e.texte);
    const ok = await signer(term.id, term.secret, { events: [{ ref: "e1", type: "fingerprint", reference: "Z-17",
      resultat: "match", score: 0.97, action: "checkin" }] });
    verifier("événement signé valide : pointage écrit par le moteur v2", ok.status === 200
      && ok.data?.resultats?.[0]?.pointage?.statut === "enregistre", JSON.stringify(ok.data));
    const ev = (await q(`SELECT source, device_id, biometric_score::float AS score, performed_by
                           FROM attendance_event_log_v2 WHERE employee_id = $1`, [j.carriere2]))[0];
    verifier("source EMPREINTE, terminal et score tracés", ev?.source === "EMPREINTE" && ev.device_id === term.id
      && ev.score === 0.97 && ev.performed_by === null, JSON.stringify(ev));
    const rejeu = await signer(term.id, term.secret, { events: [{ ref: "e1", type: "fingerprint", reference: "Z-17", resultat: "match", action: "checkin" }] });
    verifier("même événement rejoué : ignoré (doublon)", rejeu.data?.resultats?.[0]?.statut === "doublon", JSON.stringify(rejeu.data));
    const fausse = await signer(term.id, term.secret, { events: [] }, { signatureFausse: true });
    verifier("signature fausse : 401", fausse.status === 401 && fausse.data?.code === "SIGNATURE_INVALIDE");
    const vieux = await signer(term.id, term.secret, { events: [] }, { horodatage: Date.now() - 10 * 60 * 1000 });
    verifier("horodatage de 10 minutes : 401 (rejeu)", vieux.status === 401 && vieux.data?.code === "SIGNATURE_EXPIREE");
    const autre = await signer(appareil.device_id, appareil.device_key, { events: [{ ref: "e9", type: "fingerprint",
      reference: "Z-17", resultat: "match", action: "checkout" }] });
    verifier("kiosque Triangle avec la référence d'un employé FAT & MAT : refusé", autre.data?.resultats?.[0]?.statut === "refuse", JSON.stringify(autre.data));
  }

  // ════════════════════════════════════════════════════════════════════
  section("PASSKEYS (WEBAUTHN) ET VALIDATION RENFORCÉE");
  const cle = new AuthentificateurLogiciel({ origine: ORIGINE, rpId: RP });
  {
    const o = await appel("POST", "/auth/passkeys/register/options", tAdminT, {});
    verifier("options d'enregistrement : vérification utilisateur exigée", o.status === 200
      && o.data?.authenticatorSelection?.userVerification === "required", o.texte);
    verifier("nom de la partie de confiance : Triangle", /Triangle/.test(o.data?.rp?.name || ""), JSON.stringify(o.data?.rp));
    const r = await appel("POST", "/auth/passkeys/register/verify", tAdminT, { response: cle.creer(o.data), name: "iPhone direction" });
    verifier("passkey enregistrée", r.status === 201 && r.data?.passkey?.name === "iPhone direction", r.texte);
    const stockee = (await q(`SELECT public_key FROM auth_passkeys WHERE user_id = $1`, [j.ADMIN_TRIANGLE]))[0];
    verifier("le serveur ne garde qu'une clé publique", stockee && stockee.public_key.length > 40);
    const rejeuEnr = await appel("POST", "/auth/passkeys/register/verify", tAdminT, { response: cle.creer(o.data) });
    verifier("défi d'enregistrement rejoué : refusé", rejeuEnr.status === 409 && rejeuEnr.data?.code === "DEFI_REJOUE");

    const lo0 = await appel("POST", "/auth/passkeys/login/options", null, {});
    const nonVerifie = await appel("POST", "/auth/passkeys/login/verify", null, { response: cle.obtenir(lo0.data) });
    verifier("compte non vérifié : la passkey ne contourne pas la vérification", nonVerifie.status === 403
      && nonVerifie.data?.code === "verification_required", nonVerifie.texte);
    await q(`UPDATE users SET verification_mode = 'none' WHERE id = $1`, [j.ADMIN_TRIANGLE]);
    await q(`UPDATE users SET is_active = false WHERE id = $1`, [j.ADMIN_TRIANGLE]);
    const lo1 = await appel("POST", "/auth/passkeys/login/options", null, {});
    const inactif = await appel("POST", "/auth/passkeys/login/verify", null, { response: cle.obtenir(lo1.data) });
    verifier("compte désactivé : la passkey est refusée comme le mot de passe", inactif.status === 403, inactif.texte);
    await q(`UPDATE users SET is_active = true WHERE id = $1`, [j.ADMIN_TRIANGLE]);
    const lo = await appel("POST", "/auth/passkeys/login/options", null, {});
    const assertion = cle.obtenir(lo.data);
    const login = await appel("POST", "/auth/passkeys/login/verify", null, { response: assertion });
    verifier("connexion par passkey : jeton de session émis", login.status === 200 && typeof login.data?.token === "string"
      && login.data?.user?.id === j.ADMIN_TRIANGLE, login.texte.slice(0, 300));
    const audit = (await q(`SELECT details FROM audit_logs WHERE action = 'login' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [j.ADMIN_TRIANGLE]))[0];
    verifier("connexion journalisée avec sa méthode", audit?.details?.methode === "passkey", JSON.stringify(audit));
    const rejeu = await appel("POST", "/auth/passkeys/login/verify", null, { response: assertion });
    verifier("assertion rejouée : refusée", rejeu.status === 409 && rejeu.data?.code === "DEFI_REJOUE", rejeu.texte);
    const lo2 = await appel("POST", "/auth/passkeys/login/options", null, {});
    const origine = await appel("POST", "/auth/passkeys/login/verify", null,
      { response: cle.obtenir(lo2.data, { origine: "https://faux-site.example" }) });
    verifier("autre origine (hameçonnage) : refusée", origine.status === 401 && origine.data?.code === "PASSKEY_INVALIDE", origine.texte);
    const lo3 = await appel("POST", "/auth/passkeys/login/options", null, {});
    const sansUV = await appel("POST", "/auth/passkeys/login/verify", null, { response: cle.obtenir(lo3.data, { sansVerification: true }) });
    verifier("sans vérification de l'appareil (UV) : refusée", sansUV.status === 401);

    const sansSU = await appel("PUT", "/biometrics/settings", tAdminT, { require_liveness: true });
    verifier("action sensible sans validation renforcée : 403 STEP_UP_REQUIS", sansSU.status === 403
      && sansSU.data?.code === "STEP_UP_REQUIS", sansSU.texte);
    const so = await appel("POST", "/auth/step-up/options", tAdminT, { scope: "biometrie.parametres" });
    const sv = await appel("POST", "/auth/step-up/verify", tAdminT, { response: cle.obtenir(so.data), scope: "biometrie.parametres" });
    verifier("validation renforcée accordée (5 min)", sv.status === 200 && typeof sv.data?.step_up_token === "string", sv.texte);
    const avec = await appel("PUT", "/biometrics/settings", tAdminT, { require_liveness: true }, { "x-step-up-token": sv.data.step_up_token });
    verifier("action sensible avec validation : 200", avec.status === 200, avec.texte);
    const autreScope = await appel("POST", `/biometrics/devices/${appareil.device_id}/secret`, tAdminT, {},
      { "x-step-up-token": sv.data.step_up_token });
    verifier("validation limitée à sa portée (autre action : refusée)", autreScope.status === 403
      && autreScope.data?.code === "STEP_UP_REQUIS");
    await q(`UPDATE auth_stepup_grants SET expires_at = now() - interval '1 second'`);
    const expire = await appel("PUT", "/biometrics/settings", tAdminT, { require_liveness: true }, { "x-step-up-token": sv.data.step_up_token });
    verifier("validation expirée : refusée", expire.status === 403);

    const liste = await appel("GET", "/auth/passkeys", tAdminT);
    const id = liste.data?.passkeys?.[0]?.id;
    verifier("liste des passkeys sans clé publique", liste.status === 200 && id && !liste.texte.includes(stockee.public_key));
    const ren = await appel("PATCH", `/auth/passkeys/${id}`, tAdminT, { name: "Téléphone pro" });
    verifier("renommer l'appareil", ren.status === 200 && ren.data?.passkey?.name === "Téléphone pro", ren.texte);
    const autrui = await appel("DELETE", `/auth/passkeys/${id}`, tKati);
    verifier("supprimer la passkey d'autrui : impossible", autrui.status === 404);
    const del = await appel("DELETE", `/auth/passkeys/${id}`, tAdminT);
    const lo4 = await appel("POST", "/auth/passkeys/login/options", null, {});
    const apres = await appel("POST", "/auth/passkeys/login/verify", null, { response: cle.obtenir(lo4.data) });
    verifier("passkey révoquée : plus de connexion", del.status === 200 && apres.status === 401
      && apres.data?.code === "PASSKEY_INCONNUE", apres.texte);
  }

  // ════════════════════════════════════════════════════════════════════
  section("SOI-MÊME : ÉTAT, VISAGE POUR UNE ACTION SENSIBLE, RÉVOCATION");
  {
    const st = await appel("GET", "/biometrics/status", tKati);
    const face = st.data?.profils?.find((p) => p.biometric_type === "face" && p.status === "actif");
    verifier("Kati voit son propre état (sans gabarit)", st.status === 200 && face && !st.texte.includes("bv1."), st.texte);
    const d = (await appel("POST", "/biometrics/challenges", tKati, { biometric_type: "face", purpose: "action_sensible", ...appareil })).data;
    const v = await appel("POST", "/biometrics/verify-face", tKati, { capture: visage("kati"), challenge: d,
      purpose: "action_sensible", scope: "paie.validation", ...appareil });
    verifier("visage vérifié → validation renforcée accordée à son compte", v.status === 200 && v.data?.step_up?.method === "visage", v.texte);
    const autre = await appel("POST", "/biometrics/revoke", tSansDroit, { profile_id: face.id });
    verifier("un collègue ne révoque pas le profil de Kati", autre.status === 403, autre.texte);
    const r = await appel("POST", "/biometrics/revoke", tKati, { profile_id: face.id });
    const ligne = (await q(`SELECT status, template_encrypted FROM biometric_profiles WHERE id = $1`, [face.id]))[0];
    verifier("Kati révoque son visage : gabarit effacé", r.status === 200 && ligne.status === "revoque"
      && ligne.template_encrypted === null, r.texte);
  }

  // ════════════════════════════════════════════════════════════════════
  section("RETRAIT DU CONSENTEMENT ET RÉVOCATION");
  {
    const cB = (await q(`SELECT id FROM biometric_consents WHERE employee_id = $1 AND withdrawn_at IS NULL`, [j.bamako]))[0];
    const w = await appel("POST", `/biometrics/consents/${cB.id}/withdraw`, tAdminT, { reason: "Demande de l'employé" });
    verifier("retrait du consentement de Bamako : profils révoqués", w.status === 200 && w.data?.profils_revoques >= 2, w.texte);
    verifier("… aucun gabarit restant pour Bamako",
      (await q(`SELECT count(*)::int AS n FROM biometric_profiles WHERE employee_id = $1 AND template_encrypted IS NOT NULL`,
        [j.bamako]))[0].n === 0);
    const d = await defi({ subject: { employee_id: j.bamako } });
    const apres = await appel("POST", "/biometrics/verify-face", tAdminT, { subject: { employee_id: j.bamako },
      capture: visage("bamako"), challenge: d, purpose: "pointage", ...appareil });
    verifier("consentement retiré : plus de vérification possible", apres.status === 404 || apres.status === 403, apres.texte);
    const reenrole = await appel("POST", "/biometrics/enroll-face", tAdminT, { subject: { employee_id: j.bamako },
      capture: visage("bamako"), ...appareil });
    verifier("consentement retiré : ré-enrôlement refusé (CONSENTEMENT_ABSENT)", reenrole.status === 403
      && reenrole.data?.code === "CONSENTEMENT_ABSENT", reenrole.texte);
  }

  // ════════════════════════════════════════════════════════════════════
  section("JOURNAL");
  {
    const jr = await appel("GET", "/biometrics/events?limit=500", tAdminT);
    verifier("journal lisible par l'admin, sans gabarit ni secret", jr.status === 200 && jr.data.evenements.length > 10
      && !jr.texte.includes("bv1.") && !jr.texte.includes("template"));
    verifier("refus journalisés avec leur motif", ["DEFI_REJOUE", "VIVANT_REFUSE", "CONSENTEMENT_ABSENT", "NON_CORRESPONDANT"]
      .every((c) => jr.data.evenements.some((e) => e.reason_code === c)));
    verifier("le journal porte le nom des employés", jr.data.evenements.some((e) => e.subject_name === "Essai QR Bamako"));
    const pp = await appel("GET", "/biometrics/people", tAdminT);
    verifier("liste du personnel = fiches employés de la société", pp.status === 200
      && pp.data.personnes.some((x) => x.employee_id === j.bamako) && pp.data.personnes.every((x) => x.employee_id !== j.carriere));
    const id = await appel("POST", "/biometrics/identify", tAdminT, { biometric_type: "face", capture: visage("kati"), ...appareil });
    verifier("identification 1:N désactivée par défaut : 403", id.status === 403 && id.data?.code === "IDENTIFICATION_INTERDITE", id.texte);
  }
}

main()
  .then(async () => {
    console.log(`\n${G}BILAN${Z}\n  ${reussis} réussis, ${echoues} échoués`);
    await pool.end();
    process.exit(echoues ? 1 : 0);
  })
  .catch(async (e) => {
    console.error(e);
    await pool.end().catch(() => {});
    process.exit(1);
  });

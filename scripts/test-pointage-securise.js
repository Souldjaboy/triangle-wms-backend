"use strict";

/**
 * POINTAGE SÉCURISÉ — anciennes routes et scan v2.
 *
 *   bash scripts/test-pointage-securise.sh
 *
 * Ce que la suite prouve :
 *
 *   AFFECTATION     PUT /attendance/assign-user/:id : jeton exigé, droit
 *                   pointage|configure, taux de paie sous paie|adjust, société
 *                   active seulement, audit, réponse réduite, champ absent
 *                   jamais remis à zéro ;
 *   ANCIENNES       /attendance/legacy/scan et /legacy/check : retirées (410),
 *                   sans aucune donnée de compte, journalisées, limitées ;
 *   RÉSOLUTION      un ancien badge imprimé n'expose ni courriel ni identifiant
 *                   et ne propose plus de pointer ; l'énumération par numéro
 *                   de compte est fermée ;
 *   SCAN v2         sans jeton refusé, badge d'une autre société refusé comme
 *                   un badge inconnu, badge valide accepté, double lecture =
 *                   un seul événement, ordre des étapes, périmètre, aucune
 *                   donnée sensible dans la réponse ;
 *   DÉBIT           au-delà de la limite par minute : 429.
 */

const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const { execFileSync } = require("child_process");

const BASE = `http://127.0.0.1:${process.env.PORT || 5050}`;
const SECRET = process.env.JWT_SECRET || "test-secret-durcissement";
const URL_BASE = process.env.DATABASE_URL ||
  "postgresql://postgres:triangle_test_password@127.0.0.1:5433/triangle_wms";
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

async function appel(methode, chemin, token, corps) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  let json; try { json = JSON.parse(texte); } catch { json = { brut: texte }; }
  return { statut: r.status, corps: json, texte };
}

function poserLeJeu() {
  const sortie = execFileSync(process.execPath, ["scripts/jeu-essai-badges-qr.js"],
    { env: { ...process.env, DATABASE_URL: URL_BASE }, encoding: "utf8" });
  return JSON.parse(sortie.trim().split("\n").pop());
}

const SENSIBLE = /password|"\$2[aby]\$|qr_token|token_hint|email/i;

async function main() {
  console.log(`\n${G}POINTAGE SÉCURISÉ (anciennes routes, scan v2)${Z}`);
  const j = poserLeJeu();
  const tAdminT = jeton(j.ADMIN_TRIANGLE, "admin", j.TRIANGLE);
  const tAdminF = jeton(j.ADMIN_FATMAT, "admin", j.FATMAT);
  const tOpT = jeton(j.OPERATEUR_TRIANGLE, "responsable_entrepot", j.TRIANGLE);

  /* Un compte qui peut configurer le pointage mais à qui la paie est
     explicitement refusée : c'est lui qui prouve que les taux exigent plus. */
  await q(`DELETE FROM users WHERE email = 'qr-config-pointage@essai.test'`);
  const configurateur = (await q(
    `INSERT INTO users (company_id, fullname, email, password, role, is_super_admin, is_active)
     VALUES ($1,'Essai Configurateur','qr-config-pointage@essai.test','$non-utilisable$','magasinier',false,true)
     RETURNING id`, [j.TRIANGLE]))[0].id;
  for (const [m, a, e] of [["pointage", "visible", "ALLOW"], ["pointage", "configure", "ALLOW"],
    ["paie", "visible", "DENY"], ["paie", "adjust", "DENY"]]) {
    await q(`INSERT INTO user_permission_overrides (company_id, user_id, module_key, action, effect)
             VALUES ($1,$2,$3,$4,$5)`, [j.TRIANGLE, configurateur, m, a, e]);
  }
  const tConfig = jeton(configurateur, "magasinier", j.TRIANGLE);

  await q(`DELETE FROM schedule_groups WHERE name LIKE 'Essai groupe %'`);
  const groupeT = (await q(`INSERT INTO schedule_groups (name, start_time, end_time, company_id)
                             VALUES ('Essai groupe T','08:00','17:00',$1) RETURNING id`, [j.TRIANGLE]))[0].id;
  const groupeF = (await q(`INSERT INTO schedule_groups (name, start_time, end_time, company_id)
                             VALUES ('Essai groupe F','08:00','17:00',$1) RETURNING id`, [j.FATMAT]))[0].id;
  const cible = j.OPERATEUR_TRIANGLE;
  await q(`UPDATE users SET schedule_group_id = NULL, hourly_rate = 1500, daily_rate = 12000, payment_type = 'horaire'
            WHERE id = $1`, [cible]);
  const etat = async () => (await q(
    `SELECT schedule_group_id, hourly_rate::float AS h, daily_rate::float AS d, payment_type FROM users WHERE id = $1`, [cible]))[0];

  // ════════════════════════════════════════════════════════════════════
  section("AFFECTATION HORAIRE (assign-user)");
  {
    const sansJeton = await appel("PUT", `/attendance/assign-user/${cible}`, null, { schedule_group_id: groupeT, hourly_rate: 0 });
    verifier("sans jeton : 401", sansJeton.statut === 401, sansJeton.texte);
    verifier("… et rien n'a changé", (await etat()).h === 1500);

    const sansDroit = await appel("PUT", `/attendance/assign-user/${cible}`, tOpT, { schedule_group_id: groupeT });
    verifier("opérateur sans droit de configurer : refusé", [403, 404].includes(sansDroit.statut), sansDroit.texte);

    const autreSociete = await appel("PUT", `/attendance/assign-user/${cible}`, tAdminF, { schedule_group_id: groupeF });
    verifier("admin FAT & MAT sur un compte Triangle : 404 (comme un inconnu)",
      autreSociete.statut === 404 && autreSociete.corps.code === "USER_NOT_FOUND", autreSociete.texte);
    const inconnu = await appel("PUT", `/attendance/assign-user/987654`, tAdminT, { schedule_group_id: groupeT });
    verifier("… même réponse qu'un compte inexistant", inconnu.statut === 404 && inconnu.corps.error === autreSociete.corps.error);
    verifier("… et rien n'a changé", (await etat()).schedule_group_id === null);

    const groupeEtranger = await appel("PUT", `/attendance/assign-user/${cible}`, tAdminT, { schedule_group_id: groupeF });
    verifier("groupe horaire d'une autre société : 404", groupeEtranger.statut === 404
      && groupeEtranger.corps.code === "SCHEDULE_GROUP_NOT_FOUND", groupeEtranger.texte);

    const typeInvalide = await appel("PUT", `/attendance/assign-user/${cible}`, tAdminT, { payment_type: "'; DROP TABLE users; --" });
    verifier("type de paiement hors liste : 400", typeInvalide.statut === 400 && typeInvalide.corps.code === "PAYMENT_TYPE_INVALID");
    const tauxNegatif = await appel("PUT", `/attendance/assign-user/${cible}`, tAdminT, { hourly_rate: -5 });
    verifier("taux négatif : 400", tauxNegatif.statut === 400 && tauxNegatif.corps.code === "RATE_INVALID");

    const taux = await appel("PUT", `/attendance/assign-user/${cible}`, tConfig, { hourly_rate: 0 });
    verifier("droit de configurer sans droit de paie : le taux est refusé (403)",
      taux.statut === 403 && taux.corps.code === "PERMISSION_DENIED", taux.texte);
    const groupeSeul = await appel("PUT", `/attendance/assign-user/${cible}`, tConfig, { schedule_group_id: groupeT });
    verifier("… mais le groupe horaire seul est accepté", groupeSeul.statut === 200, groupeSeul.texte);
    const e1 = await etat();
    verifier("un champ absent n'est PAS remis à zéro (taux conservés)",
      e1.schedule_group_id === groupeT && e1.h === 1500 && e1.d === 12000 && e1.payment_type === "horaire", JSON.stringify(e1));

    const ok = await appel("PUT", `/attendance/assign-user/${cible}`, tAdminT,
      { schedule_group_id: groupeT, hourly_rate: 1750, payment_type: "journalier" });
    verifier("admin de la société : 200", ok.statut === 200 && ok.corps.success === true, ok.texte);
    verifier("réponse réduite aux champs modifiés",
      JSON.stringify(Object.keys(ok.corps.user || {}).sort())
        === JSON.stringify(["daily_rate", "hourly_rate", "id", "payment_type", "schedule_group_id"]),
      JSON.stringify(Object.keys(ok.corps.user || {})));
    verifier("aucune donnée sensible (mot de passe, courriel)", !SENSIBLE.test(ok.texte), ok.texte);
    const e2 = await etat();
    verifier("valeurs écrites", e2.h === 1750 && e2.d === 12000 && e2.payment_type === "journalier", JSON.stringify(e2));
    const audit = await q(`SELECT user_id, company_id, details FROM audit_logs
                            WHERE action = 'attendance.assign_user' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [cible]);
    verifier("affectation journalisée (auteur, société)", audit[0]?.user_id === j.ADMIN_TRIANGLE
      && audit[0]?.company_id === j.TRIANGLE, JSON.stringify(audit[0]));
  }

  // ════════════════════════════════════════════════════════════════════
  section("ANCIENNES ROUTES DE POINTAGE : RETIRÉES");
  {
    await q(`UPDATE users SET badge_code = 'ESSAI-LEGACY-001' WHERE id = $1`, [cible]);
    const avant = (await q(`SELECT count(*)::int AS n FROM attendance_records WHERE user_id = $1`, [cible]))[0].n;

    const sansJeton = await appel("POST", "/attendance/legacy/scan", null, { badge_code: "ESSAI-LEGACY-001" });
    verifier("ancien scan sans jeton : 401", sansJeton.statut === 401);
    const scan = await appel("POST", "/attendance/legacy/scan", tAdminF, { badge_code: "ESSAI-LEGACY-001", action_type: "checkin" });
    verifier("ancien scan (badge d'une autre société) : 410", scan.statut === 410
      && scan.corps.code === "LEGACY_ATTENDANCE_RETIRED", scan.texte);
    verifier("… sans la moindre donnée de compte", !("user" in scan.corps) && !SENSIBLE.test(scan.texte), scan.texte);
    const scanT = await appel("POST", "/attendance/legacy/scan", tAdminT, { badge_code: "ESSAI-LEGACY-001", action_type: "checkin" });
    verifier("ancien scan dans la bonne société : 410 aussi (code imprimé devinable)", scanT.statut === 410);
    const check = await appel("POST", "/attendance/legacy/check", tAdminT, { user_id: cible, action_type: "checkin" });
    verifier("ancien pointage direct : 410", check.statut === 410 && check.corps.code === "LEGACY_ATTENDANCE_RETIRED");
    const apres = (await q(`SELECT count(*)::int AS n FROM attendance_records WHERE user_id = $1`, [cible]))[0].n;
    verifier("aucune ligne écrite dans l'ancienne table", apres === avant, `${avant} → ${apres}`);
    const trace = await q(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'attendance.legacy_refused'
                            AND created_at > now() - interval '1 minute'`);
    verifier("chaque tentative est journalisée", trace[0].n >= 3, JSON.stringify(trace[0]));
  }

  // ════════════════════════════════════════════════════════════════════
  section("RÉSOLUTION D'UN ANCIEN BADGE IMPRIMÉ");
  {
    const r = await appel("GET", `/scan/resolve/${encodeURIComponent("ESSAI-LEGACY-001")}`, tAdminT);
    verifier("reconnu comme ancien badge, sans pointage proposé", r.statut === 200 && r.corps.type === "employee"
      && r.corps.badge_obsolete === true, r.texte);
    verifier("ni courriel, ni identifiant, ni historique", !("email" in (r.corps.employee || {}))
      && !("id" in (r.corps.employee || {})) && !("history" in r.corps) && !SENSIBLE.test(r.texte), r.texte);
    const parNumero = await appel("GET", `/scan/resolve/${cible}`, tAdminT);
    verifier("un numéro de compte ne résout plus un employé (énumération fermée)",
      parNumero.statut === 404 || parNumero.corps.type !== "employee", parNumero.texte);
    const ailleurs = await appel("GET", `/scan/resolve/${encodeURIComponent("ESSAI-LEGACY-001")}`, tAdminF);
    verifier("depuis une autre société : introuvable", ailleurs.statut === 404 || ailleurs.corps.type !== "employee");
  }

  // ════════════════════════════════════════════════════════════════════
  section("SCAN v2 (badge à jeton aléatoire)");
  {
    const badgeBamako = (await appel("POST", "/attendance-v2/badges", tAdminT, { employee_id: j.bamako })).corps.badge;
    const badgeKati = (await appel("POST", "/attendance-v2/badges", tAdminT, { employee_id: j.kati })).corps.badge;
    const badgeCarriere = (await appel("POST", "/attendance-v2/badges", tAdminF, { employee_id: j.carriere })).corps.badge;
    const jetonDe = async (id) => (await q(`SELECT qr_token FROM attendance_badges WHERE id = $1`, [id]))[0].qr_token;
    const tokBamako = await jetonDe(badgeBamako.id);
    const tokKati = await jetonDe(badgeKati.id);
    const tokCarriere = await jetonDe(badgeCarriere.id);

    const sansJeton = await appel("POST", "/attendance-v2/qr/scan", null, { qr_token: tokBamako });
    verifier("sans jeton de session : 401", sansJeton.statut === 401);
    const inconnu = await appel("POST", "/attendance-v2/qr/scan", tAdminT, { qr_token: "x".repeat(32) });
    verifier("badge inconnu : 404", inconnu.statut === 404 && inconnu.corps.code === "BADGE_NOT_FOR_THIS_COMPANY", inconnu.texte);
    const etranger = await appel("POST", "/attendance-v2/qr/scan", tAdminT, { qr_token: tokCarriere });
    verifier("badge FAT & MAT scanné chez Triangle : refusé du même message qu'un inconnu",
      etranger.statut === 404 && etranger.corps.error === inconnu.corps.error, etranger.texte);
    const imprime = await appel("POST", "/attendance-v2/qr/scan", tAdminT, { qr_token: badgeBamako.badge_code });
    verifier("le code imprimé (prévisible) ne vaut pas pointage", imprime.statut === 404, imprime.texte);

    const ok = await appel("POST", "/attendance-v2/qr/scan", tOpT, { qr_token: tokBamako });
    verifier("badge valide, opérateur du site : arrivée enregistrée", ok.statut === 200 && ok.corps.action === "CHECK_IN", ok.texte);
    verifier("réponse sans jeton, mot de passe ni courriel", !SENSIBLE.test(ok.texte), ok.texte);
    verifier("l'employé n'est décrit que par nom, matricule, badge, poste",
      JSON.stringify(Object.keys(ok.corps.employe || {}).sort()) === JSON.stringify(["badge", "id", "matricule", "nom", "poste"]));

    const double = await appel("POST", "/attendance-v2/qr/scan", tOpT, { qr_token: tokBamako });
    verifier("double lecture immédiate : répétition, pas d'erreur", double.statut === 200 && double.corps.repetition === true, double.texte);
    const evts = await q(`SELECT source FROM attendance_event_log_v2 WHERE employee_id = $1`, [j.bamako]);
    verifier("… un seul événement écrit, source QR", evts.length === 1 && evts[0].source === "QR", JSON.stringify(evts));

    const desordre = await appel("POST", "/attendance-v2/qr/scan", tAdminT, { qr_token: tokKati, action_type: "BREAK_OUT" });
    verifier("ordre : une pause avant l'arrivée est refusée", desordre.statut === 409
      && desordre.corps.code === "ATTENDANCE_SEQUENCE_INVALID", desordre.texte);
    const horsPerimetre = await appel("POST", "/attendance-v2/qr/scan", tOpT, { qr_token: tokKati });
    verifier("opérateur de Bamako sur un employé de Kati : 403", horsPerimetre.statut === 403
      && horsPerimetre.corps.code === "ATTENDANCE_SCOPE_DENIED", horsPerimetre.texte);
    const refus = await q(`SELECT count(*)::int AS n FROM attendance_qr_scans WHERE NOT accepted AND company_id = $1`, [j.TRIANGLE]);
    verifier("les refus sont tracés", refus[0].n >= 3, JSON.stringify(refus[0]));
  }

  // ════════════════════════════════════════════════════════════════════
  section("DÉBIT LIMITÉ");
  {
    const limite = Number(process.env.ATTENDANCE_SCAN_RATE_LIMIT || 60);
    let trop = 0;
    for (let i = 0; i < limite + 5; i += 1) {
      const r = await appel("POST", "/attendance/legacy/scan", tAdminT, { badge_code: `RAFALE-${i}` });
      if (r.statut === 429) trop += 1;
    }
    verifier(`au-delà de ${limite} lectures par minute : 429`, trop >= 1, `${trop} refus`);
  }

  console.log(`\n${G}BILAN${Z}\n  ${reussis} réussis, ${echoues} échoués`);
  await pool.end();
  process.exit(echoues ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await pool.end().catch(() => {});
  process.exit(1);
});

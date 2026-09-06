"use strict";

/**
 * TROIS CONTOURNEMENTS DU MOTEUR DE DROITS (migration 089).
 *
 *   bash scripts/test-rbac-contournements.sh
 *
 * 1. LE RÔLE NE CONTOURNE PLUS LES DROITS.
 *    `canManagePayroll()` accordait la paie à quiconque portait le rôle
 *    « comptable », avant même de regarder les permissions. Un administrateur
 *    posait DENY sur `paie|pay`, le bouton disparaissait de l'écran — et le
 *    comptable payait quand même en appelant la route directement. Le refus
 *    n'existait qu'à l'écran.
 *
 * 2. UN COMPTE HABILITÉ EST ADMINISTRABLE LÀ OÙ IL TRAVAILLE.
 *    L'écran des droits ne listait que les comptes dont la société d'ORIGINE
 *    était la société active. Le comptable et le directeur des deux sociétés,
 *    d'origine Triangle, étaient donc invisibles dans les droits FAT & MAT —
 *    et on ne configure pas les droits de quelqu'un qu'on ne voit pas.
 *
 * 3. UNE PERMISSION HISTORIQUE NE TRAVERSE PAS UNE SOCIÉTÉ.
 *    `user_permissions` est antérieure au multi-sociétés : elle porte un
 *    `user_id`, mais aucun `company_id`. Une ligne y disait « ce compte
 *    pouvait faire ceci », sans dire où — et l'emportait donc partout.
 */

const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

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

const pool = new Pool({ connectionString: URL_BASE });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const jeton = (id, role, companyId, superAdmin = false) =>
  jwt.sign({ id, fullname: `Compte ${id}`, email: `c${id}@essai.test`, role,
             company_id: companyId, is_super_admin: superAdmin }, SECRET, { expiresIn: "3h" });

async function appel(methode, chemin, token, corps, societe) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(societe ? { "x-active-company-id": String(societe) } : {}),
    },
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  let json; try { json = JSON.parse(texte); } catch { json = { brut: texte }; }
  return { statut: r.status, corps: json };
}

const TRIANGLE = 1, FATMAT = 2;
const PERIODE = "2026-06";
let SUPER = 0, FOFANA = 0, DIALLO = 0, DIRECTEUR = 0, RESP = 0, ANCIEN = 0;
let siteId = 0, scheduleId = 0, employeA = 0, caisseId = 0;

const droit = (companyId, userId, module, action, effet) => pool.query(
  `INSERT INTO user_permission_overrides (company_id, user_id, module_key, action, effect)
   VALUES ($1,$2,$3,$4,$5)
   ON CONFLICT (company_id, user_id, module_key, action) DO UPDATE SET effect = EXCLUDED.effect`,
  [companyId, userId, module, action, effet]);

const retirerDroit = (companyId, userId, module, action) => pool.query(
  `DELETE FROM user_permission_overrides
    WHERE company_id=$1 AND user_id=$2 AND module_key=$3 AND action=$4`,
  [companyId, userId, module, action]);

async function poserLeJeu() {
  await pool.query(`DELETE FROM user_company_access_log WHERE reason LIKE 'ESSAI089%'`);
  await pool.query(`DELETE FROM user_company_access WHERE reason LIKE 'ESSAI089%'`);
  await pool.query(`DELETE FROM salary_advance_repayments`);
  await pool.query(`DELETE FROM salary_advance_installments`);
  await pool.query(`DELETE FROM salary_advances`);
  await pool.query(`DELETE FROM payroll_vouchers`);
  await pool.query(`DELETE FROM payroll_item_adjustments`);
  await pool.query(`DELETE FROM payroll_requests`);
  await pool.query(`DELETE FROM attendance_payroll_items_v2`);
  await pool.query(`DELETE FROM attendance_payroll_runs_v2`);
  await pool.query(`DELETE FROM attendance_periods WHERE company_id = $1`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_salary_settings_v2`);
  await pool.query(`DELETE FROM attendance_event_log_v2`);
  await pool.query(`DELETE FROM attendance_day_records_v2`);
  await pool.query(`DELETE FROM attendance_employees WHERE company_id = $1`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_schedule_days WHERE schedule_id IN
      (SELECT id FROM attendance_work_schedules WHERE company_id=$1 AND code='ESSAI-089')`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_work_schedules WHERE company_id=$1 AND code='ESSAI-089'`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_work_sites WHERE company_id=$1 AND code='ESSAI-089'`, [TRIANGLE]);
  await pool.query(`DELETE FROM caisses WHERE company_id=$1 AND nom_caisse='Caisse Essai 089'`, [TRIANGLE]);
  await pool.query(`DELETE FROM user_permissions WHERE user_id IN
      (SELECT id FROM users WHERE email LIKE 'cont089-%@essai.test')`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'cont089-%@essai.test'`);

  const creer = async (email, nom, role, companyId, superAdmin = false) => (await pool.query(
    `INSERT INTO users (company_id, fullname, email, password, role, is_super_admin, is_active)
     VALUES ($1,$2,$3,'$non-utilisable$',$4,$5,true) RETURNING id`,
    [companyId, nom, email, role, superAdmin])).rows[0].id;

  SUPER     = await creer("cont089-super@essai.test", "Essai 089 Super", "super_admin", TRIANGLE, true);
  /* Le comptable des deux sociétés : origine Triangle, habilité FAT & MAT. */
  FOFANA    = await creer("cont089-comptable@essai.test", "Essai 089 Comptable deux sociétés", "comptable", TRIANGLE);
  DIALLO    = await creer("cont089-directeur2s@essai.test", "Essai 089 Directeur deux sociétés", "direction", TRIANGLE);
  DIRECTEUR = await creer("cont089-directeur@essai.test", "Essai 089 Directeur Triangle", "direction", TRIANGLE);
  RESP      = await creer("cont089-resp@essai.test", "Essai 089 Responsable", "responsable_entrepot");
  /* Un compte qui ne tient ses droits QUE de l'ancienne table. */
  ANCIEN    = await creer("cont089-ancien@essai.test", "Essai 089 Ancien modèle", "employe", TRIANGLE);

  await pool.query(
    `INSERT INTO attendance_company_configuration
       (company_id, official_start_at, timezone, saturday_mode, period_start_day)
     VALUES ($1, '2026-01-01'::timestamptz, 'Africa/Bamako', 'NORMAL', 25)
     ON CONFLICT (company_id) DO UPDATE SET official_start_at = '2026-01-01'::timestamptz`, [TRIANGLE]);

  siteId = (await pool.query(
    `INSERT INTO attendance_work_sites (company_id, code, name, city, site_type, active)
     VALUES ($1,'ESSAI-089','Essai Site 089','Bamako','WAREHOUSE',true) RETURNING id`, [TRIANGLE])).rows[0].id;
  scheduleId = (await pool.query(
    `INSERT INTO attendance_work_schedules (company_id, code, name, active)
     VALUES ($1,'ESSAI-089','Journée 08:00',true) RETURNING id`, [TRIANGLE])).rows[0].id;
  for (let j = 1; j <= 7; j += 1) {
    await pool.query(
      `INSERT INTO attendance_schedule_days (schedule_id, iso_weekday, is_working_day, start_time, end_time)
       VALUES ($1,$2,true,'08:00','17:00')`, [scheduleId, j]);
  }
  employeA = (await pool.query(
    `INSERT INTO attendance_employees
       (company_id, employee_number, full_name, site_id, schedule_id, job_title, phone, active, effective_from)
     VALUES ($1,8901,'Essai 089 Employé',$2,$3,'Manœuvre','',true,'2026-01-01') RETURNING id`,
    [TRIANGLE, siteId, scheduleId])).rows[0].id;
  await pool.query(
    `INSERT INTO attendance_salary_settings_v2 (company_id, employee_id, monthly_salary, daily_rate, effective_from)
     VALUES ($1,$2,100000,0,'2026-01-01')`, [TRIANGLE, employeA]);

  caisseId = (await pool.query(
    `INSERT INTO caisses (company_id, nom_caisse, solde_initial, solde_actuel, actif)
     VALUES ($1,'Caisse Essai 089',5000000,5000000,true) RETURNING id`, [TRIANGLE])).rows[0].id;

  await pool.query(`DELETE FROM user_permission_overrides WHERE user_id = ANY($1::int[])`,
    [[FOFANA, DIALLO, DIRECTEUR, RESP, ANCIEN]]);

  /* Le comptable a tout ce qu'il faut chez Triangle — sauf que l'on va lui
     retirer `pay` pour éprouver le DENY. */
  for (const a of ["visible","view","prepare","submit","pay","print"]) await droit(TRIANGLE, FOFANA, "paie", a, "ALLOW");
  for (const a of ["visible","view","validate","adjust"]) await droit(TRIANGLE, DIRECTEUR, "paie", a, "ALLOW");
  for (const a of ["visible","view","create","validate","close"]) await droit(TRIANGLE, RESP, "pointage.periode", a, "ALLOW");
}

const soldeCaisse = async () =>
  Number((await q(`SELECT solde_actuel FROM caisses WHERE id=$1`, [caisseId]))[0].solde_actuel);

async function main() {
  console.log(`\n${G}TROIS CONTOURNEMENTS DU MOTEUR DE DROITS (089)${Z}`);
  await poserLeJeu();
  const tSuper = jeton(SUPER, "super_admin", TRIANGLE, true);
  const tFofana = jeton(FOFANA, "comptable", TRIANGLE);
  const tDiallo = jeton(DIALLO, "direction", TRIANGLE);
  const tDirecteur = jeton(DIRECTEUR, "direction", TRIANGLE);
  const tResp = jeton(RESP, "responsable_entrepot", TRIANGLE);
  const tAncien = jeton(ANCIEN, "employe", TRIANGLE);

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}C. paie|prepare EN DENY → GÉNÉRATION REFUSÉE${Z}`);
  {
    await droit(TRIANGLE, FOFANA, "paie", "prepare", "DENY");
    const r = await appel("POST", `/attendance-v2/payroll/${PERIODE}/generate`, tFofana, {}, TRIANGLE);
    verifier("l'ancienne route de génération est refusée",
      r.statut === 403 || r.statut === 404, `${r.statut} ${r.corps.code || ""}`);

    const p = await appel("POST", `/paie/periodes/${PERIODE}/preparer`, tFofana, {}, TRIANGLE);
    verifier("la nouvelle route de préparation aussi",
      p.statut === 403 || p.statut === 404, `${p.statut} ${p.corps.code || ""}`);

    const [paies] = await q(
      `SELECT count(*)::int AS n FROM attendance_payroll_runs_v2 WHERE company_id=$1`, [TRIANGLE]);
    verifier("aucune paie n'a été créée", paies.n === 0, `${paies.n}`);

    await droit(TRIANGLE, FOFANA, "paie", "prepare", "ALLOW");
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}D. SANS paie|view → AUCUN SALAIRE DANS LA RÉPONSE${Z}`);
  {
    const r = await appel("GET", `/attendance-v2/payroll?month=${PERIODE}`, tAncien, undefined, TRIANGLE);
    verifier("la consultation des salaires est refusée",
      r.statut === 403 || r.statut === 404, `${r.statut} ${r.corps.code || ""}`);
    verifier("la réponse ne contient aucun salaire",
      !r.corps.items && !r.corps.employees, JSON.stringify(r.corps).slice(0, 120));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LA PAIE EST PRÉPARÉE, SOUMISE ET VALIDÉE${Z}`);
  let ligneA = 0;
  {
    await appel("POST", `/paie/periodes/${PERIODE}/ouvrir`, tResp, undefined, TRIANGLE);
    await appel("POST", `/paie/periodes/${PERIODE}/valider-pointage`, tResp, undefined, TRIANGLE);
    const prep = await appel("POST", `/paie/periodes/${PERIODE}/preparer`, tFofana, {}, TRIANGLE);
    verifier("la préparation réussit une fois le droit rendu", prep.statut === 201,
      JSON.stringify(prep.corps).slice(0, 150));

    const runId = prep.corps.paie?.id;
    const lignes = await q(
      `SELECT id FROM attendance_payroll_items_v2 WHERE payroll_run_id=$1`, [runId]);
    ligneA = lignes[0]?.id;

    await appel("POST", `/paie/runs/${runId}/soumettre`, tFofana, {}, TRIANGLE);
    const d = await appel("POST", `/paie/runs/${runId}/decision`, tDirecteur, { decision: "VALIDEE" }, TRIANGLE);
    verifier("la Direction autorise le paiement", d.statut === 200, JSON.stringify(d.corps).slice(0, 120));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}A. paie|pay EN DENY → L'API REFUSE, MALGRÉ LE RÔLE COMPTABLE${Z}`);
  {
    await droit(TRIANGLE, FOFANA, "paie", "pay", "DENY");

    const avant = await soldeCaisse();
    const r = await appel("POST", `/attendance-v2/payroll-items/${ligneA}/pay`, tFofana,
      { payment_method: "CASHBOX", caisse_id: caisseId }, TRIANGLE);

    verifier("le paiement est refusé par le moteur de droits",
      r.statut === 403 || r.statut === 404, `${r.statut} ${JSON.stringify(r.corps).slice(0, 140)}`);
    verifier("le refus ne vient PAS d'une règle métier — la paie était autorisée",
      r.corps.code !== "PAYROLL_NOT_AUTHORIZED" && r.corps.code !== "PAYROLL_NOT_SUBMITTED",
      String(r.corps.code));
    verifier("la caisse n'a pas bougé", (await soldeCaisse()) === avant, `${avant}`);

    const [ligne] = await q(`SELECT status FROM attendance_payroll_items_v2 WHERE id=$1`, [ligneA]);
    verifier("le salaire reste à payer", ligne.status === "TO_PAY", ligne.status);

    /* La contre-épreuve : le rôle est bien « comptable », et c'est exactement
       ce qui suffisait auparavant à passer. */
    const [compte] = await q(`SELECT role FROM users WHERE id=$1`, [FOFANA]);
    verifier("et pourtant son rôle EST comptable", compte.role === "comptable", compte.role);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}B. APRÈS ALLOW → LE PAIEMENT PASSE${Z}`);
  {
    await droit(TRIANGLE, FOFANA, "paie", "pay", "ALLOW");
    const avant = await soldeCaisse();
    const r = await appel("POST", `/attendance-v2/payroll-items/${ligneA}/pay`, tFofana,
      { payment_method: "CASHBOX", caisse_id: caisseId, payment_reference: "ESSAI-089" }, TRIANGLE);
    verifier("le paiement passe une fois le droit rendu",
      r.statut === 200 && r.corps.item?.status === "PAID", JSON.stringify(r.corps).slice(0, 160));
    verifier("la caisse a diminué", (await soldeCaisse()) < avant);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}UN COMPTE HABILITÉ EST ADMINISTRABLE DANS LA SOCIÉTÉ D'ACCUEIL${Z}`);
  {
    for (const [id, nom] of [[FOFANA, "comptable"], [DIALLO, "directeur"]]) {
      const r = await appel("POST", "/acces-societes", tSuper,
        { user_id: id, company_id: FATMAT, reason: `ESSAI089 ${nom} des deux sociétés` }, TRIANGLE);
      verifier(`le ${nom} est habilité sur FAT & MAT`, r.statut === 201, JSON.stringify(r.corps).slice(0, 110));
    }

    // A. il apparaît dans les DEUX sociétés
    const chezTriangle = await appel("GET", "/permissions/users", tSuper, undefined, TRIANGLE);
    const chezFatmat   = await appel("GET", "/permissions/users", tSuper, undefined, FATMAT);
    const dansT = (chezTriangle.corps.users || []).find((u) => u.id === FOFANA);
    const dansF = (chezFatmat.corps.users || []).find((u) => u.id === FOFANA);
    verifier("le comptable apparaît dans les droits Triangle", Boolean(dansT),
      `${(chezTriangle.corps.users || []).length} comptes`);
    verifier("et dans les droits FAT & MAT, où il n'a pourtant pas son origine",
      Boolean(dansF), `${(chezFatmat.corps.users || []).length} comptes`);
    verifier("l'écran distingue la société d'origine de l'accès secondaire",
      dansT?.societe_origine === true && dansF?.societe_origine === false,
      JSON.stringify({ triangle: dansT?.societe_origine, fatmat: dansF?.societe_origine }));

    // On ne montre jamais un compte sans rattachement
    const inconnuChezFatmat = (chezFatmat.corps.users || []).find((u) => u.id === DIRECTEUR);
    verifier("un compte Triangle NON habilité reste invisible chez FAT & MAT",
      !inconnuChezFatmat, JSON.stringify((chezFatmat.corps.users || []).map((u) => u.id)));

    // B et C. des overrides différents de chaque côté, sans contamination
    /* La route attend un tableau `changes` : c'est ainsi que l'écran envoie
       plusieurs cases cochées d'un coup. */
    const poser = (societe, effet) => appel("PUT", `/permissions/users/${FOFANA}`, tSuper,
      { changes: [{ module_key: "acompte_client", action: "view", effect: effet }] }, societe);

    const rT = await poser(TRIANGLE, "ALLOW");
    verifier("on configure ses droits chez Triangle", rT.statut === 200 || rT.statut === 201,
      `${rT.statut} ${JSON.stringify(rT.corps).slice(0, 100)}`);
    const rF = await poser(FATMAT, "DENY");
    verifier("et différemment chez FAT & MAT", rF.statut === 200 || rF.statut === 201,
      `${rF.statut} ${JSON.stringify(rF.corps).slice(0, 100)}`);

    const overrides = await q(
      `SELECT company_id, effect FROM user_permission_overrides
        WHERE user_id=$1 AND module_key='acompte_client' AND action='view'
        ORDER BY company_id`, [FOFANA]);
    verifier("deux exceptions distinctes coexistent, une par société",
      overrides.length === 2
      && overrides.find((o) => o.company_id === TRIANGLE)?.effect === "ALLOW"
      && overrides.find((o) => o.company_id === FATMAT)?.effect === "DENY",
      JSON.stringify(overrides));

    const fiche = await appel("GET", `/permissions/users/${FOFANA}`, tSuper, undefined, FATMAT);
    verifier("la fiche FAT & MAT ne montre que les exceptions de FAT & MAT",
      (fiche.corps.overrides || []).every((o) => Number(o.company_id ?? FATMAT) === FATMAT)
      && (fiche.corps.overrides || []).some((o) => o.module_key === "acompte_client" && o.effect === "DENY"),
      JSON.stringify((fiche.corps.overrides || []).slice(0, 3)));

    // D. après révocation, il disparaît
    const revoque = await appel("DELETE", `/acces-societes/${FOFANA}/${FATMAT}`, tSuper,
      { reason: "ESSAI089 fin de mission" }, TRIANGLE);
    verifier("l'habilitation est révoquée", revoque.statut === 200, JSON.stringify(revoque.corps));

    const apres = await appel("GET", "/permissions/users", tSuper, undefined, FATMAT);
    verifier("il disparaît immédiatement des droits FAT & MAT",
      !(apres.corps.users || []).find((u) => u.id === FOFANA),
      JSON.stringify((apres.corps.users || []).map((u) => u.id)));

    const fermee = await appel("GET", `/permissions/users/${FOFANA}`, tSuper, undefined, FATMAT);
    verifier("et sa fiche n'y est plus consultable", fermee.statut === 404, `statut ${fermee.statut}`);

    const toujoursT = await appel("GET", "/permissions/users", tSuper, undefined, TRIANGLE);
    verifier("mais il reste dans les droits Triangle",
      Boolean((toujoursT.corps.users || []).find((u) => u.id === FOFANA)));

    const [origine] = await q(`SELECT company_id FROM users WHERE id=$1`, [FOFANA]);
    verifier("sa société d'origine n'a jamais été réécrite",
      Number(origine.company_id) === TRIANGLE, String(origine.company_id));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}UNE PERMISSION HISTORIQUE NE TRAVERSE PAS UNE SOCIÉTÉ${Z}`);
  {
    /* L'ancienne table ne porte pas de company_id : une ligne y dit « ce
       compte pouvait faire ceci », sans dire où. */
    await pool.query(
      `INSERT INTO user_permissions (user_id, module_key, can_view, can_create, can_edit, can_delete, can_validate)
       VALUES ($1,'comptabilite',true,true,true,false,true)
       ON CONFLICT DO NOTHING`, [ANCIEN]);

    const habilite = await appel("POST", "/acces-societes", tSuper,
      { user_id: ANCIEN, company_id: FATMAT, reason: "ESSAI089 compte ancien modèle" }, TRIANGLE);
    verifier("le compte est habilité sur FAT & MAT", habilite.statut === 201,
      JSON.stringify(habilite.corps).slice(0, 110));

    const chezTriangle = await appel("GET", "/permissions/me", tAncien, undefined, TRIANGLE);
    verifier("chez Triangle — sa société d'ORIGINE — l'ancienne permission vaut encore",
      chezTriangle.corps.permissions?.comptabilite?.view === true,
      JSON.stringify(chezTriangle.corps.permissions?.comptabilite));

    const chezFatmat = await appel("GET", "/permissions/me", tAncien, undefined, FATMAT);
    verifier("chez FAT & MAT, elle ne donne AUCUN droit",
      chezFatmat.corps.permissions?.comptabilite?.view !== true,
      JSON.stringify(chezFatmat.corps.permissions?.comptabilite));

    /* Un ALLOW moderne posé chez FAT & MAT autorise ensuite l'action. */
    await droit(FATMAT, ANCIEN, "comptabilite", "visible", "ALLOW");
    await droit(FATMAT, ANCIEN, "comptabilite", "view", "ALLOW");
    const avecAllow = await appel("GET", "/permissions/me", tAncien, undefined, FATMAT);
    verifier("un ALLOW moderne FAT & MAT l'autorise",
      avecAllow.corps.permissions?.comptabilite?.view === true,
      JSON.stringify(avecAllow.corps.permissions?.comptabilite));

    /* Et un DENY moderne la refuse toujours, ancienne permission ou non. */
    await droit(FATMAT, ANCIEN, "comptabilite", "view", "DENY");
    const avecDeny = await appel("GET", "/permissions/me", tAncien, undefined, FATMAT);
    verifier("un DENY moderne FAT & MAT la refuse",
      avecDeny.corps.permissions?.comptabilite?.view === false,
      JSON.stringify(avecDeny.corps.permissions?.comptabilite));

    /* Chez Triangle, un DENY moderne l'emporte aussi sur l'ancienne ligne :
       l'exception personnelle passe avant le repli historique. */
    await droit(TRIANGLE, ANCIEN, "comptabilite", "view", "DENY");
    const triangleDeny = await appel("GET", "/permissions/me", tAncien, undefined, TRIANGLE);
    verifier("chez Triangle, un DENY moderne l'emporte sur l'ancienne permission",
      triangleDeny.corps.permissions?.comptabilite?.view === false,
      JSON.stringify(triangleDeny.corps.permissions?.comptabilite));
  }

  await pool.query(`DELETE FROM user_company_access_log WHERE reason LIKE 'ESSAI089%'`);
  await pool.query(`DELETE FROM user_company_access WHERE reason LIKE 'ESSAI089%'`);

  console.log(`\n${G}BILAN${Z}`);
  console.log(`  ${reussis} réussis, ${echoues} échoués\n`);
  await pool.end();
  process.exit(echoues > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`${R}ÉCHEC : ${e.message}${Z}`); console.error(e.stack);
  await pool.end().catch(() => {});
  process.exit(1);
});

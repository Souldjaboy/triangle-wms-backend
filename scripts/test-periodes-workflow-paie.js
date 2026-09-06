"use strict";

/**
 * PÉRIODES 25→24 ET WORKFLOW DE PAIE (migration 081).
 *
 *   bash scripts/test-periodes-workflow-paie.sh
 *
 * Ce que la suite prouve :
 *
 *   PÉRIODES     la paie de septembre couvre bien le 25/08 → 24/09 ; les
 *                périodes s'enchaînent sans trou ; deux périodes qui se
 *                recouvrent sont REFUSÉES PAR LA BASE, pas par le code ;
 *   CALENDRIER   dimanche jamais attendu, samedi selon le réglage, jour
 *                férié pas compté comme dû ;
 *   WORKFLOW     préparer → soumettre → Direction → autorisé → payer ;
 *   SÉPARATION   le comptable ne valide pas sa propre demande, même si on
 *                lui accorde le droit de valider ;
 *   BLOCAGE      payer sans validation est refusé ; payer après refus aussi ;
 *   AJUSTEMENT   la Direction corrige un montant, avant/après conservé ;
 *   BON          numéroté par société, figé, une seule émission, réimpression
 *                comptée ;
 *   CLÔTURE      impossible tant qu'un salaire reste à payer.
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
  jwt.sign({ id, fullname: `Compte ${id}`, email: `p${id}@essai.test`, role,
             company_id: companyId, is_super_admin: superAdmin }, SECRET, { expiresIn: "3h" });

async function appel(methode, chemin, token, corps) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  let json; try { json = JSON.parse(texte); } catch { json = { brut: texte }; }
  return { statut: r.status, corps: json };
}

const TRIANGLE = 1;
let COMPTABLE = 0, DIRECTEUR = 0, RESPONSABLE = 0, AUTRE_DIRECTEUR = 0;
let siteId = 0, scheduleId = 0, employeA = 0, employeB = 0;

async function poserLeJeu() {
  await pool.query(`DELETE FROM payroll_vouchers`);
  await pool.query(`DELETE FROM payroll_item_adjustments`);
  await pool.query(`DELETE FROM payroll_requests`);
  await pool.query(`DELETE FROM attendance_payroll_items_v2`);
  await pool.query(`DELETE FROM attendance_payroll_runs_v2`);
  await pool.query(`DELETE FROM attendance_periods WHERE company_id = $1`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_holidays WHERE company_id = $1`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_salary_settings_v2`);
  await pool.query(`DELETE FROM attendance_event_log_v2`);
  await pool.query(`DELETE FROM attendance_day_records_v2`);
  await pool.query(`DELETE FROM attendance_qr_scans`);
  await pool.query(`DELETE FROM attendance_badge_events`);
  await pool.query(`DELETE FROM attendance_badges`);
  await pool.query(`DELETE FROM attendance_operator_scopes`);
  /* Les avances référencent les employés : les effacer d'abord, sinon la
       suite échoue sur une clé étrangère alors que rien ne va mal. */
  await pool.query(`DELETE FROM salary_advance_repayments`);
  await pool.query(`DELETE FROM salary_advance_installments`);
  await pool.query(`DELETE FROM salary_advances`);
  await pool.query(`DELETE FROM attendance_employees WHERE company_id = $1`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_schedule_days WHERE schedule_id IN
      (SELECT id FROM attendance_work_schedules WHERE company_id = $1 AND code = 'ESSAI-081')`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_work_schedules WHERE company_id = $1 AND code = 'ESSAI-081'`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_work_sites WHERE company_id = $1 AND code = 'ESSAI-081'`, [TRIANGLE]);
  await pool.query(`DELETE FROM caisses WHERE company_id = $1 AND nom_caisse = 'Caisse Essai 081'`, [TRIANGLE]);
  await pool.query(`DELETE FROM users WHERE email LIKE 'paie081-%@essai.test'`);

  const creer = async (email, nom, role) => (await pool.query(
    `INSERT INTO users (company_id, fullname, email, password, role, is_super_admin, is_active)
     VALUES ($1,$2,$3,'$non-utilisable$',$4,false,true) RETURNING id`,
    [TRIANGLE, nom, email, role])).rows[0].id;

  COMPTABLE       = await creer("paie081-comptable@essai.test", "Essai 081 Comptable", "comptable");
  DIRECTEUR       = await creer("paie081-directeur@essai.test", "Essai 081 Directeur", "direction");
  AUTRE_DIRECTEUR = await creer("paie081-directeur2@essai.test", "Essai 081 Directeur bis", "direction");
  RESPONSABLE     = await creer("paie081-resp@essai.test", "Essai 081 Responsable", "responsable_entrepot");

  await pool.query(
    `INSERT INTO attendance_company_configuration (company_id, official_start_at, timezone, saturday_mode, period_start_day)
     VALUES ($1, now() - interval '400 days', 'Africa/Bamako', 'NORMAL', 25)
     ON CONFLICT (company_id) DO UPDATE
       SET official_start_at = EXCLUDED.official_start_at, saturday_mode = 'NORMAL', period_start_day = 25`,
    [TRIANGLE]);

  const { rows: sites } = await pool.query(
    `INSERT INTO attendance_work_sites (company_id, code, name, city, site_type, active)
     VALUES ($1,'ESSAI-081','Essai Site 081','Bamako','WAREHOUSE',true) RETURNING id`, [TRIANGLE]);
  siteId = sites[0].id;

  const { rows: sch } = await pool.query(
    `INSERT INTO attendance_work_schedules (company_id, code, name, active)
     VALUES ($1,'ESSAI-081','Journée 08:00',true) RETURNING id`, [TRIANGLE]);
  scheduleId = sch[0].id;
  for (let jour = 1; jour <= 7; jour += 1) {
    await pool.query(
      `INSERT INTO attendance_schedule_days (schedule_id, iso_weekday, is_working_day, start_time, end_time)
       VALUES ($1,$2,$3,'08:00','17:00')`, [scheduleId, jour, jour !== 7]);
  }

  const emp = async (numero, nom) => (await pool.query(
    `INSERT INTO attendance_employees
       (company_id, employee_number, full_name, site_id, schedule_id, job_title, phone, active, effective_from)
     VALUES ($1,$2,$3,$4,$5,'Manœuvre','',true, current_date - 400) RETURNING id`,
    [TRIANGLE, numero, nom, siteId, scheduleId])).rows[0].id;
  employeA = await emp(8101, "Essai 081 Employé A");
  employeB = await emp(8102, "Essai 081 Employé B");

  for (const id of [employeA, employeB]) {
    await pool.query(
      `INSERT INTO attendance_salary_settings_v2 (company_id, employee_id, monthly_salary, daily_rate, effective_from)
       VALUES ($1,$2,100000,4000, current_date - 400)`, [TRIANGLE, id]);
  }

  /* Droits accordés nommément, pour ne pas dépendre de la matrice des rôles
     que d'autres suites réécrivent. Ils reproduisent exactement la séparation
     voulue : le comptable prépare/soumet/paie, la Direction valide/ajuste. */
  const droit = (userId, module, action, effet = "ALLOW") => pool.query(
    `INSERT INTO user_permission_overrides (company_id, user_id, module_key, action, effect)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (company_id, user_id, module_key, action) DO UPDATE SET effect = EXCLUDED.effect`,
    [TRIANGLE, userId, module, action, effet]);
  await pool.query(`DELETE FROM user_permission_overrides WHERE company_id = $1 AND user_id = ANY($2::int[])`,
    [TRIANGLE, [COMPTABLE, DIRECTEUR, AUTRE_DIRECTEUR, RESPONSABLE]]);

  for (const a of ["visible", "view", "prepare", "submit", "pay", "print"]) await droit(COMPTABLE, "paie", a);
  for (const d of [DIRECTEUR, AUTRE_DIRECTEUR]) {
    for (const a of ["visible", "view", "validate", "adjust", "print"]) await droit(d, "paie", a);
  }

  /* Les REFUS sont posés explicitement, en DENY, plutôt que laissés à la
     matrice des rôles. Deux raisons :

       • `direction` figure dans ROLES_ADMIN : sans ligne de rôle, le moteur
         retombe sur « repli_role » et lui accorde tout. Or d'autres suites
         régénèrent `role_permissions` en fonction des seuls comptes présents
         en base, effaçant les lignes posées par la migration 081 — la
         séparation dépendrait alors de l'ordre d'exécution des suites ;

       • c'est le chemin « exception personnelle DENY » du RBAC, qui doit être
         éprouvé pour de vrai et pas seulement supposé.

     Ce que ces DENY expriment est exactement ce que dit la migration 081 : le
     comptable prépare, soumet et paie ; la Direction valide et ajuste. */
  for (const d of [DIRECTEUR, AUTRE_DIRECTEUR]) {
    for (const a of ["prepare", "submit", "pay"]) await droit(d, "paie", a, "DENY");
  }
  for (const a of ["validate", "adjust"]) await droit(COMPTABLE, "paie", a, "DENY");
  for (const a of ["visible", "view", "create", "validate", "close", "reopen"]) {
    await droit(RESPONSABLE, "pointage.periode", a);
    await droit(COMPTABLE, "pointage.periode", a === "validate" ? "view" : a);
  }
}

async function main() {
  console.log(`\n${G}PÉRIODES 25→24 ET WORKFLOW DE PAIE (081)${Z}`);
  await poserLeJeu();

  const tComptable = jeton(COMPTABLE, "comptable", TRIANGLE);
  const tDirecteur = jeton(DIRECTEUR, "direction", TRIANGLE);
  const tDirecteur2 = jeton(AUTRE_DIRECTEUR, "direction", TRIANGLE);
  const tResp = jeton(RESPONSABLE, "responsable_entrepot", TRIANGLE);

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LA PÉRIODE VA DU 25 AU 24${Z}`);
  {
    const r = await appel("POST", "/paie/periodes/2026-09/ouvrir", tResp);
    verifier("la période 2026-09 s'ouvre", r.statut === 201, JSON.stringify(r.corps));
    verifier("elle commence le 25 août", r.corps.periode?.debut === "2026-08-25", r.corps.periode?.debut);
    verifier("elle finit le 24 septembre", r.corps.periode?.fin === "2026-09-24", r.corps.periode?.fin);
    verifier("elle naît OUVERTE", r.corps.periode?.status === "OUVERTE", r.corps.periode?.status);

    /* Janvier : le passage d'année ne doit pas produire un mois 13. */
    const janvier = await appel("POST", "/paie/periodes/2027-01/ouvrir", tResp);
    verifier("la période de janvier 2027 commence le 25 décembre 2026",
      janvier.corps.periode?.debut === "2026-12-25", janvier.corps.periode?.debut);

    const toutes = await q(
      `SELECT code, date_debut::text AS d, date_fin::text AS f FROM attendance_periods
        WHERE company_id = $1 ORDER BY date_debut`, [TRIANGLE]);
    verifier("les mois intermédiaires ont été créés, sans trou",
      toutes.map((p) => p.code).join(",") === "2026-09,2026-10,2026-11,2026-12,2027-01",
      toutes.map((p) => p.code).join(","));

    let sansTrou = true;
    for (let i = 1; i < toutes.length; i += 1) {
      const finPrecedente = new Date(`${toutes[i - 1].f}T00:00:00Z`);
      const debut = new Date(`${toutes[i].d}T00:00:00Z`);
      if ((debut - finPrecedente) / 86_400_000 !== 1) sansTrou = false;
    }
    verifier("chaque période commence le lendemain de la précédente", sansTrou,
      JSON.stringify(toutes.map((p) => `${p.d}→${p.f}`)));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LA BASE REFUSE DEUX PÉRIODES QUI SE RECOUVRENT${Z}`);
  {
    /* On force l'insertion en base, sans passer par le code : c'est bien la
       CONTRAINTE qu'on éprouve, pas la prudence de l'application. */
    let erreur = null;
    try {
      await pool.query(
        `INSERT INTO attendance_periods (company_id, code, date_debut, date_fin)
         VALUES ($1,'CHEVAUCHE','2026-09-01','2026-09-30')`, [TRIANGLE]);
    } catch (e) { erreur = e; }
    verifier("une période qui chevauche une autre est refusée par PostgreSQL",
      Boolean(erreur) && erreur.code === "23P01",
      erreur ? `${erreur.code}` : "ACCEPTÉE À TORT — deux paies pourraient payer les mêmes journées");

    let jointive = null;
    try {
      await pool.query(
        `INSERT INTO attendance_periods (company_id, code, date_debut, date_fin)
         VALUES ($1,'2026-08','2026-07-25','2026-08-24')`, [TRIANGLE]);
    } catch (e) { jointive = e; }
    verifier("une période JOINTIVE (qui finit la veille) est acceptée",
      !jointive, jointive ? `${jointive.code} ${jointive.message}` : "");
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LE CALENDRIER : DIMANCHE, SAMEDI, JOURS FÉRIÉS${Z}`);
  {
    const P = require("../services/attendance-periodes");
    const client = await pool.connect();
    try {
      const employe = { schedule_id: scheduleId };
      /* Une semaine pleine, lundi 2026-08-31 → dimanche 2026-09-06. */
      const normal = await P.joursAttendus(client, TRIANGLE, employe, "2026-08-31", "2026-09-06");
      verifier("samedi NORMAL : six jours attendus sur la semaine, jamais le dimanche",
        normal === 6, `${normal}`);

      await pool.query(
        `UPDATE attendance_company_configuration SET saturday_mode = 'NON_TRAVAILLE' WHERE company_id = $1`,
        [TRIANGLE]);
      const sansSamedi = await P.joursAttendus(client, TRIANGLE, employe, "2026-08-31", "2026-09-06");
      verifier("samedi NON_TRAVAILLE : cinq jours attendus", sansSamedi === 5, `${sansSamedi}`);

      await pool.query(
        `UPDATE attendance_company_configuration SET saturday_mode = 'NORMAL' WHERE company_id = $1`,
        [TRIANGLE]);
      await pool.query(
        `INSERT INTO attendance_holidays (company_id, holiday_date, label)
         VALUES ($1,'2026-09-22','Fête de l''Indépendance')`, [TRIANGLE]);
      const avecFerie = await P.joursAttendus(client, TRIANGLE, employe, "2026-09-21", "2026-09-24");
      verifier("un jour férié n'est pas un jour attendu (donc pas une absence)",
        avecFerie === 3, `${avecFerie} au lieu de 4 sans férié`);
    } finally { client.release(); }
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}VALIDATION DU POINTAGE${Z}`);
  {
    const parComptable = await appel("POST", "/paie/periodes/2026-09/valider-pointage", tComptable);
    verifier("le comptable ne valide pas le pointage (ce n'est pas son geste)",
      parComptable.statut === 403 || parComptable.statut === 404, `statut ${parComptable.statut}`);

    const r = await appel("POST", "/paie/periodes/2026-09/valider-pointage", tResp);
    verifier("le responsable valide le pointage de la période",
      r.statut === 200 && r.corps.periode?.status === "POINTAGE_VALIDE", JSON.stringify(r.corps));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}PRÉPARATION ET SOUMISSION${Z}`);
  let runId = 0, ligneA = 0, ligneB = 0;
  {
    /* La préparation passe par la PÉRIODE, comme le fait l'écran. L'ancienne
       route calculait un mois civil et laissait la paie sans période ; ce test
       rattachait alors `period_id` à la main, ce qui ne prouvait rien de ce
       qui se passe en production. C'est la route qui pose le lien. */
    const gen = await appel("POST", "/paie/periodes/2026-09/preparer", tComptable);
    verifier("le comptable prépare la paie sur la période", gen.statut === 201,
      JSON.stringify(gen.corps).slice(0, 200));
    runId = gen.corps.paie?.id;

    const [rattachee] = await q(
      `SELECT period_id FROM attendance_payroll_runs_v2 WHERE id=$1`, [runId]);
    verifier("la période est rattachée par la route elle-même",
      rattachee && rattachee.period_id !== null, JSON.stringify(rattachee));

    const lignes = await q(
      `SELECT id, employee_id, net_salary, status FROM attendance_payroll_items_v2
        WHERE payroll_run_id=$1 ORDER BY employee_id`, [runId]);
    verifier("la paie contient les deux employés", lignes.length === 2, `${lignes.length}`);
    ligneA = lignes[0]?.id; ligneB = lignes[1]?.id;

    const parDirecteur = await appel("POST", `/paie/runs/${runId}/soumettre`, tDirecteur);
    verifier("la Direction ne soumet pas (elle décide)",
      parDirecteur.statut === 403 || parDirecteur.statut === 404, `statut ${parDirecteur.statut}`);

    const r = await appel("POST", `/paie/runs/${runId}/soumettre`, tComptable);
    verifier("le comptable soumet la paie à la Direction", r.statut === 201, JSON.stringify(r.corps));

    const encore = await appel("POST", `/paie/runs/${runId}/soumettre`, tComptable);
    verifier("soumettre deux fois est refusé",
      encore.statut === 409, JSON.stringify(encore.corps));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}PAYER AVANT VALIDATION EST IMPOSSIBLE${Z}`);
  {
    const r = await appel("POST", `/attendance-v2/payroll-items/${ligneA}/pay`, tComptable,
      { payment_method: "CASH" });
    verifier("le paiement est refusé tant que la Direction n'a pas tranché",
      r.statut === 409 && r.corps.code === "PAYROLL_NOT_AUTHORIZED", JSON.stringify(r.corps));
    const [ligne] = await q(`SELECT status FROM attendance_payroll_items_v2 WHERE id=$1`, [ligneA]);
    verifier("le salaire reste à payer", ligne.status === "TO_PAY", ligne.status);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LE COMPTABLE NE VALIDE PAS SA PROPRE DEMANDE${Z}`);
  {
    /* On lui ACCORDE explicitement le droit de valider : la règle ne doit pas
       reposer sur l'absence du droit, mais sur le fait que c'est lui qui a
       soumis. */
    await pool.query(
      `INSERT INTO user_permission_overrides (company_id, user_id, module_key, action, effect)
       VALUES ($1,$2,'paie','validate','ALLOW')
       ON CONFLICT (company_id, user_id, module_key, action) DO UPDATE SET effect='ALLOW'`,
      [TRIANGLE, COMPTABLE]);

    const r = await appel("POST", `/paie/runs/${runId}/decision`, tComptable,
      { decision: "VALIDEE" });
    verifier("même avec le droit de valider, il ne valide pas ce qu'il a soumis",
      r.statut === 403 && r.corps.code === "SELF_APPROVAL_FORBIDDEN", JSON.stringify(r.corps));

    await pool.query(
      `UPDATE user_permission_overrides SET effect='DENY'
        WHERE company_id=$1 AND user_id=$2 AND module_key='paie' AND action='validate'`,
      [TRIANGLE, COMPTABLE]);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LA DIRECTION DEMANDE UNE CORRECTION, PUIS VALIDE${Z}`);
  {
    const sansMotif = await appel("POST", `/paie/runs/${runId}/decision`, tDirecteur,
      { decision: "CORRECTION_DEMANDEE" });
    verifier("demander une correction sans motif est refusé",
      sansMotif.statut === 400 && sansMotif.corps.code === "REASON_REQUIRED", JSON.stringify(sansMotif.corps));

    const correction = await appel("POST", `/paie/runs/${runId}/decision`, tDirecteur,
      { decision: "CORRECTION_DEMANDEE", reason: "Le net de l'employé A ne tient pas compte de son absence du 12." });
    verifier("la Direction demande une correction", correction.statut === 200, JSON.stringify(correction.corps));

    const paiementApres = await appel("POST", `/attendance-v2/payroll-items/${ligneA}/pay`, tComptable,
      { payment_method: "CASH" });
    verifier("après une demande de correction, payer reste refusé",
      paiementApres.statut === 409, JSON.stringify(paiementApres.corps));

    const resoumis = await appel("POST", `/paie/runs/${runId}/soumettre`, tComptable);
    verifier("le comptable peut soumettre à nouveau après correction",
      resoumis.statut === 201, JSON.stringify(resoumis.corps));

    const valide = await appel("POST", `/paie/runs/${runId}/decision`, tDirecteur2,
      { decision: "VALIDEE" });
    verifier("un AUTRE directeur valide", valide.statut === 200 && valide.corps.decision === "VALIDEE",
      JSON.stringify(valide.corps));

    const [run] = await q(`SELECT status FROM attendance_payroll_runs_v2 WHERE id=$1`, [runId]);
    verifier("la paie passe à AUTORISEE_AU_PAIEMENT", run.status === "AUTORISEE_AU_PAIEMENT", run.status);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}AJUSTEMENT PAR LA DIRECTION, AVANT/APRÈS CONSERVÉ${Z}`);
  {
    const [avant] = await q(`SELECT net_salary FROM attendance_payroll_items_v2 WHERE id=$1`, [ligneB]);

    const sansMotif = await appel("POST", `/paie/lignes/${ligneB}/ajuster`, tDirecteur, { net_salary: 90000 });
    verifier("ajuster sans motif est refusé",
      sansMotif.statut === 400 && sansMotif.corps.code === "REASON_REQUIRED", JSON.stringify(sansMotif.corps));

    const parComptable = await appel("POST", `/paie/lignes/${ligneB}/ajuster`, tComptable,
      { net_salary: 90000, reason: "tentative sans droit d'ajustement" });
    verifier("le comptable n'ajuste pas les montants",
      parComptable.statut === 403 || parComptable.statut === 404, `statut ${parComptable.statut}`);

    const r = await appel("POST", `/paie/lignes/${ligneB}/ajuster`, tDirecteur,
      { net_salary: 90000, reason: "Retenue convenue avec le salarié pour matériel cassé." });
    verifier("la Direction ajuste le montant", r.statut === 200 && Number(r.corps.nouveau) === 90000,
      JSON.stringify(r.corps).slice(0, 160));

    const [trace] = await q(
      `SELECT field, old_value, new_value, reason, performed_by_name
         FROM payroll_item_adjustments WHERE payroll_item_id=$1 ORDER BY id DESC LIMIT 1`, [ligneB]);
    verifier("l'ancien montant est conservé",
      Number(trace.old_value) === Number(avant.net_salary), `${trace.old_value} / ${avant.net_salary}`);
    verifier("le nouveau aussi, avec le motif et l'auteur",
      Number(trace.new_value) === 90000 && trace.reason.length > 10 && trace.performed_by_name.length > 0,
      JSON.stringify(trace));

    const [run] = await q(`SELECT net_amount FROM attendance_payroll_runs_v2 WHERE id=$1`, [runId]);
    const [somme] = await q(
      `SELECT COALESCE(sum(net_salary),0) AS s FROM attendance_payroll_items_v2 WHERE payroll_run_id=$1`, [runId]);
    verifier("le total de la paie suit ses lignes",
      Number(run.net_amount) === Number(somme.s), `${run.net_amount} / ${somme.s}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}PAIEMENT AUTORISÉ, PUIS BON${Z}`);
  {
    await pool.query(
      `INSERT INTO caisses (company_id, nom_caisse, solde_initial, solde_actuel, actif)
       VALUES ($1,'Caisse Essai 081',500000,500000,true)
       ON CONFLICT DO NOTHING`, [TRIANGLE]);
    const [caisse] = await q(`SELECT id FROM caisses WHERE company_id=$1 ORDER BY id DESC LIMIT 1`, [TRIANGLE]);

    const r = await appel("POST", `/attendance-v2/payroll-items/${ligneA}/pay`, tComptable,
      { payment_method: "CASHBOX", caisse_id: caisse.id, payment_reference: "ESSAI-081-A" });
    verifier("le paiement passe une fois la paie autorisée",
      r.statut === 200 && r.corps.item?.status === "PAID", JSON.stringify(r.corps).slice(0, 200));

    const encore = await appel("POST", `/attendance-v2/payroll-items/${ligneA}/pay`, tComptable,
      { payment_method: "CASHBOX", caisse_id: caisse.id });
    verifier("payer deux fois le même salaire est refusé (double clic sans double débit)",
      encore.statut !== 200, `statut ${encore.statut}`);

    const [ecritures] = await q(
      `SELECT count(*)::int AS n FROM accounting_transactions
        WHERE source_type='attendance_payroll_item' AND source_id=$1`, [ligneA]);
    verifier("une seule écriture comptable a été produite", ecritures.n === 1, `${ecritures.n}`);

    const bonAvantPaiement = await appel("POST", `/paie/lignes/${ligneB}/bon`, tComptable);
    verifier("le bon d'un salaire non payé est refusé",
      bonAvantPaiement.statut === 409 && bonAvantPaiement.corps.code === "PAYROLL_ITEM_NOT_PAID",
      JSON.stringify(bonAvantPaiement.corps));

    const bon = await appel("POST", `/paie/lignes/${ligneA}/bon`, tComptable);
    verifier("le bon est émis après paiement", bon.statut === 201, JSON.stringify(bon.corps).slice(0, 160));
    verifier("il porte un numéro de la série BON-SAL",
      /^BON-SAL-\d{4}-\d{6}$/.test(bon.corps.bon?.voucher_number || ""), bon.corps.bon?.voucher_number);
    verifier("son contenu est figé, pas relu par jointure",
      bon.corps.bon?.payload?.employe && bon.corps.bon?.payload?.net_paye != null,
      JSON.stringify(bon.corps.bon?.payload).slice(0, 200));

    const encoreBon = await appel("POST", `/paie/lignes/${ligneA}/bon`, tComptable);
    verifier("réémettre renvoie le MÊME bon, pas un second",
      encoreBon.corps.deja_emis === true &&
      encoreBon.corps.bon?.voucher_number === bon.corps.bon?.voucher_number,
      JSON.stringify(encoreBon.corps.bon?.voucher_number));

    const impression = await appel("GET", `/paie/lignes/${ligneA}/bon`, tComptable);
    verifier("l'impression est comptée", Number(impression.corps.bon?.print_count) === 1,
      JSON.stringify(impression.corps.bon?.print_count));
    const reimpression = await appel("GET", `/paie/lignes/${ligneA}/bon`, tComptable);
    verifier("la seconde lecture est une réimpression", reimpression.corps.reimpression === true);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}CLÔTURE${Z}`);
  {
    const tot = await appel("POST", "/paie/periodes/2026-09/cloturer", tResp);
    verifier("clôturer est refusé tant qu'un salaire reste à payer",
      tot.statut === 409 && tot.corps.code === "PERIOD_HAS_UNPAID", JSON.stringify(tot.corps));

    const [caisse] = await q(`SELECT id FROM caisses WHERE company_id=$1 ORDER BY id DESC LIMIT 1`, [TRIANGLE]);
    await appel("POST", `/attendance-v2/payroll-items/${ligneB}/pay`, tComptable,
      { payment_method: "CASHBOX", caisse_id: caisse.id, payment_reference: "ESSAI-081-B" });

    const [periodeApres] = await q(
      `SELECT status FROM attendance_periods WHERE company_id=$1 AND code='2026-09'`, [TRIANGLE]);
    verifier("tout payé, la période passe à PAYEE", periodeApres.status === "PAYEE", periodeApres.status);

    const ok = await appel("POST", "/paie/periodes/2026-09/cloturer", tResp);
    verifier("la clôture est alors possible",
      ok.statut === 200 && ok.corps.periode?.status === "CLOTUREE", JSON.stringify(ok.corps).slice(0, 160));

    const sansMotif = await appel("POST", "/paie/periodes/2026-09/rouvrir", tResp, {});
    verifier("rouvrir sans motif est refusé",
      sansMotif.statut === 400 && sansMotif.corps.code === "REASON_REQUIRED", JSON.stringify(sansMotif.corps));

    const rouvre = await appel("POST", "/paie/periodes/2026-09/rouvrir", tResp,
      { reason: "Un pointage du 3 septembre a été oublié." });
    verifier("une période close se rouvre avec motif",
      rouvre.statut === 200 && rouvre.corps.periode?.status === "EN_REVISION_POINTAGE",
      JSON.stringify(rouvre.corps).slice(0, 160));

    const [trace] = await q(
      `SELECT reopen_reason, reopened_by FROM attendance_periods WHERE company_id=$1 AND code='2026-09'`,
      [TRIANGLE]);
    verifier("le motif et l'auteur de la réouverture sont conservés",
      trace.reopen_reason.length > 10 && Number(trace.reopened_by) === RESPONSABLE, JSON.stringify(trace));
  }

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

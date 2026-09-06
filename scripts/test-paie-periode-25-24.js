"use strict";

/**
 * LA PAIE EST CALCULÉE DU 25 AU 24, POUR DE VRAI.
 *
 *   bash scripts/test-paie-periode-25-24.sh
 *
 * `calculatePayroll()` calculait un mois CIVIL alors que l'écran annonçait
 * une période du 25 au 24. Les deux ne couvraient pas les mêmes journées, et
 * personne ne pouvait le voir sans recompter à la main : une présence du
 * 25 août tombait hors de la paie de septembre, alors qu'elle en fait partie.
 *
 * Les bornes sont éprouvées aux quatre coins :
 *
 *   25 août 2026     → DANS la paie de septembre
 *   24 septembre     → DANS la paie de septembre
 *   24 août          → DEHORS (appartient à août)
 *   25 septembre     → DEHORS (appartient à octobre)
 *
 * Et le `period_id` n'est JAMAIS posé à la main : il est produit par la route
 * que l'écran utilise. Un test qui le rattacherait lui-même ne prouverait
 * rien de ce qui se passera en production.
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
const jeton = (id, role, companyId) =>
  jwt.sign({ id, fullname: `Compte ${id}`, email: `p${id}@essai.test`, role,
             company_id: companyId, is_super_admin: false }, SECRET, { expiresIn: "3h" });

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
const PERIODE = "2026-09";           // du 25/08/2026 au 24/09/2026
let COMPTABLE = 0, RESP = 0;
let siteId = 0, scheduleId = 0;
let bornes = 0, dimanche = 0, ferie = 0;

async function poserLeJeu() {
  await pool.query(`DELETE FROM salary_advance_repayments`);
  await pool.query(`DELETE FROM salary_advance_installments`);
  await pool.query(`DELETE FROM salary_advances`);
  await pool.query(`DELETE FROM payroll_vouchers`);
  await pool.query(`DELETE FROM payroll_item_adjustments`);
  await pool.query(`DELETE FROM payroll_requests`);
  await pool.query(`DELETE FROM attendance_payroll_items_v2`);
  await pool.query(`DELETE FROM attendance_payroll_runs_v2`);
  await pool.query(`DELETE FROM attendance_periods WHERE company_id = $1`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_regularizations`);
  await pool.query(`DELETE FROM attendance_regularization_batches`);
  await pool.query(`DELETE FROM attendance_salary_settings_v2`);
  await pool.query(`DELETE FROM attendance_salary_adjustments_v2`);
  await pool.query(`DELETE FROM attendance_event_log_v2`);
  await pool.query(`DELETE FROM attendance_day_records_v2`);
  await pool.query(`DELETE FROM attendance_qr_scans`);
  await pool.query(`DELETE FROM attendance_badge_events`);
  await pool.query(`DELETE FROM attendance_badges`);
  await pool.query(`DELETE FROM attendance_operator_scopes`);
  await pool.query(`DELETE FROM attendance_employees WHERE company_id = $1`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_holidays WHERE company_id = $1`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_schedule_days WHERE schedule_id IN
      (SELECT id FROM attendance_work_schedules WHERE company_id=$1 AND code='ESSAI-P25')`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_work_schedules WHERE company_id=$1 AND code='ESSAI-P25'`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_work_sites WHERE company_id=$1 AND code='ESSAI-P25'`, [TRIANGLE]);
  await pool.query(`DELETE FROM users WHERE email LIKE 'per25-%@essai.test'`);

  const creer = async (email, nom, role) => (await pool.query(
    `INSERT INTO users (company_id, fullname, email, password, role, is_super_admin, is_active)
     VALUES ($1,$2,$3,'$non-utilisable$',$4,false,true) RETURNING id`,
    [TRIANGLE, nom, email, role])).rows[0].id;
  COMPTABLE = await creer("per25-comptable@essai.test", "Essai P25 Comptable", "comptable");
  RESP      = await creer("per25-resp@essai.test", "Essai P25 Responsable", "responsable_entrepot");

  await pool.query(
    `INSERT INTO attendance_company_configuration
       (company_id, official_start_at, timezone, saturday_mode, period_start_day)
     VALUES ($1, '2026-01-01'::timestamptz, 'Africa/Bamako', 'NORMAL', 25)
     ON CONFLICT (company_id) DO UPDATE
       SET official_start_at = '2026-01-01'::timestamptz,
           saturday_mode = 'NORMAL', period_start_day = 25`, [TRIANGLE]);

  siteId = (await pool.query(
    `INSERT INTO attendance_work_sites (company_id, code, name, city, site_type, active)
     VALUES ($1,'ESSAI-P25','Essai Site P25','Bamako','WAREHOUSE',true) RETURNING id`, [TRIANGLE])).rows[0].id;
  scheduleId = (await pool.query(
    `INSERT INTO attendance_work_schedules (company_id, code, name, active)
     VALUES ($1,'ESSAI-P25','Lundi au samedi 08:00',true) RETURNING id`, [TRIANGLE])).rows[0].id;
  /* Dimanche non travaillé : c'est ce qui rend vérifiable qu'il ne crée
     aucune absence. */
  for (let j = 1; j <= 7; j += 1) {
    await pool.query(
      `INSERT INTO attendance_schedule_days (schedule_id, iso_weekday, is_working_day, start_time, end_time)
       VALUES ($1,$2,$3,'08:00','17:00')`, [scheduleId, j, j !== 7]);
  }

  const emp = async (numero, nom) => {
    const id = (await pool.query(
      `INSERT INTO attendance_employees
         (company_id, employee_number, full_name, site_id, schedule_id, job_title, phone, active, effective_from)
       VALUES ($1,$2,$3,$4,$5,'Manœuvre','',true,'2026-01-01') RETURNING id`,
      [TRIANGLE, numero, nom, siteId, scheduleId])).rows[0].id;
    await pool.query(
      `INSERT INTO attendance_salary_settings_v2 (company_id, employee_id, monthly_salary, daily_rate, effective_from)
       VALUES ($1,$2,100000,0,'2026-01-01')`, [TRIANGLE, id]);
    return id;
  };
  bornes   = await emp(2501, "Essai P25 Bornes");
  dimanche = await emp(2502, "Essai P25 Dimanche");
  ferie    = await emp(2503, "Essai P25 Férié");

  /* L'employé « Bornes » a pointé les quatre journées qui décident :
     deux dedans, deux dehors. */
  const pointer = (employeeId, jour) => pool.query(
    `INSERT INTO attendance_day_records_v2
       (company_id, employee_id, work_date, check_in, check_out, status, late_minutes, worked_minutes)
     VALUES ($1,$2,$3::date, ($3::date + '08:00'::time)::timestamptz,
             ($3::date + '17:00'::time)::timestamptz, 'COMPLETED', 0, 480)`,
    [TRIANGLE, employeeId, jour]);
  await pointer(bornes, "2026-08-24");  // dehors : appartient à la paie d'août
  await pointer(bornes, "2026-08-25");  // dedans  : premier jour de septembre
  await pointer(bornes, "2026-09-24");  // dedans  : dernier jour de septembre
  await pointer(bornes, "2026-09-25");  // dehors  : appartient à octobre

  /* Un jour férié dans la période, pour l'employé « Férié ». */
  await pool.query(
    `INSERT INTO attendance_holidays (company_id, holiday_date, label)
     VALUES ($1,'2026-09-22','Fête d''essai')`, [TRIANGLE]);

  await pool.query(`DELETE FROM user_permission_overrides WHERE company_id=$1 AND user_id=ANY($2::int[])`,
    [TRIANGLE, [COMPTABLE, RESP]]);
  const droit = (userId, module, action) => pool.query(
    `INSERT INTO user_permission_overrides (company_id, user_id, module_key, action, effect)
     VALUES ($1,$2,$3,$4,'ALLOW')
     ON CONFLICT (company_id, user_id, module_key, action) DO UPDATE SET effect='ALLOW'`,
    [TRIANGLE, userId, module, action]);
  for (const a of ["visible","view","prepare","submit","pay","print"]) await droit(COMPTABLE, "paie", a);
  for (const a of ["visible","view","create","validate","close","reopen"]) {
    await droit(RESP, "pointage.periode", a);
    await droit(COMPTABLE, "pointage.periode", a === "validate" ? "view" : a);
  }
}

async function main() {
  console.log(`\n${G}LA PAIE DU 25 AU 24${Z}`);
  await poserLeJeu();
  const tComptable = jeton(COMPTABLE, "comptable", TRIANGLE);
  const tResp = jeton(RESP, "responsable_entrepot", TRIANGLE);

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LA PÉRIODE VA BIEN DU 25 AOÛT AU 24 SEPTEMBRE${Z}`);
  {
    const r = await appel("POST", `/paie/periodes/${PERIODE}/ouvrir`, tResp);
    verifier("la période s'ouvre", r.statut === 201, JSON.stringify(r.corps).slice(0, 150));
    verifier("elle commence le 25 août 2026", r.corps.periode?.debut === "2026-08-25", r.corps.periode?.debut);
    verifier("elle finit le 24 septembre 2026", r.corps.periode?.fin === "2026-09-24", r.corps.periode?.fin);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}PRÉPARER AVANT VALIDATION DU POINTAGE EST INTERDIT${Z}`);
  {
    const r = await appel("POST", `/paie/periodes/${PERIODE}/preparer`, tComptable);
    verifier("la préparation est refusée tant que le pointage n'est pas validé",
      r.statut === 409 && r.corps.code === "ATTENDANCE_NOT_VALIDATED", JSON.stringify(r.corps));

    const [paies] = await q(
      `SELECT count(*)::int AS n FROM attendance_payroll_runs_v2 WHERE company_id=$1`, [TRIANGLE]);
    verifier("aucune paie n'a été créée", paies.n === 0, `${paies.n}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LA PRÉPARATION RATTACHE LA PÉRIODE ELLE-MÊME${Z}`);
  let runId = 0;
  {
    await appel("POST", `/paie/periodes/${PERIODE}/valider-pointage`, tResp);
    const r = await appel("POST", `/paie/periodes/${PERIODE}/preparer`, tComptable);
    verifier("la préparation réussit", r.statut === 201, JSON.stringify(r.corps).slice(0, 200));
    verifier("elle annonce les vraies bornes",
      r.corps.periode?.debut === "2026-08-25" && r.corps.periode?.fin === "2026-09-24",
      JSON.stringify(r.corps.periode));
    runId = r.corps.paie?.id;

    const [paie] = await q(
      `SELECT r.period_id, p.code, p.date_debut::text AS debut, p.date_fin::text AS fin
         FROM attendance_payroll_runs_v2 r
         JOIN attendance_periods p ON p.id = r.period_id
        WHERE r.id = $1`, [runId]);
    verifier("le period_id est posé par la ROUTE, pas par le test",
      paie && paie.code === PERIODE, JSON.stringify(paie));
    verifier("il pointe sur la période aux bonnes bornes",
      paie.debut === "2026-08-25" && paie.fin === "2026-09-24", JSON.stringify(paie));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LES QUATRE COINS DE LA PÉRIODE${Z}`);
  {
    const [ligne] = await q(
      `SELECT attended_days, expected_days, absence_days
         FROM attendance_payroll_items_v2 WHERE payroll_run_id=$1 AND employee_id=$2`,
      [runId, bornes]);

    /* Quatre pointages posés, deux dans la période : le 25 août et le
       24 septembre. Les deux autres — 24 août et 25 septembre — tombent
       dehors. Si le calcul se faisait encore sur un mois civil, on compterait
       le 25 septembre et pas le 25 août. */
    verifier("exactement deux journées pointées sont comptées",
      Number(ligne.attended_days) === 2,
      `${ligne.attended_days} — attendues ${ligne.expected_days}`);

    const dansLaPeriode = await q(
      `SELECT work_date::text AS d FROM attendance_day_records_v2
        WHERE employee_id=$1 AND work_date BETWEEN '2026-08-25' AND '2026-09-24'
        ORDER BY work_date`, [bornes]);
    verifier("le 25 août est dans la période",
      dansLaPeriode.some((x) => x.d === "2026-08-25"), JSON.stringify(dansLaPeriode.map((x) => x.d)));
    verifier("le 24 septembre aussi",
      dansLaPeriode.some((x) => x.d === "2026-09-24"));
    verifier("le 24 août en est exclu",
      !dansLaPeriode.some((x) => x.d === "2026-08-24"));
    verifier("le 25 septembre en est exclu",
      !dansLaPeriode.some((x) => x.d === "2026-09-25"));

    /* La contre-épreuve, celle qui distingue vraiment les deux calculs.
       Comparer les NOMBRES ne prouverait rien : ici les deux valent deux. Ce
       qui diffère, ce sont les JOURNÉES — un mois civil de septembre prend le
       25 septembre et rate le 25 août, exactement l'inverse de la période. */
    const civil = (await q(
      `SELECT work_date::text AS d FROM attendance_day_records_v2
        WHERE employee_id=$1 AND work_date BETWEEN '2026-09-01' AND '2026-09-30'
        ORDER BY work_date`, [bornes])).map((x) => x.d);
    const periode = dansLaPeriode.map((x) => x.d);
    verifier("un mois civil retiendrait d'AUTRES journées que la période",
      JSON.stringify(civil) !== JSON.stringify(periode),
      `mois civil ${JSON.stringify(civil)} vs période ${JSON.stringify(periode)}`);
    verifier("le mois civil prend le 25 septembre, que la période exclut",
      civil.includes("2026-09-25") && !periode.includes("2026-09-25"));
    verifier("et rate le 25 août, que la période inclut",
      !civil.includes("2026-08-25") && periode.includes("2026-08-25"));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}DIMANCHES ET JOURS FÉRIÉS NE CRÉENT PAS D'ABSENCE${Z}`);
  {
    const [dim] = await q(
      `SELECT expected_days, absence_days FROM attendance_payroll_items_v2
        WHERE payroll_run_id=$1 AND employee_id=$2`, [runId, dimanche]);

    /* Du 25/08 au 24/09 inclus : 31 jours, dont 4 dimanches (30/08, 06/09,
       13/09, 20/09) et un férié le 22/09 → 26 jours dus. */
    const [comptes] = await q(
      `SELECT count(*) FILTER (WHERE extract(isodow FROM d) = 7)::int AS dimanches,
              count(*)::int AS total
         FROM generate_series('2026-08-25'::date, '2026-09-24'::date, interval '1 day') d`);
    const attendus = comptes.total - comptes.dimanches - 1; // −1 pour le férié
    verifier(`les jours dus excluent ${comptes.dimanches} dimanches et le jour férié`,
      Number(dim.expected_days) === attendus,
      `${dim.expected_days} attendu ${attendus} (total ${comptes.total})`);

    verifier("les dimanches ne sont pas comptés comme absences",
      Number(dim.absence_days) === attendus,
      `${dim.absence_days} absences pour ${attendus} jours dus, sans aucun pointage`);

    const [fer] = await q(
      `SELECT expected_days FROM attendance_payroll_items_v2
        WHERE payroll_run_id=$1 AND employee_id=$2`, [runId, ferie]);
    verifier("le jour férié ne compte pas comme jour dû",
      Number(fer.expected_days) === attendus, `${fer.expected_days}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}UNE SEULE PAIE PAR PÉRIODE${Z}`);
  {
    const encore = await appel("POST", `/paie/periodes/${PERIODE}/preparer`, tComptable);
    verifier("recalculer réussit sans créer de seconde paie", encore.statut === 201,
      JSON.stringify(encore.corps).slice(0, 140));

    const [paies] = await q(
      `SELECT count(*)::int AS n FROM attendance_payroll_runs_v2
        WHERE company_id=$1 AND period_id IS NOT NULL`, [TRIANGLE]);
    verifier("une seule paie porte cette période", paies.n === 1, `${paies.n}`);

    /* Et la base le garantit, pas seulement le code. */
    const [periode] = await q(
      `SELECT id FROM attendance_periods WHERE company_id=$1 AND code=$2`, [TRIANGLE, PERIODE]);
    let refus = null;
    try {
      await pool.query(
        `INSERT INTO attendance_payroll_runs_v2 (company_id, period_id, period_month, status)
         VALUES ($1,$2,'2026-10-01','DRAFT')`, [TRIANGLE, periode.id]);
    } catch (e) { refus = e; }
    verifier("PostgreSQL refuse une seconde paie sur la même période",
      Boolean(refus), refus ? refus.code : "ACCEPTÉE À TORT");
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LA VALEUR RÉGULARISÉE COMPTE COMME UNE PRÉSENCE${Z}`);
  {
    /* Une journée non pointée mais régularisée doit compter comme travaillée :
       c'est tout l'objet de la régularisation. */
    await pool.query(
      `INSERT INTO attendance_regularizations
         (company_id, employee_id, work_date, effective_check_in, effective_check_out,
          effective_status, reason, performed_by_name)
       VALUES ($1,$2,'2026-08-26', ('2026-08-26'::date + '08:00'::time)::timestamptz,
               ('2026-08-26'::date + '17:00'::time)::timestamptz, 'PRESENT',
               'Mise en service du pointage', 'Essai')`, [TRIANGLE, bornes]);

    const r = await appel("POST", `/paie/periodes/${PERIODE}/preparer`, tComptable);
    verifier("la paie se recalcule", r.statut === 201, JSON.stringify(r.corps).slice(0, 140));

    const [ligne] = await q(
      `SELECT attended_days FROM attendance_payroll_items_v2
        WHERE payroll_run_id=(SELECT id FROM attendance_payroll_runs_v2
                               WHERE company_id=$1 AND period_id IS NOT NULL)
          AND employee_id=$2`, [TRIANGLE, bornes]);
    verifier("la journée régularisée s'ajoute aux journées travaillées",
      Number(ligne.attended_days) === 3, `${ligne.attended_days}`);

    /* Et une absence marquée par-dessus la régularisation la retire. */
    await pool.query(
      `UPDATE attendance_regularizations
          SET overridden_at = now(), overridden_status = 'ABSENT',
              override_reason = 'Absent constaté par le chef de chantier.'
        WHERE company_id=$1 AND employee_id=$2 AND work_date='2026-08-26'`, [TRIANGLE, bornes]);
    await appel("POST", `/paie/periodes/${PERIODE}/preparer`, tComptable);

    const [apres] = await q(
      `SELECT attended_days FROM attendance_payroll_items_v2
        WHERE payroll_run_id=(SELECT id FROM attendance_payroll_runs_v2
                               WHERE company_id=$1 AND period_id IS NOT NULL)
          AND employee_id=$2`, [TRIANGLE, bornes]);
    verifier("une absence marquée par-dessus l'emporte sur la régularisation",
      Number(apres.attended_days) === 2, `${apres.attended_days}`);
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

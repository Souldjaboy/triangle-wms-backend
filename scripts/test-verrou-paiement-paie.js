"use strict";

/**
 * LA VALIDATION DE LA DIRECTION EST INCONTOURNABLE (migration 088).
 *
 *   bash scripts/test-verrou-paiement-paie.sh
 *
 * L'ancien verrou n'exigeait une demande validée que si une demande EXISTAIT
 * DÉJÀ. Une paie neuve dont personne n'avait rien soumis restait donc payable —
 * il suffisait de ne pas soumettre pour n'avoir personne à convaincre.
 *
 * Les sept cas exigés, éprouvés par l'API, jamais par les boutons :
 *
 *   A. paie DRAFT avec period_id et sans demande        → refus
 *   B. demande en attente                                → refus
 *   C. demande refusée                                   → refus
 *   D. demande validée par son propre demandeur          → impossible
 *   E. demande validée par quelqu'un d'autre             → paiement possible
 *   F. deux paiements simultanés                         → un seul débit
 *   G. ancienne paie sans period_id                      → comportement historique
 *
 * Aucun `period_id` n'est rattaché à la main : c'est la vraie route de
 * préparation qui le pose, celle que l'écran utilise.
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
  jwt.sign({ id, fullname: `Compte ${id}`, email: `v${id}@essai.test`, role,
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
let COMPTABLE = 0, DIRECTEUR = 0, DIRECTEUR2 = 0, RESP = 0, CUMULARD = 0;
let siteId = 0, scheduleId = 0, employeA = 0, employeB = 0, caisseId = 0;

/* Une période passée, entièrement écoulée : ses journées sont connues et ne
   dépendent pas du jour où la suite tourne. */
const PERIODE = "2026-07";

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
  await pool.query(`DELETE FROM attendance_event_log_v2`);
  await pool.query(`DELETE FROM attendance_day_records_v2`);
  await pool.query(`DELETE FROM attendance_qr_scans`);
  await pool.query(`DELETE FROM attendance_badge_events`);
  await pool.query(`DELETE FROM attendance_badges`);
  await pool.query(`DELETE FROM attendance_operator_scopes`);
  await pool.query(`DELETE FROM attendance_employees WHERE company_id = $1`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_holidays WHERE company_id = $1`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_schedule_days WHERE schedule_id IN
      (SELECT id FROM attendance_work_schedules WHERE company_id=$1 AND code='ESSAI-088')`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_work_schedules WHERE company_id=$1 AND code='ESSAI-088'`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_work_sites WHERE company_id=$1 AND code='ESSAI-088'`, [TRIANGLE]);
  await pool.query(`DELETE FROM caisses WHERE company_id=$1 AND nom_caisse='Caisse Essai 088'`, [TRIANGLE]);
  await pool.query(`DELETE FROM users WHERE email LIKE 'paie088-%@essai.test'`);

  const creer = async (email, nom, role) => (await pool.query(
    `INSERT INTO users (company_id, fullname, email, password, role, is_super_admin, is_active)
     VALUES ($1,$2,$3,'$non-utilisable$',$4,false,true) RETURNING id`,
    [TRIANGLE, nom, email, role])).rows[0].id;
  COMPTABLE  = await creer("paie088-comptable@essai.test", "Essai 088 Comptable", "comptable");
  DIRECTEUR  = await creer("paie088-directeur@essai.test", "Essai 088 Directeur", "direction");
  DIRECTEUR2 = await creer("paie088-directeur2@essai.test", "Essai 088 Directeur bis", "direction");
  RESP       = await creer("paie088-resp@essai.test", "Essai 088 Responsable", "responsable_entrepot");
  /* Celui qui cumule submit + validate + pay : le cas que le verrou doit
     rendre inoffensif. */
  CUMULARD   = await creer("paie088-cumul@essai.test", "Essai 088 Cumulard", "comptable");

  await pool.query(
    `INSERT INTO attendance_company_configuration
       (company_id, official_start_at, timezone, saturday_mode, period_start_day)
     VALUES ($1, now() - interval '500 days', 'Africa/Bamako', 'NORMAL', 25)
     ON CONFLICT (company_id) DO UPDATE
       SET official_start_at = EXCLUDED.official_start_at,
           saturday_mode = 'NORMAL', period_start_day = 25`, [TRIANGLE]);

  siteId = (await pool.query(
    `INSERT INTO attendance_work_sites (company_id, code, name, city, site_type, active)
     VALUES ($1,'ESSAI-088','Essai Site 088','Bamako','WAREHOUSE',true) RETURNING id`, [TRIANGLE])).rows[0].id;
  scheduleId = (await pool.query(
    `INSERT INTO attendance_work_schedules (company_id, code, name, active)
     VALUES ($1,'ESSAI-088','Lundi au samedi 08:00',true) RETURNING id`, [TRIANGLE])).rows[0].id;
  for (let j = 1; j <= 7; j += 1) {
    await pool.query(
      `INSERT INTO attendance_schedule_days (schedule_id, iso_weekday, is_working_day, start_time, end_time)
       VALUES ($1,$2,$3,'08:00','17:00')`, [scheduleId, j, j !== 7]);
  }

  const emp = async (numero, nom) => {
    const id = (await pool.query(
      `INSERT INTO attendance_employees
         (company_id, employee_number, full_name, site_id, schedule_id, job_title, phone, active, effective_from)
       VALUES ($1,$2,$3,$4,$5,'Manœuvre','',true, current_date - 500) RETURNING id`,
      [TRIANGLE, numero, nom, siteId, scheduleId])).rows[0].id;
    await pool.query(
      `INSERT INTO attendance_salary_settings_v2 (company_id, employee_id, monthly_salary, daily_rate, effective_from)
       VALUES ($1,$2,100000,0, current_date - 500)`, [TRIANGLE, id]);
    return id;
  };
  employeA = await emp(8801, "Essai 088 Employé A");
  employeB = await emp(8802, "Essai 088 Employé B");

  caisseId = (await pool.query(
    `INSERT INTO caisses (company_id, nom_caisse, solde_initial, solde_actuel, actif)
     VALUES ($1,'Caisse Essai 088',5000000,5000000,true) RETURNING id`, [TRIANGLE])).rows[0].id;

  await pool.query(`DELETE FROM user_permission_overrides WHERE company_id=$1 AND user_id=ANY($2::int[])`,
    [TRIANGLE, [COMPTABLE, DIRECTEUR, DIRECTEUR2, RESP, CUMULARD]]);
  const droit = (userId, module, action, effet = "ALLOW") => pool.query(
    `INSERT INTO user_permission_overrides (company_id, user_id, module_key, action, effect)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (company_id, user_id, module_key, action) DO UPDATE SET effect = EXCLUDED.effect`,
    [TRIANGLE, userId, module, action, effet]);

  for (const a of ["visible","view","prepare","submit","pay","print"]) await droit(COMPTABLE, "paie", a);
  for (const a of ["validate","adjust"]) await droit(COMPTABLE, "paie", a, "DENY");
  for (const d of [DIRECTEUR, DIRECTEUR2]) {
    for (const a of ["visible","view","validate","adjust","print"]) await droit(d, "paie", a);
    for (const a of ["prepare","submit","pay"]) await droit(d, "paie", a, "DENY");
  }
  /* Le cumulard reçoit TOUT : submit, validate et pay. */
  for (const a of ["visible","view","prepare","submit","validate","adjust","pay","print"]) {
    await droit(CUMULARD, "paie", a);
  }
  for (const a of ["visible","view","create","validate","close","reopen"]) {
    await droit(RESP, "pointage.periode", a);
    await droit(COMPTABLE, "pointage.periode", a === "validate" ? "view" : a);
    await droit(CUMULARD, "pointage.periode", a);
  }
}

const soldeCaisse = async () =>
  Number((await q(`SELECT solde_actuel FROM caisses WHERE id=$1`, [caisseId]))[0].solde_actuel);

/** Ouvre la période, valide le pointage, prépare la paie PAR LA VRAIE ROUTE. */
async function preparerParLaVraieRoute(tPreparateur, tValideur) {
  await appel("POST", `/paie/periodes/${PERIODE}/ouvrir`, tValideur);
  await appel("POST", `/paie/periodes/${PERIODE}/valider-pointage`, tValideur);
  return appel("POST", `/paie/periodes/${PERIODE}/preparer`, tPreparateur);
}

async function main() {
  console.log(`\n${G}LA VALIDATION DE LA DIRECTION EST INCONTOURNABLE (088)${Z}`);
  await poserLeJeu();
  const tComptable = jeton(COMPTABLE, "comptable", TRIANGLE);
  const tDirecteur = jeton(DIRECTEUR, "direction", TRIANGLE);
  const tDirecteur2 = jeton(DIRECTEUR2, "direction", TRIANGLE);
  const tResp = jeton(RESP, "responsable_entrepot", TRIANGLE);
  const tCumul = jeton(CUMULARD, "comptable", TRIANGLE);

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LA PAIE EST PRÉPARÉE PAR LA VRAIE ROUTE, AVEC SA PÉRIODE${Z}`);
  let runId = 0, ligneA = 0, ligneB = 0;
  {
    const r = await preparerParLaVraieRoute(tComptable, tResp);
    verifier("la préparation par période réussit", r.statut === 201,
      JSON.stringify(r.corps).slice(0, 200));
    runId = r.corps.paie?.id;

    const [paie] = await q(
      `SELECT r.period_id, r.legacy_sans_validation, p.code
         FROM attendance_payroll_runs_v2 r
         LEFT JOIN attendance_periods p ON p.id = r.period_id
        WHERE r.id = $1`, [runId]);
    verifier("la paie porte SA période, posée par la route et non à la main",
      paie.period_id !== null && paie.code === PERIODE, JSON.stringify(paie));
    verifier("elle n'est PAS marquée historique",
      paie.legacy_sans_validation === false, String(paie.legacy_sans_validation));

    const lignes = await q(
      `SELECT id, employee_id FROM attendance_payroll_items_v2
        WHERE payroll_run_id=$1 ORDER BY employee_id`, [runId]);
    ligneA = lignes[0]?.id; ligneB = lignes[1]?.id;
    verifier("elle contient les deux employés", lignes.length === 2, `${lignes.length}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}A. PAIE AVEC PÉRIODE, SANS AUCUNE DEMANDE → REFUS${Z}`);
  {
    const avant = await soldeCaisse();
    const r = await appel("POST", `/attendance-v2/payroll-items/${ligneA}/pay`, tComptable,
      { payment_method: "CASHBOX", caisse_id: caisseId });
    verifier("le paiement est refusé faute de demande",
      r.statut === 409 && r.corps.code === "PAYROLL_NOT_SUBMITTED", JSON.stringify(r.corps));
    verifier("la caisse n'a pas bougé", (await soldeCaisse()) === avant, `${avant}`);
    const [l] = await q(`SELECT status FROM attendance_payroll_items_v2 WHERE id=$1`, [ligneA]);
    verifier("le salaire reste à payer", l.status === "TO_PAY", l.status);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}B. DEMANDE EN ATTENTE → REFUS${Z}`);
  {
    const s = await appel("POST", `/paie/runs/${runId}/soumettre`, tComptable);
    verifier("la paie est soumise", s.statut === 201, JSON.stringify(s.corps).slice(0, 140));

    const avant = await soldeCaisse();
    const r = await appel("POST", `/attendance-v2/payroll-items/${ligneA}/pay`, tComptable,
      { payment_method: "CASHBOX", caisse_id: caisseId });
    verifier("le paiement est refusé pendant l'attente",
      r.statut === 409 && r.corps.code === "PAYROLL_NOT_AUTHORIZED"
        && r.corps.statut_demande === "EN_ATTENTE_DIRECTION", JSON.stringify(r.corps));
    verifier("la caisse n'a pas bougé", (await soldeCaisse()) === avant);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}C. DEMANDE REFUSÉE → REFUS${Z}`);
  {
    const d = await appel("POST", `/paie/runs/${runId}/decision`, tDirecteur,
      { decision: "REFUSEE", reason: "Les jours d'absence ne correspondent pas au registre." });
    verifier("la Direction refuse", d.statut === 200, JSON.stringify(d.corps).slice(0, 140));

    const avant = await soldeCaisse();
    const r = await appel("POST", `/attendance-v2/payroll-items/${ligneA}/pay`, tComptable,
      { payment_method: "CASHBOX", caisse_id: caisseId });
    verifier("le paiement est refusé après un refus",
      r.statut === 409 && r.corps.statut_demande === "REFUSEE", JSON.stringify(r.corps));
    verifier("la caisse n'a pas bougé", (await soldeCaisse()) === avant);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}D. VALIDÉE PAR SON PROPRE DEMANDEUR → IMPOSSIBLE${Z}`);
  {
    /* Le cumulard a submit, validate ET pay. Il soumet, puis tente de valider
       sa propre demande : la route de décision doit le refuser. */
    const s = await appel("POST", `/paie/runs/${runId}/soumettre`, tCumul);
    verifier("le cumulard soumet la paie", s.statut === 201, JSON.stringify(s.corps).slice(0, 140));

    const d = await appel("POST", `/paie/runs/${runId}/decision`, tCumul, { decision: "VALIDEE" });
    verifier("il ne peut pas valider ce qu'il a soumis, malgré le droit",
      d.statut === 403 && d.corps.code === "SELF_APPROVAL_FORBIDDEN", JSON.stringify(d.corps));

    const avant = await soldeCaisse();
    const r = await appel("POST", `/attendance-v2/payroll-items/${ligneA}/pay`, tCumul,
      { payment_method: "CASHBOX", caisse_id: caisseId });
    verifier("et il ne peut pas payer davantage",
      r.statut === 409, JSON.stringify(r.corps));
    verifier("la caisse n'a pas bougé", (await soldeCaisse()) === avant);

    /* Deuxième garde : même si une demande auto-validée existait en base — par
       un script, un import, une manipulation directe — le paiement la refuse.
       On la fabrique pour l'éprouver. */
    await pool.query(
      `UPDATE payroll_requests
          SET status='VALIDEE', decided_by = submitted_by, decided_by_name='Auto',
              decided_at = now()
        WHERE payroll_run_id = $1 AND status = 'EN_ATTENTE_DIRECTION'`, [runId]);
    await pool.query(
      `UPDATE attendance_payroll_runs_v2 SET status='AUTORISEE_AU_PAIEMENT' WHERE id=$1`, [runId]);

    const force = await appel("POST", `/attendance-v2/payroll-items/${ligneA}/pay`, tCumul,
      { payment_method: "CASHBOX", caisse_id: caisseId });
    verifier("une demande auto-validée écrite directement en base est refusée au paiement",
      force.statut === 409 && force.corps.code === "SELF_APPROVED_REQUEST", JSON.stringify(force.corps));
    verifier("la caisse n'a toujours pas bougé", (await soldeCaisse()) === avant);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}E. VALIDÉE PAR QUELQU'UN D'AUTRE → PAIEMENT POSSIBLE${Z}`);
  {
    /* On remet la demande en attente, et un AUTRE directeur tranche. */
    /* Seulement la DERNIÈRE demande : l'index « une seule en attente par paie »
       refuse d'en remettre deux en file, et il a raison — la Direction ne doit
       pas avoir deux décisions à prendre pour une même paie. */
    await pool.query(
      `UPDATE payroll_requests
          SET status='EN_ATTENTE_DIRECTION', decided_by=NULL, decided_at=NULL
        WHERE id = (SELECT id FROM payroll_requests WHERE payroll_run_id=$1
                     ORDER BY submitted_at DESC, id DESC LIMIT 1)`, [runId]);
    await pool.query(
      `UPDATE attendance_payroll_runs_v2 SET status='EN_ATTENTE_DIRECTION' WHERE id=$1`, [runId]);

    const d = await appel("POST", `/paie/runs/${runId}/decision`, tDirecteur2, { decision: "VALIDEE" });
    verifier("un autre directeur valide", d.statut === 200 && d.corps.decision === "VALIDEE",
      JSON.stringify(d.corps).slice(0, 140));

    const avant = await soldeCaisse();
    const r = await appel("POST", `/attendance-v2/payroll-items/${ligneA}/pay`, tComptable,
      { payment_method: "CASHBOX", caisse_id: caisseId, payment_reference: "ESSAI-088-A" });
    verifier("le paiement passe", r.statut === 200 && r.corps.item?.status === "PAID",
      JSON.stringify(r.corps).slice(0, 200));

    const apres = await soldeCaisse();
    const [ligne] = await q(`SELECT net_salary FROM attendance_payroll_items_v2 WHERE id=$1`, [ligneA]);
    verifier("la caisse a diminué du net, exactement",
      avant - apres === Math.round(Number(ligne.net_salary)),
      `${avant} → ${apres} pour un net de ${ligne.net_salary}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}F. DEUX PAIEMENTS SIMULTANÉS → UN SEUL DÉBIT${Z}`);
  {
    const avant = await soldeCaisse();
    const [ligne] = await q(`SELECT net_salary FROM attendance_payroll_items_v2 WHERE id=$1`, [ligneB]);
    const net = Math.round(Number(ligne.net_salary));

    const corps = { payment_method: "CASHBOX", caisse_id: caisseId, payment_reference: "ESSAI-088-B" };
    const [a, b] = await Promise.all([
      appel("POST", `/attendance-v2/payroll-items/${ligneB}/pay`, tComptable, corps),
      appel("POST", `/attendance-v2/payroll-items/${ligneB}/pay`, tComptable, corps),
    ]);
    const reussites = [a, b].filter((x) => x.statut === 200).length;
    verifier("un seul des deux appels réussit", reussites === 1,
      `statuts ${a.statut}/${b.statut}`);

    const apres = await soldeCaisse();
    verifier("la caisse n'a été débitée qu'une fois", avant - apres === net,
      `${avant} → ${apres} pour un net de ${net}`);

    const [transactions] = await q(
      `SELECT count(*)::int AS n FROM accounting_transactions
        WHERE source_type='attendance_payroll_item' AND source_id=$1`, [ligneB]);
    verifier("une seule transaction comptable a été produite", transactions.n === 1, `${transactions.n}`);

    const [ecritures] = await q(
      `SELECT count(*)::int AS n FROM accounting_entries
        WHERE source_type='attendance_payroll_item' AND source_id=$1`, [ligneB]);
    verifier("deux écritures, une seule fois", ecritures.n === 2, `${ecritures.n}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}G. ANCIENNE PAIE SANS PÉRIODE → COMPORTEMENT HISTORIQUE${Z}`);
  {
    /* On reproduit exactement l'état laissé par la migration 088 : une paie
       sans période, marquée historique au moment du marquage. */
    const [ancienne] = await q(
      `INSERT INTO attendance_payroll_runs_v2
         (company_id, period_month, status, prepared_by, legacy_sans_validation)
       VALUES ($1,'2026-01-01','DRAFT',$2,true) RETURNING id`, [TRIANGLE, COMPTABLE]);
    const [ligne] = await q(
      `INSERT INTO attendance_payroll_items_v2
         (company_id, payroll_run_id, employee_id, employee_name, monthly_salary, daily_rate,
          expected_days, attended_days, absence_days, late_minutes,
          absence_deduction, adjustments, net_salary, status)
       VALUES ($1,$2,$3,'Essai 088 Employé A',50000,0,20,20,0,0,0,0,50000,'TO_PAY')
       RETURNING id`, [TRIANGLE, ancienne.id, employeA]);

    const avant = await soldeCaisse();
    const r = await appel("POST", `/attendance-v2/payroll-items/${ligne.id}/pay`, tComptable,
      { payment_method: "CASHBOX", caisse_id: caisseId, payment_reference: "ESSAI-088-HISTORIQUE" });
    verifier("une paie historique reste payable sans demande",
      r.statut === 200 && r.corps.item?.status === "PAID", JSON.stringify(r.corps).slice(0, 180));
    verifier("elle débite bien la caisse", avant - (await soldeCaisse()) === 50000);

    /* Et la contre-épreuve : la même paie SANS le drapeau historique est
       refusée. C'est ce qui garantit que l'exception ne s'élargit pas. */
    const [neuve] = await q(
      `INSERT INTO attendance_payroll_runs_v2
         (company_id, period_month, status, prepared_by, legacy_sans_validation)
       VALUES ($1,'2026-02-01','DRAFT',$2,false) RETURNING id`, [TRIANGLE, COMPTABLE]);
    const [ligneNeuve] = await q(
      `INSERT INTO attendance_payroll_items_v2
         (company_id, payroll_run_id, employee_id, employee_name, monthly_salary, daily_rate,
          expected_days, attended_days, absence_days, late_minutes,
          absence_deduction, adjustments, net_salary, status)
       VALUES ($1,$2,$3,'Essai 088 Employé A',50000,0,20,20,0,0,0,0,50000,'TO_PAY')
       RETURNING id`, [TRIANGLE, neuve.id, employeA]);

    const solde = await soldeCaisse();
    const refus = await appel("POST", `/attendance-v2/payroll-items/${ligneNeuve.id}/pay`, tComptable,
      { payment_method: "CASHBOX", caisse_id: caisseId });
    verifier("une paie NEUVE sans période et sans drapeau est refusée",
      refus.statut === 409 && refus.corps.code === "PAYROLL_NOT_SUBMITTED", JSON.stringify(refus.corps));
    verifier("la caisse n'a pas bougé", (await soldeCaisse()) === solde);

    const [marquees] = await q(
      `SELECT count(*)::int AS n FROM attendance_payroll_runs_v2
        WHERE legacy_sans_validation AND period_id IS NOT NULL`);
    verifier("aucune paie ne cumule une période ET le drapeau historique",
      marquees.n === 0, `${marquees.n}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}L'ANCIEN POINT D'ENTRÉE NE CRÉE PLUS DE PAIE ORPHELINE${Z}`);
  {
    const r = await appel("POST", `/attendance-v2/payroll/${PERIODE}/generate`, tComptable);
    verifier("il refuse quand la période est ouverte",
      r.statut === 409 && r.corps.code === "USE_PERIOD_ENDPOINT", JSON.stringify(r.corps));
    verifier("et indique la route à utiliser",
      String(r.corps.route || "").includes(`/paie/periodes/${PERIODE}/preparer`), r.corps.route);
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

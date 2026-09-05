"use strict";

/**
 * RAPPORTS DE POINTAGE, TABLEAU DE BORD ET NOTIFICATIONS (086 / 087).
 *
 *   bash scripts/test-rapports-tableau-bord.sh
 *
 * Ce que la suite prouve :
 *
 *   RAPPORTS   la valeur EFFECTIVE l'emporte sur la valeur brute ; chaque
 *              chiffre dit d'où il vient ; les durées sont en heures et
 *              minutes, jamais en décimal ; QR et MANUEL apparaissent dans le
 *              même rapport ; un jour férié n'est pas une absence ;
 *   TOTAUX     jours attendus, travaillés, absences, retards, samedis,
 *              journées incomplètes, corrections ;
 *   BORD       chaque nombre vient d'une requête sur la société active ;
 *   ALERTES    rafraîchir dix fois ne crée pas dix alertes ;
 *   ISOLATION  aucun chiffre d'une société ne fuit dans l'autre.
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
  jwt.sign({ id, fullname: `Compte ${id}`, email: `r${id}@essai.test`, role,
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

const TRIANGLE = 1, FATMAT = 2;
let ADMIN = 0, ADMIN_F = 0, siteId = 0, scheduleId = 0, empA = 0, empB = 0;

/* Semaine connue : lundi 2026-08-24 → dimanche 2026-08-30. */
const DU = "2026-08-24", AU = "2026-08-30";

async function poserLeJeu() {
  await pool.query(`DELETE FROM notifications WHERE event_key IS NOT NULL`);
  await pool.query(`DELETE FROM attendance_regularizations`);
  await pool.query(`DELETE FROM attendance_regularization_batches`);
  await pool.query(`DELETE FROM salary_advance_repayments`);
  await pool.query(`DELETE FROM salary_advance_installments`);
  await pool.query(`DELETE FROM salary_advances`);
  await pool.query(`DELETE FROM payroll_vouchers`);
  await pool.query(`DELETE FROM payroll_item_adjustments`);
  await pool.query(`DELETE FROM payroll_requests`);
  await pool.query(`DELETE FROM attendance_payroll_items_v2`);
  await pool.query(`DELETE FROM attendance_payroll_runs_v2`);
  await pool.query(`DELETE FROM attendance_salary_settings_v2`);
  await pool.query(`DELETE FROM attendance_day_record_corrections`);
  await pool.query(`DELETE FROM attendance_event_log_v2`);
  await pool.query(`DELETE FROM attendance_day_records_v2`);
  await pool.query(`DELETE FROM attendance_qr_scans`);
  await pool.query(`DELETE FROM attendance_badge_events`);
  await pool.query(`DELETE FROM attendance_badges`);
  await pool.query(`DELETE FROM attendance_operator_scopes`);
  await pool.query(`DELETE FROM attendance_employees`);
  await pool.query(`DELETE FROM attendance_holidays`);
  await pool.query(`DELETE FROM attendance_periods`);
  await pool.query(`DELETE FROM attendance_schedule_days WHERE schedule_id IN
      (SELECT id FROM attendance_work_schedules WHERE code='ESSAI-087')`);
  await pool.query(`DELETE FROM attendance_work_schedules WHERE code='ESSAI-087'`);
  await pool.query(`DELETE FROM attendance_work_sites WHERE code='ESSAI-087'`);
  await pool.query(`DELETE FROM client_deposit_refunds`);
  await pool.query(`DELETE FROM client_deposit_allocations`);
  await pool.query(`DELETE FROM client_deposits`);
  await pool.query(`DELETE FROM tax_payments`);
  await pool.query(`DELETE FROM tax_declarations`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'rap087-%@essai.test'`);

  const creer = async (email, nom, companyId) => (await pool.query(
    `INSERT INTO users (company_id, fullname, email, password, role, is_super_admin, is_active)
     VALUES ($1,$2,$3,'$non-utilisable$','admin',true,true) RETURNING id`,
    [companyId, nom, email])).rows[0].id;
  ADMIN   = await creer("rap087-admin@essai.test", "Essai 087 Admin", TRIANGLE);
  ADMIN_F = await creer("rap087-admin-f@essai.test", "Essai 087 Admin FAT", FATMAT);

  for (const c of [TRIANGLE, FATMAT]) {
    await pool.query(
      `INSERT INTO attendance_company_configuration (company_id, official_start_at, timezone, saturday_mode)
       VALUES ($1, now() - interval '400 days', 'Africa/Bamako', 'NORMAL')
       ON CONFLICT (company_id) DO UPDATE
         SET official_start_at = EXCLUDED.official_start_at, saturday_mode = 'NORMAL'`, [c]);
  }

  siteId = (await pool.query(
    `INSERT INTO attendance_work_sites (company_id, code, name, city, site_type, active)
     VALUES ($1,'ESSAI-087','Essai Site 087','Bamako','WAREHOUSE',true) RETURNING id`, [TRIANGLE])).rows[0].id;
  scheduleId = (await pool.query(
    `INSERT INTO attendance_work_schedules (company_id, code, name, active)
     VALUES ($1,'ESSAI-087','Lundi au samedi 08:00',true) RETURNING id`, [TRIANGLE])).rows[0].id;
  for (let j = 1; j <= 7; j += 1) {
    await pool.query(
      `INSERT INTO attendance_schedule_days (schedule_id, iso_weekday, is_working_day, start_time, end_time)
       VALUES ($1,$2,$3,'08:00','17:00')`, [scheduleId, j, j !== 7]);
  }

  const emp = async (numero, nom) => (await pool.query(
    `INSERT INTO attendance_employees
       (company_id, employee_number, full_name, site_id, schedule_id, job_title, phone, active, effective_from)
     VALUES ($1,$2,$3,$4,$5,'Manœuvre','',true, current_date - 400) RETURNING id`,
    [TRIANGLE, numero, nom, siteId, scheduleId])).rows[0].id;
  empA = await emp(8701, "Essai 087 Employé A");
  empB = await emp(8702, "Essai 087 Employé B");

  /* Le mercredi 26 est férié : il ne doit devenir ni une absence, ni un jour dû. */
  await pool.query(
    `INSERT INTO attendance_holidays (company_id, holiday_date, label)
     VALUES ($1,'2026-08-26','Jour férié d''essai')`, [TRIANGLE]);

  /* A : pointé lundi 24 (en retard de 30 min, source QR) et jeudi 27 (à l'heure,
     source MANUEL, sans départ → journée incomplète). */
  const record = async (employeeId, jour, arrivee, depart, statut, retard, minutes, source) => {
    const { rows } = await pool.query(
      `INSERT INTO attendance_day_records_v2
         (company_id, employee_id, work_date, check_in, check_out, status, late_minutes, worked_minutes)
       VALUES ($1,$2,$3::date, ($3::date + $4::time)::timestamptz,
               CASE WHEN $5::text IS NULL THEN NULL ELSE ($3::date + $5::time)::timestamptz END,
               $6,$7,$8) RETURNING id`,
      [TRIANGLE, employeeId, jour, arrivee, depart, statut, retard, minutes]);
    await pool.query(
      `INSERT INTO attendance_event_log_v2
         (company_id, employee_id, record_id, action_type, event_at, performed_by_name, source)
       VALUES ($1,$2,$3,'CHECK_IN', now(), 'Essai', $4)`,
      [TRIANGLE, employeeId, rows[0].id, source]);
    return rows[0].id;
  };
  await record(empA, "2026-08-24", "08:30", "17:00", "LATE", 30, 450, "QR");
  await record(empA, "2026-08-27", "08:00", null, "PRESENT", 0, 0, "MANUEL");

  /* B : rien pointé, mais mardi 25 régularisé, et vendredi 28 régularisé puis
     marqué absent par-dessus. */
  await pool.query(
    `INSERT INTO attendance_regularizations
       (company_id, employee_id, work_date, effective_check_in, effective_check_out,
        effective_status, reason, performed_by_name)
     VALUES ($1,$2,'2026-08-25', ('2026-08-25'::date + '08:00'::time)::timestamptz,
             ('2026-08-25'::date + '17:00'::time)::timestamptz, 'PRESENT',
             'Mise en service du pointage', 'Essai')`, [TRIANGLE, empB]);
  await pool.query(
    `INSERT INTO attendance_regularizations
       (company_id, employee_id, work_date, effective_check_in, effective_check_out,
        effective_status, reason, performed_by_name,
        overridden_at, overridden_status, override_reason)
     VALUES ($1,$2,'2026-08-28', ('2026-08-28'::date + '08:00'::time)::timestamptz,
             ('2026-08-28'::date + '17:00'::time)::timestamptz, 'PRESENT',
             'Mise en service du pointage', 'Essai',
             now(), 'ABSENT', 'Absent constaté par le chef de chantier.')`, [TRIANGLE, empB]);
}

async function main() {
  console.log(`\n${G}RAPPORTS, TABLEAU DE BORD ET NOTIFICATIONS (086 / 087)${Z}`);
  await poserLeJeu();
  const tA = jeton(ADMIN, "admin", TRIANGLE, true);
  const tF = jeton(ADMIN_F, "admin", FATMAT, true);

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}RAPPORT INDIVIDUEL — LA VALEUR EFFECTIVE L'EMPORTE${Z}`);
  {
    const r = await appel("GET", `/pointage/rapports/employe/${empB}?du=${DU}&au=${AU}`, tA);
    verifier("le rapport s'établit", r.statut === 200, JSON.stringify(r.corps).slice(0, 150));
    verifier("il porte l'identité de la société et l'auteur de l'impression",
      Boolean(r.corps.entete?.societe?.name) && Boolean(r.corps.entete?.imprime_par),
      JSON.stringify(r.corps.entete));

    const parJour = Object.fromEntries((r.corps.journees || []).map((j) => [j.jour, j]));
    verifier("la journée régularisée du 25 est PRÉSENTE, source régularisation",
      parJour["2026-08-25"]?.statut === "PRESENT" && parJour["2026-08-25"]?.source === "regularisation",
      JSON.stringify(parJour["2026-08-25"]));
    verifier("son motif est repris",
      /Mise en service/.test(parJour["2026-08-25"]?.motif || ""), parJour["2026-08-25"]?.motif);

    verifier("l'absence marquée par-dessus le 28 l'emporte sur la régularisation",
      parJour["2026-08-28"]?.statut === "ABSENT"
      && parJour["2026-08-28"]?.source === "correction_administrative",
      JSON.stringify(parJour["2026-08-28"]));
    verifier("et son motif est celui de la correction",
      /chef de chantier/.test(parJour["2026-08-28"]?.motif || ""), parJour["2026-08-28"]?.motif);

    verifier("le mercredi férié est FERIE, pas une absence",
      parJour["2026-08-26"]?.statut === "FERIE", JSON.stringify(parJour["2026-08-26"]));
    verifier("et il n'est pas compté comme jour dû",
      parJour["2026-08-26"]?.du === false, JSON.stringify(parJour["2026-08-26"]?.du));

    verifier("le dimanche est REPOS",
      parJour["2026-08-30"]?.statut === "REPOS", JSON.stringify(parJour["2026-08-30"]));
    verifier("le samedi est un jour dû (mode NORMAL)",
      parJour["2026-08-29"]?.du === true, JSON.stringify(parJour["2026-08-29"]));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LES TOTAUX${Z}`);
  {
    const r = await appel("GET", `/pointage/rapports/employe/${empA}?du=${DU}&au=${AU}`, tA);
    const t = r.corps.totaux;
    /* Lun 24, mar 25, mer 26 (férié), jeu 27, ven 28, sam 29, dim 30.
       Jours dus : 24, 25, 27, 28, 29 = 5. */
    verifier("cinq jours dus (férié et dimanche exclus)", t.jours_attendus === 5, `${t.jours_attendus}`);
    verifier("deux jours travaillés", t.jours_travailles === 2, `${t.jours_travailles}`);
    verifier("trois absences", t.absences === 3, `${t.absences}`);
    verifier("un retard, de 30 minutes",
      t.retards === 1 && t.minutes_retard === 30, JSON.stringify({ r: t.retards, m: t.minutes_retard }));
    verifier("une journée incomplète (jeudi sans départ)",
      t.journees_incompletes === 1, `${t.journees_incompletes}`);
    verifier("un jour férié compté comme tel", t.feries === 1, `${t.feries}`);
    verifier("un jour de repos", t.repos === 1, `${t.repos}`);

    verifier("la durée est en heures et minutes, jamais en décimal",
      /^\d+ h \d{2}$/.test(t.duree_travaillee), t.duree_travaillee);
    verifier("le retard cumulé aussi", /^\d+ h \d{2}$/.test(t.retard_cumule), t.retard_cumule);
    verifier("7 h 30 de travail (450 minutes)", t.duree_travaillee === "7 h 30", t.duree_travaillee);
    verifier("0 h 30 de retard", t.retard_cumule === "0 h 30", t.retard_cumule);

    verifier("QR et MANUEL apparaissent dans le MÊME rapport",
      t.par_source.QR === 1 && t.par_source.MANUEL === 1, JSON.stringify(t.par_source));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}RAPPORT GLOBAL${Z}`);
  {
    const r = await appel("GET", `/pointage/rapports/global?du=${DU}&au=${AU}`, tA);
    verifier("le rapport global s'établit", r.statut === 200);
    verifier("il couvre les deux employés", r.corps.effectif === 2, `${r.corps.effectif}`);
    verifier("chaque employé porte son matricule et son site",
      (r.corps.employes || []).every((e) => e.matricule && e.site), JSON.stringify(r.corps.employes?.[0]));
    verifier("les totaux généraux cumulent les deux",
      r.corps.totaux_generaux?.jours_attendus === 10, `${r.corps.totaux_generaux?.jours_attendus}`);

    const parRetard = await appel("GET", `/pointage/rapports/global?du=${DU}&au=${AU}&statut=LATE`, tA);
    verifier("le filtre « retard » ne garde que qui en a",
      (parRetard.corps.employes || []).length === 1
      && parRetard.corps.employes[0].employee_id === empA,
      JSON.stringify((parRetard.corps.employes || []).map((e) => e.nom)));

    const parSite = await appel("GET", `/pointage/rapports/global?du=${DU}&au=${AU}&site=${siteId}`, tA);
    verifier("le filtre par site fonctionne", parSite.corps.effectif === 2, `${parSite.corps.effectif}`);

    const autreSite = await appel("GET", `/pointage/rapports/global?du=${DU}&au=${AU}&site=999999`, tA);
    verifier("un site inconnu ne renvoie personne", autreSite.corps.effectif === 0, `${autreSite.corps.effectif}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}ISOLATION DES RAPPORTS${Z}`);
  {
    const croise = await appel("GET", `/pointage/rapports/employe/${empA}?du=${DU}&au=${AU}`, tF);
    verifier("FAT & MAT ne lit pas le rapport d'un employé Triangle",
      croise.statut === 404, JSON.stringify(croise.corps).slice(0, 120));

    const global = await appel("GET", `/pointage/rapports/global?du=${DU}&au=${AU}`, tF);
    verifier("son rapport global est vide", global.corps.effectif === 0, `${global.corps.effectif}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}TABLEAU DE BORD${Z}`);
  {
    /* D'autres suites laissent des comptes en base. On mesure donc l'ÉCART
       produit par nos propres comptes, pas un total absolu : un test qui
       exigerait un chiffre rond dépendrait de l'ordre d'exécution, pour une
       raison sans rapport avec ce qu'il vérifie. */
    const avant = (await appel("GET", "/tableau-de-bord", tA)).corps.tresorerie;

    await pool.query(
      `INSERT INTO accounting_banks (company_id, bank_name, account_number, currency,
         initial_balance, current_balance, is_active)
       VALUES ($1,'Banque Essai 087','B087','FCFA',3000000,3000000,true)`, [TRIANGLE]);
    await pool.query(
      `INSERT INTO caisses (company_id, nom_caisse, solde_initial, solde_actuel, actif)
       VALUES ($1,'Caisse Essai 087',500000,500000,true)`, [TRIANGLE]);

    const r = await appel("GET", "/tableau-de-bord", tA);
    verifier("le tableau de bord répond", r.statut === 200, JSON.stringify(r.corps).slice(0, 150));
    verifier("la banque ajoutée fait monter le total de 3 000 000",
      Number(r.corps.tresorerie?.banques) - Number(avant?.banques) === 3000000,
      `${avant?.banques} → ${r.corps.tresorerie?.banques}`);
    verifier("la caisse ajoutée le fait monter de 500 000",
      Number(r.corps.tresorerie?.caisses) - Number(avant?.caisses) === 500000,
      `${avant?.caisses} → ${r.corps.tresorerie?.caisses}`);
    verifier("le total est la somme des trois natures",
      Number(r.corps.tresorerie?.total) ===
        Number(r.corps.tresorerie?.banques) + Number(r.corps.tresorerie?.caisses)
        + Number(r.corps.tresorerie?.compte_general),
      JSON.stringify(r.corps.tresorerie));
    verifier("il présente acomptes, avances, créances et fiscalité",
      r.corps.acomptes && r.corps.avances && r.corps.creances_clients && r.corps.fiscalite,
      JSON.stringify(Object.keys(r.corps)));

    /* FAT & MAT a ses propres comptes, laissés par d'autres suites : on ne
       vérifie donc pas qu'elle voit zéro, mais qu'elle voit EXACTEMENT ses
       comptes à elle — ce qui est la vraie question d'isolation. */
    const chezFatmat = await appel("GET", "/tableau-de-bord", tF);
    const [reelFatmat] = await q(
      `SELECT COALESCE(sum(current_balance),0) AS total, count(*)::int AS n
         FROM accounting_banks WHERE company_id=$1 AND COALESCE(is_active,true)`, [FATMAT]);
    verifier("FAT & MAT voit exactement ses propres banques, ni plus ni moins",
      Number(chezFatmat.corps.tresorerie?.banques) === Number(reelFatmat.total)
      && Number(chezFatmat.corps.tresorerie?.nombre_banques) === Number(reelFatmat.n),
      `vu ${chezFatmat.corps.tresorerie?.banques} / réel ${reelFatmat.total}`);
    verifier("et la banque de Triangle n'y figure pas",
      Number(chezFatmat.corps.tresorerie?.banques) < Number(r.corps.tresorerie?.banques),
      `${chezFatmat.corps.tresorerie?.banques} vs ${r.corps.tresorerie?.banques}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LES ALERTES NE SE RÉPÈTENT PAS${Z}`);
  {
    /* Une période terminée et non contrôlée : de quoi produire une alerte. */
    await pool.query(
      `INSERT INTO attendance_periods (company_id, code, date_debut, date_fin, status)
       VALUES ($1,'2026-08','2026-07-25','2026-08-24','OUVERTE')`, [TRIANGLE]);

    const premier = await appel("POST", "/notifications-metier/rafraichir", tA);
    verifier("le premier rafraîchissement crée des alertes",
      premier.statut === 200 && premier.corps.creees > 0, JSON.stringify(premier.corps));

    const total1 = Number((await q(
      `SELECT count(*)::int AS n FROM notifications WHERE company_id=$1 AND event_key IS NOT NULL`,
      [TRIANGLE]))[0].n);

    for (let i = 0; i < 5; i += 1) await appel("POST", "/notifications-metier/rafraichir", tA);
    const total2 = Number((await q(
      `SELECT count(*)::int AS n FROM notifications WHERE company_id=$1 AND event_key IS NOT NULL`,
      [TRIANGLE]))[0].n);
    verifier("cinq rafraîchissements de plus ne créent RIEN", total2 === total1, `${total1} → ${total2}`);

    const liste = await appel("GET", "/notifications-metier", tA);
    verifier("les alertes sont lisibles", liste.statut === 200 && (liste.corps.notifications || []).length > 0,
      `${(liste.corps.notifications || []).length}`);
    verifier("elles portent une clé d'événement",
      (liste.corps.notifications || []).every((n) => n.event_key));

    const une = liste.corps.notifications[0];
    const lue = await appel("POST", `/notifications-metier/${une.id}/lue`, tA);
    verifier("une alerte se marque comme lue", lue.statut === 200 && lue.corps.ok === true);

    const apres = await appel("GET", "/notifications-metier", tA);
    verifier("elle disparaît des non lues",
      !(apres.corps.notifications || []).some((n) => n.id === une.id));

    const chezFatmat = await appel("GET", "/notifications-metier", tF);
    verifier("FAT & MAT ne reçoit aucune alerte de Triangle",
      (chezFatmat.corps.notifications || []).length === 0,
      `${(chezFatmat.corps.notifications || []).length}`);
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

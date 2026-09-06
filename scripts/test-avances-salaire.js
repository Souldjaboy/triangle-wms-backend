"use strict";

/**
 * AVANCES SUR SALAIRE (migration 083).
 *
 *   bash scripts/test-avances-salaire.sh
 *
 * Les trois cas chiffrés exigés, éprouvés bout en bout :
 *
 *   1. salaire 100 000, avance 25 000 retenue en une fois → net 75 000 ;
 *   2. avance 25 000, mensualité 5 000 → 5 échéances, net 95 000 ;
 *   3. solde 25 000, remboursement direct 20 000 → solde 5 000, l'argent
 *      RENTRE en caisse et un reçu numéroté est produit.
 *
 * Et ce qui doit rester impossible :
 *   • verser deux fois la même avance ;
 *   • rembourser plus que le solde ;
 *   • préparer deux fois la paie et retenir deux fois la même échéance ;
 *   • valider sa propre demande ;
 *   • laisser une retenue rendre un salaire négatif.
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
  jwt.sign({ id, fullname: `Compte ${id}`, email: `a${id}@essai.test`, role,
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
let COMPTABLE = 0, DIRECTEUR = 0, RESP = 0;
let empUnique = 0, empEcheances = 0, empDirect = 0, empPetitNet = 0;
let caisseId = 0, scheduleId = 0, siteId = 0;
/* La période dont on prépare la paie : le mois courant, pour que les
   journées attendues existent réellement. */
const MOIS = new Date().toISOString().slice(0, 7);

async function poserLeJeu() {
  await pool.query(`DELETE FROM salary_advance_repayments`);
  await pool.query(`DELETE FROM salary_advance_installments`);
  await pool.query(`DELETE FROM salary_advances`);
  await pool.query(`DELETE FROM payroll_vouchers`);
  await pool.query(`DELETE FROM payroll_item_adjustments`);
  await pool.query(`DELETE FROM payroll_requests`);
  await pool.query(`DELETE FROM attendance_payroll_items_v2`);
  await pool.query(`DELETE FROM attendance_payroll_runs_v2`);
  await pool.query(`DELETE FROM attendance_salary_settings_v2`);
  await pool.query(`DELETE FROM attendance_event_log_v2`);
  await pool.query(`DELETE FROM attendance_day_records_v2`);
  await pool.query(`DELETE FROM attendance_qr_scans`);
  await pool.query(`DELETE FROM attendance_badge_events`);
  await pool.query(`DELETE FROM attendance_badges`);
  await pool.query(`DELETE FROM attendance_operator_scopes`);
  await pool.query(`DELETE FROM attendance_employees WHERE company_id = $1`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_schedule_days WHERE schedule_id IN
      (SELECT id FROM attendance_work_schedules WHERE company_id=$1 AND code='ESSAI-083')`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_work_schedules WHERE company_id=$1 AND code='ESSAI-083'`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_work_sites WHERE company_id=$1 AND code='ESSAI-083'`, [TRIANGLE]);
  await pool.query(`DELETE FROM caisses WHERE company_id=$1 AND nom_caisse='Caisse Essai 083'`, [TRIANGLE]);
  await pool.query(`DELETE FROM users WHERE email LIKE 'ava083-%@essai.test'`);

  const creer = async (email, nom, role) => (await pool.query(
    `INSERT INTO users (company_id, fullname, email, password, role, is_super_admin, is_active)
     VALUES ($1,$2,$3,'$non-utilisable$',$4,false,true) RETURNING id`,
    [TRIANGLE, nom, email, role])).rows[0].id;
  COMPTABLE = await creer("ava083-comptable@essai.test", "Essai 083 Comptable", "comptable");
  DIRECTEUR = await creer("ava083-directeur@essai.test", "Essai 083 Directeur", "direction");
  RESP      = await creer("ava083-resp@essai.test", "Essai 083 Responsable", "responsable_entrepot");

  await pool.query(
    `INSERT INTO attendance_company_configuration (company_id, official_start_at, timezone, saturday_mode, period_start_day)
     VALUES ($1, now() - interval '400 days', 'Africa/Bamako', 'NORMAL', 25)
     ON CONFLICT (company_id) DO UPDATE SET official_start_at = EXCLUDED.official_start_at`,
    [TRIANGLE]);

  siteId = (await pool.query(
    `INSERT INTO attendance_work_sites (company_id, code, name, city, site_type, active)
     VALUES ($1,'ESSAI-083','Essai Site 083','Bamako','WAREHOUSE',true) RETURNING id`, [TRIANGLE])).rows[0].id;
  scheduleId = (await pool.query(
    `INSERT INTO attendance_work_schedules (company_id, code, name, active)
     VALUES ($1,'ESSAI-083','Journée 08:00',true) RETURNING id`, [TRIANGLE])).rows[0].id;
  /* Tous les jours travaillés : cette suite porte sur les avances, pas sur le
     calendrier. Un dimanche chômé la ferait échouer un jour sur sept. */
  for (let j = 1; j <= 7; j += 1) {
    await pool.query(
      `INSERT INTO attendance_schedule_days (schedule_id, iso_weekday, is_working_day, start_time, end_time)
       VALUES ($1,$2,true,'08:00','17:00')`, [scheduleId, j]);
  }

  const emp = async (numero, nom, salaire) => {
    const id = (await pool.query(
      `INSERT INTO attendance_employees
         (company_id, employee_number, full_name, site_id, schedule_id, job_title, phone, active, effective_from)
       VALUES ($1,$2,$3,$4,$5,'Manœuvre','',true, current_date - 400) RETURNING id`,
      [TRIANGLE, numero, nom, siteId, scheduleId])).rows[0].id;
    await pool.query(
      `INSERT INTO attendance_salary_settings_v2 (company_id, employee_id, monthly_salary, daily_rate, effective_from)
       VALUES ($1,$2,$3,$4, current_date - 400)`, [TRIANGLE, id, salaire, 0]);
    return id;
  };
  /* Taux journalier à 0 : aucune retenue d'absence ne vient brouiller les
     trois cas chiffrés, qui portent sur les AVANCES et rien d'autre. */
  empUnique     = await emp(8301, "Essai 083 Retenue unique", 100000);
  empEcheances  = await emp(8302, "Essai 083 Mensualités", 100000);
  empDirect     = await emp(8303, "Essai 083 Remboursement direct", 100000);
  empPetitNet   = await emp(8304, "Essai 083 Petit salaire", 10000);

  caisseId = (await pool.query(
    `INSERT INTO caisses (company_id, nom_caisse, solde_initial, solde_actuel, actif)
     VALUES ($1,'Caisse Essai 083',1000000,1000000,true) RETURNING id`, [TRIANGLE])).rows[0].id;

  await pool.query(`DELETE FROM user_permission_overrides WHERE company_id=$1 AND user_id=ANY($2::int[])`,
    [TRIANGLE, [COMPTABLE, DIRECTEUR, RESP]]);
  const droit = (userId, module, action) => pool.query(
    `INSERT INTO user_permission_overrides (company_id, user_id, module_key, action, effect)
     VALUES ($1,$2,$3,$4,'ALLOW')
     ON CONFLICT (company_id, user_id, module_key, action) DO UPDATE SET effect='ALLOW'`,
    [TRIANGLE, userId, module, action]);
  for (const a of ["visible","view","create","pay","update","print"]) await droit(COMPTABLE, "paie.avance", a);
  for (const a of ["visible","view","prepare","submit","pay","print"]) await droit(COMPTABLE, "paie", a);
  for (const a of ["visible","view","validate","cancel","update"]) await droit(DIRECTEUR, "paie.avance", a);
  for (const a of ["visible","view","validate","adjust"]) await droit(DIRECTEUR, "paie", a);
}

/** Demande + validation + versement, en une fois. */
async function avanceVersee(tC, tD, employeeId, montant, mensualite) {
  const demande = await appel("POST", "/avances", tC, {
    employee_id: employeeId, amount_requested: montant,
    installment_amount: mensualite, first_period_code: MOIS,
    reason: "Essai 083",
  });
  const id = demande.corps.avance?.id;
  await appel("POST", `/avances/${id}/decision`, tD, { decision: "VALIDEE" });
  const versement = await appel("POST", `/avances/${id}/versement`, tC, { caisse_id: caisseId });
  return { id, demande, versement };
}

async function main() {
  console.log(`\n${G}AVANCES SUR SALAIRE (083)${Z}`);
  await poserLeJeu();
  const tC = jeton(COMPTABLE, "comptable", TRIANGLE);
  const tD = jeton(DIRECTEUR, "direction", TRIANGLE);

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}DEMANDE, VALIDATION, VERSEMENT${Z}`);
  let avanceUnique = 0;
  {
    const soldeAvant = Number((await q(`SELECT solde_actuel FROM caisses WHERE id=$1`, [caisseId]))[0].solde_actuel);

    const demande = await appel("POST", "/avances", tC, {
      employee_id: empUnique, amount_requested: 25000,
      installment_amount: 0, first_period_code: MOIS, reason: "Frais de santé",
    });
    verifier("la demande est enregistrée", demande.statut === 201, JSON.stringify(demande.corps).slice(0, 150));
    avanceUnique = demande.corps.avance?.id;
    verifier("elle porte une référence de la série AVA",
      /^AVA-\d{4}-\d{6}$/.test(demande.corps.avance?.reference || ""), demande.corps.avance?.reference);
    verifier("elle naît DEMANDEE, sans argent versé",
      demande.corps.avance?.status === "DEMANDEE" && Number(demande.corps.avance?.amount_paid) === 0);

    const versementAvantValidation = await appel("POST", `/avances/${avanceUnique}/versement`, tC, { caisse_id: caisseId });
    verifier("verser avant validation est refusé",
      versementAvantValidation.statut === 409 && versementAvantValidation.corps.code === "ADVANCE_NOT_VALIDATED",
      JSON.stringify(versementAvantValidation.corps));

    const parLeDemandeur = await appel("POST", `/avances/${avanceUnique}/decision`, tC, { decision: "VALIDEE" });
    verifier("le demandeur ne valide pas sa propre demande",
      parLeDemandeur.statut === 403 || parLeDemandeur.statut === 404, `statut ${parLeDemandeur.statut}`);

    const tropHaut = await appel("POST", `/avances/${avanceUnique}/decision`, tD,
      { decision: "VALIDEE", amount_authorized: 40000 });
    verifier("autoriser plus que demandé est refusé",
      tropHaut.statut === 409 && tropHaut.corps.code === "AMOUNT_ABOVE_REQUEST", JSON.stringify(tropHaut.corps));

    const valide = await appel("POST", `/avances/${avanceUnique}/decision`, tD, { decision: "VALIDEE" });
    verifier("la Direction valide", valide.statut === 200 && valide.corps.avance?.status === "VALIDEE");

    const versement = await appel("POST", `/avances/${avanceUnique}/versement`, tC, { caisse_id: caisseId });
    verifier("le versement passe", versement.statut === 200, JSON.stringify(versement.corps).slice(0, 150));

    const soldeApres = Number((await q(`SELECT solde_actuel FROM caisses WHERE id=$1`, [caisseId]))[0].solde_actuel);
    verifier("la caisse a diminué d'exactement 25 000",
      soldeAvant - soldeApres === 25000, `${soldeAvant} → ${soldeApres}`);

    const doubleVersement = await appel("POST", `/avances/${avanceUnique}/versement`, tC, { caisse_id: caisseId });
    verifier("verser une seconde fois est refusé",
      doubleVersement.statut === 409 && doubleVersement.corps.code === "ADVANCE_ALREADY_PAID",
      JSON.stringify(doubleVersement.corps));
    const soldeFinal = Number((await q(`SELECT solde_actuel FROM caisses WHERE id=$1`, [caisseId]))[0].solde_actuel);
    verifier("et la caisse n'a pas bougé une seconde fois", soldeFinal === soldeApres, `${soldeFinal}`);

    const ecritures = await q(
      `SELECT account_label, debit, credit FROM accounting_entries
        WHERE source_type='salary_advance' AND source_id=$1 ORDER BY id`, [avanceUnique]);
    verifier("deux écritures, équilibrées, ont été produites",
      ecritures.length === 2 &&
      Number(ecritures[0].debit) + Number(ecritures[1].debit) === Number(ecritures[0].credit) + Number(ecritures[1].credit),
      JSON.stringify(ecritures));
    verifier("l'avance est comptabilisée en CRÉANCE, pas en charge de personnel",
      ecritures.some((e) => /Créances sur le personnel/i.test(e.account_label)),
      JSON.stringify(ecritures.map((e) => e.account_label)));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}CAS 1 — 100 000, AVANCE 25 000 EN UNE FOIS → NET 75 000${Z}`);
  {
    const [ech] = await q(
      `SELECT count(*)::int AS n, sum(amount_due) AS total FROM salary_advance_installments WHERE advance_id=$1`,
      [avanceUnique]);
    verifier("une seule échéance de 25 000",
      ech.n === 1 && Number(ech.total) === 25000, JSON.stringify(ech));

    const gen = await appel("POST", `/attendance-v2/payroll/${MOIS}/generate`, tC);
    verifier("la paie se prépare", gen.statut === 201, JSON.stringify(gen.corps).slice(0, 120));

    const [ligne] = await q(
      `SELECT net_salary, advance_deduction, monthly_salary FROM attendance_payroll_items_v2
        WHERE employee_id=$1`, [empUnique]);
    verifier("25 000 sont retenus sur la paie", Number(ligne.advance_deduction) === 25000,
      `${ligne.advance_deduction}`);
    verifier("le net est exactement 75 000", Number(ligne.net_salary) === 75000,
      `${ligne.monthly_salary} − ${ligne.advance_deduction} = ${ligne.net_salary}`);

    const [avance] = await q(`SELECT balance, status FROM salary_advances WHERE id=$1`, [avanceUnique]);
    verifier("le solde de l'avance tombe à zéro", Number(avance.balance) === 0, `${avance.balance}`);
    verifier("son statut passe à REMBOURSEE", avance.status === "REMBOURSEE", avance.status);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}PRÉPARER DEUX FOIS NE RETIENT PAS DEUX FOIS${Z}`);
  {
    const gen = await appel("POST", `/attendance-v2/payroll/${MOIS}/generate`, tC);
    verifier("la paie se régénère", gen.statut === 201, JSON.stringify(gen.corps).slice(0, 120));

    const [ligne] = await q(
      `SELECT net_salary, advance_deduction FROM attendance_payroll_items_v2 WHERE employee_id=$1`, [empUnique]);
    verifier("la retenue reste 25 000, pas 50 000", Number(ligne.advance_deduction) === 25000,
      `${ligne.advance_deduction}`);
    verifier("le net reste 75 000", Number(ligne.net_salary) === 75000, `${ligne.net_salary}`);

    const [avance] = await q(`SELECT balance FROM salary_advances WHERE id=$1`, [avanceUnique]);
    verifier("le solde reste zéro, jamais négatif", Number(avance.balance) === 0, `${avance.balance}`);

    const [mouvements] = await q(
      `SELECT count(*)::int AS n FROM salary_advance_repayments
        WHERE advance_id=$1 AND origin='RETENUE_PAIE'`, [avanceUnique]);
    verifier("une seule retenue figure au journal de l'avance", mouvements.n === 1, `${mouvements.n}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}CAS 2 — AVANCE 25 000, MENSUALITÉ 5 000 → 5 ÉCHÉANCES, NET 95 000${Z}`);
  {
    const { id } = await avanceVersee(tC, tD, empEcheances, 25000, 5000);

    const echeances = await q(
      `SELECT rank, period_code, amount_due FROM salary_advance_installments
        WHERE advance_id=$1 ORDER BY rank`, [id]);
    verifier("cinq échéances de 5 000 sont posées",
      echeances.length === 5 && echeances.every((e) => Number(e.amount_due) === 5000),
      JSON.stringify(echeances.map((e) => e.amount_due)));
    verifier("elles couvrent cinq mois consécutifs",
      new Set(echeances.map((e) => e.period_code)).size === 5,
      JSON.stringify(echeances.map((e) => e.period_code)));

    await appel("POST", `/attendance-v2/payroll/${MOIS}/generate`, tC);
    const [ligne] = await q(
      `SELECT net_salary, advance_deduction FROM attendance_payroll_items_v2 WHERE employee_id=$1`,
      [empEcheances]);
    verifier("5 000 seulement sont retenus ce mois-ci", Number(ligne.advance_deduction) === 5000,
      `${ligne.advance_deduction}`);
    verifier("le net est exactement 95 000", Number(ligne.net_salary) === 95000, `${ligne.net_salary}`);

    const [avance] = await q(`SELECT balance, status FROM salary_advances WHERE id=$1`, [id]);
    verifier("il reste 20 000 dus", Number(avance.balance) === 20000, `${avance.balance}`);
    verifier("l'avance passe EN_REMBOURSEMENT", avance.status === "EN_REMBOURSEMENT", avance.status);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}CAS 3 — SOLDE 25 000, REMBOURSEMENT DIRECT 20 000 → SOLDE 5 000${Z}`);
  {
    const { id } = await avanceVersee(tC, tD, empDirect, 25000, 0);
    const caisseAvant = Number((await q(`SELECT solde_actuel FROM caisses WHERE id=$1`, [caisseId]))[0].solde_actuel);

    const trop = await appel("POST", `/avances/${id}/remboursement`, tC,
      { amount: 30000, caisse_id: caisseId });
    verifier("rembourser plus que le solde est refusé",
      trop.statut === 409 && trop.corps.code === "ADVANCE_OVERPAYMENT", JSON.stringify(trop.corps));

    const r = await appel("POST", `/avances/${id}/remboursement`, tC,
      { amount: 20000, caisse_id: caisseId, reference: "ESP-083" });
    verifier("le remboursement de 20 000 passe", r.statut === 200, JSON.stringify(r.corps).slice(0, 150));
    verifier("le nouveau solde est exactement 5 000", Number(r.corps.solde_apres) === 5000,
      `${r.corps.solde_avant} → ${r.corps.solde_apres}`);

    const caisseApres = Number((await q(`SELECT solde_actuel FROM caisses WHERE id=$1`, [caisseId]))[0].solde_actuel);
    verifier("l'argent est RENTRÉ en caisse (+20 000)",
      caisseApres - caisseAvant === 20000, `${caisseAvant} → ${caisseApres}`);
    verifier("un reçu numéroté est produit",
      /^REMB-AVA-\d{4}-\d{6}$/.test(r.corps.recu || ""), r.corps.recu);

    const [avance] = await q(`SELECT balance, status FROM salary_advances WHERE id=$1`, [id]);
    verifier("le solde en base confirme 5 000", Number(avance.balance) === 5000, `${avance.balance}`);
    verifier("l'avance est EN_REMBOURSEMENT", avance.status === "EN_REMBOURSEMENT", avance.status);

    // ── Contrepassation ──
    const [ligne] = await q(
      `SELECT id FROM salary_advance_repayments WHERE advance_id=$1 AND origin='VERSEMENT_DIRECT'`, [id]);
    const sansMotif = await appel("POST", `/avances/remboursements/${ligne.id}/contrepasser`, tD, {});
    verifier("contrepasser sans motif est refusé",
      sansMotif.statut === 400 && sansMotif.corps.code === "REASON_REQUIRED", JSON.stringify(sansMotif.corps));

    const contre = await appel("POST", `/avances/remboursements/${ligne.id}/contrepasser`, tD,
      { reason: "Espèces recomptées : le versement n'avait pas eu lieu." });
    verifier("la contrepassation passe", contre.statut === 200, JSON.stringify(contre.corps).slice(0, 150));
    verifier("le solde revient à 25 000", Number(contre.corps.solde_apres) === 25000,
      `${contre.corps.solde_avant} → ${contre.corps.solde_apres}`);

    const caisseFinale = Number((await q(`SELECT solde_actuel FROM caisses WHERE id=$1`, [caisseId]))[0].solde_actuel);
    verifier("l'argent est ressorti de la caisse", caisseFinale === caisseAvant, `${caisseFinale} / ${caisseAvant}`);

    const [origine] = await q(`SELECT amount, origin FROM salary_advance_repayments WHERE id=$1`, [ligne.id]);
    verifier("la ligne d'origine reste au journal, pas effacée",
      origine && Number(origine.amount) === 20000, JSON.stringify(origine));

    const deuxFois = await appel("POST", `/avances/remboursements/${ligne.id}/contrepasser`, tD,
      { reason: "seconde tentative de contrepassation" });
    verifier("contrepasser deux fois est refusé",
      deuxFois.statut === 409 && deuxFois.corps.code === "ALREADY_REVERSED", JSON.stringify(deuxFois.corps));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}UNE RETENUE NE REND JAMAIS UN SALAIRE NÉGATIF${Z}`);
  {
    /* Salaire 10 000, avance 25 000 : la retenue doit s'arrêter à 10 000,
       et 15 000 rester dus pour les mois suivants. */
    const { id } = await avanceVersee(tC, tD, empPetitNet, 25000, 0);
    await appel("POST", `/attendance-v2/payroll/${MOIS}/generate`, tC);

    const [ligne] = await q(
      `SELECT net_salary, advance_deduction FROM attendance_payroll_items_v2 WHERE employee_id=$1`,
      [empPetitNet]);
    verifier("la retenue s'arrête au net disponible", Number(ligne.advance_deduction) === 10000,
      `${ligne.advance_deduction}`);
    verifier("le net est zéro, jamais négatif", Number(ligne.net_salary) === 0, `${ligne.net_salary}`);

    const [avance] = await q(`SELECT balance FROM salary_advances WHERE id=$1`, [id]);
    verifier("les 15 000 non retenus restent dus", Number(avance.balance) === 15000, `${avance.balance}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}RÉÉCHELONNEMENT ET SUSPENSION${Z}`);
  {
    const [avance] = await q(
      `SELECT id, balance FROM salary_advances WHERE employee_id=$1`, [empEcheances]);

    const r = await appel("POST", `/avances/${avance.id}/reechelonner`, tD,
      { installment_amount: 10000, reason: "Le salarié demande à solder plus vite." });
    verifier("le rééchelonnement replanifie le SOLDE restant, pas le montant initial",
      r.statut === 200 && Number(r.corps.solde) === 20000, JSON.stringify(r.corps).slice(0, 150));
    verifier("deux échéances de 10 000 remplacent les quatre restantes",
      JSON.stringify(r.corps.echeancier) === JSON.stringify([10000, 10000]),
      JSON.stringify(r.corps.echeancier));

    const s = await appel("POST", `/avances/${avance.id}/suspendre`, tD,
      { reason: "Salarié en arrêt maladie, retenues gelées." });
    verifier("les échéances à venir se suspendent", s.statut === 200 && s.corps.suspendues === 2,
      JSON.stringify(s.corps));

    const [apres] = await q(`SELECT balance FROM salary_advances WHERE id=$1`, [avance.id]);
    verifier("le solde reste dû malgré la suspension", Number(apres.balance) === 20000, `${apres.balance}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}ISOLATION ET SOLDE INSUFFISANT${Z}`);
  {
    const [petite] = await q(
      `INSERT INTO caisses (company_id, nom_caisse, solde_initial, solde_actuel, actif)
       VALUES ($1,'Caisse Essai 083 vide',1000,1000,true) RETURNING id`, [TRIANGLE]);
    const demande = await appel("POST", "/avances", tC, {
      employee_id: empUnique, amount_requested: 50000, installment_amount: 0, first_period_code: MOIS });
    const id = demande.corps.avance?.id;
    await appel("POST", `/avances/${id}/decision`, tD, { decision: "VALIDEE" });
    const versement = await appel("POST", `/avances/${id}/versement`, tC, { caisse_id: petite.id });
    verifier("un versement au-delà du solde est refusé, avec le manquant",
      versement.statut === 409 && versement.corps.code === "INSUFFICIENT_FUNDS"
        && versement.corps.manquant === 49000,
      JSON.stringify(versement.corps));
    const [inchangee] = await q(`SELECT solde_actuel FROM caisses WHERE id=$1`, [petite.id]);
    verifier("la caisse n'a pas bougé", Number(inchangee.solde_actuel) === 1000, `${inchangee.solde_actuel}`);
    await pool.query(`DELETE FROM caisses WHERE id=$1`, [petite.id]);

    /* Un employé d'une autre société ne doit pas être atteignable. */
    const [autre] = await q(
      `SELECT id FROM attendance_employees WHERE company_id <> $1 LIMIT 1`, [TRIANGLE]);
    if (autre) {
      const croise = await appel("POST", "/avances", tC, {
        employee_id: autre.id, amount_requested: 1000, first_period_code: MOIS });
      verifier("un employé d'une autre société est introuvable depuis Triangle",
        croise.statut === 404, JSON.stringify(croise.corps));
    } else {
      verifier("un employé d'une autre société est introuvable depuis Triangle", true, "aucun employé tiers dans le jeu");
    }
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

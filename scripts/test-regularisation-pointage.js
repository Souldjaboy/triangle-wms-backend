"use strict";

/**
 * RÉGULARISATION EXCEPTIONNELLE DES POINTAGES (migration 086).
 *
 *   DATABASE_URL=… node scripts/test-regularisation-pointage.js
 *
 * Ce que la suite prouve :
 *
 *   • le preview n'écrit RIEN ;
 *   • la période choisie est respectée, dimanche exclu, samedi selon le mode,
 *     jours fériés fournis exclus ;
 *   • les pointages bruts ne sont JAMAIS modifiés ;
 *   • un pointage réel existant n'est jamais écrasé ;
 *   • un second passage aux mêmes paramètres ne crée rien ;
 *   • deux exécutions SIMULTANÉES ne doublent rien ;
 *   • --apply sans motif ou sans la phrase exacte est refusé ;
 *   • --date-to est obligatoire : le script n'utilise jamais « aujourd'hui » ;
 *   • une panne au milieu annule tout ;
 *   • une absence réelle se marque par-dessus, sans rien effacer.
 */

const { Pool } = require("pg");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

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

const TRIANGLE = 1;
let scheduleId = 0, siteId = 0, empA = 0, empB = 0;

/* Une période dont on connaît le calendrier par cœur :
   lundi 2026-08-24 → dimanche 2026-08-30.
   24 lun, 25 mar, 26 mer, 27 jeu, 28 ven, 29 sam, 30 dim. */
const DU = "2026-08-24", AU = "2026-08-30";

async function lancer(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath,
      ["scripts/regulariser-pointage.js", ...args],
      { env: { ...process.env, DATABASE_URL: URL_BASE }, encoding: "utf8" });
    return { ok: true, sortie: stdout };
  } catch (e) {
    return { ok: false, sortie: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

const compteRegul = async () =>
  Number((await q(`SELECT count(*)::int AS n FROM attendance_regularizations WHERE company_id=$1`, [TRIANGLE]))[0].n);

async function poserLeJeu() {
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
  await pool.query(`DELETE FROM attendance_event_log_v2`);
  await pool.query(`DELETE FROM attendance_day_records_v2`);
  await pool.query(`DELETE FROM attendance_qr_scans`);
  await pool.query(`DELETE FROM attendance_badge_events`);
  await pool.query(`DELETE FROM attendance_badges`);
  await pool.query(`DELETE FROM attendance_operator_scopes`);
  await pool.query(`DELETE FROM attendance_employees WHERE company_id=$1`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_schedule_days WHERE schedule_id IN
      (SELECT id FROM attendance_work_schedules WHERE company_id=$1 AND code='ESSAI-086')`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_work_schedules WHERE company_id=$1 AND code='ESSAI-086'`, [TRIANGLE]);
  await pool.query(`DELETE FROM attendance_work_sites WHERE company_id=$1 AND code='ESSAI-086'`, [TRIANGLE]);

  await pool.query(
    `INSERT INTO attendance_company_configuration (company_id, official_start_at, timezone)
     VALUES ($1, now() - interval '400 days', 'Africa/Bamako')
     ON CONFLICT (company_id) DO UPDATE SET official_start_at = EXCLUDED.official_start_at`, [TRIANGLE]);

  siteId = (await pool.query(
    `INSERT INTO attendance_work_sites (company_id, code, name, city, site_type, active)
     VALUES ($1,'ESSAI-086','Essai Site 086','Bamako','WAREHOUSE',true) RETURNING id`, [TRIANGLE])).rows[0].id;
  scheduleId = (await pool.query(
    `INSERT INTO attendance_work_schedules (company_id, code, name, active)
     VALUES ($1,'ESSAI-086','Lundi au samedi 08:00',true) RETURNING id`, [TRIANGLE])).rows[0].id;
  /* Lundi → samedi travaillés, dimanche non. */
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
  empA = await emp(8601, "Essai 086 Employé A");
  empB = await emp(8602, "Essai 086 Employé B");
}

async function main() {
  console.log(`\n${G}RÉGULARISATION EXCEPTIONNELLE DES POINTAGES (086)${Z}`);
  await poserLeJeu();

  const COMMUN = [`--company-id=${TRIANGLE}`, `--date-from=${DU}`, `--date-to=${AU}`];
  const PHRASE = `OUI JE REGULARISE ${TRIANGLE} DU ${DU} AU ${AU}`;

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LE PREVIEW N'ÉCRIT RIEN${Z}`);
  {
    const avant = await compteRegul();
    const r = await lancer(["--preview", ...COMMUN]);
    verifier("le preview s'exécute", r.ok, r.sortie.slice(-200));
    verifier("il annonce la période exacte",
      r.sortie.includes(`du ${DU} au ${AU} inclus`), "");
    verifier("il annonce 12 journées (6 jours ouvrés × 2 employés)",
      /journées à créer\s*:\s*12/.test(r.sortie), r.sortie.match(/journées à créer.*/)?.[0]);
    verifier("il dit que rien n'a été écrit",
      /aucune écriture n'a eu lieu/i.test(r.sortie));
    verifier("et rien n'a effectivement été écrit", (await compteRegul()) === avant,
      `${avant} → ${await compteRegul()}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}--apply EXIGE UN MOTIF ET LA PHRASE EXACTE${Z}`);
  {
    const sansMotif = await lancer(["--apply", ...COMMUN, `--confirmer=${PHRASE}`]);
    verifier("sans motif, refus", !sansMotif.ok && /motif/i.test(sansMotif.sortie),
      sansMotif.sortie.slice(0, 120));

    const sansPhrase = await lancer(["--apply", ...COMMUN, "--motif=Mise en service du pointage"]);
    verifier("sans confirmation, refus", !sansPhrase.ok && /Confirmation exacte/i.test(sansPhrase.sortie));

    const mauvaisePhrase = await lancer(["--apply", ...COMMUN,
      "--motif=Mise en service du pointage", "--confirmer=OUI"]);
    verifier("avec une phrase approximative, refus", !mauvaisePhrase.ok);

    verifier("aucune écriture après ces refus", (await compteRegul()) === 0, `${await compteRegul()}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}--date-to EST OBLIGATOIRE${Z}`);
  {
    const r = await lancer(["--preview", `--company-id=${TRIANGLE}`, `--date-from=${DU}`]);
    verifier("sans --date-to, refus explicite",
      !r.ok && /n'utilise jamais la date du jour/i.test(r.sortie), r.sortie.slice(0, 160));

    const inverse = await lancer(["--preview", `--company-id=${TRIANGLE}`,
      `--date-from=${AU}`, `--date-to=${DU}`]);
    verifier("des bornes inversées sont refusées", !inverse.ok);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}UN POINTAGE RÉEL N'EST JAMAIS ÉCRASÉ${Z}`);
  {
    /* L'employé A a réellement pointé le mardi 25. */
    await pool.query(
      `INSERT INTO attendance_day_records_v2
         (company_id, employee_id, work_date, check_in, check_out, status, late_minutes, worked_minutes)
       VALUES ($1,$2,'2026-08-25','2026-08-25 09:30:00+00','2026-08-25 17:00:00+00','LATE',90,450)`,
      [TRIANGLE, empA]);

    const r = await lancer(["--preview", ...COMMUN]);
    verifier("le preview compte une journée de moins (11 au lieu de 12)",
      /journées à créer\s*:\s*11/.test(r.sortie), r.sortie.match(/journées à créer.*/)?.[0]);
    verifier("il signale la journée déjà pointée",
      /1 journée\(s\) déjà pointées/.test(r.sortie), r.sortie.match(/.*déjà pointées.*/)?.[0]);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}L'APPLICATION${Z}`);
  {
    const empreinteAvant = await q(
      `SELECT id, work_date::text AS d, check_in, status FROM attendance_day_records_v2
        WHERE company_id=$1 ORDER BY id`, [TRIANGLE]);

    const r = await lancer(["--apply", ...COMMUN,
      "--motif=Mise en service du pointage à partir du 25 août 2026",
      `--confirmer=${PHRASE}`]);
    verifier("l'application réussit", r.ok, r.sortie.slice(-250));
    verifier("elle annonce 11 journées retenues",
      /11 journée\(s\) retenues/.test(r.sortie), r.sortie.match(/.*journée\(s\) retenues.*/)?.[0]);

    const lignes = await q(
      `SELECT employee_id, work_date::text AS d, effective_status,
              to_char(timezone('Africa/Bamako', effective_check_in), 'HH24:MI') AS arrivee,
              original_check_in, reason
         FROM attendance_regularizations WHERE company_id=$1 ORDER BY employee_id, work_date`,
      [TRIANGLE]);
    verifier("onze lignes de régularisation existent", lignes.length === 11, `${lignes.length}`);
    verifier("toutes retiennent une arrivée à 08:00",
      lignes.every((l) => l.arrivee === "08:00"),
      JSON.stringify([...new Set(lignes.map((l) => l.arrivee))]));
    verifier("aucune ne porte de pointage d'origine (personne n'avait pointé)",
      lignes.every((l) => l.original_check_in === null));
    verifier("toutes portent le motif",
      lignes.every((l) => /Mise en service/.test(l.reason)));

    const dates = [...new Set(lignes.map((l) => l.d))].sort();
    verifier("le dimanche 30 août est exclu", !dates.includes("2026-08-30"), JSON.stringify(dates));
    verifier("le samedi 29 août est inclus (samedi NORMAL)", dates.includes("2026-08-29"));
    verifier("la journée réellement pointée du 25 n'est pas régularisée pour A",
      !lignes.some((l) => l.employee_id === empA && l.d === "2026-08-25"),
      JSON.stringify(lignes.filter((l) => l.employee_id === empA).map((l) => l.d)));

    const empreinteApres = await q(
      `SELECT id, work_date::text AS d, check_in, status FROM attendance_day_records_v2
        WHERE company_id=$1 ORDER BY id`, [TRIANGLE]);
    verifier("LES POINTAGES BRUTS SONT INTACTS",
      JSON.stringify(empreinteAvant) === JSON.stringify(empreinteApres),
      `${empreinteAvant.length} → ${empreinteApres.length}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}UN SECOND PASSAGE NE CRÉE RIEN${Z}`);
  {
    const avant = await compteRegul();
    const r = await lancer(["--apply", ...COMMUN,
      "--motif=Mise en service du pointage à partir du 25 août 2026",
      `--confirmer=${PHRASE}`]);
    verifier("le second passage s'exécute sans erreur", r.ok, r.sortie.slice(-150));
    verifier("il annonce que le lot a déjà été appliqué",
      /déjà été appliqué/i.test(r.sortie));
    verifier("aucune ligne supplémentaire", (await compteRegul()) === avant,
      `${avant} → ${await compteRegul()}`);
    const [lots] = await q(
      `SELECT count(*)::int AS n FROM attendance_regularization_batches WHERE company_id=$1`, [TRIANGLE]);
    verifier("un seul lot en base", lots.n === 1, `${lots.n}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}DEUX EXÉCUTIONS SIMULTANÉES${Z}`);
  {
    await pool.query(`DELETE FROM attendance_regularizations WHERE company_id=$1`, [TRIANGLE]);
    await pool.query(`DELETE FROM attendance_regularization_batches WHERE company_id=$1`, [TRIANGLE]);

    const args = ["--apply", ...COMMUN,
      "--motif=Mise en service du pointage à partir du 25 août 2026", `--confirmer=${PHRASE}`];
    const [a, b] = await Promise.all([lancer(args), lancer(args)]);
    verifier("les deux s'exécutent sans planter", a.ok && b.ok,
      `${a.ok} / ${b.ok}`);
    verifier("onze lignes au total, pas vingt-deux", (await compteRegul()) === 11,
      `${await compteRegul()}`);
    const [lots] = await q(
      `SELECT count(*)::int AS n FROM attendance_regularization_batches WHERE company_id=$1`, [TRIANGLE]);
    verifier("un seul lot, malgré la simultanéité", lots.n === 1, `${lots.n}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LE SAMEDI ET LES JOURS FÉRIÉS SE CONFIGURENT${Z}`);
  {
    const sansSamedi = await lancer(["--preview", `--company-id=${TRIANGLE}`,
      "--date-from=2026-09-07", "--date-to=2026-09-13", "--samedi=NON_TRAVAILLE"]);
    verifier("samedi NON_TRAVAILLE : 10 journées (5 jours × 2 employés)",
      /journées à créer\s*:\s*10/.test(sansSamedi.sortie),
      sansSamedi.sortie.match(/journées à créer.*/)?.[0]);

    const avecSamedi = await lancer(["--preview", `--company-id=${TRIANGLE}`,
      "--date-from=2026-09-07", "--date-to=2026-09-13", "--samedi=NORMAL"]);
    verifier("samedi NORMAL : 12 journées",
      /journées à créer\s*:\s*12/.test(avecSamedi.sortie),
      avecSamedi.sortie.match(/journées à créer.*/)?.[0]);

    const avecFerie = await lancer(["--preview", `--company-id=${TRIANGLE}`,
      "--date-from=2026-09-07", "--date-to=2026-09-13", "--samedi=NORMAL",
      "--feries=2026-09-09,2026-09-10"]);
    verifier("deux jours fériés retirent 4 journées",
      /journées à créer\s*:\s*8/.test(avecFerie.sortie),
      avecFerie.sortie.match(/journées à créer.*/)?.[0]);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}RESTREINDRE À CERTAINS EMPLOYÉS${Z}`);
  {
    const r = await lancer(["--preview", `--company-id=${TRIANGLE}`,
      "--date-from=2026-09-07", "--date-to=2026-09-13", `--employes=${empB}`]);
    verifier("un seul employé : 6 journées",
      /journées à créer\s*:\s*6/.test(r.sortie), r.sortie.match(/journées à créer.*/)?.[0]);
    verifier("le preview le signale", /\(restreint\)/.test(r.sortie));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}UNE ABSENCE RÉELLE SE MARQUE PAR-DESSUS${Z}`);
  {
    const [ligne] = await q(
      `SELECT id, effective_status FROM attendance_regularizations
        WHERE company_id=$1 AND employee_id=$2 ORDER BY work_date LIMIT 1`, [TRIANGLE, empB]);

    await pool.query(
      `UPDATE attendance_regularizations
          SET overridden_at = now(), overridden_status = 'ABSENT',
              override_reason = 'Absent constaté par le chef de chantier.'
        WHERE id = $1`, [ligne.id]);

    const [apres] = await q(
      `SELECT effective_status, overridden_status, override_reason, effective_check_in
         FROM attendance_regularizations WHERE id=$1`, [ligne.id]);
    verifier("la valeur régularisée d'origine reste lisible",
      apres.effective_status === "PRESENT" && apres.effective_check_in !== null,
      JSON.stringify(apres.effective_status));
    verifier("l'absence réelle est notée par-dessus, avec son motif",
      apres.overridden_status === "ABSENT" && apres.override_reason.length > 10,
      JSON.stringify({ s: apres.overridden_status, r: apres.override_reason }));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}UNE PANNE ANNULE TOUT${Z}`);
  {
    /* On rend l'écriture impossible en fin de course : la contrainte de
       statut refuse une valeur inconnue. Le lot ne doit pas rester. */
    await pool.query(`DELETE FROM attendance_regularizations WHERE company_id=$1`, [TRIANGLE]);
    await pool.query(`DELETE FROM attendance_regularization_batches WHERE company_id=$1`, [TRIANGLE]);

    const client = await pool.connect();
    let echec = null;
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO attendance_regularization_batches
           (company_id, idempotency_key, date_from, date_to, reason)
         VALUES ($1,'panne-essai','2026-08-24','2026-08-30','Essai de panne')`, [TRIANGLE]);
      await client.query(
        `INSERT INTO attendance_regularizations
           (company_id, employee_id, work_date, effective_status, reason)
         VALUES ($1,$2,'2026-08-24','STATUT_INEXISTANT','Essai')`, [TRIANGLE, empA]);
      await client.query("COMMIT");
    } catch (e) {
      echec = e;
      await client.query("ROLLBACK").catch(() => {});
    } finally { client.release(); }

    verifier("l'écriture invalide échoue", Boolean(echec), echec ? echec.code : "PASSÉE À TORT");
    const [lots] = await q(
      `SELECT count(*)::int AS n FROM attendance_regularization_batches WHERE company_id=$1`, [TRIANGLE]);
    verifier("le lot n'a PAS été laissé derrière : rollback complet", lots.n === 0, `${lots.n}`);
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

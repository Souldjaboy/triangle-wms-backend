"use strict";

/**
 * JEU D'ESSAI DU POINTAGE QR — deux sociétés, deux sites, quatre employés.
 *
 *   DATABASE_URL=… node scripts/jeu-essai-badges-qr.js
 *
 * Pose de quoi éprouver ce qui compte vraiment :
 *
 *   • un employé Triangle et un employé FAT & MAT, pour que le refus d'un
 *     badge étranger soit un cas réel et non une hypothèse ;
 *   • deux sites dans la même société, pour que le périmètre d'un opérateur
 *     puisse en exclure un ;
 *   • un horaire qui commence à 08:00, du lundi au samedi — c'est lui qui
 *     rend vérifiable « 08h00 = 0 minute, 08h10 = 10 minutes » ;
 *   • un opérateur limité à un seul site, un opérateur FAT & MAT, et un
 *     employé sans aucun périmètre.
 *
 * Identités de simulation. Aucune de ces valeurs n'est une donnée réelle.
 */

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL manquant."); process.exit(1); }
if (/5432|prod|production/i.test(process.env.DATABASE_URL)) {
  console.error("Cette URL ressemble à une base de production. Refus."); process.exit(1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/* Un horaire qui démarre à 08:00 tous les jours ouvrés. Le samedi est
   travaillé ici : c'est le cas de Triangle, et le rendre configurable est le
   sujet d'un autre chantier. Le dimanche ne l'est pas. */
async function poserHoraire(c, companyId, code) {
  const { rows } = await c.query(
    `INSERT INTO attendance_work_schedules (company_id, code, name, active)
     VALUES ($1,$2,$3,true) RETURNING id`,
    [companyId, code, "Journée 08:00–17:00"]
  );
  const scheduleId = rows[0].id;
  for (let jour = 1; jour <= 7; jour += 1) {
    await c.query(
      `INSERT INTO attendance_schedule_days
         (schedule_id, iso_weekday, is_working_day, start_time, end_time, break_start, break_end)
       VALUES ($1,$2,$3,'08:00','17:00','12:00','13:00')`,
      [scheduleId, jour, jour !== 7]
    );
  }
  return scheduleId;
}

async function main() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    await c.query(`DELETE FROM attendance_qr_scans`);
    await c.query(`DELETE FROM attendance_badge_events`);
    await c.query(`DELETE FROM attendance_badges`);
    await c.query(`DELETE FROM attendance_operator_scopes`);
    await c.query(`DELETE FROM attendance_day_record_corrections`);
    await c.query(`DELETE FROM attendance_event_log_v2`);
    await c.query(`DELETE FROM attendance_day_records_v2`);
    await c.query(`DELETE FROM attendance_salary_adjustments_v2`);
    await c.query(`DELETE FROM attendance_payroll_items_v2`);
    await c.query(`DELETE FROM attendance_payroll_runs_v2`);
    await c.query(`DELETE FROM attendance_salary_settings_v2`);
    /* Les avances référencent les employés : les effacer d'abord, sinon la
       suite échoue sur une clé étrangère alors que rien ne va mal. */
  await c.query(`DELETE FROM salary_advance_repayments`);
  await c.query(`DELETE FROM salary_advance_installments`);
  await c.query(`DELETE FROM salary_advances`);
  await c.query(`DELETE FROM attendance_employees`);
    await c.query(`DELETE FROM attendance_schedule_days`);
    await c.query(`DELETE FROM attendance_work_schedules`);
    await c.query(`DELETE FROM attendance_work_sites`);
    await c.query(`DELETE FROM attendance_company_configuration`);
    await c.query(`DELETE FROM users WHERE email LIKE 'qr-%@essai.test'`);

    const TRIANGLE = 1, FATMAT = 2;

    /* Le pointage v2 refuse d'écrire avant `official_start_at` : on l'ouvre
       dans le passé pour que les tests puissent pointer aujourd'hui. */
    for (const societe of [TRIANGLE, FATMAT]) {
      await c.query(
        `INSERT INTO attendance_company_configuration (company_id, official_start_at, timezone)
         VALUES ($1, now() - interval '30 days', 'Africa/Bamako')
         ON CONFLICT (company_id) DO UPDATE
           SET official_start_at = EXCLUDED.official_start_at, timezone = EXCLUDED.timezone`,
        [societe]
      );
    }

    /* `attendance_work_sites` — le site du pointage v2, celui que
       `attendance_employees.site_id` et `attendance_operator_scopes.site_id`
       référencent réellement. `attendance_sites` est l'ancienne table GPS de
       l'ancien pointage ; les confondre fait échouer la clé étrangère. */
    const site = async (companyId, code, nom) => (await c.query(
      `INSERT INTO attendance_work_sites (company_id, code, name, city, site_type, active)
       VALUES ($1,$2,$3,'Bamako','WAREHOUSE',true) RETURNING id`,
      [companyId, code, nom])).rows[0].id;

    const siteBamako   = await site(TRIANGLE, "ESSAI-BKO", "Essai Bamako");
    const siteKati     = await site(TRIANGLE, "ESSAI-KATI", "Essai Kati");
    const siteCarriere = await site(FATMAT,   "ESSAI-CAR",  "Essai Carrière");

    const horaireTriangle = await poserHoraire(c, TRIANGLE, "ESSAI-QR-T");
    const horaireFatmat   = await poserHoraire(c, FATMAT,   "ESSAI-QR-F");

    const employe = async (companyId, numero, nom, siteId, scheduleId, poste) => (await c.query(
      `INSERT INTO attendance_employees
         (company_id, employee_number, full_name, site_id, schedule_id, job_title, phone, active, effective_from)
       VALUES ($1,$2,$3,$4,$5,$6,'',true, current_date - 30) RETURNING id`,
      [companyId, numero, nom, siteId, scheduleId, poste])).rows[0].id;

    const ids = {
      TRIANGLE, FATMAT, siteBamako, siteKati, siteCarriere,
      bamako:   await employe(TRIANGLE, 9001, "Essai QR Bamako",   siteBamako,   horaireTriangle, "Magasinier"),
      kati:     await employe(TRIANGLE, 9002, "Essai QR Kati",     siteKati,     horaireTriangle, "Chauffeur"),
      carriere: await employe(FATMAT,   9003, "Essai QR Carrière", siteCarriere, horaireFatmat,   "Conducteur"),
      carriere2:await employe(FATMAT,   9004, "Essai QR Carrière 2", siteCarriere, horaireFatmat, "Manœuvre"),
    };

    /* Ce jeu d'essai crée SES propres comptes plutôt que de compter sur ceux
       du socle : les autres suites remplacent les comptes fixtures, et un
       identifiant écrit en dur ici casserait selon l'ordre d'exécution. */
    const compte = async (email, nom, role, companyId) => (await c.query(
      `INSERT INTO users (company_id, fullname, email, password, role, is_super_admin, is_active)
       VALUES ($1,$2,$3,'$non-utilisable$',$4,false,true) RETURNING id`,
      [companyId, nom, email, role])).rows[0].id;

    const OPERATEUR_TRIANGLE = await compte("qr-op-triangle@essai.test", "Essai Opérateur Bamako", "responsable_entrepot", TRIANGLE);
    const OPERATEUR_FATMAT   = await compte("qr-op-fatmat@essai.test",   "Essai Opérateur Carrière", "responsable_entrepot", FATMAT);
    const ADMIN_TRIANGLE     = await compte("qr-admin-triangle@essai.test", "Essai Admin Triangle", "admin", TRIANGLE);
    const ADMIN_FATMAT       = await compte("qr-admin-fatmat@essai.test",   "Essai Admin FAT & MAT", "admin", FATMAT);

    /* Le périmètre décide de QUI l'on peut pointer ; le droit `pointage.qr|scan`
       décide seulement d'ouvrir l'écran. `canPunchEmployee` n'exempte que le
       super admin et l'employé pointant pour lui-même — un administrateur de
       société doit donc, lui aussi, avoir un périmètre. C'est ce qui permet
       à un opérateur d'être cantonné à un site sans être cantonné par son
       rôle, et c'est le comportement existant, pas une nouveauté.

       Ici : l'opérateur Triangle ne couvre que Bamako (Kati doit lui être
       refusé), tandis que l'administrateur Triangle couvre les deux sites. */
    const perimetre = (companyId, userId, siteId) => c.query(
      `INSERT INTO attendance_operator_scopes (company_id, operator_user_id, site_id, can_punch)
       VALUES ($1,$2,$3,true)`, [companyId, userId, siteId]);

    /* Les droits sont accordés NOMMÉMENT à ces comptes, par exception
       personnelle, plutôt que laissés à la matrice des rôles : celle-ci est
       réécrite par d'autres suites selon les rôles présents en base, et la
       suite QR échouerait alors pour une raison sans rapport avec elle.
       C'est aussi ce qui rend le chemin « exception personnelle » du moteur
       RBAC réellement éprouvé plutôt que supposé.

       Les opérateurs reçoivent de quoi scanner et pointer, PAS de quoi
       remplacer un badge ni lire le journal des lectures : c'est exactement
       ce que la suite vérifie ensuite. */
    const droit = (companyId, userId, module, action) => c.query(
      `INSERT INTO user_permission_overrides (company_id, user_id, module_key, action, effect)
       VALUES ($1,$2,$3,$4,'ALLOW')`, [companyId, userId, module, action]);

    const droitsAdmin = {
      "pointage.qr":     ["visible", "view", "scan"],
      "pointage.manuel": ["visible", "view", "create", "correct"],
      "pointage.badge":  ["visible", "view", "create", "print", "reprint", "replace", "audit"],
    };
    const droitsOperateur = {
      "pointage.qr":     ["visible", "view", "scan"],
      "pointage.manuel": ["visible", "view", "create"],
      "pointage.badge":  ["visible", "view"],
    };
    for (const [companyId, userId, jeu] of [
      [TRIANGLE, ADMIN_TRIANGLE, droitsAdmin],
      [FATMAT,   ADMIN_FATMAT,   droitsAdmin],
      [TRIANGLE, OPERATEUR_TRIANGLE, droitsOperateur],
      [FATMAT,   OPERATEUR_FATMAT,   droitsOperateur],
    ]) {
      for (const [module, actions] of Object.entries(jeu)) {
        for (const action of actions) await droit(companyId, userId, module, action);
      }
    }

    await perimetre(TRIANGLE, OPERATEUR_TRIANGLE, siteBamako);
    await perimetre(TRIANGLE, ADMIN_TRIANGLE, siteBamako);
    await perimetre(TRIANGLE, ADMIN_TRIANGLE, siteKati);
    await perimetre(FATMAT,   OPERATEUR_FATMAT, siteCarriere);
    await perimetre(FATMAT,   ADMIN_FATMAT, siteCarriere);

    await c.query("COMMIT");
    console.log(JSON.stringify({
      ...ids, OPERATEUR_TRIANGLE, OPERATEUR_FATMAT, ADMIN_TRIANGLE, ADMIN_FATMAT,
    }));
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    console.error("ÉCHEC :", e.message);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

main();

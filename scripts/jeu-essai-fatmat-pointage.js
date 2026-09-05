"use strict";

/**
 * LE JEU D'ESSAI DU POINTAGE FAT & MAT — pour éprouver le script de
 * configuration sans jamais toucher à une base réelle.
 *
 *   DATABASE_URL=… node scripts/jeu-essai-fatmat-pointage.js
 *   DATABASE_URL=… AMBIGU=1 node scripts/jeu-essai-fatmat-pointage.js
 *
 * Pose une société nommée EXACTEMENT comme en production le ferait
 * (« FAT & MAT Entreprise », mais le script cible réel ne dépend que de
 * « FAT » + « MAT » dans le nom — vérifié explicitement par un test dédié
 * avec un nom différent), avec :
 *
 *   • un compte utilisateur dont le téléphone est CELUI d'Issa Diallo
 *     (77 11 30 98), sous un nom volontairement DIFFÉRENT du certifié
 *     (« I. Diallo ») — pour prouver que le script le retrouve par
 *     téléphone, jamais par ressemblance de nom ;
 *   • une société Triangle témoin, avec un « Issa Diallo » DIFFÉRENT
 *     (autre téléphone) — pour prouver qu'il n'est jamais confondu avec
 *     l'homonyme d'une autre société ;
 *   • si AMBIGU=1 : un second compte FAT & MAT portant le MÊME téléphone
 *     qu'Issa, pour éprouver le refus sur ambiguïté.
 *
 * Chiffres et identités de simulation. Aucune de ces valeurs n'est une
 * décision du client.
 */

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL manquant."); process.exit(1); }
if (/5432|prod|production/i.test(process.env.DATABASE_URL)) {
  console.error("Cette URL ressemble à une base de production. Refus."); process.exit(1);
}

const AMBIGU = process.env.AMBIGU === "1";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    await c.query(`DELETE FROM attendance_operator_scopes`);
    await c.query(`DELETE FROM attendance_day_record_corrections`);
    await c.query(`DELETE FROM attendance_event_log_v2`);
    await c.query(`DELETE FROM attendance_day_records_v2`);
    await c.query(`DELETE FROM attendance_salary_settings_v2`);
    /* La paie référence les employés : la relancer sans effacer d'abord les
       bulletins fait échouer la suite sur une clé étrangère, alors que rien
       ne va mal — c'est seulement l'ordre du ménage qui manquait. */
    await c.query(`DELETE FROM attendance_salary_adjustments_v2`);
    await c.query(`DELETE FROM attendance_payroll_items_v2`);
    await c.query(`DELETE FROM attendance_payroll_runs_v2`);
    await c.query(`DELETE FROM attendance_badge_events`);
    await c.query(`DELETE FROM attendance_qr_scans`);
    await c.query(`DELETE FROM attendance_badges`);
    await c.query(`DELETE FROM attendance_employees`);
    await c.query(`DELETE FROM attendance_schedule_days`);
    await c.query(`DELETE FROM attendance_work_schedules`);
    await c.query(`DELETE FROM attendance_work_sites`);
    await c.query(`DELETE FROM attendance_company_configuration`);
    await c.query(`DELETE FROM users WHERE email LIKE 'fatmat-%@essai.test'`);

    /* Réutilise la FAT & MAT du socle partagé (rebuild-test-db.sh) au lieu
       d'en créer une seconde : le script réel refuse — à raison — dès que
       deux sociétés correspondent à « FAT & MAT », et ce fixture doit rester
       le cas normal, pas le cas d'ambiguïté (qui a son propre test, plus
       bas, avec AMBIGU=1). */
    const { rows: societes } = await c.query(
      `SELECT id FROM companies WHERE name ILIKE '%FAT%' AND name ILIKE '%MAT%' ORDER BY id`);
    if (societes.length !== 1) {
      throw new Error(`Le socle partagé ne porte pas exactement une société FAT & MAT `
        + `(trouvé : ${societes.length}). Ce fixture suppose rebuild-test-db.sh déjà exécuté.`);
    }
    const fatmat = societes[0].id;
    const triangleTemoin = (await c.query(
      `SELECT id FROM companies WHERE NOT (name ILIKE '%FAT%' AND name ILIKE '%MAT%') ORDER BY id LIMIT 1`
    )).rows[0].id;

    const issaCompte = (await c.query(
      `INSERT INTO users (company_id, fullname, email, password, role, phone, is_active, created_at)
       VALUES ($1,'I. Diallo','fatmat-issa@essai.test','x','employe','77 11 30 98',true,now())
       RETURNING id`, [fatmat])).rows[0].id;

    /* Un homonyme d'une AUTRE société, autre téléphone : ne doit jamais être
       confondu ni touché. */
    await c.query(
      `INSERT INTO users (company_id, fullname, email, password, role, phone, is_active, created_at)
       VALUES ($1,'Issa Diallo','fatmat-issa-triangle@essai.test','x','employe','60 00 00 00',true,now())`,
      [triangleTemoin]);

    /* `prepared_by`/`paid_by` portent une clé étrangère vers `users` : un
       jeton minté avec un id absent ferait échouer la préparation de la
       paie sur une violation de contrainte, pas sur le comportement
       réellement testé (même piège déjà rencontré côté ventes de sable). */
    const superAdminId = (await c.query(
      `INSERT INTO users (company_id, fullname, email, password, role, is_active, created_at)
       VALUES ($1,'Super Admin Essai','fatmat-superadmin@essai.test','x','super_admin',true,now())
       RETURNING id`, [fatmat])).rows[0].id;

    if (AMBIGU) {
      await c.query(
        `INSERT INTO users (company_id, fullname, email, password, role, phone, is_active, created_at)
         VALUES ($1,'Second Compte','fatmat-issa-bis@essai.test','x','employe','77 11 30 98',true,now())`,
        [fatmat]);
    }

    await c.query("COMMIT");
    console.log(JSON.stringify({ fatmat, triangleTemoin, issaCompte, superAdminId, ambigu: AMBIGU }, null, 2));
  } catch (e) {
    await c.query("ROLLBACK");
    console.error("ÉCHEC :", e.message);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

main();

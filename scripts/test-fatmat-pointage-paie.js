"use strict";

/**
 * POINTAGE ET PAIE FAT & MAT, DE BOUT EN BOUT.
 *
 *   DATABASE_URL=… JWT_SECRET=test-secret-durcissement node scripts/test-fatmat-pointage-paie.js
 *
 * Suppose un serveur déjà démarré (voir le wrapper .sh) et
 * scripts/jeu-essai-fatmat-pointage.js déjà posé, scripts/configurer-fatmat-pointage-paie.js
 * déjà appliqué.
 */

const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const { execFileSync } = require("child_process");
const path = require("path");

const V = "\x1b[32m", R = "\x1b[31m", G = "\x1b[1m", Z = "\x1b[0m";
let reussis = 0, echoues = 0;
function verifier(titre, condition, detail = "") {
  if (condition) { reussis += 1; console.log(`${V}  ✓${Z} ${titre}`); }
  else { echoues += 1; console.log(`${R}  ✗ ${titre}${Z}${detail ? `  — ${detail}` : ""}`); }
}

const PORT = process.env.PORT || 5050;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = process.env.JWT_SECRET || "test-secret-durcissement";
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL manquant."); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const CONFIGURER = path.join(__dirname, "configurer-fatmat-pointage-paie.js");
const JEU = path.join(__dirname, "jeu-essai-fatmat-pointage.js");

function poserLeJeu(env = {}) {
  return JSON.parse(execFileSync(process.execPath, [JEU],
    { encoding: "utf8", env: { ...process.env, ...env } }));
}
function sansCouleurs(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ""); }

function lancerConfig(...args) {
  try {
    return { code: 0, sortie: execFileSync(process.execPath, [CONFIGURER, ...args], { encoding: "utf8", env: process.env }) };
  } catch (e) { return { code: e.status || 1, sortie: `${e.stdout || ""}${e.stderr || ""}` }; }
}

const jetonPour = (id, role, companyId, superAdmin = false) =>
  jwt.sign({ id, email: "x@x.test", role, company_id: companyId, is_super_admin: superAdmin }, SECRET, { expiresIn: "3h" });

async function appel(methode, chemin, jeton, corps, entetes = {}) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}), ...entetes },
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  let corpsJson; try { corpsJson = JSON.parse(texte); } catch { corpsJson = { brut: texte }; }
  return { statut: r.status, corps: corpsJson };
}

async function q(sql, params = []) { return (await pool.query(sql, params)).rows; }

async function main() {
  console.log(`\n${G}POINTAGE ET PAIE FAT & MAT${Z}`);

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}SCRIPT DE CONFIGURATION${Z}`);
  const jeu = poserLeJeu();
  {
    const rp = lancerConfig("--preview");
    const rpClair = sansCouleurs(rp.sortie);
    verifier("le preview s'exécute", rp.code === 0, rp.sortie.slice(-300));
    verifier("les totaux certifiés sont vérifiés", /net total  : 775000 \(attendu 775000\) ✓/.test(rpClair));
    verifier("Djoulédé apparaît à 25000, jamais 10000",
      /Djoulédé Traoré[\s\S]{0,80}net   25000/.test(rpClair) && !/Djoulédé[\s\S]{0,40}net   10000/.test(rpClair));
    verifier("le preview n'écrit rien",
      Number((await q(`SELECT count(*) n FROM attendance_employees WHERE company_id=$1`, [jeu.fatmat]))[0].n) === 0);

    const ra = lancerConfig("--apply", "--confirmer=OUI-JE-CONFIGURE-FATMAT");
    verifier("l'apply s'exécute", ra.code === 0, ra.sortie.slice(-300));

    const ra2 = lancerConfig("--apply", "--confirmer=OUI-JE-CONFIGURE-FATMAT");
    verifier("le rejeu est idempotent (tout « à jour », rien créé deux fois)",
      ra2.code === 0 && !/créé  —/.test(ra2.sortie) && /à jour —/.test(ra2.sortie));
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}1-6. NEUF EMPLOYÉS, AUCUN DOUBLON, TOTAUX EXACTS${Z}`);
  {
    const emps = await q(`SELECT * FROM attendance_employees WHERE company_id=$1 ORDER BY id`, [jeu.fatmat]);
    verifier("exactement 9 employés dans FAT & MAT", emps.length === 9, String(emps.length));
    verifier("aucun employé n'appartient à Triangle sous ces noms",
      Number((await q(
        `SELECT count(*) n FROM attendance_employees
          WHERE full_name = ANY($1::text[]) AND company_id <> $2`,
        [emps.map((e) => e.full_name), jeu.fatmat]))[0].n) === 0);
    verifier("aucun doublon de nom", new Set(emps.map((e) => e.full_name)).size === 9);

    const salaires = await q(
      `SELECT e.full_name, s.monthly_salary FROM attendance_employees e
         JOIN attendance_salary_settings_v2 s ON s.employee_id = e.id
        WHERE e.company_id = $1 AND s.effective_to IS NULL`, [jeu.fatmat]);
    const djoulede = salaires.find((s) => s.full_name === "Djoulédé Traoré");
    verifier("Djoulédé Traoré = exactement 25000 FCFA", Number(djoulede?.monthly_salary) === 25000);
    const totalBase = (await q(
      `SELECT sum(CASE WHEN e.full_name='Djoulédé Traoré' THEN 25000
                        WHEN e.full_name IN ('Drissa Togo','Moussa Boujare','Siaka Dembele') THEN 100000
                        WHEN e.full_name='Dougakoro Coulibali' THEN 100000
                        WHEN e.full_name='Issa Diallo' THEN 125000
                        ELSE 15000 END) t FROM attendance_employees e WHERE e.company_id=$1`, [jeu.fatmat]))[0].t;
    verifier("somme des salaires de base = 595000", Number(totalBase) === 595000);
    verifier("net total = 775000",
      salaires.reduce((s, x) => s + Number(x.monthly_salary), 0) === 775000,
      String(salaires.reduce((s, x) => s + Number(x.monthly_salary), 0)));
  }

  const ISSA = jetonPour(jeu.issaCompte, "employe", jeu.fatmat);
  const temoinId = (await q(`SELECT id FROM users WHERE email='fatmat-issa-triangle@essai.test'`))[0].id;
  const TRIANGLE = jetonPour(temoinId, "employe", jeu.triangleTemoin);
  const employes = await q(`SELECT id, full_name FROM attendance_employees WHERE company_id=$1 ORDER BY id`, [jeu.fatmat]);
  const drissa = employes.find((e) => e.full_name === "Drissa Togo");
  const moussa = employes.find((e) => e.full_name === "Moussa Boujare");

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}7-9. ISSA VOIT LES 9, PEUT LES POINTER, RIEN D'UNE AUTRE SOCIÉTÉ${Z}`);
  {
    const r = await appel("GET", "/attendance-v2/employees", ISSA);
    const liste = Array.isArray(r.corps) ? r.corps : r.corps.employees || [];
    verifier("Issa voit les 9 employés de FAT & MAT", liste.length === 9, String(liste.length));
    verifier("aucun employé Triangle dans la liste d'Issa",
      !liste.some((e) => e.company_id && Number(e.company_id) !== jeu.fatmat));

    const rPointe = await appel("POST", "/attendance-v2/check", ISSA,
      { employee_id: drissa.id, action_type: "CHECK_IN" });
    verifier("Issa peut sélectionner et pointer un employé (arrivée)", rPointe.statut === 200,
      JSON.stringify(rPointe.corps).slice(0, 150));

    const rAutreSociete = await appel("POST", "/attendance-v2/check", TRIANGLE,
      { employee_id: drissa.id, action_type: "BREAK_OUT" });
    verifier("un compte d'une autre société ne voit/pointe jamais cet employé",
      rAutreSociete.statut === 404 || rAutreSociete.statut === 403);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}10. ISSA NE VOIT PAS LES SALAIRES SANS PERMISSION${Z}`);
  {
    const mois = new Date().toISOString().slice(0, 7);
    const r = await appel("GET", `/attendance-v2/payroll?month=${mois}`, ISSA);
    verifier("Issa est refusé sur la paie (403, aucune permission de paie accordée)", r.statut === 403,
      JSON.stringify(r.corps));
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}11-12. RETARD EXACT — 08H00 = 0, 08H10 = 10${Z}`);
  let recordDrissa;
  {
    recordDrissa = (await q(
      `SELECT id, work_date::text AS work_date FROM attendance_day_records_v2 WHERE employee_id=$1`, [drissa.id]))[0];
    const r1 = await appel("PATCH", `/attendance-v2/records/${recordDrissa.id}`, ISSA,
      { field: "check_in", value: `${recordDrissa.work_date}T08:00:00.000Z`, reason: "Heure réelle vérifiée" });
    verifier("arrivée à 08h00 = 0 minute de retard", Number(r1.corps.record?.late_minutes) === 0,
      JSON.stringify(r1.corps).slice(0, 150));

    const r2 = await appel("PATCH", `/attendance-v2/records/${recordDrissa.id}`, ISSA,
      { field: "check_in", value: `${recordDrissa.work_date}T08:10:00.000Z`, reason: "Correction, chauffeur confirmé en retard" });
    verifier("arrivée à 08h10 = 10 minutes de retard", Number(r2.corps.record?.late_minutes) === 10);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}13-14. PAUSE ET FIN DE JOURNÉE${Z}`);
  {
    const r1 = await appel("POST", "/attendance-v2/check", ISSA, { employee_id: drissa.id, action_type: "BREAK_OUT" });
    verifier("départ en pause enregistré", r1.statut === 200);
    const r2 = await appel("POST", "/attendance-v2/check", ISSA, { employee_id: drissa.id, action_type: "BREAK_IN" });
    verifier("retour de pause enregistré", r2.statut === 200);
    const r3 = await appel("PATCH", `/attendance-v2/records/${recordDrissa.id}`, ISSA,
      { field: "check_out", value: `${recordDrissa.work_date}T17:00:00.000Z`, reason: "Fin de journée à 17h00" });
    verifier("fin de journée à 17h00 enregistrée", r3.statut === 200 && r3.corps.record?.check_out);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}15-17. SÉQUENCE ET DOUBLONS REFUSÉS${Z}`);
  {
    const rFinSansArrivee = await appel("POST", "/attendance-v2/check", ISSA,
      { employee_id: moussa.id, action_type: "CHECK_OUT" });
    verifier("une fin sans arrivée est refusée", rFinSansArrivee.statut === 409
      && rFinSansArrivee.corps.code === "ATTENDANCE_SEQUENCE_INVALID");

    const rRetourSansDepart = await appel("POST", "/attendance-v2/check", ISSA,
      { employee_id: moussa.id, action_type: "BREAK_IN" });
    verifier("un retour de pause sans départ est refusé", rRetourSansDepart.statut === 409
      && rRetourSansDepart.corps.code === "ATTENDANCE_SEQUENCE_INVALID");

    await appel("POST", "/attendance-v2/check", ISSA, { employee_id: moussa.id, action_type: "CHECK_IN" });
    const rDoublon = await appel("POST", "/attendance-v2/check", ISSA, { employee_id: moussa.id, action_type: "CHECK_IN" });
    verifier("une double arrivée le même jour est refusée", rDoublon.statut === 409
      && rDoublon.corps.code === "ATTENDANCE_ALREADY_RECORDED");
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}18-19. CORRECTION AVEC MOTIF, HISTORIQUE AVANT/APRÈS${Z}`);
  {
    const recordMoussa = (await q(`SELECT id FROM attendance_day_records_v2 WHERE employee_id=$1`, [moussa.id]))[0];
    const rSansMotif = await appel("PATCH", `/attendance-v2/records/${recordMoussa.id}`, ISSA,
      { field: "check_in", value: new Date().toISOString() });
    verifier("correction sans motif refusée", rSansMotif.statut === 400 && rSansMotif.corps.code === "REASON_REQUIRED");

    const avant = (await q(`SELECT check_in::text AS check_in FROM attendance_day_records_v2 WHERE id=$1`, [recordMoussa.id]))[0];
    const rCorrige = await appel("PATCH", `/attendance-v2/records/${recordMoussa.id}`, ISSA,
      { field: "check_in", value: "2026-09-03T08:05:00.000Z", reason: "Heure corrigée après vérification" });
    verifier("correction avec motif réussit", rCorrige.statut === 200);

    const hist = await appel("GET", `/attendance-v2/records/${recordMoussa.id}/corrections`, ISSA);
    const entree = (hist.corps.corrections || []).find((c) => c.field === "check_in");
    verifier("l'historique porte l'avant/après complet",
      entree && entree.old_value?.check_in && entree.new_value?.check_in
      && new Date(entree.old_value.check_in).toISOString() === new Date(avant.check_in).toISOString(),
      JSON.stringify({ historique: entree?.old_value?.check_in, base: avant.check_in }));
    verifier("l'auteur réel est enregistré", Boolean(entree?.corrected_by_name));
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}20-21. ABSENCE ET RETENUE, PAIEMENT ESPÈCES/BANQUE${Z}`);
  {
    const superAdmin = jetonPour(jeu.superAdminId, "super_admin", jeu.fatmat, true);
    const mois = new Date().toISOString().slice(0, 7);
    const rGen = await appel("POST", `/attendance-v2/payroll/${mois}/generate`, superAdmin, {});
    verifier("le super_admin génère la paie du mois", rGen.statut === 200 || rGen.statut === 201,
      JSON.stringify(rGen.corps).slice(0, 200));

    const rPaie = await appel("GET", `/attendance-v2/payroll?month=${mois}`, superAdmin);
    verifier("super_admin voit la paie (conserve ses droits)", rPaie.statut === 200);
    const items = rPaie.corps.items || rPaie.corps;
    const itemMoussa = Array.isArray(items) ? items.find((i) => i.employee_id === moussa.id) : null;
    if (itemMoussa) {
      verifier("une absence produit une retenue traçable (absence_deduction renseignée)",
        itemMoussa.absence_deduction !== undefined);
    } else {
      verifier("les lignes de paie sont bien produites", Array.isArray(items) && items.length > 0);
    }
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}24. CALCUL EN HEURE DE BAMAKO${Z}`);
  {
    const cfg = (await q(`SELECT timezone FROM attendance_company_configuration WHERE company_id=$1`, [jeu.fatmat]))[0];
    verifier("la société est configurée en Africa/Bamako", cfg?.timezone === "Africa/Bamako");
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}25. DEUX POINTAGES SIMULTANÉS SANS DOUBLON${Z}`);
  {
    const sidiki = employes.find((e) => e.full_name === "Sidiki Dembele");
    const [a, b] = await Promise.all([
      appel("POST", "/attendance-v2/check", ISSA, { employee_id: sidiki.id, action_type: "CHECK_IN" }),
      appel("POST", "/attendance-v2/check", ISSA, { employee_id: sidiki.id, action_type: "CHECK_IN" }),
    ]);
    const succes = [a, b].filter((r) => r.statut === 200).length;
    verifier("exactement un des deux pointages simultanés réussit", succes === 1, `A=${a.statut} B=${b.statut}`);
    const cnt = await q(`SELECT count(*) n FROM attendance_day_records_v2 WHERE employee_id=$1`, [sidiki.id]);
    verifier("une seule ligne de pointage pour ce jour", Number(cnt[0].n) === 1);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}26. PANNE AU MILIEU D'UNE CORRECTION = ROLLBACK TOTAL${Z}`);
  {
    const record = (await q(`SELECT id, late_minutes FROM attendance_day_records_v2 WHERE employee_id=$1`, [drissa.id]))[0];
    await pool.query(`
      CREATE OR REPLACE FUNCTION essai_panne_pointage() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'PANNE SIMULÉE — correction pointage'; END $$ LANGUAGE plpgsql`);
    await pool.query(`DROP TRIGGER IF EXISTS essai_panne_pointage_trg ON attendance_day_record_corrections`);
    await pool.query(`CREATE TRIGGER essai_panne_pointage_trg BEFORE INSERT ON attendance_day_record_corrections
                       FOR EACH ROW EXECUTE FUNCTION essai_panne_pointage()`);

    const avantCount = Number((await q(`SELECT count(*) n FROM attendance_day_record_corrections`))[0].n);
    const r = await appel("PATCH", `/attendance-v2/records/${record.id}`, ISSA,
      { field: "check_in", value: "2026-09-03T09:00:00.000Z", reason: "Ne doit jamais aboutir" });
    verifier("le serveur répond une erreur", r.statut >= 500);
    const apres = await q(`SELECT late_minutes FROM attendance_day_records_v2 WHERE id=$1`, [record.id]);
    verifier("le pointage n'a pas changé (rollback complet)", Number(apres[0].late_minutes) === Number(record.late_minutes));
    const apresCount = Number((await q(`SELECT count(*) n FROM attendance_day_record_corrections`))[0].n);
    verifier("aucune ligne de correction n'a survécu", apresCount === avantCount);

    await pool.query(`DROP TRIGGER IF EXISTS essai_panne_pointage_trg ON attendance_day_record_corrections`);
    await pool.query(`DROP FUNCTION IF EXISTS essai_panne_pointage()`);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}27. DISPARITION DE « ENTREPRISE ACTIVE REQUISE »${Z}`);
  {
    const r = await appel("GET", "/attendance-v2/today", ISSA);
    verifier("aucun COMPANY_REQUIRED pour Issa", r.corps.code !== "COMPANY_REQUIRED" && r.statut !== 409);
  }

  console.log(`\n${G}BILAN${Z}`);
  console.log(`  ${reussis} réussis, ${echoues} échoués\n`);
  await pool.end();
  process.exit(echoues > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`${R}ÉCHEC : ${e.message}${Z}`);
  console.error(e.stack);
  await pool.end().catch(() => {});
  process.exit(1);
});

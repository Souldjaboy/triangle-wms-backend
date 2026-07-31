"use strict";
/*
 * Import RÉEL des fichiers comptables Triangle / Fat et Mat, réutilisant le
 * Centre d'importation existant (aucun second moteur).
 *
 *   node scripts/import-real-accounting-files.js \
 *     --company-triangle-id=<id> --company-fatmat-id=<id> \
 *     --files-dir=<dossier> --dry-run
 *   node scripts/import-real-accounting-files.js ... --apply
 *
 * dry-run : n'écrit RIEN. apply : import transactionnel + réconciliation des
 * totaux ; rollback automatique si les totaux ne correspondent pas.
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { Pool } = require("pg");
const ic = require("../import-center");
const { recognizeWorkbook } = require("../import-center/recognizer");
const { executeFactures, simulateFactures, rollbackFactures } = require("../import-center/executor-factures");
const { executeCashbook, simulateCashbook, rollbackCashbook } = require("../import-center/executor-cashbook");

// ---- Helpers comptables autonomes (mêmes tables que server.js) ----
async function nextAccountingNumber(client, table, col, prefix, cid) {
  const { rows } = await client.query(`SELECT COUNT(*)::int n FROM ${table} WHERE company_id=$1`, [cid]);
  return `${prefix}-${cid}-${rows[0].n + 1}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}
async function createAccountingEntry(client, { companyId, sourceType, sourceId, accountLabel, debit = 0, credit = 0, description = "", createdBy = null }) {
  const num = await nextAccountingNumber(client, "accounting_entries", "entry_number", "ECR", companyId);
  await client.query(
    `INSERT INTO accounting_entries (company_id, entry_number, source_type, source_id, account_label, debit, credit, description, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [companyId, num, sourceType, sourceId, accountLabel, Number(debit), Number(credit), description, createdBy]
  );
}
const { isPeriodClosed } = require("../import-center/closure");
const helpers = { nextAccountingNumber, createAccountingEntry, isPeriodClosed };

// ---- Args ----
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, "").split("="); return [k, v === undefined ? true : v];
}));
const APPLY = args.apply === true;
const DRY = !APPLY;
const filesDir = args["files-dir"] ? String(args["files-dir"]).replace(/^~/, process.env.HOME) : null;
const triangleId = Number(args["company-triangle-id"]);
const fatmatId = Number(args["company-fatmat-id"]);
const USER_ID = Number(args["user-id"] || 0) || null;

// Totaux VALIDÉS (cahier des charges). Réconciliation obligatoire.
const EXPECT = {
  "tresorerie": { income: 5550000, expense: 5460750, label: "Trésorerie Mai" },
  "suivi_triangle": { income: 0, expense: 3153450, label: "Suivi Triangle" },
  "suivi_fatmat": { income: 3840000, expense: 2307300, label: "Suivi Fat et Mat" },
};

function companyForUnit(fileName, sheetName) {
  const f = fileName.toLowerCase(), s = String(sheetName || "").toLowerCase();
  if (/fat.?et.?mat|fatmat|fat_et_mat/.test(f) || /fat et mat/.test(s)) return { id: fatmatId, key: "fatmat", name: "Fat et Mat" };
  return { id: triangleId, key: "triangle", name: "Triangle Logistics" };
}
function expectKey(profileKey, companyKey) {
  if (profileKey === "triangle.tresorerie") return "tresorerie";
  if (profileKey === "triangle.suivi") return companyKey === "fatmat" ? "suivi_fatmat" : "suivi_triangle";
  return null;
}

async function main() {
  if (!triangleId || !fatmatId || !filesDir) {
    console.error("Usage: --company-triangle-id=<id> --company-fatmat-id=<id> --files-dir=<dir> [--dry-run|--apply]");
    process.exit(2);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log(`\n=== IMPORT RÉEL — MODE ${APPLY ? "APPLY (écriture)" : "DRY-RUN (aucune écriture)"} ===`);

  // Vérification des entreprises.
  for (const [label, id] of [["Triangle Logistics", triangleId], ["Fat et Mat", fatmatId]]) {
    const r = await pool.query("SELECT id, name FROM companies WHERE id=$1", [id]);
    if (!r.rows[0]) { console.error(`❌ Entreprise ${label} (id=${id}) INTROUVABLE. Ne pas créer silencieusement — abandon.`); await pool.end(); process.exit(3); }
    console.log(`  • ${label} → company_id=${id} (« ${r.rows[0].name} »)`);
  }

  const files = fs.readdirSync(filesDir).filter((f) => /\.(xlsx|xls|csv)$/i.test(f));
  if (files.length === 0) { console.error("❌ Aucun fichier dans " + filesDir); await pool.end(); process.exit(3); }

  // Empreintes déjà importées par (company, profil) + accumulées inter-feuilles (anti-doublons).
  const runFingerprints = new Map(); // `${companyId}|${profileKey}` -> Set

  async function persistentFp(companyId, profileKey) {
    const key = `${companyId}|${profileKey}`;
    if (!runFingerprints.has(key)) {
      const r = await pool.query(
        `SELECT DISTINCT r.fingerprint FROM import_rows r JOIN import_jobs j ON j.id=r.job_id
          WHERE r.company_id=$1 AND j.import_type=$2 AND j.status='imported' AND r.status='imported' AND r.fingerprint IS NOT NULL`,
        [companyId, profileKey]
      );
      runFingerprints.set(key, new Set(r.rows.map((x) => x.fingerprint)));
    }
    return runFingerprints.get(key);
  }

  const plan = [];
  for (const file of files) {
    const buf = fs.readFileSync(path.join(filesDir, file));
    const kind = file.toLowerCase().endsWith(".csv") ? "csv" : "excel";
    const rec = recognizeWorkbook(buf).filter((s) => s.recognized);
    for (const s of rec) {
      const comp = companyForUnit(file, s.sheet);
      plan.push({ file, buf, kind, sheet: s.sheet, headerRow: s.headerRow, mapping: s.mapping, profileKey: s.profileKey, comp });
    }
  }

  console.log(`\n${plan.length} unité(s) reconnue(s) :`);
  let anyMismatch = false;
  const report = [];

  for (const u of plan) {
    const profile = ic.registry.getProfile(u.profileKey);
    const analysis = await ic.analyzeBuffer(u.buf, u.kind, { sheet: u.sheet, headerRow: u.headerRow });
    const fp = await persistentFp(u.comp.id, u.profileKey);
    const result = ic.validate(analysis, u.profileKey, u.mapping, u.comp.id, { existingFingerprints: fp });

    // Cumule les empreintes de CETTE feuille pour éviter les doublons inter-feuilles.
    for (const r of result.rows) if (["new", "warning"].includes(r.status)) fp.add(r.fingerprint);

    const rows = result.rows.map((r) => ({ __row: r.__row, status: r.status, mapped: r.mapped }));
    let sim;
    if (profile.kind === "factures") sim = await simulateFactures(pool, u.comp.id, profile, rows);
    else sim = await simulateCashbook(pool, u.comp.id, profile, rows);

    const line = {
      fichier: u.file, feuille: u.sheet, profil: u.profileKey, entreprise: `${u.comp.name} (#${u.comp.id})`,
      total: result.summary.total, nouvelles: result.summary.new, deja_importees: result.summary.existing,
      doublons: result.summary.duplicates, invalides: result.summary.invalid,
    };
    if (profile.kind === "factures") {
      line.factures_facture = sim.totals.totalInvoiced; line.factures_paye = sim.totals.totalPaid;
      line.paye = sim.totals.paye; line.partiel = sim.totals.partiel; line.impaye = sim.totals.impaye;
    } else {
      line.recettes = sim.totals.totalIncome; line.depenses = sim.totals.totalExpense;
      const ek = expectKey(u.profileKey, u.comp.key);
      if (ek) {
        const exp = EXPECT[ek];
        // Réconciliation seulement si rien n'a encore été importé (sinon incrémental fausse le total).
        const fresh = result.summary.existing === 0;
        line.attendu = `${exp.income}/${exp.expense}`;
        line.reconcilie = fresh ? (sim.totals.totalIncome === exp.income && sim.totals.totalExpense === exp.expense) : "n/a (incrémental)";
        if (fresh && line.reconcilie !== true) anyMismatch = true;
      }
    }
    report.push({ u, profile, rows, sim, summary: result.summary, line });
    console.log("  " + JSON.stringify(line));
  }

  if (DRY) {
    console.log(`\n=== DRY-RUN terminé — AUCUNE écriture. ${anyMismatch ? "⚠ ÉCART de réconciliation détecté (voir 'reconcilie')." : "✅ Totaux réconciliés."} ===`);
    await pool.end();
    process.exit(anyMismatch ? 1 : 0);
  }

  // ---- APPLY ----
  if (anyMismatch) { console.error("\n❌ APPLY refusé : écart de réconciliation. Corriger avant import."); await pool.end(); process.exit(1); }
  const jobs = [];
  for (const R of report) {
    const { u, profile, rows } = R;
    // import_job de traçabilité.
    const job = (await pool.query(
      `INSERT INTO import_jobs (job_uid, company_id, tenant_id, product_code, module_key, submodule_key, import_type, original_filename, status, total_rows, created_by, validated_by, validated_at)
       VALUES ($1,$2,'triangle','triangle',$3,$4,$5,$6,'validated',$7,$8,$8,NOW()) RETURNING id, job_uid`,
      [require("crypto").randomUUID(), u.comp.id, profile.module_key, profile.submodule_key || null, u.profileKey, `${u.file}:${u.sheet || ""}`, R.summary.total, USER_ID]
    )).rows[0];
    // Persiste les lignes en staging (empreintes -> anti-doublons futur).
    for (const r of R.rows) {
      const fpr = ic.validator.fingerprint(u.comp.id, profile, r.mapped);
      await pool.query(
        `INSERT INTO import_rows (job_id, company_id, sheet_name, row_index, raw, mapped, fingerprint, status)
         VALUES ($1,$2,$3,$4,'{}',$5,$6,$7)`,
        [job.id, u.comp.id, u.sheet, r.__row, JSON.stringify(r.mapped), fpr, r.status]
      );
    }
    const opts = { jobId: job.id };
    const exec = profile.kind === "factures"
      ? await executeFactures(pool, u.comp.id, USER_ID, profile, R.rows, opts)
      : await executeCashbook(pool, u.comp.id, USER_ID, profile, R.rows, opts, helpers);
    // Met à jour les statuts des lignes importées (pour rollback).
    for (const rr of exec.rowResults) {
      await pool.query(`UPDATE import_rows SET status=$3, result_ref=$4 WHERE job_id=$1 AND row_index=$2`, [job.id, rr.__row, rr.status, JSON.stringify(rr.result_ref || {})]);
    }
    await pool.query(`UPDATE import_jobs SET status='imported', imported_rows=$2, executed_by=$3, executed_at=NOW() WHERE id=$1`, [job.id, exec.report.imported, USER_ID]);
    jobs.push({ job, unit: u, profile, report: exec.report });
    console.log(`  ✓ ${u.file} / ${u.sheet || "—"} → job ${job.job_uid.slice(0, 8)}… : ${JSON.stringify(exec.report)}`);
  }

  console.log(`\n=== IMPORT APPLIQUÉ. ${jobs.length} job(s) créé(s). ===`);
  console.log("Pour ANNULER : node scripts/import-real-accounting-files.js --rollback=<job_uid> (ou via /import/jobs/:uid/rollback).");
  console.log("job_uids :", jobs.map((j) => j.job.job_uid).join(", "));
  await pool.end();
}

// Rollback autonome d'un job.
async function rollbackJob(uid) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const job = (await pool.query("SELECT * FROM import_jobs WHERE job_uid=$1", [uid])).rows[0];
  if (!job) { console.error("Job introuvable."); await pool.end(); process.exit(3); }
  const profile = ic.registry.getProfile(job.import_type);
  const rows = (await pool.query("SELECT row_index, result_ref FROM import_rows WHERE job_id=$1 AND status='imported'", [job.id])).rows;
  const res = profile.kind === "factures"
    ? await rollbackFactures(pool, job.company_id, USER_ID, profile, job, rows)
    : await rollbackCashbook(pool, job.company_id, USER_ID, job, rows, helpers);
  console.log("Rollback :", JSON.stringify(res));
  await pool.end();
}

if (args.rollback) rollbackJob(String(args.rollback)).catch((e) => { console.error(e); process.exit(1); });
else main().catch((e) => { console.error("ERREUR:", e.message); process.exit(1); });

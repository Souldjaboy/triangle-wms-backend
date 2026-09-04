"use strict";

/**
 * Vérifie la migration 078 :
 * - laboratory_cases.case_number devient unique PAR société ;
 * - laboratory_cases.result_code reste unique GLOBALEMENT ;
 * - documents.document_number devient unique PAR société ;
 * - aucune contrainte n'est affaiblie à l'intérieur d'une même société.
 *
 * Usage :
 *   DATABASE_URL=… node scripts/test-numerotation-laboratoire-documents-par-societe.js
 */

const { Pool } = require("pg");

const V = "\x1b[32m", R = "\x1b[31m", G = "\x1b[1m", Z = "\x1b[0m";
let reussis = 0, echoues = 0;
function verifier(titre, condition, detail = "") {
  if (condition) { reussis += 1; console.log(`${V}  ✓${Z} ${titre}`); }
  else { echoues += 1; console.log(`${R}  ✗ ${titre}${Z}${detail ? `  — ${detail}` : ""}`); }
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquant.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function q(sql, params = []) { return (await pool.query(sql, params)).rows; }

const marqueur = `TEST078-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

async function main() {
  console.log(`\n${G}078 — NUMÉROTATION LABORATOIRE / DOCUMENTS PAR SOCIÉTÉ${Z}`);

  const societes = await q(`SELECT id FROM companies ORDER BY id LIMIT 2`);
  if (societes.length < 2) {
    console.error("Il faut au moins 2 sociétés dans la base de test.");
    process.exit(1);
  }
  const [S1, S2] = societes.map((s) => s.id);

  const caseNumber = `${marqueur}-CASE`;
  const resultCode1 = `${marqueur}-R1`;
  const resultCode2 = `${marqueur}-R2`;
  const documentNumber = `${marqueur}-DOC`;

  try {
    console.log(`\n${G}CONTRAINTES${Z}`);
    const labConstraints = await q(`
      SELECT conname
        FROM pg_constraint
       WHERE conrelid='laboratory_cases'::regclass
         AND contype='u'
       ORDER BY conname`);
    const docConstraints = await q(`
      SELECT conname
        FROM pg_constraint
       WHERE conrelid='documents'::regclass
         AND contype='u'
       ORDER BY conname`);

    verifier("ancienne contrainte globale case_number supprimée",
      !labConstraints.some((c) => c.conname === "laboratory_cases_case_number_key"),
      JSON.stringify(labConstraints));
    verifier("case_number unique par société",
      labConstraints.some((c) => c.conname === "laboratory_cases_company_case_number_key"),
      JSON.stringify(labConstraints));
    verifier("result_code reste unique globalement",
      labConstraints.some((c) => c.conname === "laboratory_cases_result_code_key"),
      JSON.stringify(labConstraints));
    verifier("document_number unique par société",
      docConstraints.some((c) => c.conname === "documents_company_document_number_key"),
      JSON.stringify(docConstraints));

    console.log(`\n${G}LABORATOIRE — MÊME case_number DANS DEUX SOCIÉTÉS${Z}`);
    const l1 = await q(
      `INSERT INTO laboratory_cases (company_id, case_number, result_code)
       VALUES ($1,$2,$3) RETURNING id`, [S1, caseNumber, resultCode1]);
    verifier("société 1 insère le dossier", Boolean(l1[0]?.id));

    let erreurInterSocieteCase = null;
    let idLab2 = null;
    try {
      const l2 = await q(
        `INSERT INTO laboratory_cases (company_id, case_number, result_code)
         VALUES ($1,$2,$3) RETURNING id`, [S2, caseNumber, resultCode2]);
      idLab2 = l2[0]?.id;
    } catch (e) { erreurInterSocieteCase = e; }
    verifier("société 2 peut utiliser le même case_number",
      !erreurInterSocieteCase && Boolean(idLab2),
      erreurInterSocieteCase ? `${erreurInterSocieteCase.code} ${erreurInterSocieteCase.message}` : "");

    let erreurMemeSocieteCase = null;
    try {
      await q(
        `INSERT INTO laboratory_cases (company_id, case_number, result_code)
         VALUES ($1,$2,$3)`, [S1, caseNumber, `${marqueur}-R3`]);
    } catch (e) { erreurMemeSocieteCase = e; }
    verifier("une même société ne peut pas dupliquer case_number",
      erreurMemeSocieteCase?.code === "23505",
      erreurMemeSocieteCase ? `${erreurMemeSocieteCase.code}` : "ACCEPTÉ À TORT");

    let erreurResultCode = null;
    try {
      await q(
        `INSERT INTO laboratory_cases (company_id, case_number, result_code)
         VALUES ($1,$2,$3)`, [S2, `${marqueur}-CASE-2`, resultCode1]);
    } catch (e) { erreurResultCode = e; }
    verifier("result_code reste refusé en doublon même entre deux sociétés",
      erreurResultCode?.code === "23505",
      erreurResultCode ? `${erreurResultCode.code}` : "ACCEPTÉ À TORT");

    console.log(`\n${G}DOCUMENTS — MÊME document_number DANS DEUX SOCIÉTÉS${Z}`);
    const d1 = await q(
      `INSERT INTO documents (company_id, document_number, document_type)
       VALUES ($1,$2,'Test 078') RETURNING id`, [S1, documentNumber]);
    verifier("société 1 insère le document", Boolean(d1[0]?.id));

    let erreurInterSocieteDoc = null;
    let idDoc2 = null;
    try {
      const d2 = await q(
        `INSERT INTO documents (company_id, document_number, document_type)
         VALUES ($1,$2,'Test 078') RETURNING id`, [S2, documentNumber]);
      idDoc2 = d2[0]?.id;
    } catch (e) { erreurInterSocieteDoc = e; }
    verifier("société 2 peut utiliser le même document_number",
      !erreurInterSocieteDoc && Boolean(idDoc2),
      erreurInterSocieteDoc ? `${erreurInterSocieteDoc.code} ${erreurInterSocieteDoc.message}` : "");

    let erreurMemeSocieteDoc = null;
    try {
      await q(
        `INSERT INTO documents (company_id, document_number, document_type)
         VALUES ($1,$2,'Test 078')`, [S1, documentNumber]);
    } catch (e) { erreurMemeSocieteDoc = e; }
    verifier("une même société ne peut pas dupliquer document_number",
      erreurMemeSocieteDoc?.code === "23505",
      erreurMemeSocieteDoc ? `${erreurMemeSocieteDoc.code}` : "ACCEPTÉ À TORT");

  } finally {
    await pool.query(`DELETE FROM laboratory_cases WHERE case_number LIKE $1`, [`${marqueur}%`]).catch(() => {});
    await pool.query(`DELETE FROM documents WHERE document_number LIKE $1`, [`${marqueur}%`]).catch(() => {});
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

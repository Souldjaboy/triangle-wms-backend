"use strict";

/**
 * L'UNICITÉ DES NUMÉROS SUIT LE COMPTEUR QUI LES PRODUIT (migration 078).
 *
 *   DATABASE_URL=… node scripts/test-numerotation-unique-par-societe.js
 *
 * Prolonge test-numerotation-comptable-par-societe.js (077) sur les deux
 * colonnes trouvées ensuite :
 *
 *   • laboratory_cases.case_number — même défaut que transaction_number :
 *     compteur par société, contrainte globale. Deux sociétés atteignant la
 *     même séquence le même jour se heurtaient ; elles doivent désormais
 *     coexister, sans pour autant qu'une société puisse se dupliquer.
 *
 *   • documents.document_number — n'avait AUCUNE contrainte : deux documents
 *     pouvaient porter le même numéro en silence, même société comprise.
 *     Le doublon doit maintenant être refusé, la coexistence inter-sociétés
 *     rester possible.
 *
 *   • laboratory_cases.result_code — vérifie la NON-modification délibérée :
 *     ce code est tiré au hasard et interrogé par une route publique sans
 *     société ; son unicité doit rester GLOBALE. Un test qui « passerait »
 *     après l'avoir resserrée signalerait une régression de sécurité.
 */

const { Pool } = require("pg");

const V = "\x1b[32m", R = "\x1b[31m", G = "\x1b[1m", Z = "\x1b[0m";
let reussis = 0, echoues = 0;
function verifier(titre, condition, detail = "") {
  if (condition) { reussis += 1; console.log(`${V}  ✓${Z} ${titre}`); }
  else { echoues += 1; console.log(`${R}  ✗ ${titre}${Z}${detail ? `  — ${detail}` : ""}`); }
}

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL manquant."); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/* Copie EXACTE de server.js:nextAccountingNumber — le test doit exercer le
   vrai algorithme, pas une reformulation qui pourrait diverger. */
async function nextAccountingNumber(client, tableName, columnName, prefix, companyId) {
  const year = new Date().getFullYear();
  const safeCompanyId = Number(companyId || 0);
  const counterKey = `${tableName}.${columnName}.${prefix}.${year}`;
  const counterResult = await client.query(
    `INSERT INTO number_counters (company_id, counter_key, last_value)
     VALUES ($1,$2,1)
     ON CONFLICT (company_id, counter_key)
     DO UPDATE SET last_value=number_counters.last_value + 1, updated_at=CURRENT_TIMESTAMP
     RETURNING last_value`,
    [safeCompanyId, counterKey]
  );
  const counterSequence = Number(counterResult.rows[0]?.last_value || 1);
  const { rows: colRows } = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name=$1 AND column_name='company_id'`, [tableName]);
  const hasCompanyId = colRows.length > 0;
  const result = await client.query(
    `SELECT ${columnName} AS number FROM ${tableName}
      WHERE ${hasCompanyId ? "company_id=$1 AND" : ""} ${columnName} LIKE $${hasCompanyId ? "2" : "1"}
      ORDER BY id DESC LIMIT 1`,
    hasCompanyId ? [companyId, `${prefix}-${year}-%`] : [`${prefix}-${year}-%`]
  );
  const lastNumber = String(result.rows[0]?.number || "");
  const lastSequence = Number(lastNumber.split("-").pop() || 0);
  const nextSequence = Math.max(counterSequence, lastSequence + 1);
  if (nextSequence !== counterSequence) {
    await client.query(
      `UPDATE number_counters SET last_value=$1, updated_at=CURRENT_TIMESTAMP WHERE company_id=$2 AND counter_key=$3`,
      [nextSequence, safeCompanyId, counterKey]);
  }
  return `${prefix}-${year}-${String(nextSequence).padStart(6, "0")}`;
}

const MARQUE = "ESSAI-078";

async function q(sql, params = []) { return (await pool.query(sql, params)).rows; }

const insererDossier = (c, companyId, numero, code) =>
  c.query(`INSERT INTO laboratory_cases (company_id, case_number, result_code, status)
           VALUES ($1,$2,$3,$4) RETURNING id`, [companyId, numero, code, MARQUE]);

const insererDocument = (c, companyId, numero) =>
  c.query(`INSERT INTO documents (company_id, document_number, document_type, client_name)
           VALUES ($1,$2,$3,$4) RETURNING id`, [companyId, numero, MARQUE, MARQUE]);

async function nettoyer() {
  await pool.query(`DELETE FROM laboratory_cases WHERE status = $1`, [MARQUE]);
  await pool.query(`DELETE FROM documents WHERE document_type = $1`, [MARQUE]);
  await pool.query(`DELETE FROM number_counters WHERE counter_key LIKE '%ESSAI078%'`);
}

async function main() {
  console.log(`\n${G}NUMÉROTATION — UNICITÉ À LA MAILLE DU COMPTEUR (078)${Z}`);

  const societes = await q(`SELECT id FROM companies ORDER BY id LIMIT 2`);
  if (societes.length < 2) { console.error("Il faut au moins 2 sociétés dans la base de test."); process.exit(1); }
  const [S1, S2] = societes.map((s) => s.id);
  await nettoyer();

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}LES CONTRAINTES SONT CELLES ATTENDUES${Z}`);
  {
    const labo = await q(`SELECT conname FROM pg_constraint
                           WHERE conrelid='laboratory_cases'::regclass AND contype='u'`);
    const noms = labo.map((c) => c.conname);
    verifier("laboratory_cases : l'ancienne contrainte globale sur case_number a disparu",
      !noms.includes("laboratory_cases_case_number_key"), JSON.stringify(noms));
    verifier("laboratory_cases : (company_id, case_number) est en place",
      noms.includes("laboratory_cases_company_case_number_key"));
    verifier("laboratory_cases : result_code garde son unicité GLOBALE (non-correction délibérée)",
      noms.includes("laboratory_cases_result_code_key"), JSON.stringify(noms));

    const docs = await q(`SELECT conname FROM pg_constraint
                           WHERE conrelid='documents'::regclass AND contype='u'`);
    verifier("documents : (company_id, document_number) existe désormais",
      docs.some((c) => c.conname === "documents_company_document_number_key"),
      JSON.stringify(docs.map((c) => c.conname)));
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}DOSSIERS DE LABORATOIRE : DEUX SOCIÉTÉS, MÊME SÉQUENCE${Z}`);
  {
    const c1 = await pool.connect(), c2 = await pool.connect();
    try {
      const n1 = await nextAccountingNumber(c1, "laboratory_cases", "case_number", "LABD-ESSAI078", S1);
      const n2 = await nextAccountingNumber(c2, "laboratory_cases", "case_number", "LABD-ESSAI078", S2);
      verifier("les deux sociétés obtiennent le MÊME texte de numéro (c'est le bug d'origine)",
        n1 === n2, `${n1} / ${n2}`);

      const r1 = await insererDossier(c1, S1, n1, `${MARQUE}-A`);
      verifier("la société 1 enregistre son dossier", Boolean(r1.rows[0]?.id));

      let erreur = null, id2 = null;
      try { id2 = (await insererDossier(c2, S2, n2, `${MARQUE}-B`)).rows[0]?.id; }
      catch (e) { erreur = e; }
      verifier("la société 2 enregistre AUSSI le sien — c'est le correctif",
        !erreur && Boolean(id2), erreur ? `${erreur.code} ${erreur.message}` : "");

      const lignes = await q(`SELECT company_id FROM laboratory_cases
                               WHERE case_number = $1 ORDER BY company_id`, [n1]);
      verifier("les deux dossiers coexistent réellement, un par société",
        lignes.length === 2 && lignes[0].company_id !== lignes[1].company_id, JSON.stringify(lignes));
    } finally { c1.release(); c2.release(); }
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}UNE MÊME SOCIÉTÉ NE PEUT TOUJOURS PAS SE DUPLIQUER${Z}`);
  {
    const c = await pool.connect();
    try {
      const n = await nextAccountingNumber(c, "laboratory_cases", "case_number", "LABD-ESSAI078-INT", S1);
      await insererDossier(c, S1, n, `${MARQUE}-C`);
      let refus = null;
      try { await insererDossier(c, S1, n, `${MARQUE}-D`); } catch (e) { refus = e; }
      verifier("réutiliser le même case_number dans la même société est refusé",
        Boolean(refus), refus ? "refusé comme attendu" : "ACCEPTÉ À TORT");
    } finally { c.release(); }
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}RESULT_CODE : L'UNICITÉ GLOBALE PROTÈGE LA RECHERCHE PUBLIQUE${Z}`);
  {
    /* La route publique /laboratory/public/results/verify cherche sur le seul
       result_code, sans société. Deux sociétés ne doivent donc jamais pouvoir
       porter le même code : ce refus est le comportement VOULU. */
    const c = await pool.connect();
    try {
      const code = `${MARQUE}-PARTAGE`;
      await insererDossier(c, S1, `LABD-ESSAI078-RC-1`, code);
      let refus = null;
      try { await insererDossier(c, S2, `LABD-ESSAI078-RC-2`, code); } catch (e) { refus = e; }
      verifier("une AUTRE société ne peut pas réutiliser le même result_code",
        Boolean(refus), refus ? "refusé comme attendu" : "ACCEPTÉ À TORT — la recherche publique fuiterait");
    } finally { c.release(); }
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}DOCUMENTS : LE DOUBLON SILENCIEUX N'EST PLUS POSSIBLE${Z}`);
  {
    const c = await pool.connect();
    try {
      const numero = `REC-ESSAI078-0001`;
      const a = await insererDocument(c, S1, numero);
      verifier("un document s'enregistre normalement", Boolean(a.rows[0]?.id));

      let refus = null;
      try { await insererDocument(c, S1, numero); } catch (e) { refus = e; }
      verifier("le MÊME numéro dans la MÊME société est désormais refusé (il passait en silence avant 078)",
        Boolean(refus), refus ? "refusé comme attendu" : "ACCEPTÉ À TORT");

      let erreurAutre = null, idAutre = null;
      try { idAutre = (await insererDocument(c, S2, numero)).rows[0]?.id; }
      catch (e) { erreurAutre = e; }
      verifier("le même numéro reste possible dans l'AUTRE société (compteurs séparés)",
        !erreurAutre && Boolean(idAutre), erreurAutre ? `${erreurAutre.code} ${erreurAutre.message}` : "");

      /* Un numéro absent n'est pas un doublon : PostgreSQL ne compare pas les
         NULL entre eux, et de vieux documents importés n'en portent pas. */
      let erreurNull = null;
      try {
        await insererDocument(c, S1, null);
        await insererDocument(c, S1, null);
      } catch (e) { erreurNull = e; }
      verifier("plusieurs documents sans numéro restent acceptés",
        !erreurNull, erreurNull ? `${erreurNull.code} ${erreurNull.message}` : "");
    } finally { c.release(); }
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}LE VRAI CHEMIN DES REÇUS DE LABORATOIRE (préfixe REC-LAB)${Z}`);
  {
    const c = await pool.connect();
    try {
      const r1 = await nextAccountingNumber(c, "documents", "document_number", "REC-LAB-ESSAI078", S1);
      const r2 = await nextAccountingNumber(c, "documents", "document_number", "REC-LAB-ESSAI078", S2);
      verifier("les deux sociétés produisent le même texte de reçu", r1 === r2, `${r1} / ${r2}`);
      await insererDocument(c, S1, r1);
      let echec = null;
      try { await insererDocument(c, S2, r2); } catch (e) { echec = e; }
      verifier("le reçu de la seconde société s'enregistre sans collision",
        !echec, echec ? `${echec.code} ${echec.message}` : "");
    } finally { c.release(); }
  }

  await nettoyer();

  console.log(`\n${G}BILAN${Z}`);
  console.log(`  ${reussis} réussis, ${echoues} échoués\n`);
  await pool.end();
  process.exit(echoues > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`${R}ÉCHEC : ${e.message}${Z}`);
  console.error(e.stack);
  await nettoyer().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});

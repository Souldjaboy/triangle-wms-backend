"use strict";

/**
 * DEUX SOCIÉTÉS PEUVENT DÉSORMAIS ATTEINDRE LA MÊME SÉQUENCE DU MÊME
 * PRÉFIXE LE MÊME JOUR, SANS COLLISION.
 *
 *   DATABASE_URL=… node scripts/test-numerotation-comptable-par-societe.js
 *
 * Reproduit exactement le scénario qui a fait échouer une contrepassation le
 * 2026-09-03 : deux sociétés, chacune à sa première transaction comptable
 * d'un préfixe donné, la même année — ce qui produit littéralement le même
 * texte (« ENC-SAB-2026-000001 ») sous l'ancien compteur par société. Avant
 * la migration 077, la seconde société heurtait une violation de contrainte
 * PostgreSQL brute. Après, les deux réussissent : la contrainte porte sur
 * (company_id, transaction_number), pas sur transaction_number seul.
 *
 * Vérifie aussi que la fonction ne pourra plus jamais l'écraser en silence :
 * appeler nextAccountingNumber() pour la MÊME société sur le MÊME préfixe
 * deux fois de suite doit toujours produire deux numéros DIFFÉRENTS (la
 * contrainte élargie ne doit pas ouvrir la porte à des doublons internes à
 * une société).
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

/* Copie EXACTE de server.js:nextAccountingNumber — ce test doit exercer le
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

async function inserer(client, companyId, transactionNumber) {
  return client.query(
    `INSERT INTO accounting_transactions
       (company_id, transaction_number, transaction_type, source_type, source_id,
        amount, currency, direction, category, description, status, created_by)
     VALUES ($1,$2,'essai_numerotation','essai_source',$3,1,'FCFA','entrée','Essai','Essai numérotation','validé',NULL)
     RETURNING id`,
    [companyId, transactionNumber, Math.floor(Math.random() * 1000000)]);
}

async function q(sql, params = []) { return (await pool.query(sql, params)).rows; }

async function main() {
  console.log(`\n${G}NUMÉROTATION COMPTABLE — UNICITÉ PAR SOCIÉTÉ${Z}`);

  const societes = await q(`SELECT id FROM companies ORDER BY id LIMIT 2`);
  if (societes.length < 2) { console.error("Il faut au moins 2 sociétés dans la base de test."); process.exit(1); }
  const [S1, S2] = societes.map((s) => s.id);

  await pool.query(`DELETE FROM accounting_transactions WHERE source_type='essai_source'`);
  await pool.query(`DELETE FROM number_counters WHERE counter_key LIKE 'accounting_transactions.transaction_number.ESSAI-COLLISION%'`);

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}LA CONTRAINTE EST BIEN CELLE ATTENDUE${Z}`);
  {
    const contraintes = await q(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'accounting_transactions'::regclass AND contype = 'u'`);
    verifier("l'ancienne contrainte globale n'existe plus",
      !contraintes.some((c) => c.conname === "accounting_transactions_transaction_number_key"),
      JSON.stringify(contraintes));
    verifier("la nouvelle contrainte (company_id, transaction_number) existe",
      contraintes.some((c) => c.conname === "accounting_transactions_company_transaction_number_key"));
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}DEUX SOCIÉTÉS, MÊME PRÉFIXE, MÊME SÉQUENCE, MÊME JOUR${Z}`);
  {
    const c1 = await pool.connect(), c2 = await pool.connect();
    try {
      const num1 = await nextAccountingNumber(c1, "accounting_transactions", "transaction_number", "ESSAI-COLLISION", S1);
      const num2 = await nextAccountingNumber(c2, "accounting_transactions", "transaction_number", "ESSAI-COLLISION", S2);
      verifier("les deux sociétés obtiennent le MÊME texte de numéro (c'est le bug d'origine)",
        num1 === num2, `${num1} / ${num2}`);

      const r1 = await inserer(c1, S1, num1);
      verifier("la société 1 insère sa transaction sans erreur", Boolean(r1.rows[0]?.id));

      let erreurSociete2 = null;
      let idSociete2 = null;
      try {
        const r2 = await inserer(c2, S2, num2);
        idSociete2 = r2.rows[0]?.id;
      } catch (e) { erreurSociete2 = e; }
      verifier("la société 2 insère AUSSI sa transaction sans erreur — c'est le correctif",
        !erreurSociete2 && Boolean(idSociete2),
        erreurSociete2 ? `${erreurSociete2.code} ${erreurSociete2.message}` : "");

      const lignes = await q(
        `SELECT company_id, transaction_number FROM accounting_transactions
          WHERE transaction_number = $1 ORDER BY company_id`, [num1]);
      verifier("les deux lignes coexistent réellement en base, une par société",
        lignes.length === 2 && lignes[0].company_id !== lignes[1].company_id, JSON.stringify(lignes));
    } finally { c1.release(); c2.release(); }
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}UNE MÊME SOCIÉTÉ NE PEUT TOUJOURS PAS AVOIR DE DOUBLON${Z}`);
  {
    const client = await pool.connect();
    try {
      const numA = await nextAccountingNumber(client, "accounting_transactions", "transaction_number", "ESSAI-INTERNE", S1);
      const numB = await nextAccountingNumber(client, "accounting_transactions", "transaction_number", "ESSAI-INTERNE", S1);
      verifier("deux appels successifs pour la MÊME société donnent des numéros différents",
        numA !== numB, `${numA} / ${numB}`);

      await inserer(client, S1, numA);
      let echecAttendu = null;
      try { await inserer(client, S1, numA); } catch (e) { echecAttendu = e; }
      verifier("réinsérer le MÊME numéro pour la MÊME société est toujours refusé",
        Boolean(echecAttendu), echecAttendu ? "refusé comme attendu" : "ACCEPTÉ À TORT");
    } finally { client.release(); }
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}LE SCÉNARIO RÉEL DU 2026-09-03 : ENCAISSEMENT PUIS CONTREPASSATION${Z}`);
  {
    /* Même préfixe (REV-SAB) que celui qui a heurté la collision en
       production ce jour-là, sur les deux sociétés simultanément. */
    const client = await pool.connect();
    try {
      const numTriangle = await nextAccountingNumber(client, "accounting_transactions", "transaction_number", "REV-SAB", S1);
      const numFatmat = await nextAccountingNumber(client, "accounting_transactions", "transaction_number", "REV-SAB", S2);
      verifier("les deux préfixes REV-SAB générés le même jour sont identiques en texte",
        numTriangle === numFatmat);
      await inserer(client, S1, numTriangle);
      let echec = null;
      try { await inserer(client, S2, numFatmat); } catch (e) { echec = e; }
      verifier("la contrepassation de la seconde société n'échoue plus", !echec,
        echec ? `${echec.code} ${echec.message}` : "");
    } finally { client.release(); }
  }

  await pool.query(`DELETE FROM accounting_transactions WHERE source_type='essai_source'`);

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

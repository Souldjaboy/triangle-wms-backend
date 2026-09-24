"use strict";

/**
 * Retrait exceptionnel des 13 ventes de TEST sable FAT & MAT constatées le
 * 4 septembre 2026. Les lignes sont archivées en JSONB avant suppression.
 * Aucun import Excel, mouvement de stock ou numéro de compteur n'est modifié.
 *
 * PREVIEW :
 *   DATABASE_URL=... node scripts/nettoyer-ventes-test-sable-fatmat.js --preview
 *
 * APPLICATION :
 *   DATABASE_URL=... node scripts/nettoyer-ventes-test-sable-fatmat.js --apply \
 *     --confirmer=OUI-JE-RETIRE-LES-13-VENTES-TEST-FATMAT
 */

const { Pool } = require("pg");

const CONFIRMATION = "OUI-JE-RETIRE-LES-13-VENTES-TEST-FATMAT";
const IMPORT_KEY_PROTEGE = "COMPTA-REELLE-2026-09-03";
const SALE_IDS = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
const SALE_NUMBERS = [
  "VS-260902-001", "VS-260902-002", "VS-260902-003", "VS-260902-004",
  "VS-260902-005", "VS-260902-006", "VS-260902-007", "VS-260902-008",
  "VS-260902-009", "VS-260902-010", "VS-260903-001", "VS-260904-001",
  "VS-260904-002",
];
const TOTAL_ATTENDU = 18481500;
const SOLDE_TRESORERIE_ATTENDU = 555000;

const argv = process.argv.slice(2);
const PREVIEW = argv.includes("--preview");
const APPLY = argv.includes("--apply");
const option = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

if (PREVIEW === APPLY) {
  console.error("Indiquez exactement un mode : --preview ou --apply.");
  process.exit(1);
}
if (APPLY && option("confirmer") !== CONFIRMATION) {
  console.error(`Confirmation obligatoire : --confirmer=${CONFIRMATION}`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquant.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const amount = (v) => Number(v || 0);

async function resolveCompany(client) {
  const { rows } = await client.query(
    `SELECT id, name FROM companies
      WHERE name ILIKE '%FAT%' AND name ILIKE '%MAT%' ORDER BY id`
  );
  if (rows.length !== 1) {
    throw new Error(`FAT & MAT doit correspondre à une société unique (trouvé : ${rows.length}).`);
  }
  if (Number(rows[0].id) !== 5) {
    throw new Error(`La société FAT & MAT trouvée porte l'id ${rows[0].id}, attendu 5. Arrêt.`);
  }
  return rows[0];
}

async function inspect(client, companyId, lock = false) {
  const sales = (await client.query(
    `SELECT * FROM sand_sales
      WHERE company_id=$1 ORDER BY id ${lock ? "FOR UPDATE" : ""}`, [companyId]
  )).rows;
  const invoices = (await client.query(
    `SELECT * FROM sand_invoices WHERE company_id=$1 AND sale_id=ANY($2::int[])
      ORDER BY id ${lock ? "FOR UPDATE" : ""}`, [companyId, SALE_IDS]
  )).rows;
  const deliveries = (await client.query(
    `SELECT * FROM sand_deliveries WHERE company_id=$1 AND sale_id=ANY($2::int[])
      ORDER BY id ${lock ? "FOR UPDATE" : ""}`, [companyId, SALE_IDS]
  )).rows;
  const payments = (await client.query(
    `SELECT p.* FROM sand_payments p JOIN sand_invoices i ON i.id=p.invoice_id
      WHERE p.company_id=$1 AND i.company_id=$1 AND i.sale_id=ANY($2::int[])
      ORDER BY p.id ${lock ? "FOR UPDATE OF p" : ""}`, [companyId, SALE_IDS]
  )).rows;
  const audits = (await client.query(
    `SELECT * FROM sand_sale_audit_log
      WHERE company_id=$1 AND (
        sale_id=ANY($2::int[]) OR original_sale_id=ANY($2::int[])
        OR replacement_sale_id=ANY($2::int[])
        OR invoice_id=ANY($3::int[]) OR delivery_id=ANY($4::int[])
      ) ORDER BY id`, [companyId, SALE_IDS, invoices.map((r) => r.id), deliveries.map((r) => r.id)]
  )).rows;
  const treasury = (await client.query(
    `SELECT * FROM treasury_accounts WHERE company_id=$1 ORDER BY id ${lock ? "FOR UPDATE" : ""}`,
    [companyId]
  )).rows;
  const protectedImport = (await client.query(
    `SELECT * FROM accounting_historical_imports
      WHERE company_id=$1 AND import_key=$2 AND status='APPLIED'`,
    [companyId, IMPORT_KEY_PROTEGE]
  )).rows;
  const accountingMatches = (await client.query(
    `SELECT * FROM accounting_transactions WHERE company_id=$1 AND (
       source_type ILIKE '%sand%' OR transaction_type ILIKE '%sable%'
       OR category ILIKE '%sable%' OR description ILIKE '%sable%'
       OR amount IN (555000,570000))`, [companyId]
  )).rows;
  return { sales, invoices, deliveries, payments, audits, treasury, protectedImport, accountingMatches };
}

function validate(state) {
  const ids = state.sales.map((s) => Number(s.id));
  const numbers = state.sales.map((s) => s.sale_number);
  const total = state.sales.reduce((sum, s) => sum + amount(s.total_amount), 0);
  const active = state.sales.filter((s) => !["ANNULEE", "REMPLACEE"].includes(String(s.status).toUpperCase())).length;
  const treasury = state.treasury[0];
  const problems = [];
  if (state.sales.length !== 13) problems.push(`ventes=${state.sales.length}, attendu 13`);
  if (JSON.stringify(ids) !== JSON.stringify(SALE_IDS)) problems.push(`ids=${ids.join(",")}`);
  if (JSON.stringify(numbers) !== JSON.stringify(SALE_NUMBERS)) problems.push("numéros de ventes différents");
  if (total !== TOTAL_ATTENDU) problems.push(`total=${total}, attendu ${TOTAL_ATTENDU}`);
  if (active !== 12) problems.push(`ventes actives=${active}, attendu 12`);
  if (state.invoices.length !== 12) problems.push(`factures=${state.invoices.length}, attendu 12`);
  if (state.deliveries.length !== 12) problems.push(`BL=${state.deliveries.length}, attendu 12`);
  if (state.payments.length !== 0) problems.push(`paiements=${state.payments.length}, attendu 0`);
  if (state.accountingMatches.length !== 0) problems.push(`écritures comptables liées=${state.accountingMatches.length}, attendu 0`);
  if (state.protectedImport.length !== 1) problems.push("import Excel protégé absent ou ambigu");
  if (state.treasury.length !== 1 || amount(treasury?.current_balance) !== SOLDE_TRESORERIE_ATTENDU) {
    problems.push(`trésorerie=${state.treasury.map((t) => t.current_balance).join(",")}, attendu 555000`);
  }
  if (problems.length) throw new Error(`Périmètre différent du diagnostic certifié : ${problems.join(" ; ")}.`);
  return { total, active };
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query(PREVIEW ? "BEGIN READ ONLY" : "BEGIN");
    await client.query("SET LOCAL statement_timeout='60s'");
    const company = await resolveCompany(client);

    if (APPLY) {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('nettoyage-ventes-test-sable-fatmat'), hashtext($1))`,
        [String(company.id)]
      );
    }

    const archiveExists = (await client.query(
      `SELECT to_regclass('public.fatmat_sand_test_cleanup_archive') AS name`
    )).rows[0].name;
    if (archiveExists) {
      const previous = (await client.query(
        `SELECT id, cleanup_key, applied_at FROM fatmat_sand_test_cleanup_archive
          WHERE cleanup_key='FATMAT-SABLE-TEST-20260904'`
      )).rows[0];
      if (previous) {
        console.log(`Déjà appliqué de façon idempotente le ${previous.applied_at} (archive #${previous.id}).`);
        await client.query("ROLLBACK");
        return;
      }
    }

    const state = await inspect(client, company.id, APPLY);
    const verified = validate(state);
    console.log(`Mode : ${PREVIEW ? "PREVIEW — aucune écriture" : "APPLICATION"}`);
    console.log(`Société : #${company.id} ${company.name}`);
    console.log(`Ventes : ${state.sales.length} (${verified.active} actives), total ${verified.total} FCFA`);
    console.log(`Factures : ${state.invoices.length}; BL : ${state.deliveries.length}; paiements : 0`);
    console.log(`Trésorerie test à neutraliser : ${state.treasury[0].current_balance} FCFA`);
    console.log(`Import Excel protégé : ${state.protectedImport[0].import_key} — ${state.protectedImport[0].status}`);
    console.log(`Ventes : ${state.sales.map((s) => `${s.id}:${s.sale_number}:${s.status}`).join(" | ")}`);

    if (PREVIEW) {
      console.log("Prévisualisation terminée. Rien n'a été écrit.");
      console.log(`Pour appliquer : --apply --confirmer=${CONFIRMATION}`);
      await client.query("ROLLBACK");
      return;
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS fatmat_sand_test_cleanup_archive (
        id bigserial PRIMARY KEY,
        cleanup_key text NOT NULL UNIQUE,
        company_id integer NOT NULL,
        reason text NOT NULL,
        snapshot jsonb NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `INSERT INTO fatmat_sand_test_cleanup_archive
         (cleanup_key, company_id, reason, snapshot)
       VALUES ('FATMAT-SABLE-TEST-20260904',$1,$2,$3::jsonb)`,
      [company.id,
       "Retrait exceptionnel des ventes d'essai antérieures au démarrage réel de FAT & MAT",
       JSON.stringify(state)]
    );

    await client.query(
      `DELETE FROM sand_sale_audit_log WHERE company_id=$1 AND (
        sale_id=ANY($2::int[]) OR original_sale_id=ANY($2::int[])
        OR replacement_sale_id=ANY($2::int[])
        OR invoice_id=ANY($3::int[]) OR delivery_id=ANY($4::int[]))`,
      [company.id, SALE_IDS, state.invoices.map((r) => r.id), state.deliveries.map((r) => r.id)]
    );
    const deleted = await client.query(
      `DELETE FROM sand_sales WHERE company_id=$1 AND id=ANY($2::int[]) RETURNING id`,
      [company.id, SALE_IDS]
    );
    if (deleted.rowCount !== 13) throw new Error(`Suppression incomplète : ${deleted.rowCount}/13.`);

    const treasuryReset = await client.query(
      `UPDATE treasury_accounts SET current_balance=0, updated_at=now()
        WHERE company_id=$1 AND id=$2 AND current_balance=$3 RETURNING id`,
      [company.id, state.treasury[0].id, SOLDE_TRESORERIE_ATTENDU]
    );
    if (treasuryReset.rowCount !== 1) throw new Error("Neutralisation de la trésorerie non effectuée exactement une fois.");

    const checks = await Promise.all([
      client.query(`SELECT count(*)::int n FROM sand_sales WHERE company_id=$1`, [company.id]),
      client.query(`SELECT count(*)::int n FROM sand_invoices WHERE company_id=$1`, [company.id]),
      client.query(`SELECT count(*)::int n FROM sand_deliveries WHERE company_id=$1`, [company.id]),
      client.query(`SELECT current_balance FROM treasury_accounts WHERE company_id=$1`, [company.id]),
      client.query(`SELECT status FROM accounting_historical_imports WHERE company_id=$1 AND import_key=$2`,
        [company.id, IMPORT_KEY_PROTEGE]),
    ]);
    if (checks[0].rows[0].n !== 0 || checks[1].rows[0].n !== 0 || checks[2].rows[0].n !== 0
        || amount(checks[3].rows[0].current_balance) !== 0 || checks[4].rows[0].status !== "APPLIED") {
      throw new Error("Contrôle final incohérent : rollback total.");
    }

    await client.query("COMMIT");
    console.log("TERMINÉ : 13 ventes test archivées puis retirées, 12 factures et 12 BL retirés par cascade.");
    console.log("Trésorerie FAT & MAT : 555000 → 0 FCFA. Import Excel : intact et APPLIED.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`ARRÊT : ${error.message}`);
    console.error("Aucun changement partiel n'a été conservé.");
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();

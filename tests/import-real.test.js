"use strict";
/* Intégration : reconnaissance auto + exécuteurs factures/trésorerie/suivi
   (fixtures SYNTHÉTIQUES reproduisant la structure réelle Triangle). DB requise. */
const assert = require("assert");
require("dotenv").config();
if (!process.env.DATABASE_URL) { console.log("⏭  import-real: DATABASE_URL absente, ignoré."); process.exit(0); }

const XLSX = require("xlsx");
const { Pool } = require("pg");
const ic = require("../import-center");
const { recognizeWorkbook } = require("../import-center/recognizer");
const { executeFactures } = require("../import-center/executor-factures");
const { executeCashbook } = require("../import-center/executor-cashbook");

// Helpers comptables minimaux (mêmes tables que server.js).
async function nextAccountingNumber(client, table, col, prefix, cid) {
  const { rows } = await client.query(`SELECT COUNT(*)::int n FROM ${table} WHERE company_id=$1`, [cid]);
  return `${prefix}-${cid}-${rows[0].n + 1}-${Date.now().toString(36)}`;
}
async function createAccountingEntry(client, { companyId, sourceType, sourceId, accountLabel, debit = 0, credit = 0, description = "", createdBy = null }) {
  const num = await nextAccountingNumber(client, "accounting_entries", "entry_number", "ECR", companyId);
  await client.query(`INSERT INTO accounting_entries (company_id, entry_number, source_type, source_id, account_label, debit, credit, description, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [companyId, num, sourceType, sourceId, accountLabel, Number(debit), Number(credit), description, createdBy]);
}
const helpers = { nextAccountingNumber, createAccountingEntry, isPeriodClosed: async () => false };

const CO = 1;
const buf = (rows, name) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name); return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }); };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let passed = 0;
  const test = (n, c) => { assert.ok(c, n); passed++; console.log("  ✓ " + n); };
  const clean = async () => {
    await pool.query("DELETE FROM factures WHERE company_id=$1 AND reference LIKE 'TST-%'", [CO]).catch(() => {});
    await pool.query("DELETE FROM camion_operations WHERE company_id=$1 AND libelle LIKE 'TST %'", [CO]).catch(() => {});
    await pool.query("DELETE FROM camions WHERE company_id=$1 AND code LIKE 'TST %'", [CO]).catch(() => {});
    await pool.query("DELETE FROM accounting_transactions WHERE company_id=$1 AND description LIKE 'TST %'", [CO]).catch(() => {});
  };
  try {
    await clean();
    console.log("Import RÉEL — reconnaissance auto + exécuteurs");

    // 1) FACTURES — structure réelle (titre + en-tête + données), montants "3,900,000".
    const facBuf = buf([
      ["", "Etats global des factures", "", "", "", "", "", "", "", "", ""],
      ["N°", "Date de Facture", "Ref/N° Facture", "Localite/Site", "Description", "Montant Facturé ( en F CFA)", "Montant Payé ( en F CFA)", "Reste à payer ( en F CFA)", "Date de paiement", "Statut", "Obervations"],
      [1, "23/02/2026", "TST-001", "CSREF C1", "Ciment", "3,900,000", "3,900,000", 0, "", "Payé", ""],
      [2, "24/02/2026", "TST-002", "Site B", "Sable", "1,000,000", "400,000", 0, "", "Impayé", ""],
      [3, "25/02/2026", "TST-003", "Site C", "Gravier", "500,000", 0, 0, "", "Impayé", ""],
    ], "Feuil1");
    const facRec = recognizeWorkbook(facBuf)[0];
    test("factures reconnues automatiquement", facRec.recognized && facRec.profileKey === "triangle.factures");
    const facAnalysis = await ic.analyzeBuffer(facBuf, "excel", { sheet: facRec.sheet, headerRow: facRec.headerRow });
    const facVal = ic.validate(facAnalysis, "triangle.factures", facRec.mapping, CO);
    test("montant '3,900,000' parsé = 3900000", facVal.rows[0].mapped.invoiced_amount === 3900000);
    const facRows = facVal.rows.map((r) => ({ __row: r.__row, status: r.status, mapped: r.mapped }));
    const facRes = await executeFactures(pool, CO, 1, ic.registry.getProfile("triangle.factures"), facRows, {});
    test("factures exécutées (3 créées)", facRes.report.created === 3);
    const st = (await pool.query("SELECT status, count(*)::int n FROM factures WHERE company_id=$1 AND reference LIKE 'TST-%' GROUP BY status", [CO])).rows;
    const map = Object.fromEntries(st.map((r) => [r.status, r.n]));
    test("statuts recalculés : 1 payé, 1 partiel, 1 impayé", map.paye === 1 && map.partiel === 1 && map.impaye === 1);

    // 2) TRÉSORERIE — Date/Libellé/Entrée/Sortie/Solde + ligne Total ignorée.
    const treBuf = buf([
      ["TABLEAU DE TRESORERIE", "", "", "", ""],
      ["Date", "Libéllé", "Entrée", "Sortie", "Solde"],
      ["18/05/2026", "TST reception", "3,000,000", "", ""],
      ["19/05/2026", "TST paiement", "", "200,000", ""],
      ["", "Total", "3,000,000", "200,000", "2,800,000"],
    ], "Tresorerie Mai");
    const treRec = recognizeWorkbook(treBuf)[0];
    test("trésorerie reconnue automatiquement", treRec.profileKey === "triangle.tresorerie");
    const treAn = await ic.analyzeBuffer(treBuf, "excel", { sheet: treRec.sheet, headerRow: treRec.headerRow });
    const treVal = ic.validate(treAn, "triangle.tresorerie", treRec.mapping, CO);
    const treRows = treVal.rows.map((r) => ({ __row: r.__row, status: r.status, mapped: { ...r.mapped, libelle: "TST " + (r.mapped.libelle || "") } }));
    const treRes = await executeCashbook(pool, CO, 1, ic.registry.getProfile("triangle.tresorerie"), treRows, {}, helpers);
    test("trésorerie : ligne Total ignorée (2 transactions, pas 3)", treRes.report.transactions === 2 && treRes.report.skipped >= 1);
    test("trésorerie : recette 3M, dépense 200k", treRes.report.totalIncome === 3000000 && treRes.report.totalExpense === 200000);

    // 3) SUIVI FAT ET MAT — avec Camion + sous-totaux ignorés.
    const suiBuf = buf([
      ["Tableau de suivi", "", "", "", "", "", "", ""],
      ["Mois : Mai 2026", "", "", "", "", "", "", ""],
      ["Date", "Libelle de l'operation", "Camion", "Piece justificatif N°", "Recettes (F CFA)", "Depenses (F CFA)", "Solde (F CFA)", "Observations"],
      ["", "Solde au 11/05/2026", "", "", "", "", "", ""],
      ["18/05/2026", "TST gazoil", "TST 10R CH0578", "P1", "", "188,000", "", "Payé"],
      ["19/05/2026", "TST mission", "TST 10R CH0578", "P2", "500,000", "", "", "Payé"],
      ["", "Camion 10 Roues plaque X", "", "", "500,000", "188,000", "312,000", ""],
    ], "Tableau de Suivi Fat et Mat");
    const suiRec = recognizeWorkbook(suiBuf)[0];
    test("suivi reconnu automatiquement (avec camion)", suiRec.profileKey === "triangle.suivi");
    const suiAn = await ic.analyzeBuffer(suiBuf, "excel", { sheet: suiRec.sheet, headerRow: suiRec.headerRow });
    const suiVal = ic.validate(suiAn, "triangle.suivi", suiRec.mapping, CO);
    const suiRows = suiVal.rows.map((r) => ({ __row: r.__row, status: r.status, mapped: r.mapped }));
    const suiRes = await executeCashbook(pool, CO, 1, ic.registry.getProfile("triangle.suivi"), suiRows, {}, helpers);
    test("suivi : 2 opérations réelles (ouverture + sous-total ignorés)", suiRes.report.imported === 2);
    test("suivi : 1 camion créé + 2 opérations camion", suiRes.report.camionsCreated === 1 && suiRes.report.camionOps === 2);
    const camAgg = (await pool.query("SELECT SUM(recette)::bigint r, SUM(depense)::bigint d FROM camion_operations o JOIN camions c ON c.id=o.camion_id WHERE o.company_id=$1 AND c.code='TST 10R CH0578'", [CO])).rows[0];
    test("agrégat camion : 500000 recette / 188000 dépense", Number(camAgg.r) === 500000 && Number(camAgg.d) === 188000);

    await clean();
    console.log(`\n✅ ${passed} tests import-réel passés.`);
    await pool.end();
  } catch (e) {
    console.error("❌", e.message, e.stack);
    await clean().catch(() => {});
    await pool.end();
    process.exit(1);
  }
})();

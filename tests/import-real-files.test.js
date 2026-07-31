"use strict";
/* Tests des structures réelles Triangle (anonymisées) : reconnaissance,
   lignes Total/Solde/récap/#NAME? ignorées, réconciliation, camions,
   anti-doublons inter-feuilles. DB requise pour la simulation cashbook. */
const assert = require("assert");
require("dotenv").config();
const XLSX = require("xlsx");
const ic = require("../import-center");
const { recognizeWorkbook } = require("../import-center/recognizer");

let passed = 0;
const test = (n, c) => { assert.ok(c, n); passed++; console.log("  ✓ " + n); };
const bookOf = (sheets) => { const wb = XLSX.utils.book_new(); for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name); return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }); };

// Classeur « mois » anonymisé, structure identique aux vrais fichiers.
const moisBuf = bookOf([
  ["Tresorerie Mai ", [
    ["TABLEAU DE TRESORERIE", "", "", "", ""],
    ["Date", "Libéllé", "Entrée", "Sortie", "Solde"],
    ["18/05/2026", "Reception", "3,000,000", "", ""],
    ["19/05/2026", "Paiement", "", "200,000", ""],
    ["", "Total", "3,000,000", "200,000", "2,800,000"],
  ]],
  ["Tableau de Suivi Fat et Mat", [
    ["Tableau de suivi", "", "", "", "", "", "", ""],
    ["Mois : Mai 2026", "", "", "", "", "", "", ""],
    ["Date", "Libelle de l'operation", "Camion", "Piece justificatif N°", "Recettes (F CFA)", "Depenses (F CFA)", "Solde (F CFA)", "Observations"],
    ["", "Solde au 11/05/2026", "", "", "", "", "", ""],
    ["18/05/2026", "Gazoil", "10R CH0578", "P1", "", "188,000", "", "Payé"],
    ["19/05/2026", "Voyage", "10R CH0578", "P2", "500,000", "", "", "Payé"],
    ["20/05/2026", "#NAME?", "12R CH8013", "P3", "#NAME?", "", "", ""],
    ["", "Camion 10 Roues plaque 10R CH0578", "", "", "500,000", "188,000", "312,000", ""],
    ["", "Total Global", "", "", "500,000", "188,000", "312,000", ""],
  ]],
]);

(async () => {
  console.log("Structures réelles Triangle (anonymisées)");
  const rec = recognizeWorkbook(moisBuf, "triangle");
  test("2 feuilles reconnues", rec.filter((s) => s.recognized).length === 2);
  test("Trésorerie -> triangle.tresorerie", rec.find((s) => s.sheet === "Tresorerie Mai ").profileKey === "triangle.tresorerie");
  test("Suivi Fat et Mat -> triangle.suivi", rec.find((s) => s.sheet.includes("Fat et Mat")).profileKey === "triangle.suivi");

  if (!process.env.DATABASE_URL) { console.log(`\n✅ ${passed} tests (reconnaissance) — simulation ignorée (pas de DB).`); return; }
  const { Pool } = require("pg");
  const { simulateCashbook } = require("../import-center/executor-cashbook");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const CO = 1;
  try {
    // Trésorerie : Total ignoré.
    const tr = rec.find((s) => s.sheet === "Tresorerie Mai ");
    let an = await ic.analyzeBuffer(moisBuf, "excel", { sheet: tr.sheet, headerRow: tr.headerRow });
    let val = ic.validate(an, tr.profileKey, tr.mapping, CO, {});
    let sim = await simulateCashbook(pool, CO, ic.registry.getProfile(tr.profileKey), val.rows.map((r) => ({ __row: r.__row, status: r.status, mapped: r.mapped })));
    test("Trésorerie : ligne Total ignorée -> 3,000,000 / 200,000", sim.totals.totalIncome === 3000000 && sim.totals.totalExpense === 200000);

    // Suivi : #NAME?, Solde au, récap camion, Total Global ignorés.
    const su = rec.find((s) => s.sheet.includes("Fat et Mat"));
    an = await ic.analyzeBuffer(moisBuf, "excel", { sheet: su.sheet, headerRow: su.headerRow });
    val = ic.validate(an, su.profileKey, su.mapping, CO, {});
    const rows = val.rows.map((r) => ({ __row: r.__row, status: r.status, mapped: r.mapped }));
    sim = await simulateCashbook(pool, CO, ic.registry.getProfile(su.profileKey), rows);
    test("Suivi : détail seul compté -> recette 500,000 / dépense 188,000", sim.totals.totalIncome === 500000 && sim.totals.totalExpense === 188000);
    test("Suivi : #NAME? non compté (ligne invalide)", val.summary.invalid >= 1);
    test("Suivi : récap camion + Total Global + Solde au ignorés (skipped)", sim.totals.skipped >= 3);
    test("Suivi : 2 opérations camion réelles (10R CH0578 : gazoil + voyage)", sim.totals.camionOperations === 2);

    // Anti-doublons inter-feuilles : réutiliser une empreinte -> déjà importée.
    const fp = new Set(val.rows.filter((r) => r.status === "new").map((r) => r.fingerprint));
    const val2 = ic.validate(an, su.profileKey, su.mapping, CO, { existingFingerprints: fp });
    test("Anti-doublons : 2e passage -> lignes déjà importées", val2.summary.existing >= 1 && val2.summary.new === 0);

    await pool.end();
  } catch (e) { await pool.end(); throw e; }
  console.log(`\n✅ ${passed} tests structures réelles passés.`);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });

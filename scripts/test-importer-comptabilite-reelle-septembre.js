"use strict";

const assert = require("assert");
const XLSX = require("xlsx");
const { buildPlan, historicalProjection } = require("./importer-comptabilite-reelle-septembre");

const sheet = (rows) => XLSX.utils.aoa_to_sheet(rows);
const date = (day) => new Date(Date.UTC(2026, 8, day));

function bank(opening, closing, operations, extra = []) {
  return [
    ["Date", "Référence", "Libellé", "Dépôt(Entrée)", "Retrait(Sortie)", "Solde", "Observation"],
    [date(1), "Solde initial", null, opening, null, opening, null],
    ...operations.map((o, i) => [date(i + 2), o.reference || null, o.label || "Opération", o.income || null, o.expense || null, null, null]),
    ...extra,
    ["SOLDE ACTUEL", null, null, null, null, closing, null],
  ];
}

function workbookFixture() {
  const orabankOps = [{ expense: 75600000 }];
  const bdmOps = [{ expense: 80180000 }];
  const bndaOps = [{ expense: 17011700 }];
  const banques = {
    Sheets: {
      "ORABANK TRIANGLE": sheet(bank(95996235, 20396235, orabankOps)),
      "BDM TRIANGLE": sheet(bank(91428750, 11248750, bdmOps)),
      "BNDA ALLIANCE": sheet(bank(22120150, 5108450, bndaOps, [[date(3), "Retrait", null, null, null, 0, null]])),
    },
  };
  const triangleExpenses = Array.from({ length: 16 }, (_, i) => [date(3), `Dépense T ${i + 1}`, `T-${i + 1}`, null, i === 15 ? 180040 : 100024, null, null]);
  const fatmatExpenses = Array.from({ length: 14 }, (_, i) => [date(3), `Dépense F ${i + 1}`, null, `F-${i + 1}`, null, i === 13 ? 1038000 : 384615, null, null]);
  // Ajustement du dernier montant pour atteindre exactement le total certifié.
  fatmatExpenses[13][5] = 6038000 - 13 * 384615;
  const tableaux = {
    Sheets: {
      "Suivi Triangle": sheet([
        ["En-tête"], [""], [""], [""], [""], [""],
        ...triangleExpenses,
        [date(3), "Vente ciment", "FN-T00408", 7500000, null, null, null],
        [null, "Ancienne ligne", "SANS-MONTANT", null, null, null, "à compléter"],
        ["TOTAL"],
      ]),
      "Suivi Fat & Mat": sheet([
        ["En-tête"], [""], [""], [""], [""],
        ...fatmatExpenses,
        [null, "Ancienne dépense", null, "SANS-MONTANT", null, null, null, "à compléter"],
        ["TOTAL"], ["Pied 1"], ["Pied 2"], ["Pied 3"], ["Pied 4"], ["Pied 5"], ["Pied 6"],
      ]),
    },
  };
  return { tableaux, banques };
}

const plan = buildPlan(workbookFixture());
assert.equal(plan.confirmed.triangleExpense, 1680400);
assert.equal(plan.confirmed.fatmatExpense, 6038000);
assert.equal(plan.confirmed.intercompanyAdvance, 6038000);
assert.equal(plan.confirmed.triangleCashClosing, 2195458);
assert.equal(plan.confirmed.cementSale.businessDate, "2026-09-01");
assert.equal(plan.confirmed.cementSale.cashDate, "2026-09-02");
assert.equal(plan.confirmed.cementSale.recordedDate, "2026-09-03");
assert.equal(plan.banks.length, 3);
assert.equal(plan.monthly.length, 8);
assert.equal(plan.archive.filter((x) => x.reviewReason === "Opération bancaire sans montant").length, 1);
assert(plan.archive.every((x) => !x.income && !x.expense), "Une ligne incomplète ne doit modifier aucun solde.");

const monthlySource = plan.monthly.find((x) => x.income > 0 && x.expense > 0);
assert(monthlySource, "Le test doit reproduire une synthèse ayant entrées et dépenses.");
const monthlyProjection = historicalProjection(monthlySource);
assert.deepEqual(monthlyProjection, {
  lineType: "MONTHLY_SUMMARY",
  accountKind: "INFORMATION",
  income: 0,
  expense: 0,
});
assert(monthlySource.income > 0 && monthlySource.expense > 0,
  "Les totaux source doivent rester intacts pour source_payload et l'audit.");

assert.throws(() => historicalProjection({
  sheet: "Banque test", row: 7, income: 1000, expense: 500,
}), /simultanément une entrée et une dépense/);
assert.deepEqual(historicalProjection({ income: 1000, expense: 0 }, 42), {
  lineType: "OPERATION", accountKind: "BANK", income: 1000, expense: 0,
});

const altered = workbookFixture();
altered.tableaux.Sheets["Suivi Triangle"]["E7"].v += 1;
assert.throws(() => buildPlan(altered), /Dépenses non réconciliées/);

console.log("IMPORT COMPTABILITÉ RÉELLE : 21 contrôles, 0 échec.");

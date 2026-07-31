"use strict";
/* Vérifie que le Centre d'importation opère bien sous product_code=triangle. */
const assert = require("assert");
const ic = require("../import-center");
let passed = 0; const test = (n, c) => { assert.ok(c, n); passed++; console.log("  ✓ " + n); };

console.log("Triangle — product_code");
const triangle = ic.registry.listProfiles("triangle");
test("des profils triangle sont enregistrés", triangle.length > 0 && triangle.every((p) => p.product_code === "triangle"));
for (const key of ["triangle.factures", "triangle.tresorerie", "triangle.suivi", "triangle.expenses", "triangle.income"]) {
  const p = ic.registry.getProfile(key);
  test(`profil ${key} présent et product_code=triangle`, p && p.product_code === "triangle");
}
// La reconnaissance auto des fichiers réels ne dépend pas du produit mais renvoie des profils triangle.
const XLSX = require("xlsx");
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ["N°","Date de Facture","Ref/N° Facture","Localite/Site","Description","Montant Facturé ( en F CFA)","Montant Payé ( en F CFA)","Reste à payer ( en F CFA)","Date de paiement","Statut","Obervations"],
  [1,"23/02/2026","F-1","S","D","1000000","1000000",0,"","Payé",""],
]), "Feuil1");
const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
const rec = require("../import-center/recognizer").recognizeWorkbook(buf, "triangle")[0];
test("fichier factures reconnu -> profil triangle.factures", rec.recognized && rec.profileKey === "triangle.factures");
console.log(`\n✅ ${passed} tests product-triangle passés.`);

"use strict";
/* Tests du centre d'importation (moteur, sans base). assert natif. */
const assert = require("assert");
const XLSX = require("xlsx");
const ic = require("../import-center");
const { parseNumber, parseDate, detectValueType, analyzeColumn } = ic.detector;
const { validateUpload, sanitizeCell } = ic.security;

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("  ✓ " + name); };

// Fabrique un buffer XLSX à partir d'une matrice.
function xlsxBuffer(rows, sheetName = "Feuille1") {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

console.log("Import — détection des valeurs");
test("montant avec espace + FCFA", () => assert.strictEqual(parseNumber("12 000 FCFA"), 12000));
test("virgule décimale FR", () => assert.strictEqual(parseNumber("1 234,56"), 1234.56));
test("format US 1,234.50", () => assert.strictEqual(parseNumber("1,234.50"), 1234.5));
test("date française jj/mm/aaaa", () => { const d = parseDate("05/10/2026"); assert.strictEqual(d.getFullYear(), 2026); assert.strictEqual(d.getMonth(), 9); assert.strictEqual(d.getDate(), 5); });
test("date série Excel", () => { const d = parseDate(46296); assert.ok(d instanceof Date && !isNaN(d)); });
test("colonne de dates détectée", () => assert.strictEqual(detectValueType(["01/01/2026", "15/03/2026", "20/12/2026"]).type, "date"));
test("colonne monétaire détectée", () => assert.strictEqual(detectValueType(["12 000 FCFA", "3 500 FCFA", "800 FCFA"]).type, "amount"));
test("colonne type mouvement détectée", () => assert.strictEqual(detectValueType(["ENTREE", "SORTIE", "CASSE", "ENTREE"]).type, "movement_type"));

console.log("Import — reconnaissance des en-têtes");
test("« Désignation » -> product_name", () => assert.strictEqual(analyzeColumn("Désignation", ["Nescafé", "Lait"]).suggestedField, "product_name"));
test("« Qté entrée » -> quantity_in", () => assert.strictEqual(analyzeColumn("Qté entrée", ["5", "7"]).suggestedField, "quantity_in"));
test("« Date opération » -> transaction_date", () => assert.strictEqual(analyzeColumn("Date opération", ["01/01/2026"]).suggestedField, "transaction_date"));

console.log("Import — sécurité");
test("exécutable refusé (magic MZ)", () => {
  const buf = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
  const r = validateUpload({ originalName: "x.xlsx", size: 100, buffer: buf });
  assert.strictEqual(r.ok, false);
});
test("xlsx valide accepté", () => {
  const buf = xlsxBuffer([["Produit"], ["Nescafé"]]);
  const r = validateUpload({ originalName: "stock.xlsx", size: buf.length, buffer: buf });
  assert.strictEqual(r.ok, true);
});
test("neutralisation injection de formule", () => assert.strictEqual(sanitizeCell("=1+2"), "'=1+2"));

(async () => {
console.log("Import — pipeline XLSX (analyse -> mapping -> validation)");
const buf = xlsxBuffer([
  ["Désignation", "Type", "Quantité", "Date opération"],
  ["Nescafé", "SORTIE", "5", "05/10/2026"],
  ["Lait", "ENTREE", "7", "06/10/2026"],
  ["", "ENTREE", "3", "07/10/2026"],       // produit manquant -> invalid
  ["Nescafé", "SORTIE", "5", "05/10/2026"], // doublon exact
]);
const analysis = await ic.analyzeBuffer(buf, "excel");
test("feuilles détectées", () => assert.strictEqual(analysis.sheets.length, 1));
test("4 lignes de données", () => assert.strictEqual(analysis.rowCount, 4));
const { mapping } = ic.suggestMapping(analysis, "triangle.stock_movement");
test("mapping auto: Désignation->product_name, Type->movement_type, Quantité->quantity", () => {
  assert.strictEqual(mapping["Désignation"], "product_name");
  assert.strictEqual(mapping["Type"], "movement_type");
  assert.strictEqual(mapping["Quantité"], "quantity");
});
const res = ic.validate(analysis, "triangle.stock_movement", mapping, 1);
test("validation: 2 valides, 1 invalide, 1 doublon", () => {
  assert.strictEqual(res.summary.invalid, 1, "invalid");
  assert.strictEqual(res.summary.duplicates, 1, "duplicates");
  assert.strictEqual(res.summary.valid, 2, "valid");
});
test("aucune écriture base (pipeline pur)", () => assert.ok(Array.isArray(res.rows)));

console.log("Import — registre multi-produits");
test("profils des 3 produits enregistrés", () => {
  assert.ok(ic.registry.getProfile("triangle.stock_in"));
  assert.ok(ic.registry.getProfile("malilink.marketplace_products"));
  assert.ok(ic.registry.getProfile("hafiya.patients"));
});
test("résultats HAFIYA en statut BROUILLON (non validés auto)", () => {
  assert.strictEqual(ic.registry.getProfile("hafiya.lab_results").importStatus, "BROUILLON");
});

console.log("Import — DOCX (tableaux)");
const docx = require("../import-center/docx");
const sampleHtml = "<p>Texte libre</p><table><tr><th>Produit</th><th>Type</th><th>Quantité</th></tr><tr><td>Nescafé</td><td>SORTIE</td><td>5</td></tr><tr><td>Lait</td><td>ENTREE</td><td>7</td></tr></table>";
test("extraction des tableaux HTML DOCX", () => {
  const tables = docx.tablesFromHtml(sampleHtml);
  assert.strictEqual(tables.length, 1);
  assert.strictEqual(tables[0].length, 3);
  assert.deepStrictEqual(tables[0][0], ["Produit", "Type", "Quantité"]);
});
test("conversion tableau -> lignes structurées", () => {
  const { header, rows } = docx.tableToRows(docx.tablesFromHtml(sampleHtml)[0]);
  assert.deepStrictEqual(header, ["Produit", "Type", "Quantité"]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0]["Produit"], "Nescafé");
});
test("DOCX sans tableau -> aucun tableau détecté", () => {
  assert.strictEqual(docx.tablesFromHtml("<p>Juste du texte libre.</p>").length, 0);
});
test("plusieurs tableaux détectés", () => {
  assert.strictEqual(docx.tablesFromHtml(sampleHtml + "<table><tr><td>A</td></tr></table>").length, 2);
});

console.log(`\n✅ ${passed} tests centre d'importation passés.`);
})();

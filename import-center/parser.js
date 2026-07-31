"use strict";

/**
 * Parser tableur (XLSX / XLS / CSV) basé sur SheetJS.
 * Lit depuis un Buffer (jamais un chemin utilisateur). Ne calcule pas les
 * formules (cellval = valeur en cache, jamais évaluée comme du code).
 */
const XLSX = require("xlsx");
const { sanitizeCell } = require("./security");

/** Lit le classeur et renvoie la liste des feuilles avec dimensions. */
function readWorkbook(buffer, kind) {
  // cellFormula:false → on n'exporte pas les formules ; on ne les évalue jamais.
  const opts = { type: "buffer", cellDates: true, cellFormula: false, cellHTML: false, raw: false };
  if (kind === "csv") opts.raw = false;
  const wb = XLSX.read(buffer, opts);
  return wb;
}

/** Aperçu des feuilles (nom, lignes, colonnes) sans tout charger en détail. */
function describeSheets(wb) {
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const ref = ws["!ref"] || "A1";
    const range = XLSX.utils.decode_range(ref);
    return {
      name,
      rows: range.e.r - range.s.r + 1,
      cols: range.e.c - range.s.c + 1,
    };
  });
}

/**
 * Extrait les lignes d'une feuille sous forme de matrice (tableau de tableaux),
 * en devinant/forçant la ligne d'en-tête.
 * @returns { header: string[], headerRowIndex, rows: Array<Record<string,any>>, matrix }
 */
function extractSheet(wb, sheetName, headerRowIndex = null) {
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Feuille introuvable : ${sheetName}`);
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", blankrows: false, raw: false });
  if (matrix.length === 0) return { header: [], headerRowIndex: 0, rows: [], matrix: [] };

  // Détection de la ligne d'en-tête : première ligne avec ≥2 cellules texte non vides
  // (sauf si l'utilisateur l'impose).
  let hIdx = headerRowIndex;
  if (hIdx == null) {
    hIdx = 0;
    for (let i = 0; i < Math.min(matrix.length, 10); i++) {
      const row = matrix[i] || [];
      const textCells = row.filter((c) => typeof c === "string" && c.trim() !== "").length;
      const filled = row.filter((c) => c !== "" && c != null).length;
      if (textCells >= 2 && filled >= 2) { hIdx = i; break; }
    }
  }

  const header = (matrix[hIdx] || []).map((c, i) => {
    const label = String(c ?? "").trim();
    return label || `Colonne ${i + 1}`;
  });

  const rows = [];
  for (let i = hIdx + 1; i < matrix.length; i++) {
    const arr = matrix[i] || [];
    if (arr.every((c) => c === "" || c == null)) continue; // ligne vide
    const obj = {};
    header.forEach((h, ci) => { obj[h] = sanitizeCell(arr[ci] ?? ""); });
    obj.__row = i + 1; // index 1-based dans le fichier
    rows.push(obj);
  }
  return { header, headerRowIndex: hIdx, rows, matrix };
}

module.exports = { readWorkbook, describeSheets, extractSheet };

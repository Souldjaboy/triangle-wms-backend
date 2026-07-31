"use strict";

/**
 * Point d'entrée du centre d'importation : orchestre le pipeline SANS jamais
 * écrire en base avant confirmation. (Simulation/exécution : phases suivantes.)
 */
const security = require("./security");
const parser = require("./parser");
const detector = require("./detector");
const mapper = require("./mapper");
const validator = require("./validator");
const registry = require("./registry");
const docx = require("./docx");

/** Étape 3-5 : analyse le fichier (feuilles/tableaux, colonnes, aperçu). Async (DOCX). */
async function analyzeBuffer(buffer, kind, { sheet = null, headerRow = null, tableIndex = null } = {}) {
  if (kind === "docx") {
    const { tables } = await docx.extractDocxTables(buffer);
    const idx = tableIndex != null ? Number(tableIndex) : 0;
    const { header, rows } = docx.tableToRows(tables[idx] || tables[0], headerRow != null ? Number(headerRow) : 0);
    const columns = header.map((h) => detector.analyzeColumn(h, rows.map((r) => r[h])));
    return {
      sheets: tables.map((t, i) => ({ name: `Tableau ${i + 1}`, rows: t.length })),
      activeSheet: `Tableau ${idx + 1}`, tableIndex: idx, headerRowIndex: headerRow != null ? Number(headerRow) : 0,
      header, columns, previewRows: rows.slice(0, 20), rowCount: rows.length, _rows: rows,
    };
  }
  const wb = parser.readWorkbook(buffer, kind);
  const sheets = parser.describeSheets(wb);
  const active = sheet || (sheets[0] && sheets[0].name);
  const extracted = active ? parser.extractSheet(wb, active, headerRow) : { header: [], rows: [], headerRowIndex: 0 };
  const columns = extracted.header.map((h) => detector.analyzeColumn(h, extracted.rows.map((r) => r[h])));
  return { sheets, activeSheet: active, headerRowIndex: extracted.headerRowIndex, header: extracted.header, columns, previewRows: extracted.rows.slice(0, 20), rowCount: extracted.rows.length, _wb: wb, _rows: extracted.rows };
}

/** Étape 6 : suggestion de mapping pour un profil. */
function suggestMapping(analysis, profileKey) {
  const profile = registry.getProfile(profileKey);
  if (!profile) throw new Error(`Profil inconnu : ${profileKey}`);
  return mapper.suggestMapping(analysis.header, analysis._rows, profile);
}

/** Étape 7 : applique un mapping (confirmé/corrigé) et valide. */
function validate(analysis, profileKey, mapping, companyId, options = {}) {
  const profile = registry.getProfile(profileKey);
  if (!profile) throw new Error(`Profil inconnu : ${profileKey}`);
  const mappedItems = mapper.applyMapping(analysis._rows, mapping, profile);
  return validator.validateRows(mappedItems, profile, companyId, options);
}

module.exports = { security, parser, detector, mapper, validator, registry, analyzeBuffer, suggestMapping, validate };

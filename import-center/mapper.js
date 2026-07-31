"use strict";

/**
 * Mapping colonne -> champ. Combine la détection (en-tête + valeurs) et les
 * champs attendus par le profil. L'utilisateur peut corriger chaque ligne.
 */
const { analyzeColumn, parseNumber, parseDate, fmtYMD } = require("./detector");

/** Analyse chaque colonne et propose une correspondance vers les champs du profil. */
function suggestMapping(header, rows, profile) {
  const profileFields = new Set([...(profile.requiredFields || []), ...(profile.optionalFields || [])]);
  const columns = header.map((h) => {
    const values = rows.map((r) => r[h]);
    const a = analyzeColumn(h, values);
    // On ne retient la suggestion que si elle appartient au profil.
    const field = a.suggestedField && profileFields.has(a.suggestedField) ? a.suggestedField : null;
    return { ...a, suggestedField: field };
  });

  // Construit le mapping en évitant d'affecter deux colonnes au même champ
  // (on garde la meilleure confiance).
  const mapping = {};
  const takenByField = {};
  for (const col of [...columns].sort((x, y) => y.confidence - x.confidence)) {
    if (!col.suggestedField) continue;
    const prev = takenByField[col.suggestedField];
    if (prev && prev.confidence >= col.confidence) continue;
    if (prev) delete mapping[prev.header];
    mapping[col.header] = col.suggestedField;
    takenByField[col.suggestedField] = col;
  }
  return { mapping, columns };
}

const TYPE_OF_FIELD = (profile, field) => (profile.fieldTypes && profile.fieldTypes[field]) || "text";

/** Applique le mapping et normalise chaque valeur selon le type du champ. */
function applyMapping(rows, mapping, profile) {
  return rows.map((raw) => {
    const mapped = {};
    for (const [col, field] of Object.entries(mapping)) {
      if (!field) continue;
      const type = TYPE_OF_FIELD(profile, field);
      let value = raw[col];
      if (value === "" || value == null) { mapped[field] = null; continue; }
      if (type === "amount" || type === "quantity") mapped[field] = parseNumber(value);
      else if (type === "date") { mapped[field] = fmtYMD(parseDate(value)); }
      else mapped[field] = String(value).trim();
    }
    return { __row: raw.__row, raw, mapped };
  });
}

module.exports = { suggestMapping, applyMapping };

"use strict";

/**
 * Reconnaissance AUTOMATIQUE du type de fichier (sans que l'utilisateur choisisse).
 * Pour chaque feuille : trouve la ligne d'en-tête et le profil correspondant en
 * comparant les en-têtes normalisés aux `recognize` / `headerMap` des profils.
 */
const XLSX = require("xlsx");
const { normalize } = require("./detector");
const registry = require("./registry");

// Profils dotés d'un headerMap (adaptés aux fichiers réels). Les signatures
// d'en-têtes étant distinctives, on ne filtre PAS par produit (évite les faux
// négatifs quand le tenant de la requête diffère).
function mappedProfiles() {
  return [...registry.REGISTRY.values()].filter((p) => p.headerMap);
}

// Score d'un profil pour une ligne d'en-tête donnée.
function scoreProfile(profile, normHeaders) {
  const set = new Set(normHeaders);
  const tokensOk = (profile.recognize || []).every((tok) => normHeaders.some((h) => h.includes(tok)));
  if (!tokensOk) return 0;
  if ((profile.recognizeExclude || []).some((tok) => normHeaders.some((h) => h.includes(tok)))) return 0;
  // Nombre d'en-têtes du fichier reconnus par le headerMap.
  let hits = 0;
  for (const h of set) if (profile.headerMap[h]) hits++;
  return hits;
}

/**
 * Analyse une feuille et renvoie la meilleure reconnaissance.
 * @returns { profileKey, headerRow, mapping } ou null.
 */
function recognizeSheet(matrix, productCode) {
  const candidates = mappedProfiles();
  let best = null;
  const maxScan = Math.min(matrix.length, 15);
  for (let r = 0; r < maxScan; r++) {
    const normHeaders = (matrix[r] || []).map((c) => normalize(c)).filter(Boolean);
    if (normHeaders.length < 2) continue;
    for (const profile of candidates) {
      const score = scoreProfile(profile, normHeaders);
      if (score > 0 && (!best || score > best.score)) {
        // Construit le mapping en-tête original -> champ.
        const mapping = {};
        (matrix[r] || []).forEach((c) => {
          const field = profile.headerMap[normalize(c)];
          if (field && !String(field).startsWith("_ignore")) mapping[String(c)] = field;
        });
        best = { profileKey: profile.key, headerRow: r, mapping, score };
      }
    }
  }
  return best;
}

/** Reconnaît toutes les feuilles utiles d'un classeur. */
function recognizeWorkbook(buffer, productCode = "triangle") {
  const wb = XLSX.read(buffer, { cellDates: true, cellFormula: false, raw: false });
  const sheets = [];
  for (const name of wb.SheetNames) {
    const matrix = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", blankrows: false, raw: false });
    const rec = recognizeSheet(matrix, productCode);
    sheets.push({ sheet: name, recognized: !!rec, ...(rec || {}) });
  }
  return sheets;
}

module.exports = { recognizeSheet, recognizeWorkbook, scoreProfile };

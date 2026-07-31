"use strict";

/**
 * Validation des lignes mappées : champs requis, règles du profil, doublons
 * intra-fichier (empreinte idempotente). Ne touche JAMAIS la base.
 * Statuts : new | invalid | warning | duplicate.
 */
const crypto = require("crypto");

function fingerprint(companyId, profile, mapped) {
  const parts = profile.dedupKey ? profile.dedupKey(mapped) : JSON.stringify(mapped);
  return crypto.createHash("sha256").update(`${companyId}|${profile.key}|${parts}`).digest("hex").slice(0, 32);
}

/**
 * @param items  [{ __row, raw, mapped }]
 * @param options.existingFingerprints Set d'empreintes DÉJÀ importées en base
 *   (anti-doublons persistant / import incrémental).
 * @returns { rows: [{__row, mapped, fingerprint, status, messages}], summary }
 */
function validateRows(items, profile, companyId, options = {}) {
  const seen = new Map(); // fingerprint -> premier __row (intra-fichier)
  const existing = options.existingFingerprints instanceof Set ? options.existingFingerprints : new Set(options.existingFingerprints || []);
  const out = [];
  let valid = 0, invalid = 0, warnings = 0, duplicates = 0, existingCount = 0;

  for (const it of items) {
    const messages = [];
    const mapped = it.mapped || {};

    // Champs requis.
    for (const f of profile.requiredFields || []) {
      const v = mapped[f];
      if (v === null || v === undefined || String(v).trim() === "") {
        messages.push({ field: f, code: "REQUIRED", message: `Champ requis manquant : ${f}.`, severity: "error" });
      }
    }
    // Règles métier du profil.
    if (typeof profile.validate === "function") {
      try { for (const m of profile.validate(mapped) || []) messages.push(m); } catch { /* règle défensive */ }
    }

    const fp = fingerprint(companyId, profile, mapped);
    let status;
    const hasError = messages.some((m) => m.severity === "error");
    if (hasError) { status = "invalid"; invalid++; }
    else if (existing.has(fp)) {
      // Déjà présent en base (import précédent) : import incrémental -> ignoré.
      status = "duplicate"; duplicates++; existingCount++;
      messages.push({ code: "ALREADY_IMPORTED", message: "Ligne déjà importée lors d'un import précédent.", severity: "warning" });
    } else if (seen.has(fp)) {
      status = "duplicate"; duplicates++;
      messages.push({ code: "DUPLICATE_IN_FILE", message: `Doublon dans le fichier (ligne ${seen.get(fp)}).`, severity: "warning" });
    } else {
      seen.set(fp, it.__row);
      status = messages.length ? "warning" : "new";
      if (messages.length) warnings++;
      valid++;
    }

    out.push({ __row: it.__row, raw: it.raw, mapped, fingerprint: fp, status, messages });
  }

  return {
    rows: out,
    summary: {
      total: items.length,
      valid, invalid, warnings, duplicates,
      existing: existingCount,   // déjà importées (import incrémental)
      new: valid,                // nouvelles lignes réellement importables
    },
  };
}

module.exports = { validateRows, fingerprint };

"use strict";

/**
 * Sécurité du centre d'importation :
 * - validation type MIME réel + extension ;
 * - taille max configurable ;
 * - protection CSV / formula injection ;
 * - nom de fichier sécurisé ;
 * - hash d'empreinte du fichier.
 */
const crypto = require("crypto");
const path = require("path");

const MAX_FILE_SIZE = Number(process.env.IMPORT_MAX_FILE_SIZE || 15 * 1024 * 1024); // 15 Mo

// Types acceptés (extension -> MIME attendus).
const ALLOWED = {
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/zip", "application/octet-stream"],
  ".xls": ["application/vnd.ms-excel", "application/octet-stream", "application/x-cfb"],
  ".csv": ["text/csv", "text/plain", "application/csv", "application/vnd.ms-excel", "application/octet-stream"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/zip", "application/octet-stream"],
};

// Signatures binaires (magic numbers).
function sniffMagic(buffer) {
  if (!buffer || buffer.length < 4) return "unknown";
  const b = buffer;
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return "zip"; // xlsx/docx = zip
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return "cfb"; // xls (OLE2)
  if (b[0] === 0x4d && b[1] === 0x5a) return "exe"; // MZ -> exécutable
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "pdf"; // %PDF
  return "text";
}

function safeStoredName(originalName) {
  const ext = path.extname(String(originalName || "")).toLowerCase();
  const rnd = crypto.randomBytes(8).toString("hex");
  return `import_${Date.now()}_${rnd}${ext}`;
}

function fileHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Valide un fichier téléversé. Ne lit jamais un chemin fourni par l'utilisateur.
 * @returns { ok, ext, kind, error? }
 */
function validateUpload({ originalName, mimeType, size, buffer }) {
  const ext = path.extname(String(originalName || "")).toLowerCase();
  if (!ALLOWED[ext]) {
    return { ok: false, error: `Extension non autorisée : ${ext || "(aucune)"}. Formats : XLSX, XLS, CSV, DOCX (avec tableaux).` };
  }
  if (size != null && size > MAX_FILE_SIZE) {
    return { ok: false, error: `Fichier trop volumineux (max ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} Mo).` };
  }
  const magic = sniffMagic(buffer);
  if (magic === "exe") return { ok: false, error: "Fichier exécutable refusé." };
  if (magic === "pdf") return { ok: false, error: "Les PDF ne sont pas acceptés." };

  // Cohérence extension <-> contenu réel.
  if ((ext === ".xlsx" || ext === ".docx") && magic !== "zip") {
    return { ok: false, error: "Le contenu ne correspond pas à un fichier Office valide." };
  }
  if (ext === ".xls" && magic !== "cfb") {
    return { ok: false, error: "Le contenu ne correspond pas à un fichier .xls valide." };
  }
  if (ext === ".csv" && (magic === "zip" || magic === "cfb")) {
    return { ok: false, error: "Le contenu ne correspond pas à un CSV texte." };
  }
  // MIME déclaré : indicatif (les navigateurs varient) mais on refuse un MIME hostile.
  if (mimeType && /application\/(x-msdownload|x-sh|x-executable)/i.test(mimeType)) {
    return { ok: false, error: "Type de fichier interdit." };
  }

  const kind = ext === ".csv" ? "csv" : ext === ".docx" ? "docx" : "excel";
  return { ok: true, ext, kind };
}

// Neutralise l'injection de formules dans une valeur cellule (CSV/Excel).
function sanitizeCell(value) {
  if (typeof value !== "string") return value;
  // Une valeur commençant par = + - @ (ou tab/CR) peut être interprétée comme formule.
  if (/^[=+\-@\t\r]/.test(value)) {
    return "'" + value; // préfixe apostrophe = neutralisation standard
  }
  return value;
}

module.exports = { MAX_FILE_SIZE, validateUpload, safeStoredName, fileHash, sanitizeCell, sniffMagic };

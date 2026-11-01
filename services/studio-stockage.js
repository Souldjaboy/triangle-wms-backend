"use strict";

/**
 * LE STOCKAGE DU STUDIO : DES FICHIERS QU'AUCUNE URL N'ATTEINT.
 *
 * POURQUOI PAS `uploads/`. Ce dossier est servi en statique par express :
 * qui connaît un nom de fichier obtient le fichier, sans jeton ni société.
 * C'était la racine du défaut des pièces jointes du chat. Les documents du
 * Studio vivent donc sous `storage/`, un dossier qu'aucun middleware ne sert.
 * Il n'existe pas d'adresse publique vers eux : le seul chemin passe par un
 * point d'accès qui vérifie l'identité, la société et le partage.
 *
 * LA CLÉ EST OPAQUE. `studio/<société>/<année>/<mois>/<uuid>` : elle ne porte
 * ni le nom d'origine, ni l'extension. Deviner une clé ne sert donc à rien, et
 * un nom de fichier malveillant ne peut pas atteindre le disque.
 *
 * LE TYPE RÉEL EST VÉRIFIÉ. Un fichier nommé « bilan.xlsx » dont les premiers
 * octets disent « HTML » n'est pas un classeur : c'est une page qui pourrait
 * s'exécuter dans le navigateur d'un collègue. On lit donc les octets de
 * tête, et on les confronte au type annoncé.
 */

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

/* La racine, hors de tout ce qu'express sert. Configurable pour que le VPS
   puisse la placer sur un volume dédié sans toucher au code. */
const RACINE = path.resolve(
  process.env.STUDIO_STORAGE_DIR || path.join(__dirname, "..", "storage")
);

const TAILLE_MAX = Number(process.env.STUDIO_TAILLE_MAX || 100 * 1024 * 1024);

/* Ce que le Studio accepte de ranger. La liste est courte et explicite :
   tout ce qui n'y est pas est refusé, plutôt que d'énumérer l'interdit —
   une liste noire oublie toujours quelque chose. */
const TYPES_ACCEPTES = new Map([
  ["application/pdf", [".pdf"]],
  ["image/png", [".png"]],
  ["image/jpeg", [".jpg", ".jpeg"]],
  ["image/webp", [".webp"]],
  ["image/gif", [".gif"]],
  ["image/tiff", [".tif", ".tiff"]],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", [".xlsx"]],
  ["application/vnd.ms-excel", [".xls"]],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", [".docx"]],
  ["application/msword", [".doc"]],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", [".pptx"]],
  ["application/vnd.ms-powerpoint", [".ppt"]],
  ["text/plain", [".txt"]],
  ["text/csv", [".csv"]],
  ["application/json", [".json"]],
  ["video/mp4", [".mp4"]],
  ["audio/mpeg", [".mp3"]],
  ["audio/webm", [".webm"]],
]);

/**
 * Les signatures d'octets de tête. On ne cherche pas à tout reconnaître : on
 * cherche à démentir une annonce. Un fichier qui se dit PDF et ne commence
 * pas par « %PDF » ment.
 */
const SIGNATURES = [
  { mime: "application/pdf", octets: Buffer.from("%PDF-") },
  { mime: "image/png", octets: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { mime: "image/jpeg", octets: Buffer.from([0xff, 0xd8, 0xff]) },
  { mime: "image/gif", octets: Buffer.from("GIF8") },
  { mime: "zip", octets: Buffer.from([0x50, 0x4b, 0x03, 0x04]) }, /* xlsx, docx, pptx */
  { mime: "zip", octets: Buffer.from([0x50, 0x4b, 0x05, 0x06]) }, /* archive vide */
  { mime: "ole", octets: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]) }, /* xls, doc, ppt */
];

/* Les formats modernes d'Office sont des archives ZIP ; les anciens sont des
   conteneurs OLE. On regroupe donc, au lieu de prétendre distinguer un xlsx
   d'un docx par ses quatre premiers octets — ce qui est faux. */
const FAMILLE = new Map([
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "zip"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "zip"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "zip"],
  ["application/vnd.ms-excel", "ole"],
  ["application/msword", "ole"],
  ["application/vnd.ms-powerpoint", "ole"],
]);

/* Ces types n'ont pas de signature fiable : du texte est du texte. On ne peut
   donc rien démentir, et on l'assume plutôt que d'inventer un contrôle. */
const SANS_SIGNATURE = new Set(["text/plain", "text/csv", "application/json",
  "image/webp", "image/tiff", "video/mp4", "audio/mpeg", "audio/webm"]);

function erreur(message, code, httpStatus = 400) {
  const e = new Error(message);
  e.code = code; e.httpStatus = httpStatus;
  return e;
}

/** La famille réelle d'un contenu, d'après ses premiers octets. */
function familleReelle(buffer) {
  for (const s of SIGNATURES) {
    if (buffer.length >= s.octets.length && buffer.subarray(0, s.octets.length).equals(s.octets)) {
      return s.mime;
    }
  }
  return null;
}

/**
 * Contrôle un dépôt : taille, type annoncé, extension, et octets de tête.
 * Rend le type retenu, ou lève.
 */
function verifier({ buffer, mimeAnnonce, nomOrigine }) {
  if (!buffer || !buffer.length) {
    throw erreur("Fichier vide.", "FICHIER_VIDE");
  }
  if (buffer.length > TAILLE_MAX) {
    throw erreur(
      `Fichier trop lourd : ${Math.round(buffer.length / 1024 / 1024)} Mo pour un maximum de ${Math.round(TAILLE_MAX / 1024 / 1024)} Mo.`,
      "FICHIER_TROP_LOURD", 413);
  }

  const mime = String(mimeAnnonce || "").split(";")[0].trim().toLowerCase();
  const extensions = TYPES_ACCEPTES.get(mime);
  if (!extensions) {
    throw erreur(
      `Type de fichier non accepté : « ${mime || "inconnu"} ». Le Studio range des documents, des images et des fichiers bureautiques.`,
      "TYPE_REFUSE", 415);
  }

  const ext = path.extname(String(nomOrigine || "")).toLowerCase();
  if (ext && !extensions.includes(ext)) {
    throw erreur(
      `L'extension « ${ext} » ne correspond pas au type annoncé (${mime}). Un fichier renommé ne change pas de nature.`,
      "EXTENSION_INCOHERENTE", 415);
  }

  if (!SANS_SIGNATURE.has(mime)) {
    const attendue = FAMILLE.get(mime) || mime;
    const reelle = familleReelle(buffer);
    if (reelle !== attendue) {
      throw erreur(
        `Le contenu ne correspond pas au type annoncé. Un fichier présenté comme ${mime} doit en avoir la forme.`,
        "CONTENU_INCOHERENT", 415);
    }
  }

  return { mime, taille: buffer.length, sha256: empreinte(buffer) };
}

const empreinte = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

/** Une clé opaque, qui ne porte ni nom ni extension. */
function cleNouvelle(companyId, prefixe = "studio") {
  const d = new Date();
  const annee = d.getFullYear();
  const mois = String(d.getMonth() + 1).padStart(2, "0");
  return `${prefixe}/${Number(companyId) || 0}/${annee}/${mois}/${crypto.randomUUID()}`;
}

/** Le chemin absolu d'une clé, après s'être assuré qu'elle reste sous la racine. */
function cheminDe(cle) {
  const propre = String(cle || "").replace(/\\/g, "/");
  if (!propre || propre.includes("..") || propre.startsWith("/")) {
    throw erreur("Clé de stockage invalide.", "CLE_INVALIDE");
  }
  const chemin = path.resolve(path.join(RACINE, propre));
  if (chemin !== RACINE && !chemin.startsWith(RACINE + path.sep)) {
    throw erreur("Clé de stockage hors du dépôt.", "CLE_HORS_DEPOT");
  }
  return chemin;
}

async function ecrire(cle, buffer) {
  const chemin = cheminDe(cle);
  await fsp.mkdir(path.dirname(chemin), { recursive: true });
  /* On écrit à côté puis on renomme : un incident en cours d'écriture laisse
     un fichier temporaire, jamais un document à moitié écrit sous sa clé. */
  const provisoire = `${chemin}.en-cours-${crypto.randomBytes(4).toString("hex")}`;
  await fsp.writeFile(provisoire, buffer, { mode: 0o640 });
  await fsp.rename(provisoire, chemin);
  return { cle, taille: buffer.length, sha256: empreinte(buffer) };
}

async function lire(cle) {
  const chemin = cheminDe(cle);
  const stat = await fsp.stat(chemin);
  return { chemin, taille: stat.size };
}

function flux(cle) {
  return fs.createReadStream(cheminDe(cle));
}

async function existe(cle) {
  try { await fsp.access(cheminDe(cle)); return true; } catch { return false; }
}

async function supprimer(cle) {
  try { await fsp.unlink(cheminDe(cle)); return true; } catch { return false; }
}

/**
 * L'empreinte du fichier rangé, relue depuis le disque.
 * Sert à vérifier avant de servir qu'une archive n'a pas été altérée.
 */
async function empreinteStockee(cle) {
  const chemin = cheminDe(cle);
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const f = fs.createReadStream(chemin);
    f.on("data", (c) => h.update(c));
    f.on("end", () => resolve(h.digest("hex")));
    f.on("error", reject);
  });
}

module.exports = {
  RACINE, TAILLE_MAX, TYPES_ACCEPTES, SANS_SIGNATURE,
  erreur, verifier, empreinte, empreinteStockee, familleReelle,
  cleNouvelle, cheminDe, ecrire, lire, flux, existe, supprimer,
};

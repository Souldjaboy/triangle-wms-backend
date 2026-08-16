"use strict";

/**
 * QU'EST-CE QU'UN VRAI BAC PHYSIQUE ?
 *
 * Source unique de cette règle. Le moteur de stock, les previews et les
 * migrations doivent répondre la MÊME chose, sinon un écran autorise ce qu'un
 * autre refuse. Toute évolution se fait ici, jamais en recopiant un motif.
 *
 * Un emplacement n'est un contenant physique que s'il désigne un bac unique et
 * identifiable. Quatre familles sont donc écartées :
 *
 *   REBUT           « WRITE OFF » est un ÉTAT du produit, pas un contenant.
 *   NON PRÉCISÉ     un bin vide ou « BIN-NON-PRECISE » ne localise rien.
 *   PLAGE           « BIN1-2 », « BIN2-3 » : un bac ainsi étiqueté, ou deux
 *                   bacs voisins notés en raccourci ? La base ne le dit pas.
 *                   Décision métier : ce sont des emplacements HISTORIQUES
 *                   non précis. On ne suppose jamais un bac unique, et on ne
 *                   répartit jamais leur stock automatiquement.
 *   PLACEHOLDER     « NOUVEAU », « AUTO » : valeurs générées, pas du terrain.
 */

const WRITE_OFF_RE = /\bWRITE[\s_-]*OFF\b|\bREBUT\b|\bCASSE\b/i;
const NON_PRECISE_RE = /NON[\s_-]*PRECISE|NON[\s_-]*PRÉCIS|\bN\/?A\b|\bINCONNU\b|\bDIVERS\b/i;
/* « BIN1-2 », « BIN 2 / 3 », « 2-3 » … */
const RANGE_RE = /^\s*(BIN\s*)?(\d+)\s*[-–/]\s*(\d+)\s*$/i;
/* « FULLBIN » dit qu'un bac est plein, pas LEQUEL : ce n'est pas un repère. */
const FULLBIN_RE = /^\s*FULL[\s_-]*BIN\s*$/i;
const PLACEHOLDER_RE = /^\s*(NOUVEAU|AUTO|DEFAUT|DEFAULT|TEST|TEMP|X+|-+|0+)\s*$/i;

/* Équivalents PostgreSQL, pour les requêtes et les migrations. */
const SQL = {
  WRITE_OFF: "(WRITE[[:space:]_-]*OFF|\\mREBUT\\M|\\mCASSE\\M)",
  NON_PRECISE: "(NON[[:space:]_-]*PRECISE|NON[[:space:]_-]*PRÉCIS|\\mINCONNU\\M|\\mDIVERS\\M)",
  RANGE: "^(BIN[[:space:]]*)?[0-9]+[[:space:]]*[-/][[:space:]]*[0-9]+$",
  FULLBIN: "^FULL[[:space:]_-]*BIN$",
  PLACEHOLDER: "^(NOUVEAU|AUTO|DEFAUT|DEFAULT|TEST|TEMP|X+|-+|0+)$",
};

const s = (v) => String(v ?? "").trim();

/** Les composantes d'un emplacement, quelle que soit la forme reçue. */
function parts(loc = {}) {
  return {
    warehouse: s(loc.warehouse_code),
    row: s(loc.row_code || loc.rayon_code || loc.zone),
    location: s(loc.loc_code || loc.case_code || loc.rayon),
    level: s(loc.lvl_code || loc.level_code || loc.etagere),
    bin: s(loc.bin_code),
    code: s(loc.full_code || loc.emplacement_code),
  };
}

const isWriteOff = (loc) => Object.values(parts(loc)).some((v) => WRITE_OFF_RE.test(v));
const isNonPrecise = (loc) => { const b = parts(loc).bin; return !b || NON_PRECISE_RE.test(b); };
const isRange = (loc) => RANGE_RE.test(parts(loc).bin);
const isFullbin = (loc) => FULLBIN_RE.test(parts(loc).bin);
const isPlaceholder = (loc) => {
  const p = parts(loc);
  return PLACEHOLDER_RE.test(p.row) || PLACEHOLDER_RE.test(p.location);
};

/** Motif de non-recevabilité, ou null si l'emplacement est un vrai bac. */
function rejectionReason(loc) {
  if (isWriteOff(loc)) return "WRITE_OFF_EXCLUDE";
  if (isNonPrecise(loc)) return "LOCATION_UNRESOLVED";
  if (isRange(loc)) return "LOCATION_UNRESOLVED_RANGE";
  if (isFullbin(loc)) return "LEGACY_FULLBIN";
  if (isPlaceholder(loc)) return "LEGACY_PLACEHOLDER";
  return null;
}

const isPhysicalBin = (loc) => rejectionReason(loc) === null;

const MOTIF_FR = {
  WRITE_OFF_EXCLUDE: "mise au rebut : un état du produit, pas un contenant",
  LOCATION_UNRESOLVED: "bin non précisé : ne localise aucun contenant",
  LOCATION_UNRESOLVED_RANGE: "bin en plage : un bac ou deux ? emplacement historique non précis",
  LEGACY_FULLBIN: "« FULLBIN » indique un bac plein, pas lequel : ce n'est pas un repère",
  LEGACY_PLACEHOLDER: "composantes générées (NOUVEAU / AUTO) : emplacement réel non prouvé",
};

/**
 * Bacs réels dérivables d'une plage : « BIN1-2 » suggère BIN1 et BIN2, sous les
 * mêmes entrepôt / rayon / location / level.
 *
 * Ce sont des CANDIDATS à créer, jamais une répartition : savoir que deux bacs
 * existent ne dit pas lequel contient quoi.
 */
function binsFromRange(loc) {
  const p = parts(loc);
  const m = p.bin.match(RANGE_RE);
  if (!m) return [];
  const prefixe = (m[1] || "BIN").trim().toUpperCase();
  const [debut, fin] = [Number(m[2]), Number(m[3])].sort((a, b) => a - b);
  if (!Number.isFinite(debut) || !Number.isFinite(fin) || fin - debut > 12) return [];
  const out = [];
  for (let i = debut; i <= fin; i += 1) {
    out.push({
      warehouse: p.warehouse, row: p.row, location: p.location, level: p.level,
      bin: `${prefixe}${i}`,
      full_code: [p.warehouse, p.row, p.location, p.level, `${prefixe}${i}`].filter(Boolean).join("-"),
    });
  }
  return out;
}

module.exports = {
  WRITE_OFF_RE, NON_PRECISE_RE, RANGE_RE, PLACEHOLDER_RE, FULLBIN_RE, SQL, MOTIF_FR,
  parts, isWriteOff, isNonPrecise, isRange, isPlaceholder, isFullbin,
  isPhysicalBin, rejectionReason, binsFromRange,
};

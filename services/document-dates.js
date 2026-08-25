"use strict";

/**
 * DATES DES DOCUMENTS — QUATRE NOTIONS QU'ON NE CONFOND JAMAIS.
 *
 *   created_at              quand la ligne est entrée en base. Fait technique,
 *                           jamais réécrit, jamais corrigible.
 *   operation_effective_at  quand l'opération a EU LIEU sur le terrain.
 *   document_datetime       ce que LIT le destinataire du bon.
 *   printed_at              quand le bon est réellement sorti de l'imprimante.
 *
 * Le besoin qui impose cette séparation : une entrée saisie le 25 août pour
 * une opération faite le 22 à 10 h 30, imprimée le 27. Trois dates, trois
 * vérités, aucune ne doit écraser les autres.
 *
 * FUSEAU — Africa/Bamako.
 * Le Mali n'applique aucun changement d'heure : le décalage est nul toute
 * l'année. On ne le code pourtant pas en dur. L'offset est demandé à `Intl`
 * pour l'instant considéré : si la règle changeait un jour, les dates déjà
 * enregistrées resteraient justes, parce qu'elles sont stockées en instants
 * absolus (`timestamptz`) et non en heures locales sans repère.
 */

const FUSEAU = "Africa/Bamako";

/** Décalage du fuseau, en millisecondes, à l'instant donné. */
function decalage(instant, fuseau = FUSEAU) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: fuseau, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = Object.fromEntries(fmt.formatToParts(instant).map((x) => [x.type, x.value]));
  const commeUTC = Date.UTC(
    Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second)
  );
  return commeUTC - instant.getTime();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HEURE_RE = /^\d{2}:\d{2}(:\d{2})?$/;

class DateDocumentError extends Error {
  constructor(message, code = "INVALID_DATE", httpStatus = 400, details = null) {
    super(message);
    this.code = code; this.httpStatus = httpStatus; this.details = details;
  }
}

/**
 * « 22/08/2026 à 10:30, heure de Bamako » → l'instant absolu correspondant.
 *
 * L'utilisateur saisit une heure locale ; la base conserve un instant. Sans
 * cette conversion, le même bon afficherait deux heures différentes selon le
 * téléphone qui l'ouvre — c'est exactement ce que fait le code actuel, qui
 * s'en remet au fuseau du navigateur.
 */
function versInstant({ date, time = "00:00", iso = null }, fuseau = FUSEAU) {
  if (iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) throw new DateDocumentError("Date ISO illisible.", "INVALID_DATE");
    return d;
  }
  if (!DATE_RE.test(String(date || ""))) {
    throw new DateDocumentError("Date attendue au format AAAA-MM-JJ.", "INVALID_DATE");
  }
  const h = String(time || "00:00");
  if (!HEURE_RE.test(h)) {
    throw new DateDocumentError("Heure attendue au format HH:MM.", "INVALID_TIME");
  }
  const provisoire = new Date(`${date}T${h.length === 5 ? `${h}:00` : h}Z`);
  if (Number.isNaN(provisoire.getTime())) {
    throw new DateDocumentError("Date ou heure illisible.", "INVALID_DATE");
  }
  return new Date(provisoire.getTime() - decalage(provisoire, fuseau));
}

/** L'instant, tel qu'il s'écrit à Bamako. Sert à l'affichage et aux bons. */
function versLocal(instant, fuseau = FUSEAU) {
  if (!instant) return null;
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  const fmt = new Intl.DateTimeFormat("fr-FR", {
    timeZone: fuseau, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    iso: d.toISOString(),
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
    affichage: `${p.day}/${p.month}/${p.year} à ${p.hour}:${p.minute}`,
    fuseau,
  };
}

/* Bornes de bon sens. Une date de document n'est pas une date libre : elle
   décrit une opération qui a eu lieu, donc ni au siècle dernier ni demain. */
const PLANCHER = Date.UTC(2000, 0, 1);
const TOLERANCE_FUTUR_MS = 24 * 60 * 60 * 1000;

function verifierPlage(instant, maintenant = new Date()) {
  if (instant.getTime() < PLANCHER) {
    throw new DateDocumentError(
      "Date antérieure à l'an 2000 : vérifiez la saisie.", "DATE_TOO_OLD"
    );
  }
  if (instant.getTime() > maintenant.getTime() + TOLERANCE_FUTUR_MS) {
    throw new DateDocumentError(
      "Un document ne peut pas être daté du futur : l'opération n'a pas encore eu lieu.",
      "DATE_IN_FUTURE"
    );
  }
  return instant;
}

/**
 * Ce que le document doit afficher, quelles que soient les colonnes remplies.
 *
 * Ordre de repli : la date choisie pour le document, sinon celle de
 * l'opération, sinon — faute de mieux — la date technique de création. Le
 * repli est explicite, pour que l'écran puisse dire « date de création, non
 * confirmée » plutôt que de faire passer un fait technique pour un fait métier.
 */
function dateAAfficher(doc = {}) {
  if (doc.document_datetime) return { instant: doc.document_datetime, source: "document" };
  if (doc.operation_effective_at) return { instant: doc.operation_effective_at, source: "operation" };
  return { instant: doc.created_at, source: "creation" };
}

module.exports = {
  FUSEAU, DateDocumentError,
  decalage, versInstant, versLocal, verifierPlage, dateAAfficher,
  PLANCHER, TOLERANCE_FUTUR_MS,
};

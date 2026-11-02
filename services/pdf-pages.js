"use strict";
/**
 * LES OPÉRATIONS DE PAGES : RÉORDONNER, TOURNER, RETIRER, EXTRAIRE, FUSIONNER.
 *
 * Ce sont les gestes qu'on fait vraiment avec des PDF dans une entreprise :
 * une page blanche au milieu d'un scan, deux feuillets à l'envers, un dossier
 * à constituer à partir de quatre pièces, un bon à détacher d'un lot.
 *
 * TOUT SE FAIT SUR LE SERVEUR, et chaque opération produit un NOUVEAU
 * document : rien n'est réécrit en place. L'appelant décide ensuite d'en
 * faire une version de plus du document d'origine, ou un document à part.
 *
 * DEUX PRINCIPES.
 *
 * 1. ON NE PERD JAMAIS DE PAGE SANS LE DIRE. Chaque opération rend le compte
 *    de pages avant et après. Retirer trois pages d'un contrat de douze et
 *    n'en garder que huit au lieu de neuf est le genre d'erreur qu'on ne
 *    voit qu'au tribunal.
 *
 * 2. UN PDF QU'ON N'A PAS RELU N'EST PAS UN PDF. Chaque sortie est
 *    revérifiée avant d'être rendue.
 */
const { PDFDocument, degrees } = require("pdf-lib");

function erreur(message, code, httpStatus = 400) {
  const e = new Error(message);
  e.code = code; e.httpStatus = httpStatus;
  return e;
}

async function ouvrir(pdf, quoi = "Ce document") {
  if (!Buffer.isBuffer(pdf) || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw erreur(`${quoi} n'est pas un PDF.`, "PAS_UN_PDF", 415);
  }
  try {
    return await PDFDocument.load(pdf, { ignoreEncryption: false });
  } catch (e) {
    throw erreur(
      `${quoi} n'a pas pu être ouvert : ${e.message}. Il est peut-être protégé par un mot de passe.`,
      "PDF_ILLISIBLE", 415);
  }
}

async function finir(doc, attendu) {
  const octets = Buffer.from(await doc.save({ useObjectStreams: false }));
  if (!octets.length || octets.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw erreur("L'opération n'a pas produit un PDF valide.", "SORTIE_INVALIDE", 500);
  }
  const pages = doc.getPageCount();
  if (attendu !== undefined && pages !== attendu) {
    /* ON NE REND PAS UN DOCUMENT DONT LE COMPTE NE TOMBE PAS. Une page
       perdue en silence se découvre des mois plus tard. */
    throw erreur(
      `Le document produit porte ${pages} pages au lieu des ${attendu} attendues. ` +
      `Rien n'est enregistré.`,
      "COMPTE_INATTENDU", 500);
  }
  return { buffer: octets, pages };
}

/** Normalise une liste de numéros de page, à partir de 1. */
function numeros(liste, total, quoi = "pages") {
  if (!Array.isArray(liste) || !liste.length) {
    throw erreur(`Aucune page désignée.`, "AUCUNE_PAGE");
  }
  const vus = new Set();
  const propres = [];
  for (const brut of liste) {
    const n = Number(brut);
    if (!Number.isInteger(n) || n < 1 || n > total) {
      throw erreur(
        `La page ${brut} n'existe pas : ce document en compte ${total}.`,
        "PAGE_INEXISTANTE");
    }
    if (vus.has(n)) {
      throw erreur(`La page ${n} est désignée deux fois dans ${quoi}.`, "PAGE_EN_DOUBLE");
    }
    vus.add(n); propres.push(n);
  }
  return propres;
}

/* ─────────────────────────────────────────────────────────────────────────
   RÉORDONNER

   L'ordre donné est l'ordre voulu, en entier : toutes les pages doivent y
   figurer. Accepter un ordre partiel reviendrait à supprimer des pages sous
   couvert de les déplacer.
   ───────────────────────────────────────────────────────────────────────── */
async function reordonner({ pdf, ordre }) {
  const doc = await ouvrir(pdf);
  const total = doc.getPageCount();
  const voulu = numeros(ordre, total, "l'ordre");
  if (voulu.length !== total) {
    throw erreur(
      `L'ordre donné compte ${voulu.length} pages sur ${total}. Pour en retirer, ` +
      `utilisez le retrait : réordonner ne supprime rien.`,
      "ORDRE_INCOMPLET");
  }

  const neuf = await PDFDocument.create();
  neuf.setTitle(doc.getTitle() || "");
  const copiees = await neuf.copyPages(doc, voulu.map((n) => n - 1));
  for (const p of copiees) neuf.addPage(p);
  return { ...(await finir(neuf, total)), avant: total, apres: total };
}

/* ─────────────────────────────────────────────────────────────────────────
   TOURNER

   L'angle s'AJOUTE à la rotation déjà présente : une page déjà tournée de
   90° à laquelle on demande 90° de plus doit finir à 180°, pas revenir à 90.
   ───────────────────────────────────────────────────────────────────────── */
async function tourner({ pdf, pages, angle }) {
  const doc = await ouvrir(pdf);
  const total = doc.getPageCount();
  const voulues = numeros(pages, total);
  const a = Number(angle);
  if (![90, 180, 270, -90, -180, -270].includes(a)) {
    throw erreur(
      "On ne tourne que par quarts de tour : 90, 180 ou 270 degrés.",
      "ANGLE_INVALIDE");
  }
  for (const n of voulues) {
    const p = doc.getPage(n - 1);
    const actuel = p.getRotation().angle || 0;
    p.setRotation(degrees((((actuel + a) % 360) + 360) % 360));
  }
  return { ...(await finir(doc, total)), avant: total, apres: total, tournees: voulues.length };
}

/* ─────────────────────────────────────────────────────────────────────────
   RETIRER
   ───────────────────────────────────────────────────────────────────────── */
async function retirer({ pdf, pages }) {
  const doc = await ouvrir(pdf);
  const total = doc.getPageCount();
  const aRetirer = numeros(pages, total);
  if (aRetirer.length >= total) {
    throw erreur(
      "Un PDF doit garder au moins une page. Pour tout supprimer, supprimez le document.",
      "DOCUMENT_VIDE");
  }
  const garder = [];
  for (let n = 1; n <= total; n++) if (!aRetirer.includes(n)) garder.push(n - 1);

  const neuf = await PDFDocument.create();
  neuf.setTitle(doc.getTitle() || "");
  const copiees = await neuf.copyPages(doc, garder);
  for (const p of copiees) neuf.addPage(p);
  return {
    ...(await finir(neuf, garder.length)),
    avant: total, apres: garder.length, retirees: aRetirer,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   EXTRAIRE — les pages désignées deviennent un document à part.
   L'original n'est pas touché : c'est une COPIE qui sort.
   ───────────────────────────────────────────────────────────────────────── */
async function extraire({ pdf, pages }) {
  const doc = await ouvrir(pdf);
  const total = doc.getPageCount();
  const voulues = numeros(pages, total);

  const neuf = await PDFDocument.create();
  neuf.setTitle(doc.getTitle() || "");
  const copiees = await neuf.copyPages(doc, voulues.map((n) => n - 1));
  for (const p of copiees) neuf.addPage(p);
  return {
    ...(await finir(neuf, voulues.length)),
    avant: total, apres: voulues.length, extraites: voulues,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   FUSIONNER

   L'ordre des documents est celui donné. Le compte attendu est la somme :
   un document illisible au milieu doit faire échouer la fusion, pas
   produire un dossier incomplet qui passerait inaperçu.
   ───────────────────────────────────────────────────────────────────────── */
async function fusionner({ documents }) {
  if (!Array.isArray(documents) || documents.length < 2) {
    throw erreur("Il faut au moins deux documents à fusionner.", "PAS_ASSEZ_DE_DOCUMENTS");
  }
  const neuf = await PDFDocument.create();
  const detail = [];
  let attendu = 0;

  for (const [i, d] of documents.entries()) {
    const source = await ouvrir(d.buffer, `Le document « ${d.nom || i + 1} »`);
    const n = source.getPageCount();
    const copiees = await neuf.copyPages(source, source.getPageIndices());
    for (const p of copiees) neuf.addPage(p);
    attendu += n;
    detail.push({ nom: d.nom || `document ${i + 1}`, pages: n, depuis: attendu - n + 1 });
  }

  return { ...(await finir(neuf, attendu)), apres: attendu, detail };
}

/* ─────────────────────────────────────────────────────────────────────────
   DÉCOUPER — en tranches, chacune devenant un document.
   ───────────────────────────────────────────────────────────────────────── */
async function decouper({ pdf, tranches }) {
  const doc = await ouvrir(pdf);
  const total = doc.getPageCount();
  if (!Array.isArray(tranches) || !tranches.length) {
    throw erreur("Aucune tranche décrite.", "AUCUNE_TRANCHE");
  }

  const vues = new Set();
  const sorties = [];
  for (const [i, t] of tranches.entries()) {
    const pages = numeros(t.pages, total, `la tranche ${i + 1}`);
    for (const n of pages) {
      /* UNE PAGE DANS DEUX TRANCHES est presque toujours une erreur de
         saisie : on le dit plutôt que de la recopier deux fois. */
      if (vues.has(n)) {
        throw erreur(
          `La page ${n} se trouve dans deux tranches. Une page ne va que dans une.`,
          "PAGE_PARTAGEE");
      }
      vues.add(n);
    }
    const neuf = await PDFDocument.create();
    neuf.setTitle(String(t.nom || "").slice(0, 200));
    const copiees = await neuf.copyPages(doc, pages.map((n) => n - 1));
    for (const p of copiees) neuf.addPage(p);
    const fait = await finir(neuf, pages.length);
    /* DEUX CHOSES PORTAIENT LE MÊME NOM. `finir` rend un COMPTE de pages,
       et la tranche porte la LISTE des pages : étalées dans le même objet,
       le compte écrasait la liste, et l'appelant perdait le détail de ce
       qu'il venait de découper — sans la moindre erreur. On les nomme
       distinctement. */
    sorties.push({
      nom: t.nom || `partie ${i + 1}`,
      numeros: pages,
      buffer: fait.buffer,
      pages: fait.pages,
    });
  }

  /* On dit ce qui N'A PAS été repris : une page oubliée dans un découpage de
     dossier se retrouve six mois plus tard, ou jamais. */
  const oubliees = [];
  for (let n = 1; n <= total; n++) if (!vues.has(n)) oubliees.push(n);

  return { sorties, avant: total, oubliees };
}

module.exports = {
  reordonner, tourner, retirer, extraire, fusionner, decouper, numeros,
};

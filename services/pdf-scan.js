"use strict";
/**
 * ASSEMBLER DES PAGES SCANNÉES EN UN PDF.
 *
 * Rien de plus : prendre des images dans l'ordre, en faire un PDF qui
 * s'imprime correctement. pdfkit est déjà installé pour les factures — ce
 * module n'ajoute aucune dépendance au serveur.
 *
 * TROIS DÉCISIONS QUI CHANGENT LE RÉSULTAT À L'IMPRESSION.
 *
 * 1. CHAQUE PAGE SUIT SON ORIENTATION. Un bon de livraison à l'italienne
 *    couché de force sur un A4 debout sort illisible, à moitié de la taille.
 *    L'orientation est donc décidée page par page, d'après les dimensions
 *    réelles de l'image.
 *
 * 2. L'IMAGE EST CONTENUE, JAMAIS ROGNÉE. Remplir la page en coupant les
 *    bords amputerait un tampon ou un numéro de pièce — exactement ce qu'on
 *    scanne. On accepte donc des bandes blanches : une page avec des marges
 *    reste lisible, une page tronquée est à refaire.
 *
 * 3. LE FORMAT RESTE A4. C'est ce qui sort des imprimantes ici. Coller le
 *    format du PDF sur le rapport de l'image donnerait un document que
 *    chaque imprimante remettrait à l'échelle à sa façon.
 */
const PDFDocument = require("pdfkit");
const { dimensions } = require("./image-dimensions");

/* A4 en points typographiques, l'unité de pdfkit. */
const A4 = { petit: 595.28, grand: 841.89 };
const FORMATS = {
  A4_PORTRAIT: [A4.petit, A4.grand],
  A4_PAYSAGE: [A4.grand, A4.petit],
};

/* pdfkit n'embarque que ces deux formats. Un WebP scanné devrait être
   converti avant — et on le dit au lieu de produire un PDF vide. */
const EMBARQUABLES = new Set(["image/png", "image/jpeg"]);

function erreur(message, code, httpStatus = 400) {
  const e = new Error(message);
  e.code = code; e.httpStatus = httpStatus;
  return e;
}

/**
 * @param pages  [{ buffer, mime, nom }] dans l'ordre voulu.
 * @param format 'AUTO' | 'A4_PORTRAIT' | 'A4_PAYSAGE'
 * @returns { buffer, pages, avertissements }
 */
async function assembler({ pages, format = "AUTO", titre = "", auteur = "" }) {
  if (!Array.isArray(pages) || !pages.length) {
    throw erreur("Aucune page à assembler.", "AUCUNE_PAGE");
  }

  const avertissements = [];
  const doc = new PDFDocument({ autoFirstPage: false, bufferPages: true });
  /* Les métadonnées disent d'où vient le fichier. Un PDF anonyme retrouvé
     dans six mois ne se rattache à rien. */
  doc.info.Title = String(titre || "Document numérisé").slice(0, 200);
  doc.info.Author = String(auteur || "").slice(0, 200);
  doc.info.Creator = "Triangle Studio Pro — scanner";

  const morceaux = [];
  doc.on("data", (c) => morceaux.push(c));
  const fini = new Promise((ok, non) => { doc.on("end", ok); doc.on("error", non); });

  let posees = 0;
  for (const [i, page] of pages.entries()) {
    const rang = i + 1;
    if (!EMBARQUABLES.has(page.mime)) {
      /* On ne saute pas en silence : une page manquante dans un contrat se
         remarque trop tard. */
      throw erreur(
        `La page ${rang} est au format ${page.mime}, que le PDF ne sait pas ` +
        `embarquer. Seuls PNG et JPEG le sont. Reprenez cette page.`,
        "FORMAT_PAGE_NON_EMBARQUABLE", 415);
    }

    const d = dimensions(page.buffer);
    let taille;
    if (format !== "AUTO") {
      taille = FORMATS[format] || FORMATS.A4_PORTRAIT;
    } else if (!d) {
      /* DIMENSIONS ILLISIBLES : on choisit le portrait ET on le signale.
         Un choix silencieux ferait accuser le scanner d'avoir couché la
         page, alors que c'est l'en-tête de l'image qui n'a pas parlé. */
      taille = FORMATS.A4_PORTRAIT;
      avertissements.push(
        `Page ${rang} : dimensions illisibles, mise en portrait par défaut.`);
    } else {
      taille = d.largeur > d.hauteur ? FORMATS.A4_PAYSAGE : FORMATS.A4_PORTRAIT;
    }

    doc.addPage({ size: taille, margin: 0 });
    /* `fit` contient sans rogner ; centré, la page garde des marges égales. */
    doc.image(page.buffer, 0, 0, {
      fit: taille, align: "center", valign: "center",
    });
    posees += 1;
  }

  doc.end();
  await fini;
  const buffer = Buffer.concat(morceaux);

  /* Un PDF qu'on n'a pas relu n'est pas un PDF. Ce contrôle a l'air idiot
     jusqu'au jour où pdfkit rend un flux vide sur une image corrompue. */
  if (!buffer.length || buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw erreur("L'assemblage n'a pas produit un PDF valide.", "ASSEMBLAGE_INVALIDE", 500);
  }

  return { buffer, pages: posees, avertissements };
}

module.exports = { assembler, FORMATS, EMBARQUABLES };

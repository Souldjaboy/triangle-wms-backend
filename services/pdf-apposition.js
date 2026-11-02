"use strict";
/**
 * APPOSER UNE SIGNATURE OU UN CACHET SUR UN PDF.
 *
 * La modification se fait ICI, sur le serveur, là où l'original vit. Le
 * navigateur ne sert qu'à montrer la page et à dire où poser la marque : il
 * ne reçoit jamais l'image de la signature, et l'original ne lui est jamais
 * confié pour être réécrit.
 *
 * LE PIÈGE : LA ROTATION DE PAGE.
 *
 * Un PDF porte un attribut « /Rotate » : le nombre de degrés dont la page
 * doit être tournée DANS LE SENS DES AIGUILLES D'UNE MONTRE à l'affichage.
 * Les scanners en produisent sans arrêt. Le contenu, lui, n'est pas tourné :
 * seules les coordonnées de l'affichage le sont.
 *
 * Deux conséquences, et les ignorer donne une signature couchée dans un coin :
 *
 *   1. Les coordonnées reçues sont celles de l'ESPACE PDF, converties par le
 *      navigateur depuis ce que l'utilisateur voit. Cette conversion gère
 *      déjà la rotation : le rectangle arrive donc juste.
 *   2. Mais l'IMAGE, elle, serait dessinée dans l'espace du contenu — donc
 *      affichée tournée du même angle que la page. Pour qu'elle paraisse
 *      droite, il faut la tourner EN SENS INVERSE de l'affichage, c'est-à-dire
 *      dans le sens trigonométrique du même angle. Et comme la rotation se
 *      fait autour du point d'ancrage, l'ancre et les dimensions changent
 *      avec l'angle.
 *
 * Tout cela est calculé ci-dessous, angle par angle, et éprouvé par les
 * essais sur de vraies pages tournées.
 */
const { PDFDocument, degrees } = require("pdf-lib");

function erreur(message, code, httpStatus = 400) {
  const e = new Error(message);
  e.code = code; e.httpStatus = httpStatus;
  return e;
}

/**
 * Où ancrer l'image, et quelles dimensions lui donner, pour qu'elle
 * REMPLISSE le rectangle voulu une fois tournée.
 *
 * @param r     rotation de la page, en degrés dans le sens horaire
 * @param rect  { x, y, largeur, hauteur } dans l'espace PDF, coin bas-gauche
 */
function placement(r, { x, y, largeur, hauteur }) {
  switch (((r % 360) + 360) % 360) {
    case 90:
      /* Tournée d'un quart de tour dans le sens trigonométrique autour de
         son ancre, l'image s'étend vers la gauche et vers le haut. */
      return { x: x + largeur, y, width: hauteur, height: largeur, angle: 90 };
    case 180:
      return { x: x + largeur, y: y + hauteur, width: largeur, height: hauteur, angle: 180 };
    case 270:
      return { x, y: y + hauteur, width: hauteur, height: largeur, angle: 270 };
    default:
      return { x, y, width: largeur, height: hauteur, angle: 0 };
  }
}

/**
 * @param pdf       le document, en octets
 * @param image     l'image de la signature, en octets (PNG ou JPEG)
 * @param mime      son type
 * @param page      le numéro de page, à partir de 1
 * @param rect      { x, y, largeur, hauteur } en points PDF, coin bas-gauche
 * @param opacite   de 0 à 1
 * @returns { buffer, pages, page, rotation, rect }
 */
async function apposer({ pdf, image, mime, page, rect, opacite = 1 }) {
  if (!Buffer.isBuffer(pdf) || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw erreur("Ce document n'est pas un PDF.", "PAS_UN_PDF", 415);
  }
  if (!Buffer.isBuffer(image) || !image.length) {
    throw erreur("L'image de la signature est vide.", "IMAGE_VIDE");
  }

  let doc;
  try {
    /* `ignoreEncryption: false` : on refuse de modifier un PDF protégé
       plutôt que de produire un fichier qui s'ouvrira mal ailleurs. */
    doc = await PDFDocument.load(pdf, { ignoreEncryption: false });
  } catch (e) {
    throw erreur(
      `Ce PDF n'a pas pu être ouvert : ${e.message}. Il est peut-être protégé par un mot de passe.`,
      "PDF_ILLISIBLE", 415);
  }

  const pages = doc.getPages();
  const numero = Number(page);
  if (!Number.isInteger(numero) || numero < 1 || numero > pages.length) {
    throw erreur(
      `Ce document a ${pages.length} page${pages.length > 1 ? "s" : ""} : la page ${page} n'existe pas.`,
      "PAGE_INEXISTANTE");
  }
  const cible = pages[numero - 1];
  const { width: largeurPage, height: hauteurPage } = cible.getSize();
  const rotation = cible.getRotation().angle || 0;

  const x = Number(rect?.x), y = Number(rect?.y);
  const largeur = Number(rect?.largeur), hauteur = Number(rect?.hauteur);
  if (![x, y, largeur, hauteur].every(Number.isFinite)) {
    throw erreur("La position de la signature est incomplète.", "POSITION_INVALIDE");
  }
  if (largeur <= 0 || hauteur <= 0) {
    throw erreur("La signature doit avoir une largeur et une hauteur.", "TAILLE_INVALIDE");
  }
  /* DÉBORDER LA PAGE N'EST PAS UNE OPTION : une signature à moitié hors du
     papier ne s'imprime pas, et personne ne s'en aperçoit à l'écran. On
     tolère un demi-point d'arrondi, pas davantage. */
  const marge = 0.5;
  if (x < -marge || y < -marge ||
      x + largeur > largeurPage + marge || y + hauteur > hauteurPage + marge) {
    throw erreur(
      `La signature sort de la page (${Math.round(largeurPage)}×${Math.round(hauteurPage)} points). ` +
      `Replacez-la à l'intérieur.`,
      "HORS_PAGE");
  }

  let incrustee;
  try {
    incrustee = mime === "image/jpeg" || mime === "image/jpg"
      ? await doc.embedJpg(image)
      : await doc.embedPng(image);
  } catch (e) {
    throw erreur(
      `L'image de la signature n'a pas pu être incorporée : ${e.message}`,
      "IMAGE_INCORPORABLE", 415);
  }

  const p = placement(rotation, { x, y, largeur, hauteur });
  cible.drawImage(incrustee, {
    x: p.x, y: p.y, width: p.width, height: p.height,
    rotate: degrees(p.angle),
    opacity: Math.max(0, Math.min(1, Number(opacite) || 1)),
  });

  const octets = Buffer.from(await doc.save({ useObjectStreams: false }));
  /* On relit ce qu'on a produit : pdf-lib peut rendre un flux vide sur un
     document cabossé, et un PDF qu'on n'a pas vérifié n'est pas un PDF. */
  if (!octets.length || octets.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw erreur("L'apposition n'a pas produit un PDF valide.", "APPOSITION_INVALIDE", 500);
  }

  return {
    buffer: octets,
    pages: pages.length,
    page: numero,
    rotation,
    taillePage: { largeur: largeurPage, hauteur: hauteurPage },
    rect: { x, y, largeur, hauteur },
  };
}

/** Le nombre de pages et leurs dimensions : l'écran en a besoin pour placer. */
async function decrire(pdf) {
  if (!Buffer.isBuffer(pdf) || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw erreur("Ce document n'est pas un PDF.", "PAS_UN_PDF", 415);
  }
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: false });
  return doc.getPages().map((p, i) => {
    const { width, height } = p.getSize();
    return { page: i + 1, largeur: width, hauteur: height, rotation: p.getRotation().angle || 0 };
  });
}

module.exports = { apposer, decrire, placement };

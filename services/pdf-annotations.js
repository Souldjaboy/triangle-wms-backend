"use strict";
/**
 * POSER DU TEXTE, DES TABLEAUX ET DES ANNOTATIONS SUR UNE PAGE DE PDF.
 *
 * Quatre natures, et pas une de plus que ce qui se tient :
 *
 *   TEXTE       un paragraphe dans un cadre, coupé en lignes
 *   TABLEAU     des lignes et des colonnes, avec un filet
 *   SURLIGNAGE  un aplat translucide par-dessus
 *   CADRE       un rectangle vide, pour entourer
 *
 * CE QUE CE MODULE NE FAIT PAS SEMBLANT DE FAIRE.
 *
 * Un surlignage est dessiné PAR-DESSUS le texte, avec de la transparence. Ce
 * n'est pas le surligneur des lecteurs de PDF, qui est un objet d'annotation
 * que l'on peut sélectionner, commenter et retirer. Ici c'est de l'encre : ce
 * qui est posé est posé, et la version d'avant reste pour revenir en arrière.
 * L'intitulé à l'écran le dit ; appeler cela « surligner » sans le préciser
 * laisserait croire qu'on peut l'enlever d'un clic dans Acrobat.
 *
 * RIEN NE DÉBORDE EN SILENCE. Si le texte demandé ne tient pas dans le cadre
 * demandé, on refuse en disant combien de lignes tiennent et combien il en
 * faudrait. Réduire la police tout seul produirait un document que personne
 * n'a voulu, et rogner le texte en ferait disparaître une partie sans que
 * quiconque s'en aperçoive avant l'impression.
 *
 * LES ACCENTS SONT VÉRIFIÉS D'AVANCE. Les polices standard d'un PDF
 * n'encodent qu'un jeu de 224 caractères (WinAnsi) : « é », « ç », « œ » et
 * « € » y sont, mais ni le cyrillique, ni l'arabe, ni les guillemets
 * courbes chinois. `pdf-lib` lève alors une erreur obscure au moment du
 * dessin ; on préfère la rendre lisible, en nommant le caractère fautif.
 */
const { PDFDocument, StandardFonts, rgb, degrees } = require("pdf-lib");
const { repere } = require("./pdf-reperes");

function erreur(message, code, httpStatus = 400) {
  const e = new Error(message);
  e.code = code; e.httpStatus = httpStatus;
  return e;
}

/** Marque une erreur du rang de l'annotation qui l'a provoquée. */
function rang(index, e) {
  if (e.index === undefined) e.index = index;
  return e;
}

const NATURES = ["TEXTE", "TABLEAU", "SURLIGNAGE", "CADRE"];

/* Les cinq polices que tout lecteur de PDF possède sans qu'on les incorpore.
   En incorporer une vraie ajouterait des centaines de kilo-octets par
   document et demanderait un fichier de police au dépôt : hors sujet pour
   annoter un bon de livraison. */
const POLICES = {
  "sans":            StandardFonts.Helvetica,
  "sans-gras":       StandardFonts.HelveticaBold,
  "sans-italique":   StandardFonts.HelveticaOblique,
  "serif":           StandardFonts.TimesRoman,
  "serif-gras":      StandardFonts.TimesRomanBold,
  "serif-italique":  StandardFonts.TimesRomanItalic,
  "mono":            StandardFonts.Courier,
  "mono-gras":       StandardFonts.CourierBold,
};

const TAILLE_MIN = 4;
const TAILLE_MAX = 144;
const INTERLIGNE = 1.25;
/* Au-delà, ce n'est plus une annotation : c'est un document à part, et le
   payload deviendrait assez gros pour mériter un autre chemin. */
const ANNOTATIONS_MAX = 200;
const TEXTE_MAX = 20_000;
const CELLULES_MAX = 2_000;

function couleur(valeur, defaut = [0, 0, 0]) {
  const v = String(valeur ?? "").trim();
  const m = /^#?([0-9a-f]{6})$/i.exec(v);
  if (!m) {
    if (!v) return rgb(defaut[0], defaut[1], defaut[2]);
    throw erreur(
      `« ${v} » n'est pas une couleur. Attendu : six chiffres hexadécimaux, par exemple #1f2937.`,
      "COULEUR_INVALIDE");
  }
  const n = parseInt(m[1], 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/**
 * Les caractères que la police ne sait pas écrire, nommés.
 * On mesure chaque caractère distinct : `pdf-lib` lève sur l'encodage, donc
 * mesurer suffit à savoir s'il passera.
 */
function inecrivables(police, texte) {
  const vus = new Set();
  const mauvais = [];
  for (const c of String(texte)) {
    if (c === "\n" || c === "\r" || vus.has(c)) continue;
    vus.add(c);
    try { police.widthOfTextAtSize(c, 10); }
    catch { mauvais.push(c); }
  }
  return mauvais;
}

function verifierTexte(police, texte, ou) {
  const mauvais = inecrivables(police, texte);
  if (mauvais.length) {
    const liste = mauvais.slice(0, 6).map((c) => `« ${c} »`).join(", ");
    throw erreur(
      `${ou} contient ${mauvais.length} caractère${mauvais.length > 1 ? "s" : ""} ` +
      `que les polices d'un PDF ne savent pas écrire : ${liste}. ` +
      `Les accents français passent ; les autres alphabets demanderaient d'incorporer une police.`,
      "CARACTERE_INECRIVABLE");
  }
}

/**
 * COUPER UN PARAGRAPHE EN LIGNES.
 *
 * Les retours à la ligne voulus sont respectés. Un mot plus large que le
 * cadre est coupé au caractère — sinon il dépasserait, ce qu'on a promis de
 * ne jamais laisser passer en silence.
 */
function lignes(police, texte, taille, largeur) {
  const sortie = [];
  for (const paragraphe of String(texte).replace(/\r\n?/g, "\n").split("\n")) {
    const mots = paragraphe.split(/[ \t]+/).filter((m) => m !== "");
    if (!mots.length) { sortie.push(""); continue; }
    let courante = "";
    for (const mot of mots) {
      const essai = courante ? `${courante} ${mot}` : mot;
      if (police.widthOfTextAtSize(essai, taille) <= largeur) { courante = essai; continue; }
      if (courante) { sortie.push(courante); courante = ""; }
      if (police.widthOfTextAtSize(mot, taille) <= largeur) { courante = mot; continue; }
      /* Un mot trop large : une référence, une URL, un numéro de conteneur. */
      let morceau = "";
      for (const c of mot) {
        if (police.widthOfTextAtSize(morceau + c, taille) <= largeur) { morceau += c; continue; }
        if (morceau) sortie.push(morceau);
        morceau = c;
      }
      courante = morceau;
    }
    if (courante) sortie.push(courante);
  }
  return sortie;
}

function nombre(v, nom, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw erreur(`${nom} n'est pas un nombre.`, "NOMBRE_INVALIDE");
  if (n < min || n > max) {
    throw erreur(`${nom} doit être entre ${min} et ${max}.`, "NOMBRE_HORS_BORNES");
  }
  return n;
}

/* ═══════════════════════ LES QUATRE NATURES ═══════════════════════ */

function poserSurlignage(page, R, a) {
  const r = R.rect(a.x, a.y, a.largeur, a.hauteur);
  page.drawRectangle({
    x: r.x, y: r.y, width: r.largeur, height: r.hauteur,
    color: couleur(a.couleur || "#fde047"),
    opacity: a.opacite === undefined ? 0.35 : nombre(a.opacite, "L'opacité", { min: 0.05, max: 1 }),
  });
}

function poserCadre(page, R, a) {
  const r = R.rect(a.x, a.y, a.largeur, a.hauteur);
  page.drawRectangle({
    x: r.x, y: r.y, width: r.largeur, height: r.hauteur,
    borderColor: couleur(a.couleur || "#dc2626"),
    borderWidth: a.epaisseur === undefined ? 1.5 : nombre(a.epaisseur, "L'épaisseur", { min: 0.25, max: 12 }),
    /* Pas de `color` du tout : un cadre entoure, il ne masque pas. Sans
       couleur de remplissage, pdf-lib ne trace que le contour. */
  });
}

function poserTexte(page, R, a, police, index) {
  const taille = a.taille === undefined ? 11
    : nombre(a.taille, "La taille du texte", { min: TAILLE_MIN, max: TAILLE_MAX });
  const texte = String(a.texte ?? "");
  if (!texte.trim()) throw erreur(`L'annotation ${index} n'a pas de texte.`, "TEXTE_VIDE");
  if (texte.length > TEXTE_MAX) {
    throw erreur(`Ce texte fait ${texte.length} caractères ; la limite est ${TEXTE_MAX}.`, "TEXTE_TROP_LONG");
  }
  verifierTexte(police, texte, `L'annotation ${index}`);

  const pas = taille * INTERLIGNE;
  const lgn = lignes(police, texte, taille, a.largeur);
  const besoin = lgn.length * pas;
  if (besoin > a.hauteur + 0.5) {
    const tiennent = Math.max(0, Math.floor((a.hauteur + 0.5) / pas));
    throw erreur(
      `Ce texte demande ${lgn.length} ligne${lgn.length > 1 ? "s" : ""} ` +
      `(${Math.ceil(besoin)} points de haut) et le cadre n'en tient que ${tiennent} ` +
      `(${Math.round(a.hauteur)} points). Agrandissez le cadre ou réduisez la taille : ` +
      `rien n'est rogné sans le dire.`,
      "TEXTE_DEBORDE");
    }

  const encre = couleur(a.couleur || "#111827");
  const angle = degrees(R.angleTexte);
  lgn.forEach((ligne, i) => {
    if (!ligne) return;
    const large = police.widthOfTextAtSize(ligne, taille);
    let dx = 0;
    if (a.alignement === "centre") dx = (a.largeur - large) / 2;
    else if (a.alignement === "droite") dx = a.largeur - large;
    /* La base de la ligne, dans le repère de l'affichage : on part du haut
       du cadre et on descend. Le 0,8 place la base sous le haut des
       capitales, faute de quoi la première ligne mord le bord. */
    const ya = a.y + a.hauteur - i * pas - taille * 0.8;
    const p = R.point(a.x + dx, ya);
    page.drawText(ligne, { x: p.x, y: p.y, size: taille, font: police, color: encre, rotate: angle });
  });
  return lgn.length;
}

function poserTableau(page, R, a, police, policeGras, index) {
  const grille = Array.isArray(a.lignes) ? a.lignes : null;
  if (!grille || !grille.length) {
    throw erreur(`Le tableau ${index} n'a aucune ligne.`, "TABLEAU_VIDE");
  }
  const colonnes = Math.max(...grille.map((l) => (Array.isArray(l) ? l.length : 0)));
  if (!colonnes) throw erreur(`Le tableau ${index} n'a aucune colonne.`, "TABLEAU_VIDE");
  if (grille.length * colonnes > CELLULES_MAX) {
    throw erreur(
      `Ce tableau fait ${grille.length}×${colonnes} cellules ; la limite est ${CELLULES_MAX}.`,
      "TABLEAU_TROP_GRAND");
  }

  const taille = a.taille === undefined ? 9
    : nombre(a.taille, "La taille du texte", { min: TAILLE_MIN, max: TAILLE_MAX });
  const entete = a.entete !== false;
  const marge = 3;
  const filet = a.epaisseur === undefined ? 0.6
    : nombre(a.epaisseur, "L'épaisseur du filet", { min: 0.1, max: 4 });

  /* Les largeurs de colonnes, en parts. Égales par défaut : c'est le cas qui
     sert, et une largeur en points se tromperait au premier changement de
     cadre. */
  let parts = Array.isArray(a.colonnes) && a.colonnes.length === colonnes
    ? a.colonnes.map((v, i) => nombre(v, `La part de la colonne ${i + 1}`, { min: 0.01, max: 100 }))
    : Array(colonnes).fill(1);
  const somme = parts.reduce((s, v) => s + v, 0);
  const largeurs = parts.map((v) => (v / somme) * a.largeur);

  /* La hauteur de chaque ligne découle de son contenu : une cellule longue
     pousse toute la ligne, sinon son texte sortirait de la case. */
  const decoupe = grille.map((ligne, iL) => {
    const p = entete && iL === 0 ? policeGras : police;
    return Array.from({ length: colonnes }, (_, iC) => {
      const contenu = String(ligne?.[iC] ?? "");
      verifierTexte(p, contenu, `Le tableau ${index}, ligne ${iL + 1}, colonne ${iC + 1},`);
      const utile = Math.max(1, largeurs[iC] - 2 * marge);
      return lignes(p, contenu, taille, utile);
    });
  });
  const pas = taille * INTERLIGNE;
  const hauteurs = decoupe.map((l) => Math.max(1, ...l.map((c) => c.length)) * pas + 2 * marge);
  const besoin = hauteurs.reduce((s, v) => s + v, 0);
  if (besoin > a.hauteur + 0.5) {
    throw erreur(
      `Ce tableau demande ${Math.ceil(besoin)} points de haut et le cadre n'en offre ` +
      `que ${Math.round(a.hauteur)}. Agrandissez le cadre, réduisez la taille, ou retirez des lignes : ` +
      `aucune ligne n'est coupée sans le dire.`,
      "TABLEAU_DEBORDE");
  }

  const trait = couleur(a.couleurFilet || "#9ca3af");
  const encre = couleur(a.couleur || "#111827");
  const fondEntete = a.couleurEntete === null ? null : couleur(a.couleurEntete || "#f3f4f6");
  const angle = degrees(R.angleTexte);

  /* Un filet se dessine comme un rectangle plein de l'épaisseur voulue : les
     traits de `drawLine` ne se transforment pas aussi simplement sur une
     page tournée, et un rectangle passe par R.rect() comme tout le reste. */
  const filetH = (xa, ya, longueur) => {
    const r = R.rect(xa, ya - filet / 2, longueur, filet);
    page.drawRectangle({ x: r.x, y: r.y, width: r.largeur, height: r.hauteur, color: trait });
  };
  const filetV = (xa, ya, longueur) => {
    const r = R.rect(xa - filet / 2, ya, filet, longueur);
    page.drawRectangle({ x: r.x, y: r.y, width: r.largeur, height: r.hauteur, color: trait });
  };

  let haut = a.y + a.hauteur;
  decoupe.forEach((ligne, iL) => {
    const h = hauteurs[iL];
    if (entete && iL === 0 && fondEntete) {
      const r = R.rect(a.x, haut - h, a.largeur, h);
      page.drawRectangle({ x: r.x, y: r.y, width: r.largeur, height: r.hauteur, color: fondEntete });
    }
    const p = entete && iL === 0 ? policeGras : police;
    let gauche = a.x;
    ligne.forEach((cellule, iC) => {
      cellule.forEach((txt, i) => {
        if (!txt) return;
        const ya = haut - marge - i * pas - taille * 0.8;
        const pt = R.point(gauche + marge, ya);
        page.drawText(txt, { x: pt.x, y: pt.y, size: taille, font: p, color: encre, rotate: angle });
      });
      gauche += largeurs[iC];
    });
    filetH(a.x, haut, a.largeur);
    haut -= h;
  });
  filetH(a.x, haut, a.largeur);
  /* Les séparateurs de colonnes vont du bas de la dernière ligne au haut du
     tableau. Leur longueur est donc la hauteur RÉELLEMENT occupée, `besoin`,
     et non la hauteur du cadre : un tableau de trois lignes dans un grand
     cadre n'a pas de filets qui pendent sous lui. */
  let gauche = a.x;
  for (let iC = 0; iC <= colonnes; iC += 1) {
    filetV(gauche, haut, besoin);
    gauche += largeurs[iC] ?? 0;
  }
  return { lignes: grille.length, colonnes, hauteur: besoin };
}

/* ═══════════════════════════ L'ENTRÉE ═══════════════════════════ */

/**
 * @param pdf          le document, en octets
 * @param annotations  une liste, chacune { nature, page, x, y, largeur, hauteur, … }
 *                     en POINTS, dans le repère de la page TELLE QU'ON LA VOIT,
 *                     origine en bas à gauche. Voir services/pdf-reperes.js.
 * @returns { buffer, pages, posees }
 */
async function annoter({ pdf, annotations }) {
  if (!Buffer.isBuffer(pdf) || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw erreur("Ce document n'est pas un PDF.", "PAS_UN_PDF", 415);
  }
  const liste = Array.isArray(annotations) ? annotations : null;
  if (!liste || !liste.length) {
    throw erreur("Aucune annotation à poser.", "RIEN_A_POSER");
  }
  if (liste.length > ANNOTATIONS_MAX) {
    throw erreur(
      `${liste.length} annotations d'un coup ; la limite est ${ANNOTATIONS_MAX}.`,
      "TROP_D_ANNOTATIONS");
  }

  let doc;
  try {
    doc = await PDFDocument.load(pdf, { ignoreEncryption: false });
  } catch (e) {
    throw erreur(
      `Ce PDF n'a pas pu être ouvert : ${e.message}. Il est peut-être protégé par un mot de passe.`,
      "PDF_ILLISIBLE", 415);
  }
  const pages = doc.getPages();

  /* Les polices sont incorporées à la demande : un document n'en embarque
     que ce qu'il utilise. */
  const cache = new Map();
  const policeDe = async (nom) => {
    const clef = POLICES[nom] ? nom : "sans";
    if (nom && !POLICES[nom]) {
      throw erreur(
        `La police « ${nom} » n'existe pas. Au choix : ${Object.keys(POLICES).join(", ")}.`,
        "POLICE_INCONNUE");
    }
    if (!cache.has(clef)) cache.set(clef, await doc.embedFont(POLICES[clef]));
    return cache.get(clef);
  };

  const posees = [];
  for (let i = 0; i < liste.length; i += 1) {
    const brut = liste[i] || {};
    const index = i + 1;
    const nature = String(brut.nature || "").toUpperCase();
    if (!NATURES.includes(nature)) {
      throw rang(index, erreur(
        `L'annotation ${index} est de nature « ${brut.nature} ». Au choix : ${NATURES.join(", ")}.`,
        "NATURE_INCONNUE"));
    }
    const numero = Number(brut.page);
    if (!Number.isInteger(numero) || numero < 1 || numero > pages.length) {
      throw rang(index, erreur(
        `Ce document a ${pages.length} page${pages.length > 1 ? "s" : ""} : ` +
        `la page ${brut.page} de l'annotation ${index} n'existe pas.`,
        "PAGE_INEXISTANTE"));
    }
    const page = pages[numero - 1];
    const { width, height } = page.getSize();
    const R = repere({ largeur: width, hauteur: height, rotation: page.getRotation().angle || 0 });

    let a;
    try {
      a = {
        ...brut,
        x: nombre(brut.x, `L'abscisse de l'annotation ${index}`),
        y: nombre(brut.y, `L'ordonnée de l'annotation ${index}`),
        largeur: nombre(brut.largeur, `La largeur de l'annotation ${index}`, { min: 1 }),
        hauteur: nombre(brut.hauteur, `La hauteur de l'annotation ${index}`, { min: 1 }),
      };
    } catch (e) { throw rang(index, e); }
    /* DÉBORDER LA PAGE N'EST PAS UNE OPTION : une annotation à moitié hors
       du papier ne s'imprime pas, et personne ne s'en aperçoit à l'écran. */
    if (!R.dedans(a.x, a.y, a.largeur, a.hauteur)) {
      throw rang(index, erreur(
        `L'annotation ${index} sort de la page ${numero} ` +
        `(${Math.round(R.vue.largeur)}×${Math.round(R.vue.hauteur)} points à l'affichage). ` +
        `Replacez-la à l'intérieur.`,
        "HORS_PAGE"));
    }

    /* CHAQUE REFUS DIT DE QUELLE ANNOTATION IL PARLE, par son rang dans la
       liste envoyée. Sans cela, qui a posé six cadres sur une page et reçoit
       « ce texte demande 4 lignes » ne sait pas lequel corriger : il les
       essaie un par un. Le rang remonte jusqu'à l'écran, qui sélectionne le
       cadre fautif. */
    try {
      if (nature === "SURLIGNAGE") poserSurlignage(page, R, a);
      else if (nature === "CADRE") poserCadre(page, R, a);
      else if (nature === "TEXTE") {
        const p = await policeDe(brut.police);
        poserTexte(page, R, a, p, index);
      } else {
        const p = await policeDe(brut.police);
        const g = await policeDe(
          brut.police && POLICES[`${String(brut.police).replace(/-(gras|italique)$/, "")}-gras`]
            ? `${String(brut.police).replace(/-(gras|italique)$/, "")}-gras`
            : "sans-gras");
        poserTableau(page, R, a, p, g, index);
      }
    } catch (e) {
      if (e.index === undefined) e.index = index;
      throw e;
    }
    posees.push({ nature, page: numero, rotation: R.rotation });
  }

  const octets = Buffer.from(await doc.save({ useObjectStreams: false }));
  if (!octets.length || octets.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw erreur("L'annotation n'a pas produit un PDF valide.", "ANNOTATION_INVALIDE", 500);
  }
  return { buffer: octets, pages: pages.length, posees };
}

/** Les pages telles qu'on les VOIT : c'est dans ce repère que l'écran place. */
async function decrire(pdf) {
  if (!Buffer.isBuffer(pdf) || pdf.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw erreur("Ce document n'est pas un PDF.", "PAS_UN_PDF", 415);
  }
  const doc = await PDFDocument.load(pdf, { ignoreEncryption: false });
  return doc.getPages().map((p, i) => {
    const { width, height } = p.getSize();
    const R = repere({ largeur: width, hauteur: height, rotation: p.getRotation().angle || 0 });
    return {
      page: i + 1, rotation: R.rotation,
      largeur: R.vue.largeur, hauteur: R.vue.hauteur,
      largeurPdf: width, hauteurPdf: height,
    };
  });
}

module.exports = { annoter, decrire, lignes, NATURES, POLICES: Object.keys(POLICES) };

"use strict";

/**
 * UNE SEULE GÉNÉRATION DE PDF, POUR TOUTES LES ACTIONS.
 *
 * Télécharger, partager par WhatsApp, joindre à un email, partager depuis le
 * téléphone : le document doit être le MÊME octet pour octet. Le contraire —
 * un PDF fabriqué côté navigateur pour le téléchargement, un autre côté
 * serveur pour l'email — produit deux documents qui divergent au premier
 * changement de mise en page, et personne ne s'en aperçoit avant qu'un client
 * compare son exemplaire avec celui du classeur.
 *
 * D'où ce module, seul endroit où un bon devient un PDF. Le navigateur ne
 * fabrique rien : il télécharge ce que le serveur a produit, et partage ce
 * même fichier.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POURQUOI pdfkit ET PAS UN NAVIGATEUR SANS TÊTE
 *
 * Imprimer une page HTML avec Chromium donnerait un rendu plus proche de
 * l'écran, mais ferait dépendre l'émission d'un bon de livraison d'un
 * navigateur complet installé sur le serveur — plusieurs centaines de
 * mégaoctets, une mise à jour de sécurité à suivre, et un échec possible au
 * moment précis où quelqu'un attend son bon. pdfkit dessine le document en
 * JavaScript pur : rien à installer de plus que le paquet.
 */

const PDFDocument = require("pdfkit");

const MARGE = 40;
const NOIR = "#000000";
const GRIS = "#555555";

/** Le FCFA n'a pas de centime : un montant s'écrit en francs entiers. */
function fcfa(valeur) {
  const n = Math.round(Number(valeur || 0));
  return `${n.toLocaleString("fr-FR")} FCFA`;
}

function jour(valeur) {
  if (!valeur) return "—";
  const d = new Date(valeur);
  if (Number.isNaN(d.getTime())) return String(valeur).slice(0, 10);
  return d.toLocaleDateString("fr-FR", { timeZone: "Africa/Bamako" });
}

/**
 * Le nom du fichier, tel que le client le recevra.
 *
 *   BL_00125_FATEH_ET_MAT.pdf
 *
 * Les accents et l'esperluette sont retirés : un nom de fichier voyage entre
 * un serveur, un téléphone, WhatsApp et un ordinateur, et chacun a sa façon
 * de les abîmer. Ce qui reste doit rester lisible partout.
 */
function nomFichier({ numero, societe }) {
  const propre = (texte) =>
    String(texte || "")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/&/g, " ET ")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

  const num = propre(numero).replace(/^BL_?/, "") || "SANS_NUMERO";

  /* La forme juridique n'identifie pas l'entreprise et allonge un nom que
     quelqu'un devra lire sur l'écran d'un téléphone. « FAT & MAT Entreprise »
     donne FAT_ET_MAT, pas FAT_ET_MAT_ENTREPRISE. */
  const FORMES = new Set(["ENTREPRISE", "SARL", "SA", "SAS", "SASU", "EURL", "SUARL", "ETS", "ETABLISSEMENT", "ETABLISSEMENTS"]);
  const ste = propre(societe).split("_").filter(Boolean)
    .filter((mot, i, tous) => !(i === tous.length - 1 && FORMES.has(mot)))
    .join("_");

  return `BL_${num}${ste ? `_${ste}` : ""}.pdf`;
}

/* ═══════════════════════════════════════════════════════════════════════
   LE DESSIN
   ═══════════════════════════════════════════════════════════════════════ */

function enTete(doc, { societe, titre, numero }) {
  doc.fillColor(NOIR).font("Helvetica-Bold").fontSize(16)
     .text(societe.nom || "", MARGE, MARGE, { width: 320 });

  doc.font("Helvetica").fontSize(9).fillColor(GRIS);
  for (const ligne of [societe.adresse, societe.telephone, societe.email].filter(Boolean)) {
    doc.text(String(ligne), { width: 320 });
  }

  doc.font("Helvetica-Bold").fontSize(20).fillColor(NOIR)
     .text(titre, 340, MARGE, { width: 215, align: "right" });
  doc.font("Helvetica-Bold").fontSize(12)
     .text(numero || "", 340, doc.y, { width: 215, align: "right" });

  const bas = Math.max(doc.y, 110) + 8;
  doc.moveTo(MARGE, bas).lineTo(555, bas).lineWidth(1.5).strokeColor(NOIR).stroke();
  doc.y = bas + 14;
}

/** Deux colonnes de « libellé : valeur », pour l'identité du bon. */
function blocInfos(doc, lignes) {
  const depart = doc.y;
  const colonne = (entrees, x) => {
    let y = depart;
    for (const [libelle, valeur] of entrees) {
      doc.font("Helvetica").fontSize(9).fillColor(GRIS).text(`${libelle}`, x, y, { width: 240 });
      y = doc.y;
      doc.font("Helvetica-Bold").fontSize(10).fillColor(NOIR)
         .text(valeur === null || valeur === undefined || valeur === "" ? "—" : String(valeur),
               x, y, { width: 240 });
      y = doc.y + 6;
    }
    return y;
  };
  const milieu = Math.ceil(lignes.length / 2);
  const gauche = colonne(lignes.slice(0, milieu), MARGE);
  const droite = colonne(lignes.slice(milieu), 305);
  doc.y = Math.max(gauche, droite) + 6;
}

function tableau(doc, colonnes, lignes) {
  const largeurTotale = 515;
  const xDe = (i) => MARGE + colonnes.slice(0, i).reduce((t, c) => t + c.largeur, 0);

  doc.rect(MARGE, doc.y, largeurTotale, 20).fillColor("#eeeeee").fill();
  let y = doc.y + 6;
  colonnes.forEach((c, i) => {
    doc.font("Helvetica-Bold").fontSize(9).fillColor(NOIR)
       .text(c.titre, xDe(i) + 4, y, { width: c.largeur - 8, align: c.align || "left" });
  });
  doc.y += 20;

  for (const ligne of lignes) {
    /* Une page pleine : on continue sur la suivante plutôt que d'écrire
       par-dessus le pied de page. */
    if (doc.y > 700) {
      doc.addPage();
      doc.y = MARGE;
    }
    const hauteur = 18;
    y = doc.y + 5;
    colonnes.forEach((c, i) => {
      doc.font("Helvetica").fontSize(9).fillColor(NOIR)
         .text(String(ligne[c.cle] ?? "—"), xDe(i) + 4, y,
               { width: c.largeur - 8, align: c.align || "left", lineBreak: false });
    });
    doc.y += hauteur;
    doc.moveTo(MARGE, doc.y).lineTo(MARGE + largeurTotale, doc.y)
       .lineWidth(0.5).strokeColor("#cccccc").stroke();
  }
  doc.y += 10;
}

/**
 * Le bloc des signatures.
 *
 * « Livré par » porte un NOM quand on le connaît. Une ligne vide obligeait à
 * l'écrire à la main sur chaque exemplaire — ou à ne rien écrire, ce qui
 * revient à ne pas savoir qui a livré.
 */
function signatures(doc, { recuPar, livrePar }) {
  const y = Math.max(doc.y + 30, 640);
  const largeur = 220;

  const bloc = (titre, nom, x) => {
    doc.moveTo(x, y).lineTo(x + largeur, y).lineWidth(1).strokeColor(NOIR).stroke();
    doc.font("Helvetica-Bold").fontSize(10).fillColor(NOIR)
       .text(titre, x, y + 6, { width: largeur, align: "center" });
    doc.font("Helvetica").fontSize(10).fillColor(NOIR)
       .text(nom || "____________________", x, doc.y + 2, { width: largeur, align: "center" });
  };

  bloc("Reçu par", recuPar, MARGE);
  bloc("Livré par", livrePar, 555 - largeur);
}

function filigraneAnnule(doc) {
  doc.save();
  doc.rotate(-35, { origin: [300, 400] });
  doc.font("Helvetica-Bold").fontSize(90).fillColor("#d40000").opacity(0.18)
     .text("ANNULÉ", 60, 340, { width: 500, align: "center" });
  doc.restore();
  doc.opacity(1);
}

/**
 * Fabrique le PDF d'un bon de livraison.
 *
 * @param {object} bon
 * @param {string} bon.titre        « BON DE LIVRAISON », « BON DE SORTIE »…
 * @param {string} bon.numero
 * @param {object} bon.societe      { nom, adresse, telephone, email }
 * @param {Array}  bon.infos        [[libellé, valeur], …]
 * @param {Array}  bon.colonnes     [{ cle, titre, largeur, align }]
 * @param {Array}  bon.lignes
 * @param {string} [bon.total]
 * @param {string} [bon.observation]
 * @param {string} [bon.recuPar]
 * @param {string} [bon.livrePar]
 * @param {boolean}[bon.annule]
 * @returns {Promise<Buffer>}
 */
function genererPdfBonLivraison(bon) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: MARGE, autoFirstPage: true });
      const morceaux = [];
      doc.on("data", (c) => morceaux.push(c));
      doc.on("end", () => resolve(Buffer.concat(morceaux)));
      doc.on("error", reject);

      if (bon.annule) filigraneAnnule(doc);

      enTete(doc, { societe: bon.societe || {}, titre: bon.titre, numero: bon.numero });
      blocInfos(doc, bon.infos || []);

      if ((bon.lignes || []).length) {
        tableau(doc, bon.colonnes || [], bon.lignes || []);
      }

      if (bon.total) {
        doc.font("Helvetica-Bold").fontSize(12).fillColor(NOIR)
           .text(`Total : ${bon.total}`, MARGE, doc.y, { width: 515, align: "right" });
        doc.y += 10;
      }

      if (bon.observation && String(bon.observation).trim()) {
        doc.font("Helvetica-Bold").fontSize(9).fillColor(GRIS).text("Observation", MARGE, doc.y);
        doc.font("Helvetica").fontSize(10).fillColor(NOIR)
           .text(String(bon.observation).trim(), MARGE, doc.y + 2, { width: 515 });
      }

      if (bon.annule) {
        doc.font("Helvetica-Bold").fontSize(11).fillColor("#b00000")
           .text("Ce bon est ANNULÉ.", MARGE, doc.y + 14, { width: 515 });
        if (bon.motifAnnulation) {
          doc.font("Helvetica").fontSize(9).fillColor("#b00000")
             .text(`Motif : ${bon.motifAnnulation}`, { width: 515 });
        }
      }

      signatures(doc, { recuPar: bon.recuPar, livrePar: bon.livrePar });

      doc.font("Helvetica").fontSize(7).fillColor(GRIS)
         .text(`Édité le ${new Date().toLocaleString("fr-FR", { timeZone: "Africa/Bamako" })}`,
               MARGE, 780, { width: 515, align: "center" });

      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { genererPdfBonLivraison, nomFichier, fcfa, jour };

"use strict";

/**
 * L'ÉTAT DE FACTURES, EN PDF.
 *
 * Un tableau, un total, et de quoi reconnaître la pièce six mois plus tard :
 * le numéro de l'état, la société, la période, qui l'a validé et quand.
 *
 * TROIS CHOSES QUE CE DOCUMENT DOIT DIRE SANS QU'ON LES CHERCHE.
 *
 * 1. SON STATUT. Un brouillon porte « BROUILLON » en travers : personne ne
 *    doit pouvoir le confondre avec un état validé en le sortant d'un tiroir.
 *    Un état annulé ou remplacé le dit aussi, et nomme son successeur.
 *
 * 2. S'IL S'AGIT D'UNE RÉIMPRESSION. La première impression et la dixième ne
 *    sont pas le même document entre les mains d'un client. Le pied porte le
 *    rang de l'impression.
 *
 * 3. CE QUI N'EST PAS RAPPROCHÉ. Une ligne reprise d'un vieil état dont la
 *    facture n'a pas été retrouvée est marquée. L'état ne fait pas semblant
 *    d'être complet.
 *
 * Les en-têtes, pieds et pages tamponnées viennent de pdf-documents-rh : le
 * mécanisme est délicat (un pied écrit sous la marge basse fait ajouter une
 * page par pdfkit, et chaque page ajoutée réécrit un pied) et n'a pas à
 * exister deux fois.
 */

const { rendre, habiller, RESERVE_ENTETE, fcfa, jour } = require("./pdf-documents-rh");
const { nombreFr, texteSur } = require("./format-pdf");

const NOIR = "#000000";
const GRIS = "#555555";
const GRIS_CLAIR = "#AAAAAA";
const ROUGE = "#B00020";
const FOND = "#F2F2F2";

const txt = (v, defaut = "—") => {
  const s = texteSur(v).trim();
  return s || defaut;
};

const LIBELLE_STATUT = {
  BROUILLON: "BROUILLON — NON VALIDÉ",
  VALIDE: "",
  ANNULE: "ÉTAT ANNULÉ",
  REMPLACE: "ÉTAT REMPLACÉ",
};

/* Les colonnes, et leur largeur en points.
   A4 fait 595,28 points ; moins deux marges de 40, il reste 515,28 points
   utiles. La somme des largeurs doit tenir dans ce budget : la première
   version totalisait 562, et la colonne « Restant » sortait de la feuille —
   son titre s'imprimait « Restan » et ses montants étaient rognés. Le
   contrôle LARGEUR_UTILE ci-dessous échoue au chargement du module plutôt
   que sur un document déjà remis. */
/* Les montants s'écrivent SANS « FCFA » dans les cellules : la devise est
   dite une fois, dans le titre de la colonne. « 18 000 000 FCFA » en gras à
   8,5 points demande environ 70 points ; dans une colonne de 64 il passait à
   la ligne, et le total s'affichait sur deux lignes au milieu d'un tableau. */
const COLONNES = [
  { cle: "numero", titre: "Facture", largeur: 72 },
  { cle: "date", titre: "Date", largeur: 52 },
  { cle: "client", titre: "Client", largeur: 131 },
  { cle: "site", titre: "Site", largeur: 70, titre2: "" },
  { cle: "montant", titre: "Montant", titre2: "FCFA", largeur: 64, droite: true },
  { cle: "paye", titre: "Payé", titre2: "FCFA", largeur: 60, droite: true },
  { cle: "restant", titre: "Restant", titre2: "FCFA", largeur: 66, droite: true },
];

const MARGE_LATERALE = 40;
const LARGEUR_UTILE = 595.28 - 2 * MARGE_LATERALE;
const LARGEUR_TABLEAU = COLONNES.reduce((s, c) => s + c.largeur, 0);
if (LARGEUR_TABLEAU > LARGEUR_UTILE) {
  throw new Error(
    `Les colonnes de l'état totalisent ${LARGEUR_TABLEAU} points pour ${Math.floor(LARGEUR_UTILE)} disponibles : la dernière sortirait de la page.`);
}

/** Les x de chaque colonne, cumulés — jamais recalculés à la main. */
function abscisses(gauche) {
  const xs = [];
  let x = gauche;
  for (const c of COLONNES) { xs.push(x); x += c.largeur; }
  return xs;
}

function bandeauStatut(doc, etat) {
  const libelle = LIBELLE_STATUT[etat.status] || "";
  if (!libelle) return;
  const gauche = doc.page.margins.left;
  const largeur = doc.page.width - gauche - doc.page.margins.right;
  doc.save();
  doc.rect(gauche, doc.y, largeur, 20).fill(etat.status === "BROUILLON" ? "#FFF4E5" : "#FDE7EA");
  doc.fillColor(ROUGE).font("Helvetica-Bold").fontSize(10);
  let message = libelle;
  if (etat.status === "REMPLACE" && etat.remplace_par_numero) {
    message = `${libelle} — repris par l'état ${etat.remplace_par_numero}`;
  } else if (etat.status === "ANNULE" && etat.cancel_reason) {
    message = `${libelle} — ${etat.cancel_reason}`;
  }
  doc.text(texteSur(message), gauche + 8, doc.y + 6, { width: largeur - 16, lineBreak: false });
  doc.restore();
  doc.y += 28;
}

function enTeteEtat(doc, { etat, entreprise, produitLibelle }) {
  const gauche = doc.page.margins.left;
  const largeur = doc.page.width - gauche - doc.page.margins.right;

  doc.font("Helvetica-Bold").fontSize(13).fillColor(NOIR);
  doc.text(texteSur(`ÉTAT DE FACTURES — ${produitLibelle.toUpperCase()}`), gauche, doc.y, {
    width: largeur, align: "center",
  });
  doc.moveDown(0.2);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(NOIR);
  doc.text(texteSur(etat.statement_number), { width: largeur, align: "center" });
  if (txt(etat.title, "") !== "—" && String(etat.title || "").trim()) {
    doc.moveDown(0.1);
    doc.font("Helvetica").fontSize(9).fillColor(GRIS);
    doc.text(texteSur(etat.title), { width: largeur, align: "center" });
  }
  doc.moveDown(0.6);
  doc.fillColor(NOIR);

  bandeauStatut(doc, etat);

  /* Deux colonnes d'informations : ce qui identifie la pièce à gauche, ce qui
     la date et l'autorise à droite. */
  const y0 = doc.y;
  const colonne = (largeur / 2) - 6;
  const lignes = [
    ["Société", txt(entreprise?.name)],
    ["Période", etat.period_from || etat.period_to
      ? `${etat.period_from ? jour(etat.period_from) : "…"} au ${etat.period_to ? jour(etat.period_to) : "…"}`
      : "non précisée"],
    ["Factures", `${nombreFr(etat.invoices_count || 0)}`],
  ];
  const droites = [
    ["Établi par", txt(etat.created_by_name)],
    ["Établi le", jour(etat.created_at)],
    etat.status === "VALIDE" || etat.validated_at
      ? ["Validé par", `${txt(etat.validated_by_name)} le ${jour(etat.validated_at)}`]
      : ["Validation", "non validé"],
  ];
  if (etat.origin === "HISTORIQUE") {
    lignes.push(["Repris de", txt(etat.historical_reference)]);
  }
  if (etat.replaces_statement_id && etat.remplace_numero) {
    droites.push(["Remplace", txt(etat.remplace_numero)]);
  }

  doc.fontSize(8.5);
  let y = y0;
  for (const [cle, valeur] of lignes) {
    doc.font("Helvetica-Bold").fillColor(GRIS).text(`${cle} : `, gauche, y, { continued: true, lineBreak: false });
    doc.font("Helvetica").fillColor(NOIR).text(texteSur(valeur), { lineBreak: false });
    y += 13;
  }
  let yd = y0;
  for (const [cle, valeur] of droites) {
    doc.font("Helvetica-Bold").fillColor(GRIS).text(`${cle} : `, gauche + colonne + 12, yd, { continued: true, lineBreak: false });
    doc.font("Helvetica").fillColor(NOIR).text(texteSur(valeur), { lineBreak: false });
    yd += 13;
  }
  doc.y = Math.max(y, yd) + 8;
  doc.fillColor(NOIR);
}

/* UNE RÈGLE POUR TOUT CE FICHIER : on fixe `y` au début de la ligne, on écrit
   chaque colonne À CE y, puis on avance `y` d'une hauteur décidée.
   Sans cela, chaque `doc.text` avec un y explicite repositionne `doc.y` après
   son propre texte : les sept colonnes d'une ligne faisaient descendre le
   curseur sept fois, les lignes dérivaient, et une ligne pouvait se trouver
   coupée en deux pages — la moitié des montants d'un côté, la moitié de
   l'autre. */
function enTeteTableau(doc) {
  const gauche = doc.page.margins.left;
  const largeur = LARGEUR_TABLEAU;
  const xs = abscisses(gauche);
  const y = doc.y;
  const hauteur = 20;
  doc.save();
  doc.rect(gauche, y - 2, largeur, hauteur).fill(FOND);
  doc.restore();
  doc.font("Helvetica-Bold").fontSize(8).fillColor(NOIR);
  COLONNES.forEach((c, i) => {
    doc.text(c.titre, xs[i] + 3, y + 2, {
      width: c.largeur - 6, align: c.droite ? "right" : "left", lineBreak: false,
    });
    if (c.titre2) {
      doc.font("Helvetica").fontSize(6).fillColor(GRIS);
      doc.text(c.titre2, xs[i] + 3, y + 11, {
        width: c.largeur - 6, align: c.droite ? "right" : "left", lineBreak: false,
      });
      doc.font("Helvetica-Bold").fontSize(8).fillColor(NOIR);
    }
  });
  doc.y = y + hauteur;
  doc.moveTo(gauche, doc.y - 1).lineTo(gauche + largeur, doc.y - 1)
    .lineWidth(0.5).strokeColor(GRIS_CLAIR).stroke();
}

function ligneTableau(doc, ligne, paire) {
  const gauche = doc.page.margins.left;
  const xs = abscisses(gauche);
  const hauteur = 13;
  const y = doc.y;

  if (paire) {
    doc.save();
    doc.rect(gauche, y - 1.5, LARGEUR_TABLEAU, hauteur).fill("#FAFAFA");
    doc.restore();
  }
  const valeurs = {
    /* L'astérisque, et non une mention écrite dans la marge : à droite du
       tableau il n'y a plus de page. La note de bas de tableau l'explique. */
    numero: (ligne.reconciled === false ? "* " : "") + txt(ligne.invoice_number),
    date: ligne.invoice_date ? jour(ligne.invoice_date) : "—",
    client: txt(ligne.client_name, ""),
    site: txt(ligne.site, ""),
    montant: nombreFr(ligne.total_amount),
    paye: nombreFr(ligne.paid_amount),
    restant: nombreFr(ligne.remaining_amount),
  };
  doc.font("Helvetica").fontSize(8).fillColor(ligne.reconciled === false ? ROUGE : NOIR);
  COLONNES.forEach((c, i) => {
    doc.text(valeurs[c.cle], xs[i] + 3, y, {
      width: c.largeur - 6, align: c.droite ? "right" : "left",
      lineBreak: false, ellipsis: true,
    });
  });
  doc.y = y + hauteur;
  doc.fillColor(NOIR);
}

function totaux(doc, etat) {
  const gauche = doc.page.margins.left;
  const xs = abscisses(gauche);
  doc.moveTo(gauche, doc.y).lineTo(gauche + LARGEUR_TABLEAU, doc.y)
    .lineWidth(0.8).strokeColor(NOIR).stroke();
  const y = doc.y + 4;
  const hauteur = 17;
  doc.save();
  doc.rect(gauche, y - 2, LARGEUR_TABLEAU, hauteur).fill(FOND);
  doc.restore();
  doc.font("Helvetica-Bold").fontSize(8.5).fillColor(NOIR);
  const largeurLibelle = COLONNES.slice(0, 4).reduce((s, c) => s + c.largeur, 0) - 6;
  doc.text(`TOTAL — ${nombreFr(etat.invoices_count || 0)} facture(s)`,
    xs[0] + 3, y + 3, { width: largeurLibelle, lineBreak: false });
  doc.text(nombreFr(etat.total_invoiced), xs[4] + 3, y + 3, { width: COLONNES[4].largeur - 6, align: "right", lineBreak: false });
  doc.text(nombreFr(etat.total_paid), xs[5] + 3, y + 3, { width: COLONNES[5].largeur - 6, align: "right", lineBreak: false });
  doc.text(nombreFr(etat.total_remaining), xs[6] + 3, y + 3, { width: COLONNES[6].largeur - 6, align: "right", lineBreak: false });
  doc.y = y + hauteur + 6;
}

/**
 * @param {object} p
 * @param {object} p.etat        la ligne invoice_statements, enrichie des
 *                               numéros remplace_numero / remplace_par_numero
 * @param {Array}  p.lignes      invoice_statement_lines, dans l'ordre
 * @param {object} p.entreprise  { name, logo_path, address, phone, email, … }
 * @param {string} p.produitLibelle « Sable » ou « Ciment »
 * @param {number} p.impression  le rang de cette impression (1 = la première)
 */
function etatDeFactures({ etat, lignes = [], entreprise = {}, produitLibelle = "", impression = 1 }) {
  const reference = `${etat.statement_number}${impression > 1 ? ` — réimpression n° ${impression}` : ""}`;
  const infos = { entreprise, titre: `État de factures ${produitLibelle}`, reference };

  return rendre((doc) => {
    doc.y = doc.page.margins.top + RESERVE_ENTETE;
    enTeteEtat(doc, { etat, entreprise, produitLibelle });
    enTeteTableau(doc);

    let paire = false;
    for (const ligne of lignes) {
      /* Place pour la ligne, et pour le bloc de totaux s'il s'agit de la
         dernière : couper juste avant le total laisserait une page orpheline
         ne portant qu'un chiffre. */
      if (doc.page.height - doc.page.margins.bottom - doc.y < 40) {
        doc.addPage();
        doc.y = doc.page.margins.top + RESERVE_ENTETE;
        enTeteTableau(doc);
        paire = false;
      }
      ligneTableau(doc, ligne, paire);
      paire = !paire;
    }

    if (doc.page.height - doc.page.margins.bottom - doc.y < 60) {
      doc.addPage();
      doc.y = doc.page.margins.top + RESERVE_ENTETE;
    }
    totaux(doc, etat);

    const nonRapprochees = lignes.filter((l) => l.reconciled === false).length;
    if (nonRapprochees) {
      doc.font("Helvetica").fontSize(7.5).fillColor(ROUGE);
      doc.text(texteSur(
        `* ${nonRapprochees} ligne(s) reprise(s) d'un état antérieur n'ont pas été retrouvées parmi les factures enregistrées. Leurs montants ne sont pas comptés dans le total.`),
      doc.page.margins.left, doc.y,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
      doc.moveDown(0.5);
      doc.fillColor(NOIR);
    }

    if (String(etat.notes || "").trim()) {
      doc.font("Helvetica-Bold").fontSize(8).fillColor(GRIS).text("Observations", { continued: false });
      doc.font("Helvetica").fontSize(8).fillColor(NOIR).text(texteSur(etat.notes), {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      });
      doc.moveDown(0.5);
    }

    /* La signature : un état remis se signe. On réserve la place, on
       n'imprime pas un nom à la place de celui qui signera. */
    if (doc.page.height - doc.page.margins.bottom - doc.y < 90) {
      doc.addPage();
      doc.y = doc.page.margins.top + RESERVE_ENTETE;
    }
    doc.moveDown(1.2);
    const droite = doc.page.width - doc.page.margins.right;
    doc.font("Helvetica").fontSize(8).fillColor(GRIS);
    doc.text("Le responsable", droite - 170, doc.y, { width: 170, align: "center", lineBreak: false });
    doc.moveTo(droite - 170, doc.y + 42).lineTo(droite - 10, doc.y + 42)
      .lineWidth(0.5).strokeColor(GRIS_CLAIR).stroke();

    habiller(doc, infos);
  }, { size: "A4", margins: { top: 46, bottom: 46, left: MARGE_LATERALE, right: MARGE_LATERALE } });
}

module.exports = { etatDeFactures, COLONNES, LARGEUR_TABLEAU, LARGEUR_UTILE };

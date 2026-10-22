"use strict";

/**
 * LES DOCUMENTS DU PERSONNEL, EN PDF.
 *
 * Contrat CDI ou CDD, bulletin de salaire, attestation de travail, certificat
 * de travail, attestation de stage ou de formation, et diplôme en paysage.
 *
 * Même choix que pour les bons de livraison : pdfkit, pas un navigateur sans
 * tête. Éditer un contrat ne doit pas dépendre d'un Chromium installé sur le
 * serveur, ni échouer au moment précis où quelqu'un attend sa pièce.
 *
 * TROIS RÈGLES D'IMPRESSION
 *
 * 1. ON N'AFFIRME JAMAIS QU'UNE ANNEXE A ÉTÉ REMISE.
 *    Le règlement intérieur n'est mentionné comme annexe que s'il est
 *    réellement joint. Sinon, la clause dit « lorsqu'il existe et lui a été
 *    communiqué », et rien de plus.
 *
 * 2. UNE CLAUSE NON VALIDÉE PAR UN JURISTE LE DIT.
 *    Un bandeau le signale, en toutes lettres, sur le document lui-même.
 *
 * 3. UN BULLETIN INCOMPLET N'AFFICHE AUCUN NET.
 *    Si un taux manque, la case du net porte « non calculé » et le motif.
 *    Un net faux a l'air juste.
 */

const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const NOIR = "#000000";
const GRIS = "#555555";
const GRIS_CLAIR = "#999999";
const OR = "#B8860B";
const ROUGE = "#B00020";

/* Le séparateur de milliers français est une espace FINE INSÉCABLE que les
   polices standard de pdfkit ne savent pas encoder : « 450 /000 FCFA » sur un
   contrat signé. Le formateur partagé la remplace. */
const { fcfa, nombreFr } = require("./format-pdf");
const jour = (v) => {
  if (!v) return "—";
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
  return d.toLocaleDateString("fr-FR", { timeZone: "Africa/Bamako" });
};
const txt = (v, defaut = "—") => {
  const s = String(v ?? "").trim();
  return s || defaut;
};

/** Le logo de l'entreprise, s'il existe réellement sur le disque. */
function logoDe(entreprise) {
  const candidats = [
    entreprise?.logo_path,
    entreprise?.logo_url && entreprise.logo_url.startsWith("/")
      ? path.join(__dirname, "..", entreprise.logo_url) : null,
    path.join(__dirname, "..", "uploads", "logo.png"),
  ].filter(Boolean);
  for (const c of candidats) {
    try { if (fs.existsSync(c) && fs.statSync(c).size > 0) return c; } catch { /* ignoré */ }
  }
  return null;
}

/* ════════════════════════════════════════════════════════ EN-TÊTE / PIED ══ */

/**
 * L'en-tête, posé sur CHAQUE page. Une page de contrat sans en-tête se
 * détache du reste et ne prouve plus rien.
 */
function entete(doc, { entreprise, titre, reference }) {
  const logo = logoDe(entreprise);
  const haut = doc.page.margins.top;
  if (logo) {
    try { doc.image(logo, doc.page.margins.left, haut - 8, { fit: [90, 42] }); } catch { /* ignoré */ }
  }
  const x = doc.page.margins.left + (logo ? 104 : 0);
  /* `lineBreak: false` et des positions explicites : un en-tête qui déborde
     ajouterait une page, qui redéclencherait l'en-tête. */
  doc.font("Helvetica-Bold").fontSize(13).fillColor(NOIR)
     .text(txt(entreprise?.name, "Entreprise"), x, haut - 4, { width: 300, lineBreak: false });
  doc.font("Helvetica").fontSize(8).fillColor(GRIS);
  const coordonnees = [entreprise?.address, entreprise?.phone, entreprise?.email]
    .map((v) => txt(v, "")).filter(Boolean).join(" · ");
  if (coordonnees) doc.text(coordonnees, x, haut + 14, { width: 300, lineBreak: false });

  const droite = doc.page.width - doc.page.margins.right;
  doc.font("Helvetica-Bold").fontSize(10).fillColor(NOIR)
     .text(titre, droite - 220, haut - 4, { width: 220, align: "right", lineBreak: false });
  doc.font("Helvetica").fontSize(8).fillColor(GRIS)
     .text(`Réf. ${txt(reference)}`, droite - 220, haut + 12, { width: 220, align: "right", lineBreak: false });

  const y = haut + 38;
  doc.moveTo(doc.page.margins.left, y).lineTo(droite, y).lineWidth(0.8).strokeColor(NOIR).stroke();
  doc.fillColor(NOIR);
}

/**
 * Le pied, posé sur chaque page, avec sa pagination.
 *
 * Il s'écrit SOUS la marge basse — c'est tout l'intérêt d'un pied de page.
 * Or pdfkit, voyant du texte franchir cette limite, ajoutait une page pour
 * l'y mettre : chaque pied engendrait une page, qui engendrait un pied. Un
 * certificat d'une page en faisait trois, la dernière ne portant que « Page
 * 1 / 1 ». On neutralise donc la marge le temps de dessiner, et on la
 * remet aussitôt. */
function pied(doc, { entreprise, reference, page, total }) {
  const marge = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  try {
    const bas = doc.page.height - marge + 12;
    const gauche = doc.page.margins.left;
    const droite = doc.page.width - doc.page.margins.right;
    doc.moveTo(gauche, bas - 6).lineTo(droite, bas - 6).lineWidth(0.4).strokeColor(GRIS_CLAIR).stroke();
    doc.font("Helvetica").fontSize(7).fillColor(GRIS);
    doc.text(`${txt(entreprise?.name, "")} — ${txt(reference)}`, gauche, bas, {
      width: droite - gauche - 70, lineBreak: false,
    });
    doc.text(total ? `Page ${page} / ${total}` : `Page ${page}`, droite - 70, bas, {
      width: 70, align: "right", lineBreak: false,
    });
  } finally {
    doc.page.margins.bottom = marge;
  }
}

/**
 * Rend un document, en-têtes et pieds posés À LA FIN sur toutes les pages.
 *
 * La méthode évidente — poser l'en-tête sur l'événement `pageAdded` — part en
 * récursion infinie : écrire l'en-tête peut déborder, ce qui ajoute une page,
 * ce qui redéclenche l'en-tête. Les pages tamponnées évitent le problème
 * entièrement, et donnent le nombre exact de pages en une seule passe : plus
 * de « Page 1 / ? » sur un contrat dont on pourrait retirer une feuille.
 */
function rendre(construire, options) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ ...options, bufferPages: true });
    const morceaux = [];
    doc.on("data", (c) => morceaux.push(c));
    doc.on("end", () => resolve(Buffer.concat(morceaux)));
    doc.on("error", reject);
    try {
      construire(doc);
      doc.flushPages();
    } catch (e) { return reject(e); }
    doc.end();
  });
}

/**
 * LE FILIGRANE D'UN APERÇU.
 *
 * Un aperçu imprimé puis posé sur un bureau ne doit pas pouvoir passer pour
 * la pièce elle-même. La mention traverse la page en diagonale, en gris
 * clair, sous le texte : elle se voit à l'œil et ne gêne pas la lecture.
 *
 * On sauvegarde et restaure l'état graphique : sans cela, la rotation et la
 * couleur resteraient actives pour tout ce qui serait écrit ensuite.
 */
function filigrane(doc, texte = "APERÇU — NON ÉMIS") {
  doc.save();
  const cx = doc.page.width / 2;
  const cy = doc.page.height / 2;
  doc.rotate(-38, { origin: [cx, cy] });
  doc.font("Helvetica-Bold").fontSize(46).fillColor("#000000").opacity(0.09);
  doc.text(texte, cx - 320, cy - 28, { width: 640, align: "center", lineBreak: false });
  doc.opacity(1);
  doc.restore();
}

/**
 * Pose en-tête et pied sur chaque page déjà écrite. À appeler en dernier,
 * une fois tout le contenu posé.
 */
function habiller(doc, infos) {
  const { start, count } = doc.bufferedPageRange();
  for (let i = 0; i < count; i += 1) {
    doc.switchToPage(start + i);
    entete(doc, infos);
    pied(doc, { ...infos, page: i + 1, total: count });
    /* Le filigrane en dernier, sur chaque page : une page sans mention
       suffirait à faire prendre l'aperçu pour la pièce. */
    if (infos.apercu) filigrane(doc);
  }
}

/** La marge haute réservée à l'en-tête, que le contenu ne doit pas occuper. */
const RESERVE_ENTETE = 52;

/* ═══════════════════════════════════════════════════════════ CONTRAT ══ */

function contrat({ entreprise, salarie, contrat: c, clauses = [], annexes = [], apercu = false }) {
  const estCDD = c.contract_type === "CDD";
  const titre = estCDD ? "CONTRAT À DURÉE DÉTERMINÉE" : "CONTRAT À DURÉE INDÉTERMINÉE";
  const infos = { entreprise, titre, reference: c.reference, apercu };
  const aValider = clauses.filter((cl) => cl.requires_legal_validation);

  return rendre((doc) => {
    const L = doc.page.margins.left;
    const large = doc.page.width - L - doc.page.margins.right;
    doc.y = doc.page.margins.top + RESERVE_ENTETE;

    doc.font("Helvetica-Bold").fontSize(16).fillColor(NOIR)
       .text(titre, L, doc.y, { width: large, align: "center" });
    doc.moveDown(1);

    /* ── Les parties ── */
    doc.font("Helvetica-Bold").fontSize(10).text("ENTRE LES SOUSSIGNÉS", L, doc.y);
    doc.moveDown(0.4);
    doc.font("Helvetica").fontSize(9).fillColor(NOIR);
    doc.text(`${txt(entreprise?.name, "L'entreprise")}, ci-après dénommée « l'employeur »,`
      + `${entreprise?.address ? ` dont le siège est situé ${entreprise.address},` : ""}`
      + ` représentée par ${txt(entreprise?.manager || entreprise?.representative, "son représentant légal")}.`,
      { width: large, align: "justify" });
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").text("ET", L, doc.y);
    doc.moveDown(0.3);
    doc.font("Helvetica").text(
      `${txt(salarie?.full_name)}, ci-après dénommé(e) « le salarié »`
      + `${salarie?.employee_number ? `, matricule ${salarie.employee_number}` : ""}.`,
      { width: large, align: "justify" });
    doc.moveDown(1);

    /* ── Les conditions particulières ── */
    doc.font("Helvetica-Bold").fontSize(10).text("CONDITIONS PARTICULIÈRES", L, doc.y);
    doc.moveDown(0.5);

    const lignes = [
      ["Fonction", txt(c.job_title)],
      ["Lieu de travail", txt(c.site_label)],
      ["Date de prise de fonction", jour(c.start_date)],
    ];
    if (estCDD) {
      lignes.push(["Date de fin", jour(c.end_date)]);
      lignes.push(["Motif du recours", txt(c.cdd_reason)]);
    }
    if (c.trial_period_days != null) {
      lignes.push(["Période d'essai", `${c.trial_period_days} jour(s)`]);
    }
    if (c.weekly_hours != null) {
      lignes.push(["Durée hebdomadaire", `${Number(c.weekly_hours)} heures`]);
    }
    if (c.gross_salary != null) {
      lignes.push(["Rémunération brute mensuelle", fcfa(c.gross_salary)]);
    }

    const colonne = 190;
    for (const [etiquette, valeur] of lignes) {
      const y = doc.y;
      doc.font("Helvetica").fontSize(9).fillColor(GRIS).text(etiquette, L, y, { width: colonne - 8 });
      doc.font("Helvetica-Bold").fillColor(NOIR)
         .text(valeur, L + colonne, y, { width: large - colonne });
      doc.moveDown(0.25);
    }
    doc.moveDown(0.8);

    /* ── Les articles, numérotés en continu ── */
    doc.font("Helvetica-Bold").fontSize(10).fillColor(NOIR)
       .text("DISPOSITIONS GÉNÉRALES", L, doc.y);
    doc.moveDown(0.5);

    const applicables = clauses
      .filter((cl) => !cl.applies_to || cl.applies_to.includes(c.contract_type))
      .sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999));

    applicables.forEach((cl, i) => {
      /* Un article ne doit pas être coupé juste après son titre : on vérifie
         qu'il reste de quoi écrire au moins trois lignes. */
      const restant = doc.page.height - doc.page.margins.bottom - doc.y;
      if (restant < 60) doc.addPage();

      doc.font("Helvetica-Bold").fontSize(9).fillColor(NOIR)
         .text(`Article ${i + 1} — ${txt(cl.title)}`, L, doc.y, { width: large });
      doc.moveDown(0.2);
      doc.font("Helvetica").fontSize(9).fillColor(NOIR)
         .text(txt(cl.body), L, doc.y, { width: large, align: "justify" });
      if (cl.legal_reference) {
        doc.font("Helvetica-Oblique").fontSize(7).fillColor(GRIS)
           .text(txt(cl.legal_reference), L, doc.y, { width: large });
      }
      doc.moveDown(0.6);
    });

    /* ── Les annexes : jamais affirmées sans être jointes ── */
    if (annexes.length) {
      if (doc.page.height - doc.page.margins.bottom - doc.y < 80) doc.addPage();
      doc.font("Helvetica-Bold").fontSize(9).fillColor(NOIR).text("ANNEXES", L, doc.y);
      doc.moveDown(0.3);
      doc.font("Helvetica").fontSize(9);
      annexes.forEach((a, i) => doc.text(`${i + 1}. ${txt(a.titre || a)}`, L, doc.y, { width: large }));
      doc.moveDown(0.6);
    }

    /* ── Les signatures, équilibrées, et jamais seules sur leur page ── */
    const besoin = 150 + (aValider.length ? 44 : 0);
    if (doc.page.height - doc.page.margins.bottom - doc.y < besoin) doc.addPage();
    doc.moveDown(1);

    doc.font("Helvetica").fontSize(9).fillColor(NOIR).text(
      `Fait à ${txt(c.signed_place, "……………………")}, le ${c.signed_at ? jour(c.signed_at) : "……………………"},`
      + " en deux exemplaires originaux, dont un remis à chaque partie.",
      L, doc.y, { width: large });
    doc.moveDown(1.6);

    const colonneLarge = (large - 40) / 2;
    const yS = doc.y;
    for (const [i, qui] of [["L'employeur"], ["Le salarié"]].entries()) {
      const x = L + i * (colonneLarge + 40);
      doc.font("Helvetica-Bold").fontSize(9).fillColor(NOIR).text(qui[0], x, yS, { width: colonneLarge });
      doc.font("Helvetica-Oblique").fontSize(7).fillColor(GRIS)
         .text("(signature précédée de la mention « lu et approuvé »)", x, yS + 13,
               { width: colonneLarge });
      doc.moveTo(x, yS + 78).lineTo(x + colonneLarge, yS + 78)
         .lineWidth(0.6).strokeColor(GRIS).stroke();
    }
    doc.y = yS + 92;

    /* ── Ce que le logiciel ne garantit pas ── */
    if (aValider.length) {
      doc.rect(L, doc.y, large, 34).lineWidth(0.8).strokeColor(ROUGE).stroke();
      doc.font("Helvetica-Bold").fontSize(7.5).fillColor(ROUGE)
         .text("À FAIRE VALIDER PAR UN CONSEIL JURIDIQUE AVANT SIGNATURE", L + 8, doc.y + 6,
               { width: large - 16 });
      doc.font("Helvetica").fontSize(7).fillColor(NOIR).text(
        `${aValider.length} clause(s) de ce modèle n'ont pas été relues par un juriste. `
        + "Le logiciel ne se prononce pas sur leur conformité au droit du travail malien.",
        L + 8, doc.y + 2, { width: large - 16 });
    }

    habiller(doc, infos);
  }, { size: "A4", margins: { top: 56, bottom: 48, left: 48, right: 48 } });
}

/* ══════════════════════════════════════════════════════════ BULLETIN ══ */

function bulletin({ entreprise, salarie, periode, calcul, contrat: c, apercu = false }) {
  const infos = { entreprise, titre: "BULLETIN DE PAIE", reference: `BP-${periode}-${salarie?.employee_number || salarie?.id}`, apercu };

  return rendre((doc) => {
    const L = doc.page.margins.left;
    const large = doc.page.width - L - doc.page.margins.right;
    doc.y = doc.page.margins.top + RESERVE_ENTETE;

    doc.font("Helvetica-Bold").fontSize(14).text("BULLETIN DE PAIE", L, doc.y, { width: large, align: "center" });
    doc.font("Helvetica").fontSize(9).fillColor(GRIS)
       .text(`Période : ${periode}`, L, doc.y + 2, { width: large, align: "center" });
    doc.moveDown(1);

    /* ── Le salarié ── */
    const yI = doc.y;
    doc.font("Helvetica").fontSize(8).fillColor(GRIS).text("Salarié", L, yI);
    doc.font("Helvetica-Bold").fontSize(10).fillColor(NOIR).text(txt(salarie?.full_name), L, doc.y);
    doc.font("Helvetica").fontSize(8).fillColor(GRIS).text(
      [salarie?.employee_number && `Matricule ${salarie.employee_number}`,
       c?.job_title, c?.contract_type].filter(Boolean).join(" · "), L, doc.y, { width: large / 2 });
    doc.y = yI;
    doc.font("Helvetica").fontSize(8).fillColor(GRIS)
       .text("Employeur", L + large / 2, yI, { width: large / 2 });
    doc.font("Helvetica-Bold").fontSize(10).fillColor(NOIR)
       .text(txt(entreprise?.name), L + large / 2, doc.y, { width: large / 2 });
    doc.moveDown(1.2);

    /* ── Le tableau ── */
    const COL = [large * 0.40, large * 0.16, large * 0.11, large * 0.165, large * 0.165];
    /* Les abscisses CUMULÉES. Le calcul précédent repartait de la mauvaise
       case et la colonne « Base » venait se superposer à la désignation :
       « Salaire450 000 FCFA » sur un bulletin remis à un salarié. */
    const X = [];
    COL.reduce((x, largeurColonne) => { X.push(x); return x + largeurColonne; }, L);
    const entetes = ["Désignation", "Base", "Taux", "À déduire", "À payer"];

    const ligneTableau = (cells, gras = false, couleur = NOIR) => {
      const y = doc.y;
      doc.font(gras ? "Helvetica-Bold" : "Helvetica").fontSize(8).fillColor(couleur);
      cells.forEach((c2, i) => {
        /* `ellipsis` plutôt que le débordement : un libellé trop long se
           termine par des points de suspension au lieu d'envahir le montant
           voisin. */
        doc.text(String(c2 ?? ""), X[i] + 3, y + 3, {
          width: COL[i] - 6, align: i === 0 ? "left" : "right",
          lineBreak: false, ellipsis: true,
        });
      });
      doc.y = y + 14;
    };

    doc.rect(L, doc.y, large, 15).fillAndStroke("#EEEEEE", "#CCCCCC");
    doc.fillColor(NOIR);
    ligneTableau(entetes, true);

    ligneTableau(["Salaire de base", fcfa(calcul.brut_base), "", "", fcfa(calcul.brut_base)], true);
    for (const g of calcul.gains) ligneTableau([g.libelle, "", "", "", fcfa(g.montant)]);
    if (calcul.total_gains > 0) {
      ligneTableau(["Brut total", "", "", "", fcfa(calcul.brut_total)], true);
    }

    const salariales = calcul.lignes.filter((l) => l.nature === "RETENUE_SALARIALE");
    if (salariales.length) {
      doc.moveDown(0.2);
      ligneTableau(["Retenues salariales", "", "", "", ""], true, GRIS);
      for (const l of salariales) {
        ligneTableau([`  ${l.libelle} (${l.organisme})`, fcfa(l.base),
          l.taux != null ? `${l.taux} %` : "forfait", fcfa(l.montant), ""]);
      }
    }
    for (const r of calcul.autres_retenues) {
      ligneTableau([`  ${r.libelle}`, "", "", fcfa(r.montant), ""]);
    }

    doc.moveDown(0.3);
    doc.moveTo(L, doc.y).lineTo(L + large, doc.y).lineWidth(0.8).strokeColor(NOIR).stroke();
    doc.moveDown(0.3);

    /* ── LE NET : calculé, ou expressément pas ── */
    if (calcul.complet) {
      ligneTableau(["NET À PAYER", "", "",
        fcfa(calcul.retenues_salariales + calcul.total_autres_retenues),
        fcfa(calcul.net_a_payer)], true);
    } else {
      const y = doc.y;
      doc.rect(L, y, large, 30).lineWidth(1).strokeColor(ROUGE).stroke();
      doc.font("Helvetica-Bold").fontSize(9).fillColor(ROUGE)
         .text("NET À PAYER : NON CALCULÉ", L + 8, y + 5, { width: large - 16 });
      doc.font("Helvetica").fontSize(7).fillColor(NOIR).text(
        `Taux de cotisation non paramétrés : ${calcul.cotisations_manquantes.join(", ")}. `
        + "Ce bulletin ne peut pas être remis en l'état.",
        L + 8, y + 17, { width: large - 16 });
      doc.y = y + 36;
    }

    /* ── Les charges patronales, pour information ── */
    const patronales = calcul.lignes.filter((l) => l.nature === "CHARGE_PATRONALE");
    if (patronales.length) {
      doc.moveDown(0.6);
      doc.font("Helvetica-Bold").fontSize(8).fillColor(GRIS)
         .text("Charges patronales (pour information, non déduites du net)", L, doc.y);
      doc.moveDown(0.2);
      for (const l of patronales) {
        ligneTableau([`  ${l.libelle} (${l.organisme})`, fcfa(l.base),
          l.taux != null ? `${l.taux} %` : "forfait", "", fcfa(l.montant)]);
      }
      if (calcul.cout_employeur != null) {
        ligneTableau(["Coût employeur", "", "", "", fcfa(calcul.cout_employeur)], true, GRIS);
      }
    }

    /* ── D'où viennent les taux ── */
    if (calcul.lignes.length) {
      doc.moveDown(0.8);
      doc.font("Helvetica-Bold").fontSize(7).fillColor(GRIS).text("Références des taux appliqués", L, doc.y);
      doc.font("Helvetica").fontSize(6.5).fillColor(GRIS);
      const vues = new Set();
      for (const l of calcul.lignes) {
        if (vues.has(l.code)) continue;
        vues.add(l.code);
        doc.text(`${l.code} — ${txt(l.reference)}`, L, doc.y, { width: large });
      }
    }

    doc.moveDown(1.2);
    const yS = doc.y;
    doc.font("Helvetica").fontSize(8).fillColor(NOIR)
       .text("L'employeur", L, yS, { width: large / 2 - 20 });
    doc.text("Le salarié", L + large / 2, yS, { width: large / 2 - 20 });
    doc.moveTo(L, yS + 50).lineTo(L + large / 2 - 30, yS + 50).lineWidth(0.6).strokeColor(GRIS).stroke();
    doc.moveTo(L + large / 2, yS + 50).lineTo(L + large - 10, yS + 50).stroke();

    habiller(doc, infos);
  }, { size: "A4", margins: { top: 56, bottom: 48, left: 42, right: 42 } });
}

/* ═════════════════════════════════════════════ ATTESTATIONS ET CERTIFICATS ══ */

const ATTESTATIONS = {
  ATTESTATION_TRAVAIL: {
    titre: "ATTESTATION DE TRAVAIL",
    corps: (d) => `Je soussigné(e), ${txt(d.entreprise?.manager || d.entreprise?.representative, "le représentant légal")}, `
      + `agissant en qualité de représentant de ${txt(d.entreprise?.name)}, atteste que `
      + `${txt(d.salarie?.full_name)}${d.salarie?.employee_number ? `, matricule ${d.salarie.employee_number}` : ""}, `
      + `est employé(e) au sein de notre entreprise depuis le ${jour(d.contrat?.start_date)} `
      + `en qualité de ${txt(d.contrat?.job_title)}`
      + `${d.contrat?.contract_type ? `, dans le cadre d'un contrat ${d.contrat.contract_type}` : ""}.`,
    fin: "La présente attestation est délivrée à l'intéressé(e) pour servir et valoir ce que de droit.",
  },
  CERTIFICAT_TRAVAIL: {
    titre: "CERTIFICAT DE TRAVAIL",
    corps: (d) => `Je soussigné(e), ${txt(d.entreprise?.manager || d.entreprise?.representative, "le représentant légal")}, `
      + `agissant en qualité de représentant de ${txt(d.entreprise?.name)}, certifie que `
      + `${txt(d.salarie?.full_name)} a été employé(e) au sein de notre entreprise `
      + `du ${jour(d.contrat?.start_date)} au ${jour(d.contrat?.ended_at || d.contrat?.end_date)}, `
      + `en qualité de ${txt(d.contrat?.job_title)}.`,
    /* Le certificat de travail est un document de fin de contrat : il ne
       porte aucune appréciation, par principe. */
    fin: "Le présent certificat est délivré à l'intéressé(e) pour servir et valoir ce que de droit, "
      + "libre de tout engagement.",
  },
  ATTESTATION_STAGE: {
    titre: "ATTESTATION DE STAGE",
    corps: (d) => `Je soussigné(e), ${txt(d.entreprise?.manager || d.entreprise?.representative, "le représentant légal")}, `
      + `agissant en qualité de représentant de ${txt(d.entreprise?.name)}, atteste que `
      + `${txt(d.salarie?.full_name)} a effectué un stage au sein de notre entreprise `
      + `du ${jour(d.contrat?.start_date)} au ${jour(d.contrat?.end_date)}, `
      + `au service ${txt(d.contrat?.site_label || d.contrat?.job_title)}.`,
    fin: "La présente attestation est délivrée à l'intéressé(e) pour servir et valoir ce que de droit.",
  },
  ATTESTATION_FORMATION: {
    titre: "ATTESTATION DE FORMATION",
    corps: (d) => `Je soussigné(e), ${txt(d.entreprise?.manager || d.entreprise?.representative, "le représentant légal")}, `
      + `agissant en qualité de représentant de ${txt(d.entreprise?.name)}, atteste que `
      + `${txt(d.salarie?.full_name)} a suivi la formation « ${txt(d.formation?.intitule)} » `
      + `du ${jour(d.formation?.du)} au ${jour(d.formation?.au)}`
      + `${d.formation?.duree_heures ? `, soit ${d.formation.duree_heures} heures` : ""}.`,
    fin: "La présente attestation est délivrée à l'intéressé(e) pour servir et valoir ce que de droit.",
  },
};

function attestation(type, donnees) {
  const modele = ATTESTATIONS[type];
  if (!modele) throw new Error(`Type d'attestation inconnu : ${type}`);
  const infos = { entreprise: donnees.entreprise, titre: modele.titre, reference: donnees.reference, apercu: donnees.apercu === true };

  return rendre((doc) => {
    const L = doc.page.margins.left;
    const large = doc.page.width - L - doc.page.margins.right;
    doc.y = doc.page.margins.top + RESERVE_ENTETE;

    doc.moveDown(2);
    doc.font("Helvetica-Bold").fontSize(15).fillColor(NOIR)
       .text(modele.titre, L, doc.y, { width: large, align: "center" });
    doc.moveDown(2.5);

    doc.font("Helvetica").fontSize(10.5).fillColor(NOIR)
       .text(modele.corps(donnees), L, doc.y, { width: large, align: "justify", lineGap: 3 });
    doc.moveDown(1.2);
    doc.text(modele.fin, L, doc.y, { width: large, align: "justify", lineGap: 3 });

    doc.moveDown(3);
    doc.font("Helvetica").fontSize(10)
       .text(`Fait à ${txt(donnees.lieu, "Bamako")}, le ${jour(donnees.date || new Date())}.`,
             L, doc.y, { width: large, align: "right" });

    doc.moveDown(2);
    const yS = doc.y;
    const colonne = large / 2 - 20;
    doc.font("Helvetica-Bold").fontSize(9).fillColor(NOIR)
       .text("Pour l'entreprise", L + large / 2 + 20, yS, { width: colonne, align: "center" });
    doc.font("Helvetica-Oblique").fontSize(7).fillColor(GRIS)
       .text("(signature et cachet)", L + large / 2 + 20, yS + 13, { width: colonne, align: "center" });
    doc.rect(L + large / 2 + 20, yS + 26, colonne, 64)
       .lineWidth(0.5).strokeColor(GRIS_CLAIR).dash(3, { space: 2 }).stroke().undash();

    habiller(doc, infos);
  }, { size: "A4", margins: { top: 56, bottom: 48, left: 56, right: 56 } });
}

/* ═══════════════════════════════════════════════════════════ DIPLÔME ══ */

/**
 * Le diplôme, en PAYSAGE. Un cadre, une typographie large, du noir, du blanc
 * et de l'or — et de la place pour une signature et un cachet.
 *
 * Il porte une référence unique et les données réelles de l'entreprise et du
 * bénéficiaire : c'est une pièce, pas une décoration.
 */
function diplome({ entreprise, beneficiaire, intitule, mention, du, au, duree_heures, lieu, date, reference, signataire, apercu = false }) {
  return rendre((doc) => {
    const L = doc.page.margins.left;
    const large = doc.page.width - L - doc.page.margins.right;
    const haut = doc.page.margins.top;
    const hauteur = doc.page.height - haut - doc.page.margins.bottom;

    /* Le cadre : un trait or épais, un filet noir à l'intérieur. */
    doc.rect(L - 14, haut - 14, large + 28, hauteur + 28)
       .lineWidth(3).strokeColor(OR).stroke();
    doc.rect(L - 8, haut - 8, large + 16, hauteur + 16)
       .lineWidth(0.6).strokeColor(NOIR).stroke();

    const logo = logoDe(entreprise);
    if (logo) {
      try { doc.image(logo, L + large / 2 - 30, haut + 10, { fit: [60, 34], align: "center" }); } catch { /* ignoré */ }
    }
    /* Le bloc descend d'un dixième de la hauteur : posé tout en haut, il
       laissait un vide de près de la moitié de la page entre le texte et les
       signatures, et un diplôme à moitié vide fait brouillon. */
    doc.y = haut + hauteur * 0.10 + (logo ? 38 : 0);

    doc.font("Helvetica-Bold").fontSize(10).fillColor(GRIS)
       .text(txt(entreprise?.name).toUpperCase(), L, doc.y, { width: large, align: "center", characterSpacing: 2 });
    doc.moveDown(0.8);

    doc.font("Helvetica-Bold").fontSize(34).fillColor(NOIR)
       .text("DIPLÔME", L, doc.y, { width: large, align: "center", characterSpacing: 6 });
    doc.moveDown(0.1);
    doc.font("Helvetica").fontSize(11).fillColor(OR)
       .text(txt(mention, "de formation professionnelle"), L, doc.y, { width: large, align: "center" });

    doc.moveDown(1.8);
    doc.font("Helvetica").fontSize(11).fillColor(NOIR)
       .text("décerné à", L, doc.y, { width: large, align: "center" });
    doc.moveDown(0.6);
    doc.font("Helvetica-Bold").fontSize(24).fillColor(NOIR)
       .text(txt(beneficiaire?.full_name || beneficiaire?.nom), L, doc.y, { width: large, align: "center" });

    /* Un filet or sous le nom, de la largeur du texte et pas de la page. */
    const yFilet = doc.y + 4;
    const largeurNom = Math.min(large, doc.widthOfString(txt(beneficiaire?.full_name || beneficiaire?.nom)) + 60);
    doc.moveTo(L + (large - largeurNom) / 2, yFilet)
       .lineTo(L + (large + largeurNom) / 2, yFilet)
       .lineWidth(1.2).strokeColor(OR).stroke();
    doc.y = yFilet + 22;

    doc.font("Helvetica").fontSize(11).fillColor(NOIR).text(
      `pour avoir suivi avec succès la formation « ${txt(intitule)} »`
      + `${du ? `, du ${jour(du)}` : ""}${au ? ` au ${jour(au)}` : ""}`
      + `${duree_heures ? `, d'une durée de ${duree_heures} heures` : ""}.`,
      L, doc.y, { width: large, align: "center", lineGap: 2 });

    /* La signature et le cachet, en bas, équilibrés. */
    const yBas = haut + hauteur - 76;
    const colonne = large / 3;
    doc.font("Helvetica").fontSize(9).fillColor(GRIS)
       .text(`Fait à ${txt(lieu, "Bamako")}, le ${jour(date || new Date())}`, L, yBas, { width: colonne });

    doc.font("Helvetica-Bold").fontSize(9).fillColor(NOIR)
       .text(txt(signataire?.fonction, "La Direction"), L + 2 * colonne, yBas, { width: colonne, align: "center" });
    if (signataire?.nom) {
      doc.font("Helvetica").fontSize(8).fillColor(GRIS)
         .text(signataire.nom, L + 2 * colonne, doc.y, { width: colonne, align: "center" });
    }
    doc.moveTo(L + 2 * colonne + 10, yBas + 52).lineTo(L + 3 * colonne - 10, yBas + 52)
       .lineWidth(0.6).strokeColor(GRIS).stroke();

    doc.rect(L + colonne + 10, yBas - 4, colonne - 20, 58)
       .lineWidth(0.5).strokeColor(GRIS_CLAIR).dash(3, { space: 2 }).stroke().undash();
    doc.font("Helvetica-Oblique").fontSize(7).fillColor(GRIS_CLAIR)
       .text("cachet de l'entreprise", L + colonne + 10, yBas + 22, { width: colonne - 20, align: "center" });

    /* Même précaution que pour les pieds de page : écrire près du bord sans
       provoquer l'ajout d'une seconde feuille. */
    const margeBasse = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font("Helvetica").fontSize(6.5).fillColor(GRIS_CLAIR)
       .text(`Réf. ${txt(reference)}`, L, haut + hauteur - 6,
             { width: large, align: "center", lineBreak: false });
    doc.page.margins.bottom = margeBasse;
    /* Pas d'en-tête ni de pied standard : un diplôme n'est pas un formulaire.
       Le cadre, le logo et la référence en bas suffisent.
       Le filigrane d'aperçu, lui, est posé à la main — ce document ne passe
       pas par `habiller`, et un aperçu sans mention se confondrait avec la
       pièce, qui est précisément faite pour être encadrée. */
    if (apercu) filigrane(doc);
  }, { size: "A4", layout: "landscape",
       margins: { top: 48, bottom: 48, left: 56, right: 56 } });
}

/* `rendre`, `habiller`, `entete`, `pied` et RESERVE_ENTETE sont exportés pour
   que les états de factures posent leurs pages de la même façon : pages
   tamponnées, en-tête et pied sur chacune, marge basse neutralisée le temps
   d'écrire le pied. Deux implémentations de ce mécanisme divergeraient, et
   l'une des deux finirait par ajouter une page par pied. */
module.exports = {
  contrat, bulletin, attestation, diplome, ATTESTATIONS,
  logoDe, fcfa, jour, rendre, habiller, entete, pied, filigrane, RESERVE_ENTETE,
};

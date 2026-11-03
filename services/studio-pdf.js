"use strict";
/**
 * L'ÉDITEUR DE PAGES, RELIÉ AUX DOCUMENTS.
 *
 * Trois gestes changent le document en place — réordonner, tourner, retirer —
 * et produisent une VERSION DE PLUS. Trois gestes en créent de nouveaux —
 * extraire, fusionner, découper — et ne touchent pas aux sources.
 *
 * LA DIFFÉRENCE N'EST PAS UN DÉTAIL D'IMPLÉMENTATION : elle dit à
 * l'utilisateur ce qu'il risque. Retirer une page d'un contrat modifie le
 * contrat ; en extraire une page n'y touche pas. Les deux portent donc des
 * messages différents, et les trois premiers exigent le droit de MODIFIER le
 * document, quand les trois autres se contentent de le LIRE.
 *
 * DANS TOUS LES CAS, L'ORIGINAL RESTE. Un document modifié garde sa version
 * 1 marquée « original », avec son fichier et son empreinte : on peut
 * toujours montrer ce qui avait été reçu avant qu'on y touche.
 */
const S = require("./studio-stockage");
const B = require("./studio-bibliotheque");
const P = require("./pdf-pages");
const A = require("./pdf-annotations");

function erreur(message, code, httpStatus = 400) {
  const e = new Error(message);
  e.code = code; e.httpStatus = httpStatus;
  return e;
}

/* ─────────────────────────────────────────────────────────────────────────
   LIRE UN PDF DU DÉPÔT, EN VÉRIFIANT QU'IL N'A PAS BOUGÉ

   Modifier un fichier altéré produirait un document qu'on croirait fidèle.
   ───────────────────────────────────────────────────────────────────────── */
async function octetsDe(client, { companyId, utilisateur, documentId, requis }) {
  const { document } = await B.acces(client, {
    companyId, utilisateur, documentId, requis, inclureCorbeille: true });
  if (document.trashed_at) {
    throw erreur(
      "Ce document est à la corbeille. Restaurez-le avant d'y toucher.",
      "DOCUMENT_A_LA_CORBEILLE", 409);
  }
  if (document.mime !== "application/pdf") {
    throw erreur(
      `Ces opérations ne valent que pour un PDF. Ce document est au format ${document.mime}.`,
      "PAS_UN_PDF", 415);
  }
  const octets = await S.octets(document.storage_key).catch(() => null);
  if (!octets) throw erreur("Le fichier du document est introuvable.", "FICHIER_INTROUVABLE", 409);
  if (S.empreinte(octets) !== document.sha256) {
    throw erreur(
      "Ce document ne correspond plus à son empreinte : il a été altéré. Rien n'est modifié.",
      "DOCUMENT_ALTERE", 409);
  }
  return { document, octets };
}

/* ═════════════════ CE QUI MODIFIE LE DOCUMENT EN PLACE ════════════════ */

async function enVersion(client, {
  companyId, utilisateur, documentId, buffer, pages, note, ip,
}) {
  const apres = await B.nouvelleVersion(client, {
    companyId, utilisateur, documentId,
    buffer, mimeAnnonce: "application/pdf",
    nomOrigine: null, note, pageCount: pages, ip,
  });
  const { ocr_text: _o, ...sansTexte } = apres;
  return sansTexte;
}

async function reordonner(client, { companyId, utilisateur, documentId, ordre, ip = "" }) {
  const { document, octets } = await octetsDe(client, {
    companyId, utilisateur, documentId, requis: "MODIFICATION" });
  const r = await P.reordonner({ pdf: octets, ordre });
  const doc = await enVersion(client, {
    companyId, utilisateur, documentId, buffer: r.buffer, pages: r.pages, ip,
    note: `Pages réordonnées : ${ordre.join(", ")}`,
  });
  return { document: doc, avant: r.avant, apres: r.apres, version: doc.version };
}

async function tourner(client, { companyId, utilisateur, documentId, pages, angle, ip = "" }) {
  const { octets } = await octetsDe(client, {
    companyId, utilisateur, documentId, requis: "MODIFICATION" });
  const r = await P.tourner({ pdf: octets, pages, angle });
  const doc = await enVersion(client, {
    companyId, utilisateur, documentId, buffer: r.buffer, pages: r.pages, ip,
    note: `${r.tournees} page${r.tournees > 1 ? "s" : ""} tournée${r.tournees > 1 ? "s" : ""} ` +
      `de ${angle}° : ${pages.join(", ")}`,
  });
  return { document: doc, tournees: r.tournees, version: doc.version };
}

async function retirer(client, { companyId, utilisateur, documentId, pages, motif, ip = "" }) {
  const m = String(motif || "").trim();
  if (m.length < 10) {
    /* RETIRER DES PAGES EST LE SEUL GESTE QUI FAIT DISPARAÎTRE DU CONTENU de
       la version courante. Il demande donc une raison, qu'on relira dans
       l'historique — l'original, lui, les garde toutes. */
    throw erreur(
      "Dites pourquoi ces pages partent (dix caractères minimum). " +
      "« Page blanche du scanner » se relit ; « nettoyage » ne se relit pas.",
      "MOTIF_REQUIS");
  }
  const { octets } = await octetsDe(client, {
    companyId, utilisateur, documentId, requis: "MODIFICATION" });
  const r = await P.retirer({ pdf: octets, pages });
  const doc = await enVersion(client, {
    companyId, utilisateur, documentId, buffer: r.buffer, pages: r.pages, ip,
    note: `Pages ${r.retirees.join(", ")} retirées — ${m}`,
  });
  return {
    document: doc, avant: r.avant, apres: r.apres, retirees: r.retirees,
    version: doc.version,
  };
}

/* ═══════════════ CE QUI CRÉE DE NOUVEAUX DOCUMENTS ════════════════════ */

function nomPdf(nom, suffixe) {
  const base = String(nom || "document").replace(/\.pdf$/i, "").slice(0, 170);
  return `${base}${suffixe}.pdf`;
}

async function extraire(client, {
  companyId, utilisateur, documentId, pages, nom = "", folderId, visibility, ip = "",
}) {
  const { document, octets } = await octetsDe(client, {
    companyId, utilisateur, documentId, requis: "LECTURE" });
  const r = await P.extraire({ pdf: octets, pages });
  const nouveau = await B.deposer(client, {
    companyId, utilisateur, ip,
    buffer: r.buffer, mimeAnnonce: "application/pdf",
    nomOrigine: nom.trim() || nomPdf(document.name, ` — pages ${r.extraites.join(",")}`),
    folderId: folderId === undefined ? document.folder_id : folderId,
    kind: "PDF", pageCount: r.pages,
    visibility: visibility || document.visibility,
    sourceDocumentId: document.id,
    sourceNote: `Pages ${r.extraites.join(", ")} extraites de « ${document.name} » ` +
      `(version ${document.version}).`,
  });
  const { ocr_text: _o, ...sansTexte } = nouveau;
  return { document: sansTexte, source: document.name, extraites: r.extraites, pages: r.pages };
}

async function fusionner(client, {
  companyId, utilisateur, documentIds, nom, folderId = null, visibility = "PRIVE", ip = "",
}) {
  if (!Array.isArray(documentIds) || documentIds.length < 2) {
    throw erreur("Il faut au moins deux documents à fusionner.", "PAS_ASSEZ_DE_DOCUMENTS");
  }
  if (new Set(documentIds.map(Number)).size !== documentIds.length) {
    throw erreur(
      "Le même document est désigné deux fois. Pour le répéter, extrayez-le d'abord.",
      "DOCUMENT_EN_DOUBLE");
  }
  const titre = String(nom || "").trim();
  if (!titre) throw erreur("Donnez un nom au document fusionné.", "NOM_REQUIS");

  const sources = [];
  for (const id of documentIds) {
    const { document, octets } = await octetsDe(client, {
      companyId, utilisateur, documentId: Number(id), requis: "LECTURE" });
    sources.push({ nom: document.name, buffer: octets, id: document.id });
  }
  const r = await P.fusionner({ documents: sources });

  const nouveau = await B.deposer(client, {
    companyId, utilisateur, ip,
    buffer: r.buffer, mimeAnnonce: "application/pdf",
    nomOrigine: nomPdf(titre, ""),
    folderId, kind: "PDF", pageCount: r.pages, visibility,
    /* On garde la composition : savoir d'où vient chaque feuillet six mois
       plus tard vaut mieux qu'un dossier anonyme. */
    sourceNote: "Fusion de : " +
      r.detail.map((d) => `« ${d.nom} » (${d.pages} p., à partir de la page ${d.depuis})`)
        .join(" ; "),
  });
  const { ocr_text: _o, ...sansTexte } = nouveau;
  return { document: sansTexte, composition: r.detail, pages: r.pages };
}

async function decouper(client, {
  companyId, utilisateur, documentId, tranches, folderId, visibility, ip = "",
}) {
  const { document, octets } = await octetsDe(client, {
    companyId, utilisateur, documentId, requis: "LECTURE" });
  const r = await P.decouper({ pdf: octets, tranches });

  const crees = [];
  for (const [i, sortie] of r.sorties.entries()) {
    const nouveau = await B.deposer(client, {
      companyId, utilisateur, ip,
      buffer: sortie.buffer, mimeAnnonce: "application/pdf",
      nomOrigine: nomPdf(sortie.nom || `${document.name} partie ${i + 1}`, ""),
      folderId: folderId === undefined ? document.folder_id : folderId,
      kind: "PDF", pageCount: sortie.pages,
      visibility: visibility || document.visibility,
      sourceDocumentId: document.id,
      sourceNote: `Pages ${sortie.numeros.join(", ")} de « ${document.name} » ` +
        `(version ${document.version}).`,
    });
    const { ocr_text: _o, ...sansTexte } = nouveau;
    crees.push({ document: sansTexte, numeros: sortie.numeros, pages: sortie.pages });
  }

  return {
    source: document.name, avant: r.avant, crees,
    /* ON DIT CE QUI N'A PAS ÉTÉ REPRIS. Une page oubliée dans un découpage
       de dossier se retrouve six mois plus tard, ou jamais. */
    oubliees: r.oubliees,
  };
}

/* ═════════════════════ ANNOTER UNE PAGE ═════════════════════

   Poser du texte, un tableau, un surlignage ou un cadre MODIFIE le document :
   une version de plus, et le droit de modification exigé. L'original garde sa
   version 1, avec son fichier et son empreinte.

   LA NOTE DE VERSION DIT CE QUI A ÉTÉ POSÉ, ET OÙ. C'est tout ce dont on
   dispose six mois plus tard pour savoir d'où vient une mention manuscrite
   sur un bon de livraison. Un « document annoté » sans détail ne servirait à
   personne.                                                                */
function resume(posees) {
  const parNature = new Map();
  for (const a of posees) parNature.set(a.nature, (parNature.get(a.nature) || 0) + 1);
  const mots = {
    TEXTE: ["mention", "mentions"],
    TABLEAU: ["tableau", "tableaux"],
    SURLIGNAGE: ["surlignage", "surlignages"],
    CADRE: ["cadre", "cadres"],
  };
  const morceaux = [...parNature.entries()].map(([nature, n]) =>
    `${n} ${mots[nature][n > 1 ? 1 : 0]}`);
  const pages = [...new Set(posees.map((a) => a.page))].sort((x, y) => x - y);
  return `${morceaux.join(", ")} sur ${pages.length > 1 ? "les pages" : "la page"} ${pages.join(", ")}`;
}

async function annoter(client, { companyId, utilisateur, documentId, annotations, ip = "" }) {
  const { octets } = await octetsDe(client, {
    companyId, utilisateur, documentId, requis: "MODIFICATION" });
  const r = await A.annoter({ pdf: octets, annotations });
  const doc = await enVersion(client, {
    companyId, utilisateur, documentId, buffer: r.buffer, pages: r.pages, ip,
    note: `Annotations posées : ${resume(r.posees)}.`,
  });
  return { document: doc, posees: r.posees, version: doc.version };
}

/* La géométrie des pages TELLE QU'ON LA VOIT : c'est le repère dans lequel
   l'écran place les annotations. Voir services/pdf-reperes.js. */
async function pagesVues(client, { companyId, utilisateur, documentId }) {
  const { octets } = await octetsDe(client, {
    companyId, utilisateur, documentId, requis: "LECTURE" });
  return A.decrire(octets);
}

module.exports = {
  reordonner, tourner, retirer, extraire, fusionner, decouper, annoter, pagesVues,
};

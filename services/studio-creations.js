"use strict";
/**
 * LES CRÉATIONS GRAPHIQUES.
 *
 * Une création est un document ORDINAIRE de la bibliothèque — une image, qui
 * se cherche, se partage, s'imprime, se signe — qui porte en plus le PLAN de
 * sa mise en page, pour qu'on puisse la rouvrir et la modifier.
 *
 * LE PLAN NE REMPLACE PAS L'IMAGE. Si le document rangé était le plan,
 * personne n'en verrait rien : ni aperçu, ni pièce jointe utilisable, ni
 * impression. C'est l'image qu'on partage ; le plan la suit.
 *
 * LES DIMENSIONS PHYSIQUES SONT GARDÉES. Une carte de visite n'est pas
 * « une image » : c'est 85 sur 55 millimètres. Sans cette information, le
 * PDF d'impression sortirait à une échelle quelconque, et la carte n'entrerait
 * plus dans un porte-cartes.
 */
const { PDFDocument } = require("pdf-lib");
const S = require("./studio-stockage");
const B = require("./studio-bibliotheque");

/* 72 points typographiques par pouce, 25,4 millimètres par pouce. */
const MM_EN_POINTS = 72 / 25.4;
/* Au-delà, ce n'est plus une étiquette ni une affiche : c'est une erreur de
   saisie, et le PDF produit serait ingérable. */
const MM_MAX = 2000;

function erreur(message, code, httpStatus = 400) {
  const e = new Error(message);
  e.code = code; e.httpStatus = httpStatus;
  return e;
}

function verifierFormat({ largeurMm, hauteurMm, format }) {
  const l = Number(largeurMm), h = Number(hauteurMm);
  if (!Number.isFinite(l) || !Number.isFinite(h) || l <= 0 || h <= 0) {
    throw erreur(
      "Une création a des dimensions physiques : dites combien de millimètres de large et de haut.",
      "DIMENSIONS_REQUISES");
  }
  if (l > MM_MAX || h > MM_MAX) {
    throw erreur(
      `Les dimensions dépassent ${MM_MAX} mm. Ce n'est plus une étiquette ni une affiche.`,
      "DIMENSIONS_ABSURDES");
  }
  return { largeurMm: l, hauteurMm: h, format: String(format || "").slice(0, 60) };
}

function verifierPlan(plan) {
  if (plan === null || plan === undefined) {
    throw erreur("Le plan de la création manque.", "PLAN_REQUIS");
  }
  let objet = plan;
  if (typeof plan === "string") {
    try { objet = JSON.parse(plan); }
    catch { throw erreur("Le plan de la création n'est pas lisible.", "PLAN_ILLISIBLE"); }
  }
  if (typeof objet !== "object" || Array.isArray(objet)) {
    throw erreur("Le plan de la création doit être un objet.", "PLAN_INVALIDE");
  }
  if (!Array.isArray(objet.elements)) {
    throw erreur("Le plan ne contient aucun élément.", "PLAN_SANS_ELEMENTS");
  }
  /* Un plan démesuré finirait par ralentir chaque lecture de la ligne, et
     ce n'est de toute façon plus une mise en page. */
  const taille = JSON.stringify(objet).length;
  if (taille > 2_000_000) {
    throw erreur(
      "Le plan de la création est trop lourd : simplifiez la mise en page ou " +
      "déposez les images dans la bibliothèque plutôt que de les y inclure.",
      "PLAN_TROP_LOURD");
  }
  return objet;
}

/* ─────────────────────────────────────────────────────────────────────────
   CRÉER
   ───────────────────────────────────────────────────────────────────────── */
async function creer(client, {
  companyId, utilisateur, buffer, mimeAnnonce, nom, plan,
  largeurMm, hauteurMm, format = "", folderId = null, visibility = "PRIVE",
  description = "", tags = [], ip = "",
}) {
  const dims = verifierFormat({ largeurMm, hauteurMm, format });
  const objet = verifierPlan(plan);

  const titre = String(nom || "").trim();
  if (!titre) throw erreur("Donnez un nom à cette création.", "NOM_REQUIS");

  const document = await B.deposer(client, {
    companyId, utilisateur, ip,
    buffer, mimeAnnonce: mimeAnnonce || "image/png",
    nomOrigine: titre.toLowerCase().endsWith(".png") ? titre : `${titre}.png`,
    folderId, kind: "CREATION", visibility, description, tags,
    sourceNote: `Création ${dims.format || "sur mesure"} — ${dims.largeurMm}×${dims.hauteurMm} mm.`,
  });

  await client.query(
    `UPDATE studio_documents
        SET design = $2::jsonb, design_kind = 'CREATION', design_format = $3,
            design_mm_width = $4, design_mm_height = $5
      WHERE id = $1`,
    [document.id, JSON.stringify(objet), dims.format, dims.largeurMm, dims.hauteurMm]);

  const { ocr_text: _o, ...sansTexte } = document;
  return { ...sansTexte, design_format: dims.format,
    design_mm_width: dims.largeurMm, design_mm_height: dims.hauteurMm };
}

/* ─────────────────────────────────────────────────────────────────────────
   ROUVRIR
   ───────────────────────────────────────────────────────────────────────── */
async function plan(client, { companyId, utilisateur, documentId }) {
  const { document, niveau } = await B.acces(client, {
    companyId, utilisateur, documentId, requis: "LECTURE", inclureCorbeille: true });
  if (!document.design) {
    throw erreur(
      "Ce document n'est pas une création : il n'a pas de plan de mise en page. " +
      "Seules les créations faites dans le studio graphique se rouvrent.",
      "PAS_UNE_CREATION", 409);
  }
  if (document.design_kind === "PRESENTATION") {
    /* UNE PRÉSENTATION A UN PLAN, MAIS CE N'EST PAS LE MÊME. L'ouvrir dans
       l'éditeur de planches lui enlèverait toutes ses diapositives sauf
       l'idée qu'il s'en fait — c'est-à-dire aucune. On renvoie donc là où il
       faut aller, plutôt qu'un refus sec. */
    throw erreur(
      "Ce document est une présentation, pas une planche. Ouvrez-le dans les présentations.",
      "C_EST_UNE_PRESENTATION", 409);
  }
  return {
    document: {
      id: document.id, name: document.name, version: document.version,
      visibility: document.visibility, folder_id: document.folder_id,
      trashed_at: document.trashed_at,
    },
    plan: document.design,
    format: document.design_format,
    largeur_mm: Number(document.design_mm_width),
    hauteur_mm: Number(document.design_mm_height),
    mon_niveau: niveau,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   ENREGISTRER UNE MODIFICATION — image et plan vont ensemble
   ───────────────────────────────────────────────────────────────────────── */
async function modifier(client, {
  companyId, utilisateur, documentId, buffer, mimeAnnonce, plan: nouveauPlan,
  largeurMm, hauteurMm, format, note, ip = "",
}) {
  const { document } = await B.acces(client, {
    companyId, utilisateur, documentId, requis: "MODIFICATION" });
  if (!document.design || document.design_kind === "PRESENTATION") {
    throw erreur("Ce document n'est pas une création.", "PAS_UNE_CREATION", 409);
  }
  if (document.trashed_at) {
    throw erreur(
      "Cette création est à la corbeille. Restaurez-la avant de la modifier.",
      "DOCUMENT_A_LA_CORBEILLE", 409);
  }

  const dims = verifierFormat({
    largeurMm: largeurMm ?? document.design_mm_width,
    hauteurMm: hauteurMm ?? document.design_mm_height,
    format: format ?? document.design_format,
  });
  const objet = verifierPlan(nouveauPlan);

  /* L'IMAGE ET LE PLAN SONT ÉCRITS DANS LA MÊME TRANSACTION. Séparés, un
     incident entre les deux laisserait une image qui ne correspond plus à
     son plan — et la prochaine réouverture repartirait d'autre chose que ce
     qu'on voit. */
  const apres = await B.nouvelleVersion(client, {
    companyId, utilisateur, documentId,
    buffer, mimeAnnonce: mimeAnnonce || "image/png",
    nomOrigine: document.name.toLowerCase().endsWith(".png")
      ? document.name : `${document.name}.png`,
    note: String(note || "").trim() || "Mise en page modifiée dans le studio graphique",
    ip,
  });

  await client.query(
    `UPDATE studio_documents
        SET design = $2::jsonb, design_format = $3,
            design_mm_width = $4, design_mm_height = $5
      WHERE id = $1`,
    [documentId, JSON.stringify(objet), dims.format, dims.largeurMm, dims.hauteurMm]);

  const { ocr_text: _o, ...sansTexte } = apres;
  return { ...sansTexte, design_format: dims.format,
    design_mm_width: dims.largeurMm, design_mm_height: dims.hauteurMm };
}

/* ─────────────────────────────────────────────────────────────────────────
   EXPORTER POUR L'IMPRESSION

   Un PDF d'UNE page, exactement aux dimensions physiques voulues, l'image
   occupant toute la page. C'est ce qui garantit qu'une carte de visite sort
   à 85 sur 55 millimètres et pas « à peu près ».
   ───────────────────────────────────────────────────────────────────────── */
async function exporterPdf(client, {
  companyId, utilisateur, documentId, exemplaires = 1, nom = "", ip = "",
}) {
  const { document } = await B.acces(client, {
    companyId, utilisateur, documentId, requis: "LECTURE" });
  if (!document.design || document.design_kind === "PRESENTATION") {
    throw erreur("Ce document n'est pas une création.", "PAS_UNE_CREATION", 409);
  }
  const n = Math.max(1, Math.min(50, Number(exemplaires) || 1));

  const octets = await S.octets(document.storage_key).catch(() => null);
  if (!octets) throw erreur("Le fichier de la création est introuvable.", "FICHIER_INTROUVABLE", 409);
  if (S.empreinte(octets) !== document.sha256) {
    throw erreur(
      "Cette création ne correspond plus à son empreinte : elle a été altérée. Rien n'est exporté.",
      "DOCUMENT_ALTERE", 409);
  }

  const largeurPt = Number(document.design_mm_width) * MM_EN_POINTS;
  const hauteurPt = Number(document.design_mm_height) * MM_EN_POINTS;

  const pdf = await PDFDocument.create();
  pdf.setTitle(document.name);
  pdf.setCreator("Triangle Studio Pro — studio graphique");
  const image = document.mime === "image/jpeg"
    ? await pdf.embedJpg(octets)
    : await pdf.embedPng(octets);
  for (let i = 0; i < n; i++) {
    const page = pdf.addPage([largeurPt, hauteurPt]);
    page.drawImage(image, { x: 0, y: 0, width: largeurPt, height: hauteurPt });
  }
  const buffer = Buffer.from(await pdf.save({ useObjectStreams: false }));
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw erreur("L'export n'a pas produit un PDF valide.", "EXPORT_INVALIDE", 500);
  }

  const base = String(nom || document.name).replace(/\.[^.]+$/, "").slice(0, 170);
  const cree = await B.deposer(client, {
    companyId, utilisateur, ip,
    buffer, mimeAnnonce: "application/pdf",
    nomOrigine: `${base} — impression.pdf`,
    folderId: document.folder_id, kind: "PDF",
    visibility: document.visibility,
    pageCount: n, sourceDocumentId: document.id,
    sourceNote: `Export d'impression de « ${document.name} » (version ${document.version}) — ` +
      `${document.design_mm_width}×${document.design_mm_height} mm, ` +
      `${n} exemplaire${n > 1 ? "s" : ""}.`,
  });

  const { ocr_text: _o, ...sansTexte } = cree;
  return {
    document: sansTexte, exemplaires: n,
    mm: { largeur: Number(document.design_mm_width), hauteur: Number(document.design_mm_height) },
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   LES CRÉATIONS ACCESSIBLES
   ───────────────────────────────────────────────────────────────────────── */
async function lister(client, { companyId, utilisateur, limite = 100 }) {
  const userId = Number(utilisateur?.id || 0);
  const { rows } = await client.query(
    `SELECT d.id, d.name, d.design_format, d.design_mm_width, d.design_mm_height,
            d.version, d.visibility, d.owner_name, d.updated_at, d.size_bytes,
            (d.owner_id = $2) AS je_suis_proprietaire
       FROM studio_documents d
      WHERE d.company_id = $1 AND d.design IS NOT NULL AND d.trashed_at IS NULL
        AND d.design_kind = 'CREATION'
        AND (d.owner_id = $2 OR d.visibility = 'SOCIETE'
             OR EXISTS (SELECT 1 FROM studio_shares s
                         WHERE s.document_id = d.id AND s.kind = 'INTERNE'
                           AND s.grantee_user_id = $2))
      ORDER BY d.updated_at DESC
      LIMIT $3`,
    [companyId, userId, Math.min(Number(limite) || 100, 200)]);
  return rows;
}

module.exports = { creer, plan, modifier, exporterPdf, lister, MM_EN_POINTS };

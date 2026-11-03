"use strict";
/**
 * LES PRÉSENTATIONS.
 *
 * Une présentation se range dans la bibliothèque comme n'importe quel
 * document : elle a un propriétaire, une visibilité, des versions, une
 * corbeille, un journal d'accès. Ce qui la distingue, c'est que son PLAN —
 * la liste de ses diapositives — vit dans la même ligne, et que le fichier
 * déposé est un PDF d'autant de pages qu'il y a de diapositives.
 *
 * POURQUOI LE FICHIER EST UN PDF, ET NON UN .PPTX.
 *
 * Le PDF est ce qui se montre, s'imprime, se partage par un lien signé et
 * s'ouvre sur n'importe quel téléphone sans rien installer — y compris chez
 * un client qui n'a pas PowerPoint. C'est donc lui qui est le document.
 *
 * Le .pptx, lui, est un EXPORT, produit à la demande : il sert quand il faut
 * continuer le travail dans PowerPoint. Il entre dans la bibliothèque comme
 * un document de plus, avec sa provenance écrite — et non à la place du PDF.
 *
 * POURQUOI LE RENDU VIENT DU NAVIGATEUR.
 *
 * Les diapositives sont dessinées par le navigateur, exactement comme
 * l'aperçu que l'on vient de valider, et envoyées en images. Rendre une
 * seconde fois sur le serveur demanderait d'y reproduire la mesure du texte,
 * le découpage des lignes et les polices — un second chemin de rendu qui
 * finirait par diverger du premier. On imprimerait alors autre chose que ce
 * qu'on a vu, et cela ne se découvrirait qu'une fois la réunion commencée.
 *
 * Le serveur, lui, ASSEMBLE : il place chaque image sur une page aux
 * dimensions exactes de la diapositive. C'est ce qui garantit un 16/9 qui
 * reste 16/9.
 */
const { PDFDocument } = require("pdf-lib");
const S = require("./studio-stockage");
const B = require("./studio-bibliotheque");
const PPTX = require("./pptx");

const MM_EN_POINTS = 72 / 25.4;
const DIAPOS_MAX = 200;
const PLAN_MAX = 8_000_000;

/* Les deux formats que l'on propose, et leurs dimensions réelles — celles de
   PowerPoint, pour qu'un export s'ouvre sans bande noire. */
const FORMATS = {
  "16-9": { nom: "16/9 — écran large", largeurMm: 338.667, hauteurMm: 190.5 },
  "4-3":  { nom: "4/3 — vidéoprojecteur ancien", largeurMm: 254, hauteurMm: 190.5 },
};

function erreur(message, code, httpStatus = 400) {
  const e = new Error(message);
  e.code = code; e.httpStatus = httpStatus;
  return e;
}

function verifierPlan(plan) {
  let objet = plan;
  if (typeof plan === "string") {
    try { objet = JSON.parse(plan); }
    catch { throw erreur("Le plan de la présentation n'est pas lisible.", "PLAN_ILLISIBLE"); }
  }
  if (!objet || typeof objet !== "object" || Array.isArray(objet)) {
    throw erreur("Le plan de la présentation doit être un objet.", "PLAN_INVALIDE");
  }
  const diapos = objet.diapositives;
  if (!Array.isArray(diapos) || !diapos.length) {
    throw erreur(
      "Une présentation a au moins une diapositive.",
      "AUCUNE_DIAPOSITIVE");
  }
  if (diapos.length > DIAPOS_MAX) {
    throw erreur(
      `${diapos.length} diapositives ; la limite est ${DIAPOS_MAX}.`,
      "TROP_DE_DIAPOSITIVES");
  }
  diapos.forEach((d, i) => {
    if (!d || typeof d !== "object" || !Array.isArray(d.elements)) {
      throw erreur(
        `La diapositive ${i + 1} n'a pas de liste d'éléments.`,
        "DIAPOSITIVE_INVALIDE");
    }
  });
  /* Un plan démesuré ralentirait chaque lecture de la ligne. La limite est
     plus large que celle d'une création : une présentation a plusieurs
     diapositives, donc plusieurs images. */
  const taille = JSON.stringify(objet).length;
  if (taille > PLAN_MAX) {
    throw erreur(
      `Le plan de la présentation pèse ${Math.round(taille / 1024 / 1024)} Mo ; ` +
      `la limite est ${PLAN_MAX / 1024 / 1024} Mo. Allégez les images, ou déposez-les ` +
      `dans la bibliothèque plutôt que de les inclure dans les diapositives.`,
      "PLAN_TROP_LOURD");
  }
  return objet;
}

function verifierFormat({ format, largeurMm, hauteurMm }) {
  const connu = FORMATS[String(format || "")];
  if (connu) return { format: String(format), ...connu };
  const l = Number(largeurMm), h = Number(hauteurMm);
  if (!Number.isFinite(l) || !Number.isFinite(h) || l <= 0 || h <= 0) {
    throw erreur(
      `Format inconnu. Au choix : ${Object.keys(FORMATS).join(", ")}, ` +
      `ou donnez une largeur et une hauteur en millimètres.`,
      "FORMAT_INCONNU");
  }
  if (l > 2000 || h > 2000) {
    throw erreur("Une diapositive de plus de deux mètres n'en est plus une.", "DIMENSIONS_ABSURDES");
  }
  return { format: "sur-mesure", nom: "sur mesure", largeurMm: l, hauteurMm: h };
}

/**
 * ASSEMBLER LE PDF.
 *
 * Une page par diapositive, aux dimensions exactes. On vérifie que le compte
 * d'images correspond au compte de diapositives : une image manquante
 * donnerait une présentation à trou, ce qui ne se voit qu'en la projetant.
 */
async function assembler({ images, diapositives, largeurMm, hauteurMm, titre }) {
  if (images.length !== diapositives) {
    throw erreur(
      `Le plan annonce ${diapositives} diapositive${diapositives > 1 ? "s" : ""} ` +
      `et ${images.length} image${images.length > 1 ? "s" : ""} ${images.length > 1 ? "sont" : "est"} ` +
      `arrivée${images.length > 1 ? "s" : ""}. Rien n'est enregistré : une présentation à trou ` +
      `ne se découvrirait qu'en la projetant.`,
      "DIAPOSITIVES_MANQUANTES");
  }
  const pdf = await PDFDocument.create();
  pdf.setTitle(String(titre || "Présentation"));
  pdf.setCreator("Triangle Studio Pro — présentations");
  const largeurPt = largeurMm * MM_EN_POINTS;
  const hauteurPt = hauteurMm * MM_EN_POINTS;

  for (const [i, image] of images.entries()) {
    const octets = image.buffer;
    let incrustee;
    try {
      incrustee = (image.mimetype === "image/jpeg" || image.mimetype === "image/jpg")
        ? await pdf.embedJpg(octets)
        : await pdf.embedPng(octets);
    } catch (e) {
      throw erreur(
        `L'image de la diapositive ${i + 1} n'a pas pu être incorporée : ${e.message}`,
        "IMAGE_INCORPORABLE", 415);
    }
    const page = pdf.addPage([largeurPt, hauteurPt]);
    page.drawImage(incrustee, { x: 0, y: 0, width: largeurPt, height: hauteurPt });
  }

  const buffer = Buffer.from(await pdf.save({ useObjectStreams: false }));
  if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw erreur("L'assemblage n'a pas produit un PDF valide.", "ASSEMBLAGE_INVALIDE", 500);
  }
  return buffer;
}

const nomPdf = (titre) =>
  titre.toLowerCase().endsWith(".pdf") ? titre : `${titre}.pdf`;

/* ═════════════════════════════ CRÉER ═════════════════════════════ */

async function creer(client, {
  companyId, utilisateur, images, plan, nom, format, largeurMm, hauteurMm,
  folderId = null, visibility = "PRIVE", description = "", tags = [], ip = "",
  provenance = "",
}) {
  const dims = verifierFormat({ format, largeurMm, hauteurMm });
  const objet = verifierPlan(plan);
  const titre = String(nom || "").trim();
  if (!titre) throw erreur("Donnez un nom à cette présentation.", "NOM_REQUIS");

  const buffer = await assembler({
    images, diapositives: objet.diapositives.length,
    largeurMm: dims.largeurMm, hauteurMm: dims.hauteurMm, titre });

  const document = await B.deposer(client, {
    companyId, utilisateur, ip,
    buffer, mimeAnnonce: "application/pdf", nomOrigine: nomPdf(titre),
    folderId, kind: "PDF", visibility, description, tags,
    pageCount: objet.diapositives.length,
    sourceNote: `Présentation ${dims.nom} — ${objet.diapositives.length} diapositive` +
      `${objet.diapositives.length > 1 ? "s" : ""}, ` +
      `${dims.largeurMm.toFixed(0)}×${dims.hauteurMm.toFixed(0)} mm.` +
      (provenance ? ` ${provenance}` : ""),
  });

  await client.query(
    `UPDATE studio_documents
        SET design = $2::jsonb, design_kind = 'PRESENTATION', design_format = $3,
            design_mm_width = $4, design_mm_height = $5
      WHERE id = $1`,
    [document.id, JSON.stringify(objet), dims.format, dims.largeurMm, dims.hauteurMm]);

  const { ocr_text: _o, ...sansTexte } = document;
  return { ...sansTexte, design_kind: "PRESENTATION", design_format: dims.format,
    design_mm_width: dims.largeurMm, design_mm_height: dims.hauteurMm,
    diapositives: objet.diapositives.length };
}

/* ═══════════════════════════ ROUVRIR ═══════════════════════════ */

async function plan(client, { companyId, utilisateur, documentId }) {
  const { document, niveau } = await B.acces(client, {
    companyId, utilisateur, documentId, requis: "LECTURE", inclureCorbeille: true });
  if (!document.design || document.design_kind !== "PRESENTATION") {
    throw erreur(
      "Ce document n'est pas une présentation : il n'a pas de jeu de diapositives. " +
      "Seules les présentations faites ou importées ici se rouvrent.",
      "PAS_UNE_PRESENTATION", 409);
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

/* ══════════════════════════ ENREGISTRER ══════════════════════════ */

async function modifier(client, {
  companyId, utilisateur, documentId, images, plan: nouveauPlan,
  format, largeurMm, hauteurMm, note, ip = "",
}) {
  const { document } = await B.acces(client, {
    companyId, utilisateur, documentId, requis: "MODIFICATION", inclureCorbeille: true });
  if (!document.design || document.design_kind !== "PRESENTATION") {
    throw erreur("Ce document n'est pas une présentation.", "PAS_UNE_PRESENTATION", 409);
  }
  if (document.trashed_at) {
    throw erreur(
      "Cette présentation est à la corbeille. Restaurez-la avant de la modifier.",
      "DOCUMENT_A_LA_CORBEILLE", 409);
  }

  const dims = verifierFormat({
    format: format ?? document.design_format,
    largeurMm: largeurMm ?? document.design_mm_width,
    hauteurMm: hauteurMm ?? document.design_mm_height,
  });
  const objet = verifierPlan(nouveauPlan);
  const buffer = await assembler({
    images, diapositives: objet.diapositives.length,
    largeurMm: dims.largeurMm, hauteurMm: dims.hauteurMm, titre: document.name });

  /* LE PDF ET LE PLAN SONT ÉCRITS DANS LA MÊME TRANSACTION. Séparés, un
     incident entre les deux laisserait un PDF qui ne correspond plus à son
     plan — et la prochaine réouverture repartirait d'autre chose que ce
     qu'on voit. */
  const apres = await B.nouvelleVersion(client, {
    companyId, utilisateur, documentId,
    buffer, mimeAnnonce: "application/pdf", nomOrigine: nomPdf(document.name),
    pageCount: objet.diapositives.length,
    note: String(note || "").trim()
      || `Présentation modifiée — ${objet.diapositives.length} diapositive` +
         `${objet.diapositives.length > 1 ? "s" : ""}`,
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
    design_mm_width: dims.largeurMm, design_mm_height: dims.hauteurMm,
    diapositives: objet.diapositives.length };
}

/* ═══════════════════ EXPORTER VERS POWERPOINT ═══════════════════ */

async function exporterPptx(client, { companyId, utilisateur, documentId, nom = "", ip = "" }) {
  const { document } = await B.acces(client, {
    companyId, utilisateur, documentId, requis: "LECTURE" });
  if (!document.design || document.design_kind !== "PRESENTATION") {
    throw erreur("Ce document n'est pas une présentation.", "PAS_UNE_PRESENTATION", 409);
  }
  const objet = document.design;
  const { buffer, diapositives, nonRepris } = await PPTX.ecrire({
    titre: document.name,
    auteur: utilisateur?.name || "",
    largeurMm: Number(document.design_mm_width),
    hauteurMm: Number(document.design_mm_height),
    diapositives: objet.diapositives,
  });

  const base = String(nom || document.name).replace(/\.[^.]+$/, "").slice(0, 170);
  const cree = await B.deposer(client, {
    companyId, utilisateur, ip,
    buffer,
    mimeAnnonce: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    nomOrigine: `${base}.pptx`,
    /* « PRESENTATION » est l'une des natures que la contrainte de la base
       accepte, et c'est bien ce qu'est ce fichier. Le premier jet écrivait
       « AUTRE », qui n'existe pas : la contrainte le refusait, et l'export
       sortait en erreur 500 avec le texte brut de PostgreSQL. */
    folderId: document.folder_id, kind: "PRESENTATION",
    visibility: document.visibility,
    sourceDocumentId: document.id,
    sourceNote: `Export PowerPoint de « ${document.name} » (version ${document.version}) — ` +
      `${diapositives} diapositive${diapositives > 1 ? "s" : ""}. ` +
      `Les formes sont modifiables dans PowerPoint ; ce n'est pas une image.`,
  });

  const { ocr_text: _o, ...sansTexte } = cree;
  return { document: sansTexte, diapositives, nonRepris };
}

/* ═══════════════════ IMPORTER DEPUIS POWERPOINT ═══════════════════ */

/**
 * ON NE DÉPOSE PAS ENCORE DE DOCUMENT ICI.
 *
 * L'import rend le PLAN au navigateur, qui le dessine, montre le compte rendu
 * de ce qui n'a pas été repris, et n'enregistre QUE si l'utilisateur le
 * veut. Enregistrer d'abord et expliquer ensuite mettrait dans la
 * bibliothèque une présentation que personne n'a validée — et dont il
 * faudrait deviner, plus tard, pourquoi un tableau y manque.
 */
async function lirePptx({ octets }) {
  const { largeurMm, hauteurMm, diapositives, nonRepris } = await PPTX.lire(octets);
  /* On retrouve le format normalisé quand il correspond, pour que l'écran
     l'affiche comme « 16/9 » plutôt que « sur mesure ». */
  const connu = Object.entries(FORMATS).find(([, f]) =>
    Math.abs(f.largeurMm - largeurMm) < 1 && Math.abs(f.hauteurMm - hauteurMm) < 1);
  return {
    plan: { diapositives },
    format: connu ? connu[0] : "sur-mesure",
    largeur_mm: largeurMm,
    hauteur_mm: hauteurMm,
    non_repris: nonRepris,
  };
}

/* ═══════════════════════════ LISTER ═══════════════════════════ */

async function lister(client, { companyId, utilisateur, limite = 100 }) {
  const userId = Number(utilisateur?.id || 0);
  const { rows } = await client.query(
    `SELECT d.id, d.name, d.design_format, d.design_mm_width, d.design_mm_height,
            d.version, d.visibility, d.owner_name, d.updated_at, d.size_bytes,
            d.page_count,
            jsonb_array_length(COALESCE(d.design -> 'diapositives', '[]'::jsonb)) AS diapositives,
            (d.owner_id = $2) AS je_suis_proprietaire
       FROM studio_documents d
      WHERE d.company_id = $1 AND d.design IS NOT NULL
        AND d.design_kind = 'PRESENTATION' AND d.trashed_at IS NULL
        AND (d.owner_id = $2 OR d.visibility = 'SOCIETE'
             OR EXISTS (SELECT 1 FROM studio_shares s
                         WHERE s.document_id = d.id AND s.kind = 'INTERNE'
                           AND s.grantee_user_id = $2))
      ORDER BY d.updated_at DESC
      LIMIT $3`,
    [companyId, userId, Math.min(Number(limite) || 100, 200)]);
  return rows;
}

module.exports = {
  creer, plan, modifier, exporterPptx, lirePptx, lister,
  FORMATS, DIAPOS_MAX, MM_EN_POINTS,
};

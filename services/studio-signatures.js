"use strict";
/**
 * SIGNATURES ET CACHETS.
 *
 * UNE SIGNATURE N'EST PAS UN DOCUMENT COMME UN AUTRE. Un contrat peut être
 * ouvert à toute la société ; une signature, jamais. Quiconque l'obtient
 * peut signer à la place de son propriétaire. Les règles d'accès ici sont
 * donc PLUS STRICTES que celles de la bibliothèque, et elles ne dépendent
 * d'aucun réglage de visibilité que quelqu'un pourrait desserrer.
 *
 *   • Une SIGNATURE n'est visible et utilisable QUE par son propriétaire.
 *     Pas par son rôle, pas par la direction, pas par un administrateur.
 *   • Un CACHET appartient à la société : visible de tous ceux qui ont le
 *     module, mais jamais au-delà de la frontière entre les deux maisons.
 *
 * ON NE SUPPRIME PAS UNE SIGNATURE, ON LA RÉVOQUE. Les documents déjà signés
 * restent signés ; la trace garde son sens. Effacer la ligne rendrait
 * inexplicables les signatures déjà apposées.
 *
 * CHAQUE APPOSITION PRODUIT UNE VERSION DE PLUS, jamais une réécriture.
 * L'original non signé reste intact et téléchargeable : c'est ce qui permet
 * de montrer ce qui a été soumis avant signature. Et la trace garde les
 * empreintes d'avant et d'après, pour dire exactement ce qui a été signé.
 */
const S = require("./studio-stockage");
const B = require("./studio-bibliotheque");
const { apposer: apposerPdf, decrire } = require("./pdf-apposition");
const { dimensions } = require("./image-dimensions");

const MOTIF_MINIMUM = 10;
/* Une signature est une image, et seulement une image. Le PNG est le format
   voulu : il porte la transparence, sans laquelle un rectangle blanc
   recouvrirait le texte du document. */
const IMAGES = new Set(["image/png", "image/jpeg"]);
/* Au-delà, c'est une photo, pas une signature : on refuse plutôt que de
   laisser grossir chaque PDF signé de plusieurs mégaoctets. */
const TAILLE_MAX = 2 * 1024 * 1024;

function erreur(message, code, httpStatus = 400) {
  const e = new Error(message);
  e.code = code; e.httpStatus = httpStatus;
  return e;
}
const nomDe = (u) => String(u?.name || u?.fullname || u?.email || "Utilisateur").slice(0, 200);

/* ─────────────────────────────────────────────────────────────────────────
   CE QU'UNE PERSONNE PEUT VOIR

   Sa signature, et les cachets de sa société. Rien d'autre — et la règle est
   dans la REQUÊTE, pas dans un filtrage après coup : une liste qui
   montrerait puis masquerait laisserait fuir le nombre de résultats.
   ───────────────────────────────────────────────────────────────────────── */
async function lister(client, { companyId, utilisateur, inclureRevoquees = false }) {
  const userId = Number(utilisateur?.id || 0);
  const { rows } = await client.query(
    `SELECT id, kind, owner_id, owner_name, label, mime, size_bytes, sha256,
            width_px, height_px, ratio, is_default, created_by_name, created_at,
            revoked_at, revoked_by_name, revoke_reason,
            (owner_id = $2) AS est_la_mienne,
            (SELECT count(*)::int FROM studio_signature_uses u
              WHERE u.signature_id = studio_signatures.id) AS appositions
       FROM studio_signatures
      WHERE company_id = $1
        AND (kind = 'CACHET' OR owner_id = $2)
        ${inclureRevoquees ? "" : "AND revoked_at IS NULL"}
      ORDER BY kind, is_default DESC, created_at DESC`,
    [companyId, userId]);
  return rows;
}

/* ─────────────────────────────────────────────────────────────────────────
   ACCÉDER À UNE SIGNATURE

   « Pas la vôtre » et « n'existe pas » répondent la même chose : savoir
   qu'une signature existe chez quelqu'un d'autre n'est l'affaire de
   personne.
   ───────────────────────────────────────────────────────────────────────── */
async function accessible(client, { companyId, utilisateur, signatureId, pourUtiliser = false }) {
  const { rows } = await client.query(
    `SELECT * FROM studio_signatures WHERE id = $1 AND company_id = $2`,
    [signatureId, companyId]);
  const s = rows[0];
  if (!s) throw erreur("Signature introuvable.", "SIGNATURE_INTROUVABLE", 404);

  if (s.kind === "SIGNATURE" && Number(s.owner_id) !== Number(utilisateur?.id || 0)) {
    throw erreur("Signature introuvable.", "SIGNATURE_INTROUVABLE", 404);
  }
  if (pourUtiliser && s.revoked_at) {
    /* Ici on DIT la raison : la personne a le droit de voir cette signature,
       et lui répondre « introuvable » l'enverrait la chercher en vain. */
    throw erreur(
      `Cette ${s.kind === "CACHET" ? "cachet a" : "signature a"} été révoquée le ` +
      `${new Date(s.revoked_at).toLocaleDateString("fr-FR")} : ${s.revoke_reason}`,
      "SIGNATURE_REVOQUEE", 409);
  }
  return s;
}

/* ─────────────────────────────────────────────────────────────────────────
   ENREGISTRER
   ───────────────────────────────────────────────────────────────────────── */
async function enregistrer(client, {
  companyId, utilisateur, buffer, mimeAnnonce, nomOrigine = "signature.png",
  kind = "SIGNATURE", label = "", parDefaut = false, ip = "",
}) {
  if (!["SIGNATURE", "CACHET"].includes(kind)) {
    throw erreur("Nature inconnue : une signature ou un cachet.", "NATURE_INCONNUE");
  }
  if (!buffer?.length) throw erreur("L'image est vide.", "IMAGE_VIDE");
  if (buffer.length > TAILLE_MAX) {
    throw erreur(
      `Une signature ne doit pas dépasser ${Math.round(TAILLE_MAX / 1024 / 1024)} Mo. ` +
      `Celle-ci en fait ${(buffer.length / 1024 / 1024).toFixed(1)}. ` +
      `Une photo de signature au lieu d'un tracé alourdit chaque document signé.`,
      "TROP_LOURDE");
  }

  const controle = S.verifier({ buffer, mimeAnnonce, nomOrigine });
  if (!IMAGES.has(controle.mime)) {
    throw erreur(
      `Une signature doit être une image PNG ou JPEG. Reçu : ${controle.mime}.`,
      "PAS_UNE_IMAGE", 415);
  }

  const d = dimensions(buffer);
  const cle = S.cleNouvelle(companyId);
  await S.ecrire(cle, buffer);

  try {
    /* LE DÉFAUT EST UNIQUE, et l'index l'impose. On retire l'ancien AVANT
       de poser le nouveau, sinon l'insertion se heurte à l'index — et deux
       signatures par défaut seraient pires encore : on ne saurait plus
       laquelle part sur le document. */
    if (parDefaut) {
      await client.query(
        `UPDATE studio_signatures SET is_default = FALSE
          WHERE company_id = $1 AND kind = $2 AND revoked_at IS NULL
            AND ($3::int IS NULL OR owner_id = $3)`,
        [companyId, kind, kind === "SIGNATURE" ? Number(utilisateur?.id || 0) : null]);
    }

    const { rows } = await client.query(
      `INSERT INTO studio_signatures
         (company_id, kind, owner_id, owner_name, label, storage_key, mime,
          size_bytes, sha256, width_px, height_px, ratio, is_default,
          created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [companyId, kind,
        kind === "SIGNATURE" ? (utilisateur?.id || null) : null,
        kind === "SIGNATURE" ? nomDe(utilisateur) : "",
        String(label || "").slice(0, 200),
        cle, controle.mime, controle.taille, controle.sha256,
        d?.largeur ?? null, d?.hauteur ?? null,
        d && d.hauteur ? Number((d.largeur / d.hauteur).toFixed(4)) : null,
        !!parDefaut, utilisateur?.id || null, nomDe(utilisateur)]);
    return rows[0];
  } catch (e) {
    /* La ligne n'existe pas : l'image ne doit pas rester derrière. */
    await S.supprimer(cle).catch(() => {});
    throw e;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   DÉSIGNER CELLE QUI SERT PAR DÉFAUT
   ───────────────────────────────────────────────────────────────────────── */
async function definirDefaut(client, { companyId, utilisateur, signatureId }) {
  const s = await accessible(client, { companyId, utilisateur, signatureId, pourUtiliser: true });
  await client.query(
    `UPDATE studio_signatures SET is_default = FALSE
      WHERE company_id = $1 AND kind = $2 AND revoked_at IS NULL
        AND ($3::int IS NULL OR owner_id = $3)`,
    [companyId, s.kind, s.kind === "SIGNATURE" ? Number(utilisateur?.id || 0) : null]);
  const { rows } = await client.query(
    `UPDATE studio_signatures SET is_default = TRUE WHERE id = $1 RETURNING *`,
    [signatureId]);
  return rows[0];
}

/* ─────────────────────────────────────────────────────────────────────────
   RÉVOQUER
   ───────────────────────────────────────────────────────────────────────── */
async function revoquer(client, { companyId, utilisateur, signatureId, motif }) {
  const s = await accessible(client, { companyId, utilisateur, signatureId });
  if (s.revoked_at) {
    throw erreur("Cette signature est déjà révoquée.", "DEJA_REVOQUEE", 409);
  }
  const m = String(motif || "").trim();
  if (m.length < MOTIF_MINIMUM) {
    throw erreur(
      `Dites pourquoi (${MOTIF_MINIMUM} caractères minimum). On relira cette ligne ` +
      `le jour où une signature apposée avec elle sera contestée.`,
      "MOTIF_REQUIS");
  }
  const { rows } = await client.query(
    `UPDATE studio_signatures
        SET revoked_at = now(), revoked_by_name = $2, revoke_reason = $3,
            is_default = FALSE
      WHERE id = $1 RETURNING *`,
    [signatureId, nomDe(utilisateur), m.slice(0, 500)]);
  return rows[0];
}

/* ─────────────────────────────────────────────────────────────────────────
   LES PAGES D'UN DOCUMENT, pour que l'écran sache où poser
   ───────────────────────────────────────────────────────────────────────── */
async function pagesDe(client, { companyId, utilisateur, documentId }) {
  const { document } = await B.acces(client, {
    companyId, utilisateur, documentId, requis: "LECTURE", inclureCorbeille: true });
  if (document.mime !== "application/pdf") {
    throw erreur(
      "On n'appose une signature que sur un PDF. Ce document est au format " +
      `${document.mime}.`,
      "PAS_UN_PDF", 415);
  }
  const octets = await S.octets(document.storage_key);
  return { document, pages: await decrire(octets) };
}

/* ─────────────────────────────────────────────────────────────────────────
   APPOSER
   ───────────────────────────────────────────────────────────────────────── */
async function apposer(client, {
  companyId, utilisateur, documentId, signatureId, page, rect,
  opacite = 1, note = "", ip = "",
}) {
  /* MODIFICATION, pas lecture : signer change le document. Une personne qui
     n'a ce document qu'en lecture ne doit pas pouvoir le signer.

     `inclureCorbeille` NE DESSERRE RIEN : la personne a déjà le droit de
     modifier ce document, et la bibliothèque le lui montre dans sa
     corbeille. Sans cela, le contrôle explicite juste en dessous était
     inatteignable et l'on répondait « introuvable » à quelqu'un qui a le
     document sous les yeux — exactement le cul-de-sac déjà corrigé sur la
     fiche de la bibliothèque. Mieux vaut dire « restaurez-le d'abord ». */
  const { document } = await B.acces(client, {
    companyId, utilisateur, documentId, requis: "MODIFICATION",
    inclureCorbeille: true });
  if (document.trashed_at) {
    throw erreur(
      "Ce document est à la corbeille. Restaurez-le avant de le signer.",
      "DOCUMENT_A_LA_CORBEILLE", 409);
  }
  if (document.mime !== "application/pdf") {
    throw erreur(
      `On n'appose une signature que sur un PDF. Ce document est au format ${document.mime}.`,
      "PAS_UN_PDF", 415);
  }

  const signature = await accessible(client, {
    companyId, utilisateur, signatureId, pourUtiliser: true });

  /* LES DEUX FICHIERS SONT RELUS ET LEURS EMPREINTES REVÉRIFIÉES. Signer un
     document altéré sur le disque produirait une pièce qu'on croirait
     fidèle ; apposer une signature altérée serait pire encore. */
  const pdf = await S.octets(document.storage_key).catch(() => null);
  if (!pdf) throw erreur("Le fichier du document est introuvable.", "FICHIER_INTROUVABLE", 409);
  if (S.empreinte(pdf) !== document.sha256) {
    throw erreur(
      "Ce document ne correspond plus à son empreinte : il a été altéré. Il n'est pas signé.",
      "DOCUMENT_ALTERE", 409);
  }
  const image = await S.octets(signature.storage_key).catch(() => null);
  if (!image) throw erreur("L'image de la signature est introuvable.", "IMAGE_INTROUVABLE", 409);
  if (S.empreinte(image) !== signature.sha256) {
    throw erreur(
      "Cette signature ne correspond plus à son empreinte : elle a été altérée. Elle n'est pas apposée.",
      "SIGNATURE_ALTEREE", 409);
  }

  const resultat = await apposerPdf({
    pdf, image, mime: signature.mime, page, rect, opacite });

  const versionAvant = Number(document.version);
  const qui = nomDe(utilisateur);
  const quoi = signature.kind === "CACHET"
    ? `Cachet « ${signature.label || "sans nom"} » apposé`
    : `Signé par ${qui}`;
  const apres = await B.nouvelleVersion(client, {
    companyId, utilisateur, documentId,
    buffer: resultat.buffer, mimeAnnonce: "application/pdf",
    nomOrigine: document.name,
    /* La note se relit seule dans l'historique : « Signé par Moussa Traoré
       en page 3 » dit ce qui s'est passé, « modification » ne dit rien. */
    note: `${quoi} en page ${resultat.page}${note ? ` — ${String(note).slice(0, 200)}` : ""}`,
    pageCount: resultat.pages, ip,
  });

  await client.query(
    `INSERT INTO studio_signature_uses
       (company_id, signature_id, signature_kind, signature_label, signature_sha256,
        document_id, document_name, version_before, version_after,
        page_number, pos_x, pos_y, width_pt, height_pt,
        sha256_before, sha256_after, acted_by, acted_by_name, ip, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [companyId, signature.id, signature.kind, signature.label, signature.sha256,
      documentId, document.name, versionAvant, Number(apres.version),
      resultat.page, resultat.rect.x, resultat.rect.y,
      resultat.rect.largeur, resultat.rect.hauteur,
      document.sha256, apres.sha256,
      utilisateur?.id || null, qui, String(ip || ""), String(note || "").slice(0, 500)]);

  const { ocr_text: _o, ...sansTexte } = apres;
  return {
    document: sansTexte,
    apposition: {
      page: resultat.page, rotation: resultat.rotation,
      taille_page: resultat.taillePage, rect: resultat.rect,
      version_avant: versionAvant, version_apres: Number(apres.version),
      empreinte_avant: document.sha256, empreinte_apres: apres.sha256,
    },
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   LA TRACE D'UN DOCUMENT
   ───────────────────────────────────────────────────────────────────────── */
async function traceDe(client, { companyId, utilisateur, documentId }) {
  /* On vérifie d'abord l'accès au document : la trace dit qui a signé, ce
     qui n'est pas public. */
  await B.acces(client, {
    companyId, utilisateur, documentId, requis: "LECTURE", inclureCorbeille: true });
  const { rows } = await client.query(
    `SELECT id, signature_kind, signature_label, document_name,
            version_before, version_after, page_number,
            pos_x, pos_y, width_pt, height_pt,
            sha256_before, sha256_after, acted_by_name, acted_at, note
       FROM studio_signature_uses
      WHERE document_id = $1 AND company_id = $2
      ORDER BY acted_at DESC`, [documentId, companyId]);
  return rows;
}

module.exports = {
  MOTIF_MINIMUM, IMAGES, TAILLE_MAX,
  lister, accessible, enregistrer, definirDefaut, revoquer,
  pagesDe, apposer, traceDe,
};

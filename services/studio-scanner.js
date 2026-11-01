"use strict";
/**
 * LE SCANNER : DES PAGES, PUIS UN DOCUMENT.
 *
 * Une séance de numérisation est un BROUILLON. Tant qu'elle n'est pas
 * assemblée, ses pages ne sont pas dans la bibliothèque : elles ne se
 * cherchent pas, ne se partagent pas, et personne d'autre que leur auteur ne
 * les voit. Un brouillon ne se diffuse pas.
 *
 * TROIS RÈGLES.
 *
 * 1. UNE SÉANCE APPARTIENT À UNE SEULE PERSONNE. Pas au rôle, pas à la
 *    société : à celui qui scanne. Scanner un bulletin de paie ou un relevé
 *    médical ne doit pas le rendre lisible par un collègue avant qu'on ait
 *    choisi où le ranger et qui peut le voir. La frontière de société reste
 *    en plus, pas à la place.
 *
 * 2. CHAQUE PAGE EST RANGÉE DÈS SA CAPTURE. Scanner dix pages prend des
 *    minutes ; pendant ce temps l'écran se verrouille, un appel entre, le
 *    navigateur recharge l'onglet. Des pages qui ne vivraient que dans la
 *    page web seraient perdues — et la deuxième fois, on ne scanne plus, on
 *    photographie mal.
 *
 * 3. ASSEMBLER NE DÉTRUIT RIEN. Le PDF produit est un document ordinaire de
 *    la bibliothèque ; les pages d'origine restent jusqu'à ce qu'on demande
 *    de les retirer. C'est ce qui permet de réassembler autrement quand le
 *    résultat déçoit, au lieu de tout rescanner.
 */
const S = require("./studio-stockage");
const B = require("./studio-bibliotheque");
const { assembler: assemblerPdf } = require("./pdf-scan");
const { dimensions } = require("./image-dimensions");

const PAGES_MAX = 200;
/* Le garage où l'on range provisoirement un rang pour éviter l'index unique.
   Très au-delà de PAGES_MAX, donc jamais confondu avec un rang réel, et
   au-dessus de 1, donc accepté par la contrainte de la table. */
const HORS_DOMAINE = 1_000_000;
/* Ce qu'une caméra de navigateur produit. Le WebP est accepté à la capture
   mais refusé à l'assemblage par pdfkit : on le dit ici plutôt que de le
   découvrir à la fin d'une séance de trente pages. */
const IMAGES = new Set(["image/png", "image/jpeg"]);

function erreur(message, code, httpStatus = 400) {
  const e = new Error(message);
  e.code = code; e.httpStatus = httpStatus;
  return e;
}
const nomDe = (u) => String(u?.name || u?.fullname || u?.email || "Utilisateur").slice(0, 200);

/* ─────────────────────────────────────────────────────────────────────────
   RETROUVER SA SÉANCE
   Introuvable et « pas la vôtre » répondent la même chose : savoir qu'une
   séance existe chez quelqu'un d'autre n'est l'affaire de personne.
   ───────────────────────────────────────────────────────────────────────── */
async function seance(client, { companyId, utilisateur, sessionId, exigerEnCours = true }) {
  const { rows } = await client.query(
    `SELECT * FROM studio_scan_sessions WHERE id = $1 AND company_id = $2`,
    [sessionId, companyId]);
  const s = rows[0];
  if (!s) throw erreur("Séance introuvable.", "SEANCE_INTROUVABLE", 404);
  if (Number(s.owner_id) !== Number(utilisateur?.id || 0)) {
    throw erreur("Séance introuvable.", "SEANCE_INTROUVABLE", 404);
  }
  if (exigerEnCours && s.status !== "EN_COURS") {
    throw erreur(
      s.status === "ASSEMBLEE"
        ? "Cette séance est déjà assemblée : son document est dans la bibliothèque."
        : "Cette séance a été abandonnée.",
      "SEANCE_CLOSE", 409);
  }
  return s;
}

/* ─────────────────────────────────────────────────────────────────────────
   DÉCALER DES RANGS SANS SE COGNER À L'INDEX UNIQUE

   (session_id, position) est unique. Un « position = position + 1 » sur un
   bloc contigu peut donc échouer : PostgreSQL vérifie l'unicité ligne par
   ligne pendant l'ordre, et rien ne garantit qu'il traite les lignes dans
   l'ordre qui éviterait la collision. Selon le plan retenu, le même code
   passe ou lève une violation de clé — autrement dit il marche en essai et
   casse un jour en production, sur une séance plus longue.

   On sort donc le bloc du domaine PAR LE HAUT, au-delà de tout rang
   plausible, puis on le repose. Deux ordres, zéro collision possible, quel
   que soit le plan.

   Par le haut et non par le bas : la table porte une contrainte
   « position >= 1 », et la première version de ce code passait par des
   valeurs négatives — que cette contrainte refusait. Elle avait raison : un
   rang négatif n'a pas de sens, même une milliseconde.
   ───────────────────────────────────────────────────────────────────────── */
async function decaler(client, sessionId, condition, params, delta) {
  /* ON RELÈVE D'ABORD QUELLES LIGNES SONT CONCERNÉES, et les deux ordres
     portent ensuite sur exactement ces lignes.

     La première version rabattait « toutes les lignes négatives » de la
     séance : elle retournait du même coup la page que `deplacerPage` avait
     volontairement sortie du domaine, qui revenait donc à un rang absurde.
     Un ensemble nommé une fois, utilisé deux fois, ne laisse pas cette
     place au hasard. */
  const { rows } = await client.query(
    `SELECT id FROM studio_scan_pages WHERE session_id = $1 AND ${condition}`,
    [sessionId, ...params]);
  if (!rows.length) return 0;
  const ids = rows.map((r) => r.id);
  await client.query(
    `UPDATE studio_scan_pages SET position = position + ${HORS_DOMAINE} + $2
      WHERE id = ANY($1::bigint[])`, [ids, delta]);
  await client.query(
    `UPDATE studio_scan_pages SET position = position - ${HORS_DOMAINE}
      WHERE id = ANY($1::bigint[])`, [ids]);
  return ids.length;
}

/* ─────────────────────────────────────────────────────────────────────────
   OUVRIR
   ───────────────────────────────────────────────────────────────────────── */
async function ouvrir(client, {
  companyId, utilisateur, titre = "", folderId = null,
  visibility = "PRIVE", pageFormat = "AUTO", ocrLanguage = "",
}) {
  if (folderId) {
    const { rows } = await client.query(
      `SELECT 1 FROM studio_folders WHERE id = $1 AND company_id = $2 AND trashed_at IS NULL`,
      [folderId, companyId]);
    if (!rows.length) throw erreur("Dossier introuvable.", "DOSSIER_INTROUVABLE", 404);
  }
  if (!["PRIVE", "EQUIPE", "SOCIETE"].includes(visibility)) {
    throw erreur("Visibilité inconnue.", "VISIBILITE_INCONNUE");
  }
  if (!["AUTO", "A4_PORTRAIT", "A4_PAYSAGE"].includes(pageFormat)) {
    throw erreur("Format de page inconnu.", "FORMAT_INCONNU");
  }
  const { rows } = await client.query(
    `INSERT INTO studio_scan_sessions
       (company_id, owner_id, owner_name, title, folder_id, visibility,
        page_format, ocr_language)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [companyId, utilisateur?.id || null, nomDe(utilisateur),
      String(titre || "").slice(0, 200), folderId, visibility, pageFormat,
      String(ocrLanguage || "").slice(0, 20)]);
  return rows[0];
}

/* ─────────────────────────────────────────────────────────────────────────
   CE QU'IL Y A À REPRENDRE
   ───────────────────────────────────────────────────────────────────────── */
async function aReprendre(client, { companyId, utilisateur }) {
  const { rows } = await client.query(
    `SELECT * FROM v_studio_scans_a_reprendre
      WHERE company_id = $1 AND owner_id = $2
      ORDER BY updated_at DESC LIMIT 50`,
    [companyId, Number(utilisateur?.id || 0)]);
  return rows;
}

async function detail(client, { companyId, utilisateur, sessionId }) {
  const s = await seance(client, { companyId, utilisateur, sessionId, exigerEnCours: false });
  const { rows: pages } = await client.query(
    `SELECT id, position, mime, size_bytes, sha256, width_px, height_px,
            corners, corrected, (length(ocr_text) > 0) AS texte_reconnu, captured_at
       FROM studio_scan_pages WHERE session_id = $1 ORDER BY position`, [sessionId]);
  return { seance: s, pages };
}

/* ─────────────────────────────────────────────────────────────────────────
   AJOUTER UNE PAGE
   ───────────────────────────────────────────────────────────────────────── */
async function ajouterPage(client, {
  companyId, utilisateur, sessionId, buffer, mimeAnnonce, nomOrigine = "page.png",
  position = null, corners = [], corrected = false, ocrText = "",
}) {
  const s = await seance(client, { companyId, utilisateur, sessionId });

  /* Le contrôle complet du dépôt : taille, type, extension, octets de tête.
     Une page de scan n'a pas à être moins vérifiée qu'un fichier reçu. */
  const controle = S.verifier({ buffer, mimeAnnonce, nomOrigine });
  if (!IMAGES.has(controle.mime)) {
    throw erreur(
      `Une page de scan doit être une image PNG ou JPEG. Reçu : ${controle.mime}.`,
      "PAGE_PAS_UNE_IMAGE", 415);
  }

  const { rows: compte } = await client.query(
    `SELECT count(*)::int AS n, coalesce(max(position), 0) AS dernier
       FROM studio_scan_pages WHERE session_id = $1`, [sessionId]);
  if (compte[0].n >= PAGES_MAX) {
    throw erreur(
      `Une séance porte au plus ${PAGES_MAX} pages. Assemblez celle-ci, puis ouvrez-en une autre.`,
      "TROP_DE_PAGES", 409);
  }

  /* INSÉRER AU MILIEU DÉCALE LA SUITE. C'est le cas d'une page oubliée :
     sans cela il faudrait recommencer la séance pour une seule feuille. */
  let rang = compte[0].dernier + 1;
  if (position !== null && position !== undefined) {
    rang = Math.max(1, Math.min(Number(position), compte[0].dernier + 1));
    if (rang <= compte[0].dernier) {
      await decaler(client, sessionId, "position >= $2", [rang], 1);
    }
  }

  const d = dimensions(buffer);
  const cle = S.cleNouvelle(companyId);
  await S.ecrire(cle, buffer);

  try {
    const { rows } = await client.query(
      `INSERT INTO studio_scan_pages
         (session_id, company_id, position, storage_key, mime, size_bytes,
          sha256, width_px, height_px, corners, corrected, ocr_text)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, position, mime, size_bytes, sha256, width_px, height_px,
                 corners, corrected, captured_at`,
      [sessionId, companyId, rang, cle, controle.mime, controle.taille,
        controle.sha256, d?.largeur ?? null, d?.hauteur ?? null,
        JSON.stringify(Array.isArray(corners) ? corners.slice(0, 4) : []),
        !!corrected, String(ocrText || "").slice(0, 200_000)]);
    await client.query(
      `UPDATE studio_scan_sessions SET updated_at = now() WHERE id = $1`, [sessionId]);
    return { page: rows[0], pages: compte[0].n + 1, seance: s };
  } catch (e) {
    /* La ligne n'existe pas : le fichier ne doit pas rester derrière, sinon
       le dépôt se remplit d'images que rien ne désigne. */
    await S.supprimer(cle).catch(() => {});
    throw e;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   RETIRER UNE PAGE, ET RESSERRER LES RANGS
   ───────────────────────────────────────────────────────────────────────── */
async function retirerPage(client, { companyId, utilisateur, sessionId, pageId }) {
  await seance(client, { companyId, utilisateur, sessionId });
  const { rows } = await client.query(
    `DELETE FROM studio_scan_pages
      WHERE id = $1 AND session_id = $2 AND company_id = $3
      RETURNING storage_key, position`, [pageId, sessionId, companyId]);
  const page = rows[0];
  if (!page) throw erreur("Page introuvable.", "PAGE_INTROUVABLE", 404);

  /* On resserre : sans cela on aurait les pages 1, 2, 4, et l'écran
     montrerait un trou que personne ne sait expliquer. */
  await decaler(client, sessionId, "position > $2", [page.position], -1);
  await client.query(
    `UPDATE studio_scan_sessions SET updated_at = now() WHERE id = $1`, [sessionId]);
  /* Le fichier part aussi : une page retirée d'un brouillon n'a aucune
     raison de survivre, et personne ne viendra la chercher. */
  await S.supprimer(page.storage_key).catch(() => {});
  return { retiree: page.position };
}

/* ─────────────────────────────────────────────────────────────────────────
   DÉPLACER UNE PAGE
   ───────────────────────────────────────────────────────────────────────── */
async function deplacerPage(client, { companyId, utilisateur, sessionId, pageId, vers }) {
  await seance(client, { companyId, utilisateur, sessionId });
  const { rows } = await client.query(
    `SELECT position FROM studio_scan_pages
      WHERE id = $1 AND session_id = $2`, [pageId, sessionId]);
  if (!rows.length) throw erreur("Page introuvable.", "PAGE_INTROUVABLE", 404);
  const de = rows[0].position;
  const { rows: m } = await client.query(
    `SELECT coalesce(max(position), 0) AS n FROM studio_scan_pages WHERE session_id = $1`,
    [sessionId]);
  const a = Math.max(1, Math.min(Number(vers), m[0].n));
  if (a === de) return { de, a };

  /* On sort la page déplacée du domaine, on décale le bloc qu'elle traverse,
     puis on la repose à son nouveau rang. */
  await client.query(
    `UPDATE studio_scan_pages SET position = ${HORS_DOMAINE * 2} WHERE id = $1`, [pageId]);
  if (a < de) {
    /* Elle remonte : tout ce qui est entre sa destination et son ancien rang
       descend d'un cran. */
    await decaler(client, sessionId, "position >= $2 AND position < $3", [a, de], 1);
  } else {
    await decaler(client, sessionId, "position > $2 AND position <= $3", [de, a], -1);
  }
  await client.query(`UPDATE studio_scan_pages SET position = $2 WHERE id = $1`, [pageId, a]);
  await client.query(
    `UPDATE studio_scan_sessions SET updated_at = now() WHERE id = $1`, [sessionId]);
  return { de, a };
}

/* ─────────────────────────────────────────────────────────────────────────
   LE FICHIER D'UNE PAGE, pour la revoir avant d'assembler
   ───────────────────────────────────────────────────────────────────────── */
async function fichierPage(client, { companyId, utilisateur, sessionId, pageId }) {
  await seance(client, { companyId, utilisateur, sessionId, exigerEnCours: false });
  const { rows } = await client.query(
    `SELECT storage_key, mime, size_bytes, sha256, position
       FROM studio_scan_pages WHERE id = $1 AND session_id = $2`, [pageId, sessionId]);
  if (!rows.length) throw erreur("Page introuvable.", "PAGE_INTROUVABLE", 404);
  return rows[0];
}

/* ─────────────────────────────────────────────────────────────────────────
   ASSEMBLER
   ───────────────────────────────────────────────────────────────────────── */
async function assembler(client, {
  companyId, utilisateur, sessionId, nom = "", description = "", tags = [], ip = "",
}) {
  const s = await seance(client, { companyId, utilisateur, sessionId });

  const { rows: pages } = await client.query(
    `SELECT id, position, storage_key, mime, sha256, ocr_text
       FROM studio_scan_pages WHERE session_id = $1 ORDER BY position`, [sessionId]);
  if (!pages.length) {
    throw erreur("Cette séance ne porte aucune page.", "AUCUNE_PAGE");
  }

  /* CHAQUE PAGE EST RELUE ET SON EMPREINTE REVÉRIFIÉE. Assembler un PDF à
     partir d'un fichier altéré sur le disque produirait un document qu'on
     croirait fidèle. */
  const chargees = [];
  for (const p of pages) {
    const buffer = await S.octets(p.storage_key).catch(() => null);
    if (!buffer) {
      throw erreur(
        `Le fichier de la page ${p.position} est introuvable dans le dépôt. ` +
        `Reprenez cette page avant d'assembler.`,
        "PAGE_FICHIER_INTROUVABLE", 409);
    }
    if (S.empreinte(buffer) !== p.sha256) {
      throw erreur(
        `La page ${p.position} ne correspond plus à son empreinte : elle a été ` +
        `altérée. Elle n'est pas assemblée.`,
        "PAGE_ALTEREE", 409);
    }
    chargees.push({ buffer, mime: p.mime });
  }

  const titre = String(nom || s.title || "Document numérisé").trim().slice(0, 200);
  const { buffer, pages: posees, avertissements } = await assemblerPdf({
    pages: chargees, format: s.page_format,
    titre, auteur: nomDe(utilisateur),
  });

  /* Le texte reconnu des pages, mis bout à bout : c'est ce qui rend le PDF
     trouvable par son contenu dans la bibliothèque. */
  const ocr = pages.map((p) => p.ocr_text).filter(Boolean).join("\n\n");

  const nomFichier = titre.toLowerCase().endsWith(".pdf") ? titre : `${titre}.pdf`;
  const document = await B.deposer(client, {
    companyId, utilisateur, ip,
    buffer, nomOrigine: nomFichier, mimeAnnonce: "application/pdf",
    folderId: s.folder_id, kind: "SCAN",
    description: String(description || "").slice(0, 2000),
    tags, visibility: s.visibility,
    ocrText: ocr, ocrLanguage: ocr ? (s.ocr_language || "") : "",
    pageCount: posees, scanSessionId: sessionId,
    sourceNote: `Assemblé depuis la séance de numérisation nº ${sessionId} (${posees} pages).`,
  });

  await client.query(
    `UPDATE studio_scan_sessions
        SET status = 'ASSEMBLEE', document_id = $2, assembled_at = now(), updated_at = now()
      WHERE id = $1`, [sessionId, document.id]);

  const { ocr_text: _o, ...sansTexte } = document;
  return { document: sansTexte, pages: posees, avertissements, texte_reconnu: ocr.length > 0 };
}

/* ─────────────────────────────────────────────────────────────────────────
   ABANDONNER
   ───────────────────────────────────────────────────────────────────────── */
async function abandonner(client, { companyId, utilisateur, sessionId, motif = "" }) {
  await seance(client, { companyId, utilisateur, sessionId });
  const { rows: pages } = await client.query(
    `SELECT storage_key FROM studio_scan_pages WHERE session_id = $1`, [sessionId]);
  await client.query(`DELETE FROM studio_scan_pages WHERE session_id = $1`, [sessionId]);
  await client.query(
    `UPDATE studio_scan_sessions
        SET status = 'ABANDONNEE', abandoned_at = now(),
            abandon_reason = $2, updated_at = now()
      WHERE id = $1`, [sessionId, String(motif || "").slice(0, 500)]);
  /* Les fichiers partent après la base : si la transaction échoue, on perd
     des fichiers déjà effacés pour des lignes qui existent encore — l'inverse
     laisserait des fichiers que rien ne désigne plus jamais. */
  let effaces = 0;
  for (const p of pages) {
    if (await S.supprimer(p.storage_key).catch(() => false)) effaces += 1;
  }
  return { pages_effacees: effaces };
}

/* ─────────────────────────────────────────────────────────────────────────
   RETIRER LES PAGES D'ORIGINE D'UNE SÉANCE DÉJÀ ASSEMBLÉE
   Les garder permet de réassembler ; les garder TOUJOURS double la place
   occupée par chaque scan. C'est donc un geste explicite, et il dit ce
   qu'il coûte.
   ───────────────────────────────────────────────────────────────────────── */
async function purgerPages(client, { companyId, utilisateur, sessionId }) {
  const s = await seance(client, { companyId, utilisateur, sessionId, exigerEnCours: false });
  if (s.status !== "ASSEMBLEE") {
    throw erreur(
      "On ne retire les pages d'origine qu'après assemblage : avant, ce sont les seules copies.",
      "SEANCE_PAS_ASSEMBLEE", 409);
  }
  const { rows: pages } = await client.query(
    `SELECT storage_key FROM studio_scan_pages WHERE session_id = $1`, [sessionId]);
  if (!pages.length) return { pages_effacees: 0, deja: true };
  await client.query(`DELETE FROM studio_scan_pages WHERE session_id = $1`, [sessionId]);
  let effaces = 0;
  for (const p of pages) {
    if (await S.supprimer(p.storage_key).catch(() => false)) effaces += 1;
  }
  return { pages_effacees: effaces, deja: false };
}

module.exports = {
  PAGES_MAX, IMAGES, HORS_DOMAINE,
  ouvrir, aReprendre, detail, seance,
  ajouterPage, retirerPage, deplacerPage, fichierPage,
  assembler, abandonner, purgerPages,
};

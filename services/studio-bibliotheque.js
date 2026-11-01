"use strict";

/**
 * LA BIBLIOTHÈQUE DU STUDIO.
 *
 * QUI VOIT QUOI. Un document est visible à son propriétaire, aux personnes
 * avec qui il est partagé nommément, et — s'il est marqué « SOCIETE » — à
 * toute l'entreprise. Rien d'autre. La société est vérifiée en premier, à
 * chaque fois : un document ne traverse jamais la frontière entre Triangle et
 * FAT & MAT, même pour un super-administrateur qui a basculé d'entreprise.
 *
 * L'ORIGINAL NE CHANGE JAMAIS. Enregistrer une modification crée une VERSION
 * de plus ; la version 1 garde son fichier et son empreinte. C'est ce qui
 * permet de dire, six mois plus tard, « voici ce qui avait été remis », et de
 * ne jamais présenter un document modifié comme un original.
 *
 * RIEN NE DISPARAÎT D'UN CLIC. Jeter met à la corbeille. Seule une
 * suppression définitive, explicite et tracée, efface les fichiers.
 */

const crypto = require("crypto");
const S = require("./studio-stockage");

const erreur = S.erreur;
const nomDe = (u) => u?.name || u?.fullname || "Utilisateur";

const NIVEAUX = Object.freeze({ LECTURE: 1, COMMENTAIRE: 2, MODIFICATION: 3, TELECHARGEMENT: 4 });
const MOTIF_MINIMUM = 10;

/* ─────────────────────────────────────────────────────────────────────────
   LE JOURNAL
   ───────────────────────────────────────────────────────────────────────── */
async function journaliser(client, { companyId, documentId = null, shareId = null,
  action, detail = "", utilisateur, ip = "" }) {
  try {
    await client.query(
      `INSERT INTO studio_access_log
         (company_id, document_id, share_id, action, detail, user_id, user_name, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [companyId, documentId, shareId, action, String(detail || "").slice(0, 500),
        utilisateur?.id || null, nomDe(utilisateur), String(ip || "").slice(0, 60)]);
  } catch (e) {
    /* Le journal ne doit jamais empêcher une opération légitime. */
    console.error("journal du studio :", e.message);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   L'ACCÈS À UN DOCUMENT
   ───────────────────────────────────────────────────────────────────────── */

/**
 * @returns {{document, niveau, motif}} ou lève une erreur 404.
 *
 * On répond 404 — et non 403 — quand l'accès manque : dire « ce document
 * existe mais pas pour vous » apprend déjà son existence. Le journal, lui,
 * garde la vraie raison.
 */
async function acces(client, { companyId, utilisateur, documentId, requis = "LECTURE",
  inclureCorbeille = false }) {
  const { rows } = await client.query(
    `SELECT * FROM studio_documents WHERE id = $1 AND company_id = $2`,
    [documentId, companyId]);
  const document = rows[0];
  if (!document) throw erreur("Document introuvable.", "DOCUMENT_INTROUVABLE", 404);
  if (document.trashed_at && !inclureCorbeille) {
    throw erreur("Document introuvable.", "DOCUMENT_INTROUVABLE", 404);
  }

  const userId = Number(utilisateur?.id || 0);
  let niveau = null, motif = null;

  if (Number(document.owner_id) === userId) {
    niveau = "TELECHARGEMENT"; motif = "PROPRIETAIRE";
  } else {
    const { rows: partages } = await client.query(
      `SELECT access FROM studio_shares
        WHERE document_id = $1 AND kind = 'INTERNE' AND grantee_user_id = $2`,
      [documentId, userId]);
    if (partages[0]) { niveau = partages[0].access; motif = "PARTAGE"; }
    else if (document.visibility === "SOCIETE") { niveau = "LECTURE"; motif = "SOCIETE"; }
    else if (document.visibility === "EQUIPE") {
      /* « Équipe » signifie ici : même société et même rôle que le
         propriétaire. Faute de table d'équipes dans ce schéma, on ne
         l'invente pas — on s'appuie sur ce qui existe, et on le dit. */
      const { rows: memeRole } = await client.query(
        `SELECT 1 FROM users a JOIN users b ON b.company_id = a.company_id AND b.role = a.role
          WHERE a.id = $1 AND b.id = $2 LIMIT 1`, [document.owner_id, userId]);
      if (memeRole.length) { niveau = "LECTURE"; motif = "EQUIPE"; }
    }
  }

  if (!niveau || NIVEAUX[niveau] < NIVEAUX[requis]) {
    throw erreur("Document introuvable.", "DOCUMENT_INTROUVABLE", 404);
  }
  return { document, niveau, motif };
}

/* ─────────────────────────────────────────────────────────────────────────
   LES DOSSIERS
   ───────────────────────────────────────────────────────────────────────── */
async function creerDossier(client, { companyId, nom, parentId = null, utilisateur }) {
  const n = String(nom || "").trim();
  if (!n) throw erreur("Le dossier doit avoir un nom.", "NOM_REQUIS");
  if (n.length > 120) throw erreur("Nom de dossier trop long (120 caractères).", "NOM_TROP_LONG");

  let chemin = n;
  if (parentId) {
    const { rows } = await client.query(
      `SELECT path, name FROM studio_folders WHERE id = $1 AND company_id = $2 AND trashed_at IS NULL`,
      [parentId, companyId]);
    if (!rows[0]) throw erreur("Dossier parent introuvable.", "PARENT_INTROUVABLE", 404);
    chemin = `${rows[0].path} / ${n}`;
  }

  try {
    const { rows } = await client.query(
      `INSERT INTO studio_folders (company_id, parent_id, name, path, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [companyId, parentId, n, chemin, utilisateur?.id || null, nomDe(utilisateur)]);
    return rows[0];
  } catch (e) {
    if (e.code === "23505") {
      throw erreur(`Un dossier « ${n} » existe déjà à cet endroit.`, "DOSSIER_EXISTE", 409);
    }
    throw e;
  }
}

async function listerDossiers(client, { companyId }) {
  const { rows } = await client.query(
    `SELECT f.*,
            (SELECT count(*)::int FROM studio_documents d
              WHERE d.folder_id = f.id AND d.trashed_at IS NULL) AS documents
       FROM studio_folders f
      WHERE f.company_id = $1 AND f.trashed_at IS NULL
      ORDER BY f.path`, [companyId]);
  return rows;
}

/* ─────────────────────────────────────────────────────────────────────────
   DÉPOSER UN DOCUMENT
   ───────────────────────────────────────────────────────────────────────── */
async function deposer(client, {
  companyId, utilisateur, buffer, nomOrigine, mimeAnnonce,
  folderId = null, kind = "FICHIER", description = "", tags = [],
  visibility = "PRIVE", sourceDocumentId = null, sourceNote = "",
  ocrText = "", ocrLanguage = "", pageCount = null, ip = "",
  /* D'où vient ce document, quand c'est un scan assemblé : on garde le lien
     vers la séance pour pouvoir remonter aux pages d'origine si le PDF
     déçoit, au lieu de tout rescanner. */
  scanSessionId = null,
}) {
  const controle = S.verifier({ buffer, mimeAnnonce, nomOrigine });

  if (folderId) {
    const { rows } = await client.query(
      `SELECT 1 FROM studio_folders WHERE id = $1 AND company_id = $2 AND trashed_at IS NULL`,
      [folderId, companyId]);
    if (!rows.length) throw erreur("Dossier introuvable.", "DOSSIER_INTROUVABLE", 404);
  }

  const nom = String(nomOrigine || "document").trim().slice(0, 200) || "document";
  const cle = S.cleNouvelle(companyId);
  await S.ecrire(cle, buffer);

  try {
    const { rows } = await client.query(
      `INSERT INTO studio_documents
         (company_id, folder_id, name, kind, mime, size_bytes, sha256, storage_key,
          page_count, version, ocr_text, ocr_language, tags, description, visibility,
          owner_id, owner_name, updated_by_name, source_document_id, source_note,
          scan_session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,$14,$15,$16,$16,$17,$18,$19)
       RETURNING *`,
      [companyId, folderId, nom, kind, controle.mime, controle.taille, controle.sha256, cle,
        pageCount, String(ocrText || "").slice(0, 2_000_000), String(ocrLanguage || ""),
        Array.isArray(tags) ? tags.map((t) => String(t).slice(0, 40)).slice(0, 20) : [],
        String(description || "").slice(0, 2000), visibility,
        utilisateur?.id || null, nomDe(utilisateur), sourceDocumentId, String(sourceNote || ""),
        scanSessionId]);
    const document = rows[0];

    /* La version 1 EST l'original. Elle porte la marque, et ne la perdra
       jamais : l'index unique partiel garantit qu'il n'y en a qu'une. */
    await client.query(
      `INSERT INTO studio_document_versions
         (document_id, company_id, version, storage_key, mime, size_bytes, sha256,
          page_count, change_note, is_original, created_by, created_by_name)
       VALUES ($1,$2,1,$3,$4,$5,$6,$7,'Dépôt initial',TRUE,$8,$9)`,
      [document.id, companyId, cle, controle.mime, controle.taille, controle.sha256,
        pageCount, utilisateur?.id || null, nomDe(utilisateur)]);

    await journaliser(client, {
      companyId, documentId: document.id, action: "DEPOT",
      detail: `${nom} (${controle.mime}, ${controle.taille} octets)`, utilisateur, ip,
    });
    return document;
  } catch (e) {
    /* Le fichier est déjà écrit : si la ligne échoue, on ne laisse pas un
       orphelin sur le disque. */
    await S.supprimer(cle);
    throw e;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   ENREGISTRER UNE NOUVELLE VERSION
   ───────────────────────────────────────────────────────────────────────── */
async function nouvelleVersion(client, {
  companyId, utilisateur, documentId, buffer, mimeAnnonce, nomOrigine,
  note, pageCount = null, ocrText = null, ip = "",
}) {
  const { document } = await acces(client, {
    companyId, utilisateur, documentId, requis: "MODIFICATION" });

  const n = String(note || "").trim();
  if (n.length < MOTIF_MINIMUM) {
    throw erreur(
      `Dites ce qui change (${MOTIF_MINIMUM} caractères minimum). « Correction du montant » se relit ; « modification » ne se relit pas.`,
      "NOTE_REQUISE");
  }

  const controle = S.verifier({
    buffer, mimeAnnonce: mimeAnnonce || document.mime,
    nomOrigine: nomOrigine || document.name });

  const cle = S.cleNouvelle(companyId);
  await S.ecrire(cle, buffer);

  try {
    const version = Number(document.version) + 1;
    await client.query(
      `INSERT INTO studio_document_versions
         (document_id, company_id, version, storage_key, mime, size_bytes, sha256,
          page_count, change_note, is_original, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,FALSE,$10,$11)`,
      [documentId, companyId, version, cle, controle.mime, controle.taille,
        controle.sha256, pageCount, n, utilisateur?.id || null, nomDe(utilisateur)]);

    const { rows } = await client.query(
      `UPDATE studio_documents
          SET storage_key = $3, mime = $4, size_bytes = $5, sha256 = $6,
              page_count = COALESCE($7, page_count), version = $8,
              ocr_text = COALESCE($9, ocr_text),
              updated_at = now(), updated_by_name = $10
        WHERE id = $1 AND company_id = $2 RETURNING *`,
      [documentId, companyId, cle, controle.mime, controle.taille, controle.sha256,
        pageCount, version, ocrText, nomDe(utilisateur)]);

    await journaliser(client, {
      companyId, documentId, action: "NOUVELLE_VERSION",
      detail: `v${version} — ${n}`, utilisateur, ip });
    return rows[0];
  } catch (e) {
    await S.supprimer(cle);
    throw e;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   LIRE
   ───────────────────────────────────────────────────────────────────────── */
async function lister(client, { companyId, utilisateur, folderId, recherche, tag,
  corbeille = false, limite = 200 }) {
  const userId = Number(utilisateur?.id || 0);
  const params = [companyId, userId];
  const conditions = ["d.company_id = $1"];

  conditions.push(corbeille ? "d.trashed_at IS NOT NULL" : "d.trashed_at IS NULL");
  /* La visibilité est posée dans la requête, pas filtrée après : une liste
     qui montrerait puis masquerait laisserait fuir le nombre de résultats. */
  conditions.push(`(d.owner_id = $2
                    OR d.visibility = 'SOCIETE'
                    OR EXISTS (SELECT 1 FROM studio_shares s
                                WHERE s.document_id = d.id AND s.kind = 'INTERNE'
                                  AND s.grantee_user_id = $2))`);

  if (folderId === null) { /* tous */ }
  else if (folderId === 0) conditions.push("d.folder_id IS NULL");
  else { params.push(folderId); conditions.push(`d.folder_id = $${params.length}`); }

  if (tag) { params.push(tag); conditions.push(`$${params.length} = ANY(d.tags)`); }

  let ordre = "d.updated_at DESC";
  if (recherche && String(recherche).trim()) {
    params.push(String(recherche).trim());
    const i = params.length;
    conditions.push(
      `(to_tsvector('french', coalesce(d.name,'') || ' ' || coalesce(d.description,'') || ' ' || coalesce(d.ocr_text,''))
        @@ plainto_tsquery('french', $${i})
        OR d.name ILIKE '%' || $${i} || '%')`);
    ordre = `ts_rank(to_tsvector('french', coalesce(d.name,'') || ' ' || coalesce(d.description,'') || ' ' || coalesce(d.ocr_text,'')), plainto_tsquery('french', $${i})) DESC, d.updated_at DESC`;
  }

  params.push(limite);
  const { rows } = await client.query(
    `SELECT d.id, d.name, d.kind, d.mime, d.size_bytes, d.sha256, d.page_count,
            d.version, d.tags, d.description, d.visibility, d.folder_id,
            d.owner_id, d.owner_name, d.created_at, d.updated_at, d.updated_by_name,
            d.trashed_at, d.trashed_by_name, d.source_document_id,
            f.path AS folder_path,
            (d.owner_id = $2) AS je_suis_proprietaire,
            (SELECT count(*)::int FROM studio_document_versions v WHERE v.document_id = d.id) AS versions,
            (SELECT count(*)::int FROM studio_shares s WHERE s.document_id = d.id AND s.revoked_at IS NULL) AS partages,
            /* Le texte reconnu n'est pas renvoyé : il peut peser des
               mégaoctets et n'a d'intérêt que pour la recherche. */
            (length(d.ocr_text) > 0) AS texte_reconnu
       FROM studio_documents d
       LEFT JOIN studio_folders f ON f.id = d.folder_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY ${ordre}
      LIMIT $${params.length}`, params);
  return rows;
}

async function detail(client, { companyId, utilisateur, documentId, ip = "" }) {
  /* LA CORBEILLE DOIT S'OUVRIR. Sans `inclureCorbeille`, la liste montrait
     le document jeté mais sa fiche répondait « introuvable » : on ne pouvait
     plus ni le restaurer ni le supprimer, puisque les deux boutons vivent
     dans cette fiche. La corbeille devenait un cul-de-sac. La fiche annonce
     d'elle-même l'état du document, et un lien public refuse toujours de
     l'ouvrir — c'est là qu'est la frontière, pas ici. */
  const { document, niveau, motif } = await acces(client, {
    companyId, utilisateur, documentId, inclureCorbeille: true });
  const { rows: versions } = await client.query(
    `SELECT id, version, mime, size_bytes, sha256, page_count, change_note,
            is_original, created_by_name, created_at
       FROM studio_document_versions WHERE document_id = $1 ORDER BY version DESC`,
    [documentId]);
  const { rows: partages } = await client.query(
    `SELECT s.id, s.kind, s.access, s.grantee_user_id, u.fullname AS grantee_name,
            s.expires_at, s.max_downloads, s.download_count, s.revoked_at,
            s.revoke_reason, s.created_by_name, s.created_at
       FROM studio_shares s LEFT JOIN users u ON u.id = s.grantee_user_id
      WHERE s.document_id = $1 ORDER BY s.id DESC`, [documentId]);
  const { rows: journal } = await client.query(
    `SELECT action, detail, user_name, acted_at FROM studio_access_log
      WHERE document_id = $1 ORDER BY acted_at DESC LIMIT 100`, [documentId]);

  await journaliser(client, { companyId, documentId, action: "LECTURE", utilisateur, ip });
  const { ocr_text: _ocr, ...sansTexte } = document;
  return { document: sansTexte, mon_niveau: niveau, motif_acces: motif, versions, partages, journal };
}

/* ─────────────────────────────────────────────────────────────────────────
   RENOMMER, DÉPLACER, CLASSER
   ───────────────────────────────────────────────────────────────────────── */
async function modifier(client, { companyId, utilisateur, documentId, champs = {}, ip = "" }) {
  await acces(client, { companyId, utilisateur, documentId, requis: "MODIFICATION" });
  const sets = [], params = [documentId, companyId];
  const detail = [];

  if (champs.name !== undefined) {
    const n = String(champs.name).trim();
    if (!n) throw erreur("Le document doit avoir un nom.", "NOM_REQUIS");
    params.push(n.slice(0, 200)); sets.push(`name = $${params.length}`);
    detail.push(`nom → ${n}`);
  }
  if (champs.folder_id !== undefined) {
    const f = champs.folder_id === null ? null : Number(champs.folder_id);
    if (f !== null) {
      const { rows } = await client.query(
        `SELECT 1 FROM studio_folders WHERE id=$1 AND company_id=$2 AND trashed_at IS NULL`,
        [f, companyId]);
      if (!rows.length) throw erreur("Dossier introuvable.", "DOSSIER_INTROUVABLE", 404);
    }
    params.push(f); sets.push(`folder_id = $${params.length}`);
    detail.push(`dossier → ${f ?? "racine"}`);
  }
  if (champs.description !== undefined) {
    params.push(String(champs.description).slice(0, 2000));
    sets.push(`description = $${params.length}`);
  }
  if (champs.tags !== undefined) {
    const t = Array.isArray(champs.tags)
      ? champs.tags.map((x) => String(x).trim().slice(0, 40)).filter(Boolean).slice(0, 20) : [];
    params.push(t); sets.push(`tags = $${params.length}`);
  }
  if (champs.visibility !== undefined) {
    if (!["PRIVE", "EQUIPE", "SOCIETE"].includes(champs.visibility)) {
      throw erreur("Visibilité inconnue.", "VISIBILITE_INVALIDE");
    }
    params.push(champs.visibility); sets.push(`visibility = $${params.length}`);
    detail.push(`visibilité → ${champs.visibility}`);
  }
  if (!sets.length) throw erreur("Rien à modifier.", "RIEN_A_MODIFIER");

  params.push(nomDe(utilisateur));
  const { rows } = await client.query(
    `UPDATE studio_documents SET ${sets.join(", ")}, updated_at = now(),
            updated_by_name = $${params.length}
      WHERE id = $1 AND company_id = $2 RETURNING *`, params);

  await journaliser(client, {
    companyId, documentId, action: champs.folder_id !== undefined ? "DEPLACEMENT" : "RENOMMAGE",
    detail: detail.join(", "), utilisateur, ip });
  const { ocr_text: _o, ...sansTexte } = rows[0];
  return sansTexte;
}

/* ─────────────────────────────────────────────────────────────────────────
   LA CORBEILLE
   ───────────────────────────────────────────────────────────────────────── */
async function jeter(client, { companyId, utilisateur, documentId, ip = "" }) {
  const { document } = await acces(client, {
    companyId, utilisateur, documentId, requis: "MODIFICATION" });
  if (document.trashed_at) throw erreur("Déjà à la corbeille.", "DEJA_CORBEILLE", 409);
  const { rows } = await client.query(
    `UPDATE studio_documents
        SET trashed_at = now(), trashed_by = $3, trashed_by_name = $4, updated_at = now()
      WHERE id = $1 AND company_id = $2 RETURNING id, name`,
    [documentId, companyId, utilisateur?.id || null, nomDe(utilisateur)]);
  await journaliser(client, { companyId, documentId, action: "CORBEILLE", utilisateur, ip });
  return rows[0];
}

async function restaurer(client, { companyId, utilisateur, documentId, ip = "" }) {
  const { document } = await acces(client, {
    companyId, utilisateur, documentId, requis: "MODIFICATION", inclureCorbeille: true });
  if (!document.trashed_at) throw erreur("Ce document n'est pas à la corbeille.", "PAS_A_LA_CORBEILLE", 409);
  const { rows } = await client.query(
    `UPDATE studio_documents
        SET trashed_at = NULL, trashed_by = NULL, trashed_by_name = '', updated_at = now()
      WHERE id = $1 AND company_id = $2 RETURNING id, name`, [documentId, companyId]);
  await journaliser(client, { companyId, documentId, action: "RESTAURATION", utilisateur, ip });
  return rows[0];
}

/**
 * La suppression définitive. Elle efface les fichiers de TOUTES les versions.
 * Elle exige un motif, et la ligne du journal reste après la disparition du
 * document — c'est tout ce qui restera pour expliquer le vide.
 */
async function supprimerDefinitivement(client, { companyId, utilisateur, documentId, motif, ip = "" }) {
  const m = String(motif || "").trim();
  if (m.length < MOTIF_MINIMUM) {
    throw erreur(
      `Motif obligatoire (${MOTIF_MINIMUM} caractères minimum) : après cette opération, il ne restera que lui.`,
      "MOTIF_REQUIS");
  }
  const { document } = await acces(client, {
    companyId, utilisateur, documentId, requis: "TELECHARGEMENT", inclureCorbeille: true });
  if (!document.trashed_at) {
    throw erreur(
      "Un document se met d'abord à la corbeille. La suppression définitive ne s'applique qu'à ce qui y est déjà.",
      "PAS_A_LA_CORBEILLE", 409);
  }

  const { rows: versions } = await client.query(
    `SELECT storage_key FROM studio_document_versions WHERE document_id = $1`, [documentId]);

  /* Le journal AVANT la suppression : la ligne garde document_id, qui ne
     référence plus rien ensuite — c'est voulu, elle doit survivre. */
  await journaliser(client, {
    companyId, documentId, action: "SUPPRESSION_DEFINITIVE",
    detail: `${document.name} — ${m} (${versions.length} version(s))`, utilisateur, ip });

  await client.query(`DELETE FROM studio_documents WHERE id = $1 AND company_id = $2`,
    [documentId, companyId]);
  for (const v of versions) await S.supprimer(v.storage_key);
  return { supprime: document.name, versions: versions.length };
}

/* ─────────────────────────────────────────────────────────────────────────
   LES PARTAGES
   ───────────────────────────────────────────────────────────────────────── */
async function partagerInterne(client, { companyId, utilisateur, documentId,
  destinataireId, niveau = "LECTURE", ip = "" }) {
  await acces(client, { companyId, utilisateur, documentId, requis: "TELECHARGEMENT" });
  if (!NIVEAUX[niveau]) throw erreur("Niveau d'accès inconnu.", "NIVEAU_INVALIDE");

  const { rows: dest } = await client.query(
    `SELECT id, fullname FROM users WHERE id = $1 AND company_id = $2 AND is_active = true`,
    [destinataireId, companyId]);
  if (!dest[0]) {
    throw erreur(
      "Destinataire introuvable dans cette société. Un document ne se partage pas au-delà de son entreprise.",
      "DESTINATAIRE_INTROUVABLE", 404);
  }
  if (Number(destinataireId) === Number(utilisateur?.id)) {
    throw erreur("Vous avez déjà accès à ce document.", "PARTAGE_A_SOI_MEME", 409);
  }

  const { rows } = await client.query(
    `INSERT INTO studio_shares
       (company_id, document_id, kind, grantee_user_id, access, created_by, created_by_name)
     VALUES ($1,$2,'INTERNE',$3,$4,$5,$6)
     ON CONFLICT (document_id, grantee_user_id) WHERE kind = 'INTERNE'
     DO UPDATE SET access = EXCLUDED.access
     RETURNING *`,
    [companyId, documentId, destinataireId, niveau, utilisateur?.id || null, nomDe(utilisateur)]);

  await journaliser(client, {
    companyId, documentId, shareId: rows[0].id, action: "PARTAGE",
    detail: `${dest[0].fullname} — ${niveau}`, utilisateur, ip });
  return rows[0];
}

/**
 * Un lien signé. Le jeton n'est rendu QU'UNE FOIS : la base n'en garde que
 * l'empreinte. Une fuite de la table ne donne donc aucun lien utilisable.
 */
async function creerLien(client, { companyId, utilisateur, documentId,
  heures = 72, maxTelechargements = null, ip = "" }) {
  await acces(client, { companyId, utilisateur, documentId, requis: "TELECHARGEMENT" });

  const h = Number(heures);
  if (!Number.isFinite(h) || h <= 0 || h > 24 * 30) {
    throw erreur("La durée d'un lien va de 1 heure à 30 jours.", "DUREE_INVALIDE");
  }
  const jeton = crypto.randomBytes(32).toString("base64url");
  const empreinte = crypto.createHash("sha256").update(jeton).digest("hex");

  const { rows } = await client.query(
    `INSERT INTO studio_shares
       (company_id, document_id, kind, token_sha256, expires_at, max_downloads,
        access, created_by, created_by_name)
     VALUES ($1,$2,'LIEN',$3, now() + ($4 || ' hours')::interval, $5,'LECTURE',$6,$7)
     RETURNING *`,
    [companyId, documentId, empreinte, String(h),
      maxTelechargements ? Number(maxTelechargements) : null,
      utilisateur?.id || null, nomDe(utilisateur)]);

  await journaliser(client, {
    companyId, documentId, shareId: rows[0].id, action: "PARTAGE",
    detail: `lien de ${h} h${maxTelechargements ? `, ${maxTelechargements} téléchargement(s)` : ""}`,
    utilisateur, ip });
  return { partage: rows[0], jeton };
}

/** Résout un jeton de lien. Ne rend le document que si le lien est vivant. */
async function lienValide(client, jeton) {
  const empreinte = crypto.createHash("sha256").update(String(jeton || "")).digest("hex");
  const { rows } = await client.query(
    `SELECT s.*, d.name, d.mime, d.storage_key, d.size_bytes, d.sha256, d.trashed_at
       FROM studio_shares s
       JOIN studio_documents d ON d.id = s.document_id
      WHERE s.token_sha256 = $1 AND s.kind = 'LIEN'`, [empreinte]);
  const lien = rows[0];
  if (!lien) return { valide: false, raison: "INTROUVABLE" };
  if (lien.revoked_at) return { valide: false, raison: "REVOQUE", lien };
  if (new Date(lien.expires_at) < new Date()) return { valide: false, raison: "EXPIRE", lien };
  if (lien.trashed_at) return { valide: false, raison: "DOCUMENT_A_LA_CORBEILLE", lien };
  if (lien.max_downloads && lien.download_count >= lien.max_downloads) {
    return { valide: false, raison: "EPUISE", lien };
  }
  return { valide: true, lien };
}

async function revoquer(client, { companyId, utilisateur, shareId, motif, ip = "" }) {
  const m = String(motif || "").trim();
  if (m.length < MOTIF_MINIMUM) {
    throw erreur(`Motif obligatoire (${MOTIF_MINIMUM} caractères minimum).`, "MOTIF_REQUIS");
  }
  const { rows: trouve } = await client.query(
    `SELECT * FROM studio_shares WHERE id = $1 AND company_id = $2`, [shareId, companyId]);
  const partage = trouve[0];
  if (!partage) throw erreur("Partage introuvable.", "PARTAGE_INTROUVABLE", 404);
  await acces(client, { companyId, utilisateur, documentId: partage.document_id, requis: "TELECHARGEMENT" });
  if (partage.revoked_at) throw erreur("Déjà révoqué.", "DEJA_REVOQUE", 409);

  const { rows } = await client.query(
    `UPDATE studio_shares SET revoked_at = now(), revoked_by_name = $2, revoke_reason = $3
      WHERE id = $1 RETURNING *`, [shareId, nomDe(utilisateur), m]);
  await journaliser(client, {
    companyId, documentId: partage.document_id, shareId, action: "REVOCATION",
    detail: m, utilisateur, ip });
  return rows[0];
}

module.exports = {
  NIVEAUX, MOTIF_MINIMUM, erreur, journaliser,
  acces, creerDossier, listerDossiers,
  deposer, nouvelleVersion, lister, detail, modifier,
  jeter, restaurer, supprimerDefinitivement,
  partagerInterne, creerLien, lienValide, revoquer,
};

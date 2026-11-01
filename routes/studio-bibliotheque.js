"use strict";

/**
 * LA BIBLIOTHÈQUE DU STUDIO — LES ROUTES.
 *
 *   GET    /studio/dossiers                  l'arborescence
 *   POST   /studio/dossiers                  créer un dossier
 *   GET    /studio/documents                 lister, chercher, filtrer
 *   POST   /studio/documents                 déposer un fichier
 *   GET    /studio/documents/:id             fiche, versions, partages, journal
 *   PATCH  /studio/documents/:id             renommer, déplacer, classer
 *   POST   /studio/documents/:id/versions    enregistrer une nouvelle version
 *   GET    /studio/documents/:id/fichier     télécharger la version courante
 *   GET    /studio/versions/:id/fichier      télécharger UNE version précise
 *   POST   /studio/documents/:id/corbeille   jeter
 *   POST   /studio/documents/:id/restaurer   sortir de la corbeille
 *   DELETE /studio/documents/:id             supprimer définitivement (motif)
 *   POST   /studio/documents/:id/partages    partager à une personne
 *   POST   /studio/documents/:id/liens       créer un lien signé
 *   DELETE /studio/partages/:id              révoquer (motif)
 *   GET    /studio/liens/:jeton              ouvrir un lien — SANS jeton de session
 *
 * LE SEUL POINT PUBLIC EST `/studio/liens/:jeton`, et il ne l'est qu'en
 * apparence : le jeton EST l'autorisation. Il expire, se révoque, se compte,
 * et la base n'en garde que l'empreinte.
 */

const express = require("express");
const multer = require("multer");
const B = require("../services/studio-bibliotheque");
const S = require("../services/studio-stockage");

const MODULE = "studio.bibliotheque";

/* Le fichier passe en mémoire, pas sur le disque : il doit être contrôlé —
   taille, type annoncé, octets de tête — AVANT d'exister quelque part. */
const televersement = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: S.TAILLE_MAX, files: 1 },
});

module.exports = function createStudioBibliothequeRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission, logActivity } = deps;
  const router = express.Router();

  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const requireCompany = (req, res) => {
    const id = companyOf(req);
    if (!id) { res.status(409).json({ error: "Entreprise active requise.", code: "COMPANY_REQUIRED" }); return 0; }
    return id;
  };
  const utilisateurDe = (req) => ({
    id: req.user?.id || null,
    name: req.user?.fullname || req.user?.email || "Utilisateur",
  });
  const ipDe = (req) =>
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "";
  const fail = (res, e, secours) => {
    if (!e.httpStatus) console.error(secours, e);
    res.status(e.httpStatus || 500).json({ error: e.message || secours, code: e.code });
  };

  /** Ouvre une transaction, l'exécute, la referme. */
  async function enTransaction(res, secours, travail) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await travail(client);
      await client.query("COMMIT");
      return r;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      fail(res, e, secours);
      return null;
    } finally { client.release(); }
  }

  /* ───────────────────────────── DOSSIERS ──────────────────────────────── */
  router.get("/studio/dossiers", authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try { res.json({ dossiers: await B.listerDossiers(pool, { companyId }) }); }
      catch (e) { fail(res, e, "Lecture des dossiers impossible."); }
    });

  router.post("/studio/dossiers", authenticateToken, requirePermission(MODULE, "create"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Création impossible.", (client) =>
        B.creerDossier(client, {
          companyId, nom: req.body?.nom,
          parentId: req.body?.parent_id ? Number(req.body.parent_id) : null,
          utilisateur: utilisateurDe(req),
        }));
      if (r) res.status(201).json({ dossier: r });
    });

  /* ──────────────────────────── DOCUMENTS ──────────────────────────────── */
  router.get("/studio/documents", authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const documents = await B.lister(pool, {
          companyId, utilisateur: utilisateurDe(req),
          folderId: req.query.dossier === undefined ? null
            : (req.query.dossier === "racine" ? 0 : Number(req.query.dossier)),
          recherche: req.query.q || null,
          tag: req.query.tag || null,
          corbeille: req.query.corbeille === "1",
          limite: Math.min(Number(req.query.limite) || 200, 500),
        });
        res.json({ documents });
      } catch (e) { fail(res, e, "Lecture impossible."); }
    });

  router.post("/studio/documents", authenticateToken, requirePermission(MODULE, "create"),
    televersement.single("fichier"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu.", code: "FICHIER_MANQUANT" });
      const r = await enTransaction(res, "Dépôt impossible.", (client) =>
        B.deposer(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          buffer: req.file.buffer,
          nomOrigine: req.body?.nom || req.file.originalname,
          mimeAnnonce: req.file.mimetype,
          folderId: req.body?.dossier_id ? Number(req.body.dossier_id) : null,
          kind: req.body?.kind || "FICHIER",
          description: req.body?.description || "",
          tags: req.body?.tags ? String(req.body.tags).split(",").map((t) => t.trim()).filter(Boolean) : [],
          visibility: req.body?.visibilite || "PRIVE",
          ocrText: req.body?.ocr_texte || "",
          ocrLanguage: req.body?.ocr_langue || "",
          pageCount: req.body?.pages ? Number(req.body.pages) : null,
          sourceDocumentId: req.body?.source_id ? Number(req.body.source_id) : null,
          sourceNote: req.body?.source_note || "",
        }));
      if (r) {
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `Document « ${r.name} » déposé au Studio`, "studio", `${r.size_bytes} octets`);
        const { ocr_text: _o, ...sansTexte } = r;
        res.status(201).json({ document: sansTexte });
      }
    });

  router.get("/studio/documents/:id", authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        res.json(await B.detail(pool, {
          companyId, utilisateur: utilisateurDe(req),
          documentId: Number(req.params.id), ip: ipDe(req),
        }));
      } catch (e) { fail(res, e, "Lecture impossible."); }
    });

  router.patch("/studio/documents/:id", authenticateToken, requirePermission(MODULE, "update"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Modification impossible.", (client) =>
        B.modifier(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          documentId: Number(req.params.id), champs: req.body || {},
        }));
      if (r) res.json({ document: r });
    });

  router.post("/studio/documents/:id/versions", authenticateToken, requirePermission(MODULE, "update"),
    televersement.single("fichier"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu.", code: "FICHIER_MANQUANT" });
      const r = await enTransaction(res, "Nouvelle version impossible.", (client) =>
        B.nouvelleVersion(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          documentId: Number(req.params.id),
          buffer: req.file.buffer, mimeAnnonce: req.file.mimetype,
          nomOrigine: req.file.originalname, note: req.body?.note,
          pageCount: req.body?.pages ? Number(req.body.pages) : null,
          ocrText: req.body?.ocr_texte || null,
        }));
      if (r) { const { ocr_text: _o, ...x } = r; res.status(201).json({ document: x }); }
    });

  /* ─────────────────────────── TÉLÉCHARGER ─────────────────────────────── */
  async function servirCle(res, { cle, nom, mime, taille, sha256, enLigne }) {
    if (!(await S.existe(cle))) {
      return res.status(404).json({ error: "Fichier introuvable.", code: "FICHIER_INTROUVABLE" });
    }
    /* L'EMPREINTE EST REVÉRIFIÉE AVANT DE SERVIR. Si le contenu rangé ne
       donne plus l'empreinte enregistrée, le fichier a été altéré : on refuse
       de le remettre plutôt que de laisser circuler un document dont on ne
       peut plus dire qu'il est le bon. */
    if (sha256) {
      const vue = await S.empreinteStockee(cle);
      if (vue !== sha256) {
        return res.status(409).json({
          error: "L'empreinte de ce fichier ne correspond plus à son contenu archivé. Il n'est pas servi.",
          code: "ARCHIVE_ALTEREE",
        });
      }
    }
    const sur = String(nom || "document").replace(/[\r\n"]/g, "").slice(0, 200);
    const ascii = sur.normalize("NFKD").replace(/[^\x20-\x7E]/g, "_") || "document";
    res.setHeader("Content-Type", mime || "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition",
      `${enLigne ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(sur)}`);
    if (taille) res.setHeader("Content-Length", String(taille));
    const flux = S.flux(cle);
    flux.on("error", () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
    flux.pipe(res);
  }

  router.get("/studio/documents/:id/fichier", authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        /* On sert aussi ce qui est à la corbeille : avant une suppression
           définitive, il faut pouvoir relire le document pour être sûr de
           ce qu'on détruit. Un lien public, lui, le refuse toujours. */
        const { document } = await B.acces(pool, {
          companyId, utilisateur: utilisateurDe(req),
          documentId: Number(req.params.id), requis: "LECTURE",
          inclureCorbeille: true });
        await B.journaliser(pool, {
          companyId, documentId: document.id, action: "TELECHARGEMENT",
          detail: `v${document.version}`, utilisateur: utilisateurDe(req), ip: ipDe(req) });
        await servirCle(res, {
          cle: document.storage_key, nom: document.name, mime: document.mime,
          taille: document.size_bytes, sha256: document.sha256,
          enLigne: req.query.apercu === "1",
        });
      } catch (e) { fail(res, e, "Téléchargement impossible."); }
    });

  router.get("/studio/versions/:id/fichier", authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const { rows } = await pool.query(
          `SELECT * FROM studio_document_versions WHERE id = $1 AND company_id = $2`,
          [Number(req.params.id), companyId]);
        const version = rows[0];
        if (!version) return res.status(404).json({ error: "Version introuvable.", code: "VERSION_INTROUVABLE" });
        const { document } = await B.acces(pool, {
          companyId, utilisateur: utilisateurDe(req),
          documentId: version.document_id, requis: "LECTURE",
          inclureCorbeille: true });
        await B.journaliser(pool, {
          companyId, documentId: document.id, action: "TELECHARGEMENT",
          detail: `version ${version.version}${version.is_original ? " (original)" : ""}`,
          utilisateur: utilisateurDe(req), ip: ipDe(req) });
        await servirCle(res, {
          cle: version.storage_key,
          nom: `${document.name} (v${version.version}${version.is_original ? " original" : ""})`,
          mime: version.mime, taille: version.size_bytes, sha256: version.sha256,
          enLigne: req.query.apercu === "1",
        });
      } catch (e) { fail(res, e, "Téléchargement impossible."); }
    });

  /* ──────────────────────────── CORBEILLE ──────────────────────────────── */
  router.post("/studio/documents/:id/corbeille", authenticateToken, requirePermission(MODULE, "update"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Mise à la corbeille impossible.", (client) =>
        B.jeter(client, { companyId, utilisateur: utilisateurDe(req),
          documentId: Number(req.params.id), ip: ipDe(req) }));
      if (r) res.json({ document: r, message: "Mis à la corbeille. Rien n'est effacé : vous pouvez le restaurer." });
    });

  router.post("/studio/documents/:id/restaurer", authenticateToken, requirePermission(MODULE, "update"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Restauration impossible.", (client) =>
        B.restaurer(client, { companyId, utilisateur: utilisateurDe(req),
          documentId: Number(req.params.id), ip: ipDe(req) }));
      if (r) res.json({ document: r });
    });

  router.delete("/studio/documents/:id", authenticateToken, requirePermission(MODULE, "delete"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Suppression impossible.", (client) =>
        B.supprimerDefinitivement(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          documentId: Number(req.params.id), motif: req.body?.motif }));
      if (r) {
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `Document « ${r.supprime} » supprimé définitivement du Studio`, "studio", req.body?.motif);
        res.json({ ...r, avertissement: "Les fichiers de toutes les versions ont été effacés. Seule la ligne du journal subsiste." });
      }
    });

  /* ───────────────────────────── PARTAGES ──────────────────────────────── */
  router.post("/studio/documents/:id/partages", authenticateToken, requirePermission(MODULE, "share"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Partage impossible.", (client) =>
        B.partagerInterne(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          documentId: Number(req.params.id),
          destinataireId: Number(req.body?.utilisateur_id),
          niveau: req.body?.niveau || "LECTURE" }));
      if (r) res.status(201).json({ partage: r });
    });

  router.post("/studio/documents/:id/liens", authenticateToken, requirePermission(MODULE, "share"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Création du lien impossible.", (client) =>
        B.creerLien(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          documentId: Number(req.params.id),
          heures: req.body?.heures ?? 72,
          maxTelechargements: req.body?.max_telechargements ?? null }));
      if (r) {
        /* LE JETON N'EST RENDU QU'ICI, UNE SEULE FOIS. La base n'en garde que
           l'empreinte : il ne pourra plus jamais être relu. */
        res.status(201).json({
          partage: { ...r.partage, token_sha256: undefined },
          lien: `/studio/liens/${r.jeton}`,
          avertissement: "Ce lien n'est affiché qu'une fois : il n'est pas conservé en clair. Copiez-le maintenant.",
        });
      }
    });

  router.delete("/studio/partages/:id", authenticateToken, requirePermission(MODULE, "share"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Révocation impossible.", (client) =>
        B.revoquer(client, { companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          shareId: Number(req.params.id), motif: req.body?.motif }));
      if (r) res.json({ partage: { ...r, token_sha256: undefined } });
    });

  /* ─────────────────── OUVRIR UN LIEN — SANS SESSION ───────────────────── */
  router.get("/studio/liens/:jeton", async (req, res) => {
    try {
      const r = await B.lienValide(pool, req.params.jeton);
      if (!r.valide) {
        if (r.lien) {
          await B.journaliser(pool, {
            companyId: r.lien.company_id, documentId: r.lien.document_id,
            shareId: r.lien.id, action: "REFUS",
            detail: `lien ${r.raison.toLowerCase()}`,
            utilisateur: { id: null, name: "lien public" }, ip: ipDe(req) });
        }
        /* Une seule réponse pour toutes les raisons : révoqué, expiré,
           épuisé ou inexistant. Les distinguer dirait à un curieux qu'un
           lien a existé. */
        return res.status(404).json({
          error: "Ce lien n'est plus valable.", code: "LIEN_INVALIDE",
        });
      }

      await pool.query(
        `UPDATE studio_shares SET download_count = download_count + 1 WHERE id = $1`,
        [r.lien.id]);
      await B.journaliser(pool, {
        companyId: r.lien.company_id, documentId: r.lien.document_id,
        shareId: r.lien.id, action: "LIEN_UTILISE",
        detail: `${r.lien.download_count + 1}ᵉ ouverture`,
        utilisateur: { id: null, name: "lien public" }, ip: ipDe(req) });

      await servirCle(res, {
        cle: r.lien.storage_key, nom: r.lien.name, mime: r.lien.mime,
        taille: r.lien.size_bytes, sha256: r.lien.sha256,
        enLigne: req.query.apercu === "1",
      });
    } catch (e) { fail(res, e, "Ouverture du lien impossible."); }
  });

  return router;
};

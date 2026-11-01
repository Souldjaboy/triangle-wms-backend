"use strict";
/**
 * LES ROUTES DU SCANNER.
 *
 * Une séance de numérisation est un brouillon privé : toutes ces routes
 * répondent « introuvable » pour la séance de quelqu'un d'autre, y compris à
 * l'intérieur de la même société. Confondre « vous n'y avez pas droit » et
 * « cela n'existe pas » est volontaire : la première réponse apprend qu'une
 * séance existe, la seconde n'apprend rien.
 */
const express = require("express");
const multer = require("multer");
const SC = require("../services/studio-scanner");
const S = require("../services/studio-stockage");

const MODULE = "studio.scanner";
/* La page passe en mémoire : elle doit être contrôlée — taille, type, octets
   de tête — AVANT d'exister quelque part. */
const televersement = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: S.TAILLE_MAX, files: 1 },
});

module.exports = function createStudioScannerRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission, logActivity } = deps;
  const router = express.Router();

  const requireCompany = (req, res) => {
    const id = Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
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

  /* ─────────────────────────── LES SÉANCES ───────────────────────────── */

  /** Ce qu'il y a à reprendre. C'est la première chose que l'écran demande :
      sept pages en attente valent mieux que sept pages refaites. */
  router.get("/studio/scans", authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        res.json({ seances: await SC.aReprendre(pool, {
          companyId, utilisateur: utilisateurDe(req) }) });
      } catch (e) { fail(res, e, "Lecture des séances impossible."); }
    });

  router.post("/studio/scans", authenticateToken, requirePermission(MODULE, "create"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Ouverture impossible.", (client) =>
        SC.ouvrir(client, {
          companyId, utilisateur: utilisateurDe(req),
          titre: req.body?.titre,
          folderId: req.body?.dossier_id ? Number(req.body.dossier_id) : null,
          visibility: req.body?.visibilite || "PRIVE",
          pageFormat: req.body?.format || "AUTO",
          ocrLanguage: req.body?.ocr_langue || "",
        }));
      if (r) res.status(201).json({ seance: r });
    });

  router.get("/studio/scans/:id", authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        res.json(await SC.detail(pool, {
          companyId, utilisateur: utilisateurDe(req), sessionId: Number(req.params.id) }));
      } catch (e) { fail(res, e, "Lecture impossible."); }
    });

  /* ──────────────────────────── LES PAGES ────────────────────────────── */

  router.post("/studio/scans/:id/pages", authenticateToken, requirePermission(MODULE, "create"),
    televersement.single("page"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      if (!req.file) {
        return res.status(400).json({ error: "Aucune image reçue.", code: "PAGE_MANQUANTE" });
      }
      /* Les coins arrivent en JSON dans un champ de formulaire multipart :
         une forme illisible ne doit pas faire perdre la page, elle est
         simplement oubliée. */
      let coins = [];
      if (req.body?.coins) {
        try { coins = JSON.parse(req.body.coins); } catch { coins = []; }
      }
      const r = await enTransaction(res, "Ajout de la page impossible.", (client) =>
        SC.ajouterPage(client, {
          companyId, utilisateur: utilisateurDe(req),
          sessionId: Number(req.params.id),
          buffer: req.file.buffer, mimeAnnonce: req.file.mimetype,
          nomOrigine: req.file.originalname || "page.png",
          position: req.body?.rang !== undefined && req.body.rang !== ""
            ? Number(req.body.rang) : null,
          corners: coins,
          corrected: String(req.body?.redressee || "") === "1",
          ocrText: req.body?.ocr_texte || "",
        }));
      if (r) res.status(201).json({ page: r.page, pages: r.pages });
    });

  router.delete("/studio/scans/:id/pages/:pageId", authenticateToken,
    requirePermission(MODULE, "create"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Retrait impossible.", (client) =>
        SC.retirerPage(client, {
          companyId, utilisateur: utilisateurDe(req),
          sessionId: Number(req.params.id), pageId: Number(req.params.pageId) }));
      if (r) res.json(r);
    });

  router.post("/studio/scans/:id/pages/:pageId/rang", authenticateToken,
    requirePermission(MODULE, "create"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Déplacement impossible.", (client) =>
        SC.deplacerPage(client, {
          companyId, utilisateur: utilisateurDe(req),
          sessionId: Number(req.params.id), pageId: Number(req.params.pageId),
          vers: Number(req.body?.vers) }));
      if (r) res.json(r);
    });

  /** L'image d'une page, pour la revoir avant d'assembler. */
  router.get("/studio/scans/:id/pages/:pageId/image", authenticateToken,
    requirePermission(MODULE, "view"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const page = await SC.fichierPage(pool, {
          companyId, utilisateur: utilisateurDe(req),
          sessionId: Number(req.params.id), pageId: Number(req.params.pageId) });
        if (!(await S.existe(page.storage_key))) {
          return res.status(404).json({ error: "Fichier introuvable.", code: "FICHIER_INTROUVABLE" });
        }
        /* L'empreinte est revérifiée : une page altérée sur le disque n'est
           pas remise, pour qu'on ne valide pas un scan qu'on croit avoir vu. */
        if (page.sha256 && (await S.empreinteStockee(page.storage_key)) !== page.sha256) {
          return res.status(409).json({
            error: "Cette page ne correspond plus à son empreinte. Elle n'est pas servie.",
            code: "PAGE_ALTEREE",
          });
        }
        res.setHeader("Content-Type", page.mime);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("Content-Length", String(page.size_bytes));
        res.setHeader("Content-Disposition",
          `inline; filename="page-${page.position}"`);
        const flux = S.flux(page.storage_key);
        flux.on("error", () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
        flux.pipe(res);
      } catch (e) { fail(res, e, "Lecture de la page impossible."); }
    });

  /* ───────────────────────────── ASSEMBLER ───────────────────────────── */

  router.post("/studio/scans/:id/assembler", authenticateToken,
    requirePermission(MODULE, "create"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Assemblage impossible.", (client) =>
        SC.assembler(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          sessionId: Number(req.params.id),
          nom: req.body?.nom, description: req.body?.description,
          tags: req.body?.tags
            ? String(req.body.tags).split(",").map((t) => t.trim()).filter(Boolean) : [],
        }));
      if (r) {
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `Scan « ${r.document.name} » assemblé en ${r.pages} pages`, "studio",
          r.texte_reconnu ? "avec texte reconnu" : "sans texte reconnu");
        res.status(201).json({
          ...r,
          /* On dit si le document sera trouvable par son contenu : sans
             texte reconnu, il ne se cherchera que par son nom, et mieux
             vaut le savoir en le rangeant qu'en le cherchant. */
          message: r.texte_reconnu
            ? "Document rangé dans la bibliothèque. Il est trouvable par son contenu."
            : "Document rangé dans la bibliothèque. Sans texte reconnu, il ne se cherchera que par son nom et sa description.",
        });
      }
    });

  router.post("/studio/scans/:id/abandonner", authenticateToken,
    requirePermission(MODULE, "create"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Abandon impossible.", (client) =>
        SC.abandonner(client, {
          companyId, utilisateur: utilisateurDe(req),
          sessionId: Number(req.params.id), motif: req.body?.motif }));
      if (r) res.json({ ...r, message: "Séance abandonnée. Les pages ont été effacées." });
    });

  router.delete("/studio/scans/:id/pages", authenticateToken,
    requirePermission(MODULE, "create"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Retrait des pages impossible.", (client) =>
        SC.purgerPages(client, {
          companyId, utilisateur: utilisateurDe(req), sessionId: Number(req.params.id) }));
      if (r) {
        res.json({ ...r, message: r.deja
          ? "Les pages d'origine avaient déjà été retirées."
          : "Pages d'origine effacées. Le PDF assemblé reste ; on ne pourra plus réassembler autrement." });
      }
    });

  return router;
};

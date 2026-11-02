"use strict";
/**
 * LES ROUTES DES SIGNATURES ET CACHETS.
 *
 * Deux droits distincts, et c'est voulu :
 *
 *   • « create » suffit pour avoir SA signature et s'en servir. Signer ce
 *     qu'on a le droit de modifier ne demande la permission de personne.
 *   • « validate » est exigé pour les CACHETS d'entreprise. Le tampon de la
 *     maison engage la maison : il ne se crée ni ne se révoque au même
 *     niveau qu'un paraphe personnel.
 *
 * L'image d'une signature n'est JAMAIS servie à quelqu'un d'autre que son
 * propriétaire — pas même en aperçu, pas même en basse définition. Une image
 * de signature, c'est la signature.
 */
const express = require("express");
const multer = require("multer");
const SG = require("../services/studio-signatures");
const S = require("../services/studio-stockage");

const MODULE = "studio.signature";
const televersement = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SG.TAILLE_MAX, files: 1 },
});

module.exports = function createStudioSignaturesRouter(deps) {
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

  /* ───────────────────────── CE QU'ON POSSÈDE ────────────────────────── */
  router.get("/studio/signatures", authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        res.json({ signatures: await SG.lister(pool, {
          companyId, utilisateur: utilisateurDe(req),
          inclureRevoquees: req.query.revoquees === "1" }) });
      } catch (e) { fail(res, e, "Lecture impossible."); }
    });

  router.post("/studio/signatures", authenticateToken, requirePermission(MODULE, "create"),
    televersement.single("image"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      if (!req.file) {
        return res.status(400).json({ error: "Aucune image reçue.", code: "IMAGE_MANQUANTE" });
      }
      const kind = req.body?.nature === "CACHET" ? "CACHET" : "SIGNATURE";
      /* LE CACHET DE LA MAISON DEMANDE DAVANTAGE. On ne peut pas le poser
         dans la liste des permissions du routeur, qui ne connaît pas encore
         la nature : on le vérifie ici, une fois le corps lu. */
      if (kind === "CACHET") {
        return requirePermission(MODULE, "validate")(req, res, async () => {
          const r = await enTransaction(res, "Enregistrement impossible.", (client) =>
            SG.enregistrer(client, {
              companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
              buffer: req.file.buffer, mimeAnnonce: req.file.mimetype,
              nomOrigine: req.file.originalname || "cachet.png",
              kind, label: req.body?.nom,
              parDefaut: String(req.body?.defaut || "") === "1",
            }));
          if (r) {
            logActivity?.(utilisateurDe(req).name, req.user?.role,
              `Cachet d'entreprise « ${r.label || "sans nom"} » enregistré`, "studio", "");
            res.status(201).json({ signature: r });
          }
        });
      }
      const r = await enTransaction(res, "Enregistrement impossible.", (client) =>
        SG.enregistrer(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          buffer: req.file.buffer, mimeAnnonce: req.file.mimetype,
          nomOrigine: req.file.originalname || "signature.png",
          kind, label: req.body?.nom,
          parDefaut: String(req.body?.defaut || "") === "1",
        }));
      if (r) res.status(201).json({ signature: r });
    });

  /** L'image — servie à son propriétaire seul, et jamais mise en cache. */
  router.get("/studio/signatures/:id/image", authenticateToken,
    requirePermission(MODULE, "view"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const s = await SG.accessible(pool, {
          companyId, utilisateur: utilisateurDe(req), signatureId: Number(req.params.id) });
        if (!(await S.existe(s.storage_key))) {
          return res.status(404).json({ error: "Image introuvable.", code: "IMAGE_INTROUVABLE" });
        }
        if ((await S.empreinteStockee(s.storage_key)) !== s.sha256) {
          return res.status(409).json({
            error: "Cette signature ne correspond plus à son empreinte. Elle n'est pas servie.",
            code: "SIGNATURE_ALTEREE",
          });
        }
        res.setHeader("Content-Type", s.mime);
        res.setHeader("X-Content-Type-Options", "nosniff");
        /* Jamais en cache : une signature laissée dans le cache d'un poste
           partagé est une signature qui traîne. */
        res.setHeader("Cache-Control", "private, no-store, max-age=0");
        res.setHeader("Content-Length", String(s.size_bytes));
        const flux = S.flux(s.storage_key);
        flux.on("error", () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
        flux.pipe(res);
      } catch (e) { fail(res, e, "Lecture impossible."); }
    });

  router.post("/studio/signatures/:id/defaut", authenticateToken,
    requirePermission(MODULE, "update"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Modification impossible.", (client) =>
        SG.definirDefaut(client, {
          companyId, utilisateur: utilisateurDe(req), signatureId: Number(req.params.id) }));
      if (r) res.json({ signature: r });
    });

  router.delete("/studio/signatures/:id", authenticateToken,
    requirePermission(MODULE, "update"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Révocation impossible.", (client) =>
        SG.revoquer(client, {
          companyId, utilisateur: utilisateurDe(req),
          signatureId: Number(req.params.id), motif: req.body?.motif }));
      if (r) {
        res.json({
          signature: r,
          message: "Révoquée. Les documents déjà signés avec elle restent signés : " +
            "leur trace garde son sens.",
        });
      }
    });

  /* ─────────────── OÙ POSER : LES PAGES DU DOCUMENT ──────────────────── */
  router.get("/studio/documents/:id/pages", authenticateToken,
    requirePermission(MODULE, "view"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const { document, pages } = await SG.pagesDe(pool, {
          companyId, utilisateur: utilisateurDe(req), documentId: Number(req.params.id) });
        res.json({ document: { id: document.id, name: document.name, version: document.version },
          pages });
      } catch (e) { fail(res, e, "Lecture impossible."); }
    });

  /* ───────────────────────────── APPOSER ─────────────────────────────── */
  router.post("/studio/documents/:id/signer", authenticateToken,
    requirePermission(MODULE, "create"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Signature impossible.", (client) =>
        SG.apposer(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          documentId: Number(req.params.id),
          signatureId: Number(req.body?.signature_id),
          page: Number(req.body?.page),
          rect: {
            x: Number(req.body?.x), y: Number(req.body?.y),
            largeur: Number(req.body?.largeur), hauteur: Number(req.body?.hauteur),
          },
          opacite: req.body?.opacite === undefined ? 1 : Number(req.body.opacite),
          note: req.body?.note || "",
        }));
      if (r) {
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `Document « ${r.document.name} » signé (v${r.apposition.version_apres})`,
          "studio", `page ${r.apposition.page}`);
        res.status(201).json({
          ...r,
          /* ON DIT CE QUI VIENT D'ARRIVER AU DOCUMENT. Laisser croire que le
             fichier a simplement été « mis à jour » masquerait qu'il existe
             désormais deux états, et que l'original non signé est toujours
             là. */
          message:
            `Signé. Le document est maintenant en version ${r.apposition.version_apres} ; ` +
            `la version ${r.apposition.version_avant}, non signée, reste intacte et ` +
            `téléchargeable dans l'historique.`,
        });
      }
    });

  router.get("/studio/documents/:id/signatures", authenticateToken,
    requirePermission(MODULE, "view"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        res.json({ appositions: await SG.traceDe(pool, {
          companyId, utilisateur: utilisateurDe(req), documentId: Number(req.params.id) }) });
      } catch (e) { fail(res, e, "Lecture impossible."); }
    });

  return router;
};

"use strict";
/**
 * LES ROUTES DU STUDIO GRAPHIQUE.
 *
 * Une création est un document de la bibliothèque qui porte son plan. Les
 * routes ci-dessous font donc l'aller-retour entre les deux : créer, rouvrir
 * le plan, enregistrer une modification — image et plan ensemble — et
 * produire un PDF d'impression aux vraies dimensions.
 */
const express = require("express");
const { recevoir } = require("../services/televersement");
const C = require("../services/studio-creations");
const S = require("../services/studio-stockage");

const MODULE = "studio.design";
/* LE PLAN VOYAGE DANS UN CHAMP DE FORMULAIRE, et multer limite les champs à
   un mégaoctet par défaut. Une mise en page un peu fournie dépassait donc
   cette limite AVANT d'arriver au contrôle applicatif, et le refus sortait
   en erreur 500 muette au lieu de dire ce qui n'allait pas. */
const recevoirImage = recevoir("image", { messages: {
  LIMIT_FIELD_VALUE:
    "Le plan de la création est trop lourd pour être envoyé. Déposez les images " +
    "dans la bibliothèque plutôt que de les inclure dans la mise en page.",
} });

module.exports = function createStudioCreationsRouter(deps) {

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

  router.get("/studio/creations", authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        res.json({ creations: await C.lister(pool, {
          companyId, utilisateur: utilisateurDe(req), limite: req.query.limite }) });
      } catch (e) { fail(res, e, "Lecture impossible."); }
    });

  router.post("/studio/creations", authenticateToken, requirePermission(MODULE, "create"),
    recevoirImage, async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      if (!req.file) {
        return res.status(400).json({ error: "Aucune image reçue.", code: "IMAGE_MANQUANTE" });
      }
      const r = await enTransaction(res, "Création impossible.", (client) =>
        C.creer(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          buffer: req.file.buffer, mimeAnnonce: req.file.mimetype,
          nom: req.body?.nom, plan: req.body?.plan,
          largeurMm: req.body?.largeur_mm, hauteurMm: req.body?.hauteur_mm,
          format: req.body?.format,
          folderId: req.body?.dossier_id ? Number(req.body.dossier_id) : null,
          visibility: req.body?.visibilite || "PRIVE",
          description: req.body?.description || "",
          tags: req.body?.tags
            ? String(req.body.tags).split(",").map((t) => t.trim()).filter(Boolean) : [],
        }));
      if (r) {
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `Création « ${r.name} » enregistrée au studio graphique`, "studio",
          `${r.design_mm_width}×${r.design_mm_height} mm`);
        res.status(201).json({ creation: r });
      }
    });

  router.get("/studio/creations/:id", authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        res.json(await C.plan(pool, {
          companyId, utilisateur: utilisateurDe(req), documentId: Number(req.params.id) }));
      } catch (e) { fail(res, e, "Lecture impossible."); }
    });

  router.post("/studio/creations/:id", authenticateToken, requirePermission(MODULE, "update"),
    recevoirImage, async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      if (!req.file) {
        return res.status(400).json({ error: "Aucune image reçue.", code: "IMAGE_MANQUANTE" });
      }
      const r = await enTransaction(res, "Enregistrement impossible.", (client) =>
        C.modifier(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          documentId: Number(req.params.id),
          buffer: req.file.buffer, mimeAnnonce: req.file.mimetype,
          plan: req.body?.plan,
          largeurMm: req.body?.largeur_mm, hauteurMm: req.body?.hauteur_mm,
          format: req.body?.format, note: req.body?.note,
        }));
      if (r) {
        res.json({
          creation: r,
          message: `Enregistré en version ${r.version}. La version précédente reste ` +
            `intacte et téléchargeable dans l'historique.`,
        });
      }
    });

  router.post("/studio/creations/:id/impression", authenticateToken,
    requirePermission(MODULE, "export"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Export impossible.", (client) =>
        C.exporterPdf(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          documentId: Number(req.params.id),
          exemplaires: req.body?.exemplaires, nom: req.body?.nom }));
      if (r) {
        res.status(201).json({
          ...r,
          /* ON DIT LES DIMENSIONS RÉELLES. « PDF créé » ne permet pas de
             vérifier avant d'envoyer chez l'imprimeur. */
          message: `PDF d'impression créé : ${r.exemplaires} page` +
            `${r.exemplaires > 1 ? "s" : ""} de ${r.mm.largeur}×${r.mm.hauteur} mm exactement.`,
        });
      }
    });

  return router;
};

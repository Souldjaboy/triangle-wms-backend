"use strict";
/**
 * LES ROUTES DE L'ÉDITEUR DE PAGES.
 *
 * Deux familles, et deux droits différents :
 *
 *   • « update » pour ce qui CHANGE le document — réordonner, tourner,
 *     retirer. Chaque geste produit une version de plus.
 *   • « create » pour ce qui en FABRIQUE d'autres — extraire, fusionner,
 *     découper. Les sources ne sont pas touchées, mais un nouveau document
 *     entre dans la bibliothèque.
 *
 * Chaque réponse dit COMBIEN de pages il y avait et combien il en reste : un
 * feuillet perdu en silence se découvre au mauvais moment.
 */
const express = require("express");
const E = require("../services/studio-pdf");

const MODULE = "studio.pdf";

module.exports = function createStudioPdfRouter(deps) {
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
    /* `index` est le rang, dans la liste envoyée, de l'annotation refusée.
       L'écran s'en sert pour sélectionner le cadre fautif : avec six cadres
       en attente, le message seul ne dit pas lequel corriger. */
    res.status(e.httpStatus || 500).json({
      error: e.message || secours, code: e.code,
      ...(e.index === undefined ? {} : { index: e.index }),
    });
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

  const listeDe = (v) => Array.isArray(v) ? v.map(Number) : [];

  /* ═══════════════════════ ANNOTER UNE PAGE ════════════════════════

     LA GÉOMÉTRIE D'ABORD. L'écran a besoin de savoir, pour chaque page, ses
     dimensions TELLES QU'ON LES VOIT — une page tournée d'un quart de tour
     se présente couchée — car c'est dans ce repère qu'il envoie les
     positions. Voir services/pdf-reperes.js : le contrat n'est pas celui de
     l'apposition de signature, et les mélanger envoie les annotations à
     l'autre bout de la page.                                             */
  router.get("/studio/documents/:id/pages-vues", authenticateToken,
    requirePermission(MODULE, "view"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        const pages = await E.pagesVues(client, {
          companyId, utilisateur: utilisateurDe(req), documentId: Number(req.params.id) });
        res.json({ pages, repere: "affichage" });
      } catch (e) { fail(res, e, "Lecture de la géométrie impossible."); }
      finally { client.release(); }
    });

  router.post("/studio/documents/:id/annotations", authenticateToken,
    requirePermission(MODULE, "update"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Annotation impossible.", (client) =>
        E.annoter(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          documentId: Number(req.params.id), annotations: req.body?.annotations }));
      if (r) {
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `Annotations posées sur « ${r.document.name} »`, "studio", `v${r.version}`);
        res.json({ ...r, message:
          `${r.posees.length} annotation${r.posees.length > 1 ? "s" : ""} posée${r.posees.length > 1 ? "s" : ""}. ` +
          `Le document est en version ${r.version} ; la précédente reste intacte.` });
      }
    });

  /* ═══════════════ CE QUI MODIFIE LE DOCUMENT ══════════════════════ */

  router.post("/studio/documents/:id/pages/ordre", authenticateToken,
    requirePermission(MODULE, "update"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Réorganisation impossible.", (client) =>
        E.reordonner(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          documentId: Number(req.params.id), ordre: listeDe(req.body?.ordre) }));
      if (r) {
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `Pages réordonnées dans « ${r.document.name} »`, "studio", `v${r.version}`);
        res.json({ ...r, message:
          `Pages réordonnées. Le document est en version ${r.version} ; la précédente reste intacte.` });
      }
    });

  router.post("/studio/documents/:id/pages/rotation", authenticateToken,
    requirePermission(MODULE, "update"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Rotation impossible.", (client) =>
        E.tourner(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          documentId: Number(req.params.id),
          pages: listeDe(req.body?.pages), angle: Number(req.body?.angle) }));
      if (r) {
        res.json({ ...r, message:
          `${r.tournees} page${r.tournees > 1 ? "s tournées" : " tournée"}. ` +
          `Le document est en version ${r.version} ; la précédente reste intacte.` });
      }
    });

  router.delete("/studio/documents/:id/pages", authenticateToken,
    requirePermission(MODULE, "update"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Retrait impossible.", (client) =>
        E.retirer(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          documentId: Number(req.params.id),
          pages: listeDe(req.body?.pages), motif: req.body?.motif }));
      if (r) {
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `Pages ${r.retirees.join(", ")} retirées de « ${r.document.name} »`,
          "studio", req.body?.motif);
        res.json({ ...r, message:
          `${r.avant} pages avant, ${r.apres} après. La version ${r.version - 1}, ` +
          `complète, reste téléchargeable dans l'historique.` });
      }
    });

  /* ═══════════════ CE QUI CRÉE DE NOUVEAUX DOCUMENTS ═══════════════ */

  router.post("/studio/documents/:id/pages/extraire", authenticateToken,
    requirePermission(MODULE, "create"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Extraction impossible.", (client) =>
        E.extraire(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          documentId: Number(req.params.id),
          pages: listeDe(req.body?.pages),
          nom: req.body?.nom || "",
          folderId: req.body?.dossier_id === undefined
            ? undefined : (req.body.dossier_id ? Number(req.body.dossier_id) : null),
          visibility: req.body?.visibilite }));
      if (r) {
        res.status(201).json({ ...r, message:
          `${r.pages} page${r.pages > 1 ? "s" : ""} extraite${r.pages > 1 ? "s" : ""} ` +
          `dans un nouveau document. « ${r.source} » n'a pas été modifié.` });
      }
    });

  router.post("/studio/pdf/fusion", authenticateToken,
    requirePermission(MODULE, "create"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Fusion impossible.", (client) =>
        E.fusionner(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          documentIds: listeDe(req.body?.documents),
          nom: req.body?.nom,
          folderId: req.body?.dossier_id ? Number(req.body.dossier_id) : null,
          visibility: req.body?.visibilite || "PRIVE" }));
      if (r) {
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `Fusion en « ${r.document.name} » (${r.pages} pages)`, "studio", "");
        res.status(201).json({ ...r, message:
          `${r.pages} pages assemblées. Les documents d'origine n'ont pas été modifiés.` });
      }
    });

  router.post("/studio/documents/:id/pages/decouper", authenticateToken,
    requirePermission(MODULE, "create"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const tranches = Array.isArray(req.body?.tranches)
        ? req.body.tranches.map((t) => ({ nom: t?.nom, pages: listeDe(t?.pages) }))
        : [];
      const r = await enTransaction(res, "Découpage impossible.", (client) =>
        E.decouper(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          documentId: Number(req.params.id), tranches,
          folderId: req.body?.dossier_id === undefined
            ? undefined : (req.body.dossier_id ? Number(req.body.dossier_id) : null),
          visibility: req.body?.visibilite }));
      if (r) {
        res.status(201).json({ ...r, message:
          `${r.crees.length} documents créés à partir de « ${r.source} », qui n'a pas été modifié.` +
          (r.oubliees.length
            ? ` Attention : ${r.oubliees.length} page${r.oubliees.length > 1 ? "s ne figurent" : " ne figure"} ` +
              `dans aucune partie (${r.oubliees.join(", ")}).`
            : "") });
      }
    });

  return router;
};

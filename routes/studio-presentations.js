"use strict";
/**
 * LES ROUTES DES PRÉSENTATIONS.
 *
 * Une présentation est un document de la bibliothèque qui porte son jeu de
 * diapositives. Les routes font l'aller-retour entre les deux : créer,
 * rouvrir, enregistrer — PDF et plan ensemble —, exporter vers PowerPoint, et
 * lire un .pptx déposé.
 *
 * DEUX CHOSES À NE PAS CONFONDRE DANS CE FICHIER.
 *
 * « lire un .pptx » n'enregistre RIEN : la route rend le plan et le compte
 * rendu de ce qui n'a pas été repris, et c'est l'écran qui montre les deux
 * avant que quiconque décide. Enregistrer d'abord et expliquer ensuite
 * mettrait dans la bibliothèque une présentation que personne n'a validée.
 *
 * « exporter vers PowerPoint » dépose un document DE PLUS, avec sa
 * provenance écrite. Il ne remplace pas la présentation : le PDF reste ce
 * qui se montre et se partage.
 */
const express = require("express");
const { recevoir, recevoirPlusieurs } = require("../services/televersement");
const P = require("../services/studio-presentations");

const MODULE = "studio.presentation";

/* LE PLAN VOYAGE DANS UN CHAMP DE FORMULAIRE, à côté des images. multer
   limite les champs à un mégaoctet par défaut : une présentation un peu
   fournie dépasse cette limite AVANT d'atteindre le contrôle applicatif, et
   le refus sort alors en 500 muette. */
const recevoirDiapositives = recevoirPlusieurs("diapositives", P.DIAPOS_MAX, {
  messages: {
    LIMIT_FIELD_VALUE:
      "Le plan de la présentation est trop lourd pour être envoyé. Allégez les images " +
      "des diapositives, ou déposez-les dans la bibliothèque plutôt que de les y inclure.",
  },
});
const recevoirPptx = recevoir("fichier", { messages: {
  LIMIT_FILE_SIZE: "Ce fichier .pptx dépasse la taille autorisée.",
} });

module.exports = function createStudioPresentationsRouter(deps) {
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

  /* Les images arrivent dans l'ordre du formulaire, qui est celui des
     diapositives. On le vérifie quand même : un champ nommé « diapo3 »
     avant « diapo1 » donnerait une présentation mélangée, et personne ne
     relit l'ordre des pages d'un PDF avant de le projeter. */
  const imagesDe = (req) => {
    const fichiers = Array.isArray(req.files) ? [...req.files] : [];
    const numerote = fichiers.every((f) => /^diapo(\d+)\./i.test(f.originalname || ""));
    if (numerote) {
      fichiers.sort((a, b) =>
        Number(/^diapo(\d+)\./i.exec(a.originalname)[1])
        - Number(/^diapo(\d+)\./i.exec(b.originalname)[1]));
    }
    return fichiers;
  };

  /* ═══════════════════ LES FORMATS PROPOSÉS ═══════════════════ */
  router.get("/studio/presentations/formats", authenticateToken,
    requirePermission(MODULE, "view"), (_req, res) => {
      res.json({ formats: Object.entries(P.FORMATS).map(([cle, f]) => ({
        cle, nom: f.nom, largeur_mm: f.largeurMm, hauteur_mm: f.hauteurMm })),
        diapositives_max: P.DIAPOS_MAX });
    });

  /* ═══════════════════════════ LISTER ═══════════════════════════ */
  router.get("/studio/presentations", authenticateToken,
    requirePermission(MODULE, "view"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        res.json({ presentations: await P.lister(client, {
          companyId, utilisateur: utilisateurDe(req), limite: req.query.limite }) });
      } catch (e) { fail(res, e, "Liste des présentations impossible."); }
      finally { client.release(); }
    });

  /* ═══════════════════════════ CRÉER ═══════════════════════════ */
  router.post("/studio/presentations", authenticateToken,
    requirePermission(MODULE, "create"), recevoirDiapositives, async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const images = imagesDe(req);
      if (!images.length) {
        res.status(400).json({
          error: "Aucune image de diapositive n'est arrivée. Chaque diapositive est envoyée " +
            "telle qu'elle a été dessinée à l'écran.",
          code: "AUCUNE_IMAGE" });
        return;
      }
      const r = await enTransaction(res, "Création impossible.", (client) =>
        P.creer(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req), images,
          plan: req.body?.plan, nom: req.body?.nom, format: req.body?.format,
          largeurMm: req.body?.largeur_mm, hauteurMm: req.body?.hauteur_mm,
          folderId: req.body?.dossier ? Number(req.body.dossier) : null,
          visibility: req.body?.visibilite || "PRIVE",
          description: req.body?.description || "",
          provenance: req.body?.provenance || "",
        }));
      if (r) {
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `Présentation créée : « ${r.name} »`, "studio",
          `${r.diapositives} diapositive(s)`);
        res.status(201).json({ document: r, message:
          `Présentation créée — ${r.diapositives} diapositive${r.diapositives > 1 ? "s" : ""}.` });
      }
    });

  /* ═══════════ LIRE UN .PPTX — SANS RIEN ENREGISTRER ═══════════

     CETTE ROUTE EST DÉCLARÉE AVANT « POST /studio/presentations/:id », ET CE
     N'EST PAS UN DÉTAIL DE PRÉSENTATION.

     Express retient la PREMIÈRE déclaration qui correspond. Si
     « POST /:id » venait d'abord, il avalerait « lecture-pptx » en prenant
     « lecture-pptx » pour un identifiant : Number() en ferait NaN, et la
     requête repartirait avec un refus incompréhensible. Aucune erreur ne
     serait levée au démarrage — c'est ainsi que ce dépôt compte déjà
     quatorze routes inatteignables.

     Le premier jet de ce fichier avait justement l'ordre inverse. */
  router.post("/studio/presentations/lecture-pptx", authenticateToken,
    requirePermission(MODULE, "create"), recevoirPptx, async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      if (!req.file?.buffer?.length) {
        res.status(400).json({ error: "Aucun fichier n'est arrivé.", code: "FICHIER_REQUIS" });
        return;
      }
      try {
        const r = await P.lirePptx({ octets: req.file.buffer });
        res.json({ ...r, message:
          `${r.plan.diapositives.length} diapositive${r.plan.diapositives.length > 1 ? "s" : ""} lue` +
          `${r.plan.diapositives.length > 1 ? "s" : ""}. Rien n'est encore enregistré : ` +
          `regardez le résultat avant de le garder.` });
      } catch (e) { fail(res, e, "Lecture du fichier PowerPoint impossible."); }
    });


  /* ══════════════════════════ ROUVRIR ══════════════════════════ */
  router.get("/studio/presentations/:id", authenticateToken,
    requirePermission(MODULE, "view"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        res.json(await P.plan(client, {
          companyId, utilisateur: utilisateurDe(req), documentId: Number(req.params.id) }));
      } catch (e) { fail(res, e, "Ouverture impossible."); }
      finally { client.release(); }
    });

  /* ════════════════════════ ENREGISTRER ════════════════════════ */
  router.post("/studio/presentations/:id", authenticateToken,
    requirePermission(MODULE, "update"), recevoirDiapositives, async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const images = imagesDe(req);
      if (!images.length) {
        res.status(400).json({
          error: "Aucune image de diapositive n'est arrivée ; rien n'est enregistré.",
          code: "AUCUNE_IMAGE" });
        return;
      }
      const r = await enTransaction(res, "Enregistrement impossible.", (client) =>
        P.modifier(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req), images,
          documentId: Number(req.params.id),
          plan: req.body?.plan, format: req.body?.format,
          largeurMm: req.body?.largeur_mm, hauteurMm: req.body?.hauteur_mm,
          note: req.body?.note,
        }));
      if (r) {
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `Présentation modifiée : « ${r.name} »`, "studio", `v${r.version}`);
        res.json({ document: r, message:
          `Enregistré. La présentation est en version ${r.version} ; la précédente reste intacte.` });
      }
    });

  /* ═══════════════ EXPORTER VERS POWERPOINT ═══════════════ */
  router.post("/studio/presentations/:id/pptx", authenticateToken,
    requirePermission(MODULE, "export"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const r = await enTransaction(res, "Export PowerPoint impossible.", (client) =>
        P.exporterPptx(client, {
          companyId, utilisateur: utilisateurDe(req), ip: ipDe(req),
          documentId: Number(req.params.id), nom: req.body?.nom }));
      if (r) {
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `Export PowerPoint : « ${r.document.name} »`, "studio",
          `${r.diapositives} diapositive(s)`);
        res.status(201).json({ ...r, message:
          `Export PowerPoint déposé — ${r.diapositives} diapositive${r.diapositives > 1 ? "s" : ""}, ` +
          `aux formes modifiables.` +
          (r.nonRepris.length
            ? ` ${r.nonRepris.length} élément${r.nonRepris.length > 1 ? "s" : ""} n'a pas pu être repris.`
            : "") });
      }
    });

  return router;
};

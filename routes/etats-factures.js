"use strict";

/**
 * LES ÉTATS DE FACTURES — sable et ciment, Triangle et FAT & MAT.
 *
 *   GET    /invoice-statements/selection          ce qu'on peut encore porter
 *   GET    /invoice-statements                    la liste des états
 *   GET    /invoice-statements/:id                un état, ses lignes, son histoire
 *   POST   /invoice-statements                    créer un brouillon
 *   POST   /invoice-statements/:id/lignes         ajouter des factures
 *   DELETE /invoice-statements/:id/lignes/:ligne  en retirer une
 *   POST   /invoice-statements/:id/valider        arrêter l'état
 *   POST   /invoice-statements/:id/annuler        avec motif obligatoire
 *   POST   /invoice-statements/:id/corriger       un nouvel état remplace l'ancien
 *   GET    /invoice-statements/:id/pdf            imprimer ou réimprimer
 *   POST   /invoice-statements/historique         reprendre un état antérieur
 *   POST   /invoice-statements/historique/declarer déclarer la reprise achevée
 *   POST   /invoice-statements/rapprocher         relier les lignes orphelines
 *
 * DEUX VERROUS, PAS UN.
 *
 * Le droit d'agir sur les états (`etat_facture`) ne suffit pas : il faut aussi
 * voir le PRODUIT concerné (`sand` ou `cement`). Sans ce second contrôle, un
 * comptable du sable lirait les factures du ciment en passant par les états —
 * une porte dérobée sur un module qu'on lui a fermé.
 *
 * Et la société reste celle de la session : `getEffectiveCompanyId`. Aucune
 * route ne prend un company_id dans son corps.
 */

const express = require("express");
const E = require("../services/etats-factures");
const { etatDeFactures } = require("../services/pdf-etat-factures");

const MODULE = "etat_facture";

module.exports = function createEtatsFacturesRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission,
          permissionsService, logActivity } = deps;
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
  /* logActivity prend (nom, rôle, action, module, détails) — cinq arguments
     positionnels, pas un objet. Lui passer `req` en premier fait tenter à
     PostgreSQL la sérialisation de la requête HTTP entière, qui est
     circulaire : l'activité n'est pas enregistrée, et l'erreur se perd dans
     un catch. */
  const fail = (res, e, secours) => {
    if (!e.httpStatus) console.error(secours, e);
    res.status(e.httpStatus || 500).json({ error: e.message || secours, code: e.code });
  };

  /* Le second verrou : voir le produit. On répond 404 et non 403, comme le
     fait requirePermission pour un module caché — dire « interdit » apprend
     déjà que la chose existe. */
  async function produitAutorise(req, res, companyId, produitCle) {
    let p;
    try { p = E.produitDe(produitCle); }
    catch (e) { res.status(400).json({ error: e.message, code: e.code }); return null; }
    try {
      const ctx = await permissionsService.chargerContexte(pool, req.user, companyId);
      const vu = permissionsService.decider(ctx, p.module, "visible").autorise === true
              || permissionsService.decider(ctx, p.module, "view").autorise === true;
      if (!vu) {
        res.status(404).json({
          error: "Ressource introuvable.", code: "NOT_FOUND",
        });
        return null;
      }
    } catch (e) {
      console.error("état de factures — contrôle du produit :", e);
      res.status(500).json({ error: "Contrôle des droits impossible.", code: "PERMISSION_CHECK_FAILED" });
      return null;
    }
    return p;
  }

  /* L'état existe-t-il, et son produit est-il autorisé ? Toutes les routes
     qui prennent un :id passent par là. */
  async function etatAutorise(req, res, companyId) {
    let etat;
    try { etat = await E.charger(pool, companyId, Number(req.params.id)); }
    catch (e) { fail(res, e, "Lecture de l'état impossible."); return null; }
    const p = await produitAutorise(req, res, companyId, etat.product);
    if (!p) return null;
    return { etat, produit: p };
  }

  /* ─────────────────── CE QU'ON PEUT ENCORE PORTER SUR UN ÉTAT ─────────── */
  router.get("/invoice-statements/selection",
    authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const p = await produitAutorise(req, res, companyId, req.query.product); if (!p) return;
      try {
        const factures = await E.facturesDisponibles(pool, {
          companyId, product: p.cle,
          du: req.query.du || null, au: req.query.au || null,
          clientId: req.query.client ? Number(req.query.client) : null,
          recherche: req.query.q || null,
          inclurePrises: req.query.inclure_prises === "1",
          limite: Math.min(Number(req.query.limite) || 500, 2000),
        });
        const avertissement = await E.avertissementHistorique(pool, { companyId, product: p.cle });
        res.json({
          produit: p.cle, produit_libelle: p.libelle,
          factures, avertissement_historique: avertissement,
        });
      } catch (e) { fail(res, e, "Sélection impossible."); }
    });

  /* ───────────────────────────── LA LISTE ──────────────────────────────── */
  router.get("/invoice-statements",
    authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        /* Sans produit demandé, on ne renvoie que ceux dont le produit est
           autorisé : la liste ne doit pas révéler l'existence d'états ciment
           à qui n'a pas le ciment. */
        const ctx = await permissionsService.chargerContexte(pool, req.user, companyId);
        const autorises = Object.values(E.PRODUITS)
          .filter((p) => permissionsService.decider(ctx, p.module, "visible").autorise === true
                      || permissionsService.decider(ctx, p.module, "view").autorise === true)
          .map((p) => p.cle);
        if (req.query.product) {
          const demande = String(req.query.product).toUpperCase();
          if (!autorises.includes(demande)) return res.status(404).json({ error: "Ressource introuvable.", code: "NOT_FOUND" });
        }
        const tous = await E.lister(pool, {
          companyId,
          product: req.query.product || null,
          statut: req.query.statut || null,
          limite: Math.min(Number(req.query.limite) || 100, 500),
        });
        res.json({ etats: tous.filter((e) => autorises.includes(e.product)), produits_autorises: autorises });
      } catch (e) { fail(res, e, "Liste des états impossible."); }
    });

  /* ─────────────────────────────── UN ÉTAT ─────────────────────────────── */
  router.get("/invoice-statements/:id",
    authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const a = await etatAutorise(req, res, companyId); if (!a) return;
      try {
        res.json(await E.detail(pool, { companyId, etatId: a.etat.id }));
      } catch (e) { fail(res, e, "Lecture de l'état impossible."); }
    });

  /* ───────────────────────────── CRÉER ─────────────────────────────────── */
  router.post("/invoice-statements",
    authenticateToken, requirePermission(MODULE, "create"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const p = await produitAutorise(req, res, companyId, req.body?.product); if (!p) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const etat = await E.creer(client, {
          companyId, product: p.cle,
          factureIds: req.body?.factures || [],
          titre: req.body?.titre, du: req.body?.du || null, au: req.body?.au || null,
          notes: req.body?.notes, utilisateur: utilisateurDe(req),
        });
        await client.query("COMMIT");
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `État de factures ${etat.statement_number} créé`, "etat_facture",
          `${p.libelle} — ${etat.invoices_count} facture(s)`);
        res.status(201).json({ etat });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Création de l'état impossible.");
      } finally { client.release(); }
    });

  /* ─────────────────────── AJOUTER / RETIRER DES LIGNES ────────────────── */
  router.post("/invoice-statements/:id/lignes",
    authenticateToken, requirePermission(MODULE, "create"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const a = await etatAutorise(req, res, companyId); if (!a) return;
      const ids = [...new Set((req.body?.factures || []).map(Number).filter(Boolean))];
      if (!ids.length) return res.status(400).json({ error: "Aucune facture envoyée.", code: "NO_INVOICE_SELECTED" });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const etat = await E.charger(client, companyId, a.etat.id, { verrou: true });
        await E.ajouterFactures(client, { etat, ids, utilisateur: utilisateurDe(req) });
        const final = await E.recalculerTotaux(client, etat.id);
        await client.query("COMMIT");
        res.json({ etat: final });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Ajout impossible.");
      } finally { client.release(); }
    });

  router.delete("/invoice-statements/:id/lignes/:ligne",
    authenticateToken, requirePermission(MODULE, "create"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const a = await etatAutorise(req, res, companyId); if (!a) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const etat = await E.retirerFacture(client, {
          companyId, etatId: a.etat.id, ligneId: Number(req.params.ligne),
          utilisateur: utilisateurDe(req),
        });
        await client.query("COMMIT");
        res.json({ etat });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Retrait impossible.");
      } finally { client.release(); }
    });

  /* ───────────────────────────── VALIDER ───────────────────────────────── */
  router.post("/invoice-statements/:id/valider",
    authenticateToken, requirePermission(MODULE, "validate"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const a = await etatAutorise(req, res, companyId); if (!a) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const etat = await E.valider(client, { companyId, etatId: a.etat.id, utilisateur: utilisateurDe(req) });
        await client.query("COMMIT");
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `État ${etat.statement_number} validé`, "etat_facture",
          `${etat.invoices_count} facture(s), ${etat.total_invoiced} FCFA`);
        res.json({ etat });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Validation impossible.");
      } finally { client.release(); }
    });

  /* ───────────────────────────── ANNULER ───────────────────────────────── */
  router.post("/invoice-statements/:id/annuler",
    authenticateToken, requirePermission(MODULE, "cancel"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const a = await etatAutorise(req, res, companyId); if (!a) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const etat = await E.annuler(client, {
          companyId, etatId: a.etat.id, motif: req.body?.motif,
          utilisateur: utilisateurDe(req),
        });
        await client.query("COMMIT");
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `État ${etat.statement_number} annulé`, "etat_facture", etat.cancel_reason);
        res.json({ etat });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Annulation impossible.");
      } finally { client.release(); }
    });

  /* ───────────────────────────── CORRIGER ──────────────────────────────── */
  router.post("/invoice-statements/:id/corriger",
    authenticateToken, requirePermission(MODULE, "correct"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const a = await etatAutorise(req, res, companyId); if (!a) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const etat = await E.corriger(client, {
          companyId, etatId: a.etat.id, motif: req.body?.motif,
          factureIds: req.body?.factures || null, utilisateur: utilisateurDe(req),
        });
        await client.query("COMMIT");
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `État ${a.etat.statement_number} corrigé par ${etat.statement_number}`,
          "etat_facture", etat.replace_reason);
        res.status(201).json({ etat, remplace: a.etat.statement_number });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Correction impossible.");
      } finally { client.release(); }
    });

  /* ─────────────────────────────── LE PDF ──────────────────────────────── */
  router.get("/invoice-statements/:id/pdf",
    authenticateToken, requirePermission(MODULE, "print"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const a = await etatAutorise(req, res, companyId); if (!a) return;

      /* Réimprimer est un droit distinct d'imprimer : la deuxième sortie d'un
         état validé circule, et toutes les mains n'ont pas à pouvoir la
         produire. Un brouillon, lui, n'a jamais été imprimé. */
      if (a.etat.printed_count > 0) {
        try {
          const ctx = await permissionsService.chargerContexte(pool, req.user, companyId);
          if (permissionsService.decider(ctx, MODULE, "reprint").autorise !== true) {
            return res.status(403).json({
              error: `L'état ${a.etat.statement_number} a déjà été imprimé ${a.etat.printed_count} fois. La réimpression demande un droit distinct.`,
              code: "REPRINT_FORBIDDEN",
            });
          }
        } catch (e) {
          return res.status(500).json({ error: "Contrôle des droits impossible.", code: "PERMISSION_CHECK_FAILED" });
        }
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: lignes } = await client.query(
          `SELECT * FROM invoice_statement_lines WHERE statement_id = $1 ORDER BY sort_order, id`,
          [a.etat.id]);
        const { rows: ent } = await client.query(
          `SELECT * FROM companies WHERE id = $1`, [companyId]);
        const { rows: liens } = await client.query(
          `SELECT (SELECT statement_number FROM invoice_statements WHERE id = $1) AS remplace_numero,
                  (SELECT statement_number FROM invoice_statements
                    WHERE replaces_statement_id = $2 ORDER BY id DESC LIMIT 1) AS remplace_par_numero`,
          [a.etat.replaces_statement_id || 0, a.etat.id]);

        /* On note l'impression AVANT de rendre : si le rendu échoue, la
           transaction est annulée et le compteur ne bouge pas. Dans l'autre
           ordre, un PDF envoyé ne serait pas tracé. */
        const etat = await E.noterImpression(client, {
          companyId, etatId: a.etat.id, utilisateur: utilisateurDe(req),
        });
        const pdf = await etatDeFactures({
          etat: { ...etat, ...liens[0] },
          lignes, entreprise: ent[0] || {},
          produitLibelle: a.produit.libelle,
          impression: etat.printed_count,
        });
        await client.query("COMMIT");
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition",
          `inline; filename="${etat.statement_number}.pdf"`);
        res.send(pdf);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Impression impossible.");
      } finally { client.release(); }
    });

  /* ────────────────────── REPRENDRE UN ÉTAT ANTÉRIEUR ──────────────────── */
  router.post("/invoice-statements/historique",
    authenticateToken, requirePermission(MODULE, "archive"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const p = await produitAutorise(req, res, companyId, req.body?.product); if (!p) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const r = await E.reprendreHistorique(client, {
          companyId, product: p.cle,
          reference: req.body?.reference,
          numerosFactures: req.body?.numeros || [],
          titre: req.body?.titre, du: req.body?.du || null, au: req.body?.au || null,
          notes: req.body?.notes, utilisateur: utilisateurDe(req),
        });
        await client.query("COMMIT");
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `État antérieur repris sous ${r.etat.statement_number}`, "etat_facture",
          `${r.rapprochees} rapprochée(s), ${r.orphelines} orpheline(s), ${r.conflits.length} conflit(s)`);
        res.status(201).json(r);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Reprise impossible.");
      } finally { client.release(); }
    });

  router.post("/invoice-statements/historique/declarer",
    authenticateToken, requirePermission(MODULE, "archive"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const p = await produitAutorise(req, res, companyId, req.body?.product); if (!p) return;
      try {
        const n = await E.declarerHistoriqueComplet(pool, {
          companyId, product: p.cle, complet: !!req.body?.complet,
          note: req.body?.note, utilisateur: utilisateurDe(req),
        });
        logActivity?.(utilisateurDe(req).name, req.user?.role,
          `Reprise des états antérieurs ${req.body?.complet ? "déclarée achevée" : "rouverte"}`,
          "etat_facture", p.libelle);
        res.json({ notice: n });
      } catch (e) { fail(res, e, "Déclaration impossible."); }
    });

  router.post("/invoice-statements/rapprocher",
    authenticateToken, requirePermission(MODULE, "archive"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const p = await produitAutorise(req, res, companyId, req.body?.product); if (!p) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const r = await E.rapprocher(client, { companyId, product: p.cle, utilisateur: utilisateurDe(req) });
        await client.query("COMMIT");
        res.json(r);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Rapprochement impossible.");
      } finally { client.release(); }
    });

  return router;
};

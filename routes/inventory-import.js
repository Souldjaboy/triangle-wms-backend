"use strict";

/**
 * ROUTES D'IMPORT D'INVENTAIRE EXCEL.
 *
 * Fine couche HTTP : toute la logique vit dans import-inventory/* et
 * services/stock-operations.js. Rien n'est réécrit ici.
 *
 *   POST /inventory-import/preview        analyse SANS RIEN ÉCRIRE
 *   POST /inventory-import/execute        applique, en une transaction
 *   POST /inventory-import/:id/rollback   mouvements inverses
 *   GET  /inventory-import/history        journal des imports
 *   GET  /inventory-import/:id            détail
 *   GET  /inventory-import/:id/report     rapport CSV téléchargeable
 *
 * Isolation : chaque requête est bornée à l'entreprise ACTIVE. Un import
 * appartenant à une autre entreprise renvoie 404 — on ne révèle pas son
 * existence.
 */

const express = require("express");
const parser = require("../import-inventory/excel-inventory-parser");
const { reconcile } = require("../import-inventory/reconcile");
const { planOperations, planWriteOffs } = require("../import-inventory/plan");
const { executeImport, rollbackImport, fileHash } = require("../import-inventory/execute");
const { reconcileReceptions, detectTransfers } = require("../import-inventory/receptions");

module.exports = function createInventoryImportRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission, upload } = deps;
  const router = express.Router();
  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);

  /* RBAC : lecture pour analyser, validation pour appliquer ou annuler.
     On réutilise le moteur de permissions existant, sans en créer un second. */
  const canView = requirePermission("stock", "view");
  const canApply = requirePermission("stock", "validate");

  /** Produits de l'entreprise active, au format attendu par le réconciliateur. */
  async function loadDbProducts(companyId) {
    const { rows } = await pool.query(
      /* Les composantes d'emplacement (rayon, case, niveau, bin) vivent dans
         `locations`, pas dans `products` : sans cette jointure la détection de
         transfert n'aurait rien à comparer. LEFT JOIN — un produit sans
         emplacement connu reste listé, il ne produira simplement aucun
         transfert. */
      `SELECT p.id AS product_id, p.reference, p.name, p.stock, p.unit, p.warehouse,
              p.location_id, p.location_code,
              l.rayon_code, l.case_code, l.level_code, l.bin_code, l.warehouse_code
         FROM products p
         LEFT JOIN locations l
           ON l.id = p.location_id AND l.company_id = p.company_id
        WHERE p.company_id = $1 AND COALESCE(p.is_active, TRUE) = TRUE
        ORDER BY p.name`,
      [companyId]
    );
    return rows;
  }

  /** Analyse un classeur et construit réconciliation + plan. Aucune écriture. */
  async function analyse(companyId, buffer, warehouse) {
    const rows = parser.readStockSheet(buffer);
    const db = await loadDbProducts(companyId);
    const recon = reconcile(rows, db);

    /* Write-off déjà enregistrés — INFORMATION affichée, jamais un filtre.
       La production les stocke avec type='casse' et status='WRITE OFF' :
       un simple `type ILIKE '%WRITE%'` n'en voyait AUCUN. */
    const previous = new Set(
      (await pool.query(
        `SELECT DISTINCT product_name FROM stock_movements
          WHERE company_id = $1
            AND (
              UPPER(COALESCE(status, '')) = 'WRITE OFF'
              OR UPPER(COALESCE(type, '')) LIKE '%WRITE%'
              OR UPPER(COALESCE(type, '')) LIKE '%CASSE%'
            )`,
        [companyId]
      )).rows.map((r) => parser.normName(r.product_name))
    );
    const writeOffs = planWriteOffs(parser.readWriteOffSheet(buffer), db, previous);
    const plan = planOperations(recon, { warehouse, writeOffs });

    /* Réceptions containers : rapprochées avec les IN du plan pour prouver
       qu'aucun stock n'est compté deux fois. */
    const receptions = reconcileReceptions(
      parser.readReceptionSheets(buffer), plan.entries
    );
    /* Transferts : produits dont SEUL l'emplacement change. */
    const transfers = detectTransfers(recon.items, { warehouse: warehouse || "W-EM2S-A" });
    plan.transfers = transfers;
    plan.documents.receptions = receptions.totals.total;
    plan.documents.transfers = transfers.length;

    return { recon, plan, receptions, rowsRead: rows.length };
  }

  // ---------------- PREVIEW — n'écrit rien ----------------
  router.post("/inventory-import/preview", authenticateToken, canView, upload.single("file"),
    async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu." });
        const companyId = companyOf(req);
        const { recon, plan, receptions, rowsRead } = await analyse(companyId, req.file.buffer, req.body?.warehouse);
        const hash = fileHash(req.file.buffer);

        const already = (await pool.query(
          `SELECT id, imported_at FROM inventory_imports
            WHERE company_id=$1 AND file_hash=$2 AND status='COMPLETED'`,
          [companyId, hash]
        )).rows[0] || null;

        res.json({
          fileName: req.file.originalname, hash, rowsRead,
          alreadyImported: already,
          totals: { ...plan.totals, ...recon.totals, byAction: recon.totals.byAction },
          documents: plan.documents,
          preAdjustments: plan.preAdjustments, entries: plan.entries, exits: plan.exits,
          writeOffs: plan.writeOffs, transfers: plan.transfers || [],
          receptions: { totals: receptions.totals, items: receptions.items.slice(0, 200) },
          blockingErrors: plan.blockingErrors,
          newProducts: plan.newProducts, blocked: plan.blocked,
          /* Ce que l'utilisateur doit vérifier AVANT de valider : ces cas ne
             sont jamais appliqués automatiquement. */
          toReview: recon.items
            .filter((i) => ["TO_REVIEW", "AMBIGUOUS_PRODUCT"].includes(i.action))
            .map((i) => ({ desc: i.desc, action: i.action, reason: i.reviewReason,
                           dbStock: i.dbStock, suggestions: i.suggestions })),
          dbOnly: recon.totals.dbOnly.map((i) => ({ name: i.desc, stock: i.dbStock })),
        });
      } catch (e) {
        console.error("inventory-import preview:", e);
        res.status(e.httpStatus || 500).json({ error: e.message || "Erreur d'analyse du fichier." });
      }
    });

  // ---------------- EXECUTE ----------------
  router.post("/inventory-import/execute", authenticateToken, canApply, upload.single("file"),
    async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu." });
        const companyId = companyOf(req);
        const hash = fileHash(req.file.buffer);
        /* Le hash confirmé par le preview doit correspondre au fichier envoyé :
           on n'exécute jamais un plan calculé sur un autre fichier. */
        if (req.body?.confirmedHash && req.body.confirmedHash !== hash) {
          return res.status(409).json({
            error: "Le fichier ne correspond pas à celui analysé. Relancez l'analyse.",
            code: "HASH_MISMATCH",
          });
        }
        const warehouse = req.body?.warehouse || "W-EM2S-A";
        const { recon, plan } = await analyse(companyId, req.file.buffer, warehouse);
        /* Double barrière : le frontend désactive déjà la confirmation, mais un
           appel direct à l'API ne doit pas pouvoir contourner le contrôle. */
        if (plan.blockingErrors.length > 0) {
          return res.status(409).json({
            error: `${plan.blockingErrors.length} produit(s) produiraient un stock négatif. Import refusé.`,
            code: "BLOCKING_STOCK_ERROR",
            blockingErrors: plan.blockingErrors.slice(0, 20),
          });
        }
        const result = await executeImport(pool, {
          companyId, plan, recon, warehouse, hash,
          fileName: req.file.originalname,
          user: { id: req.user.id, name: req.user.fullname || req.user.email, role: req.user.role },
        });
        res.status(201).json({ success: true, ...result });
      } catch (e) {
        console.error("inventory-import execute:", e);
        res.status(e.httpStatus || 500).json({ error: e.message || "Erreur d'import.", code: e.code });
      }
    });

  // ---------------- ROLLBACK ----------------
  router.post("/inventory-import/:id/rollback", authenticateToken, canApply, async (req, res) => {
    try {
      const companyId = companyOf(req);
      const result = await rollbackImport(pool, {
        companyId, importId: Number(req.params.id),
        user: { id: req.user.id, name: req.user.fullname || req.user.email, role: req.user.role },
      });
      res.json({ success: true, ...result });
    } catch (e) {
      console.error("inventory-import rollback:", e);
      res.status(e.httpStatus || 500).json({ error: e.message || "Erreur d'annulation.", code: e.code });
    }
  });

  // ---------------- HISTORIQUE ----------------
  router.get("/inventory-import/history", authenticateToken, canView, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT i.*, u.fullname AS imported_by_name
           FROM inventory_imports i
           LEFT JOIN users u ON u.id = i.imported_by
          WHERE i.company_id = $1
          ORDER BY i.imported_at DESC LIMIT 100`,
        [companyOf(req)]
      );
      res.json(rows);
    } catch (e) {
      console.error("inventory-import history:", e);
      res.status(500).json({ error: "Erreur chargement historique." });
    }
  });

  router.get("/inventory-import/:id", authenticateToken, canView, async (req, res) => {
    try {
      const companyId = companyOf(req);
      const imp = (await pool.query(
        `SELECT * FROM inventory_imports WHERE id=$1 AND company_id=$2`,
        [req.params.id, companyId]
      )).rows[0];
      // Hors périmètre : 404, on ne révèle pas l'existence de l'import.
      if (!imp) return res.status(404).json({ error: "Import introuvable." });
      const movements = (await pool.query(
        `SELECT * FROM stock_movements WHERE company_id=$1 AND import_id=$2 ORDER BY id`,
        [companyId, req.params.id]
      )).rows;
      res.json({ import: imp, movements });
    } catch (e) {
      console.error("inventory-import detail:", e);
      res.status(500).json({ error: "Erreur chargement import." });
    }
  });

  // ---------------- RAPPORT CSV ----------------
  router.get("/inventory-import/:id/report", authenticateToken, canView, async (req, res) => {
    try {
      const companyId = companyOf(req);
      const imp = (await pool.query(
        `SELECT * FROM inventory_imports WHERE id=$1 AND company_id=$2`,
        [req.params.id, companyId]
      )).rows[0];
      if (!imp) return res.status(404).json({ error: "Import introuvable." });

      const rows = (await pool.query(
        `SELECT m.*, p.name AS current_name, p.stock AS current_stock,
                p.warehouse AS current_warehouse, p.location_code AS current_location
           FROM stock_movements m
           LEFT JOIN products p ON p.id = m.product_id AND p.company_id = m.company_id
          WHERE m.company_id=$1 AND m.import_id=$2
          ORDER BY m.id`,
        [companyId, req.params.id]
      )).rows;

      const esc = (v) => {
        const s = String(v == null ? "" : v);
        return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = ["import_id", "movement_id", "product_id", "produit", "action",
        "quantite", "stock_avant", "stock_apres", "stock_actuel", "entrepot",
        "emplacement", "document", "statut", "date"];
      const body = rows.map((r) => [
        req.params.id, r.id, r.product_id, r.product_name || r.current_name, r.type,
        r.final_quantity ?? r.quantity, r.stock_before, r.stock_after, r.current_stock,
        r.destination_warehouse || r.source_warehouse || r.current_warehouse,
        r.location_code || r.current_location, r.source_reference, r.status,
        r.validated_at || r.created_at,
      ]);
      const csv = [header, ...body].map((l) => l.map(esc).join(",")).join("\n");

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition",
        `attachment; filename="import-inventaire-${req.params.id}.csv"`);
      res.send("﻿" + csv);          // BOM : Excel ouvre l'UTF-8 correctement
    } catch (e) {
      console.error("inventory-import report:", e);
      res.status(500).json({ error: "Erreur génération du rapport." });
    }
  });

  return router;
};

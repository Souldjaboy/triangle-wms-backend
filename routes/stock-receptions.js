"use strict";

/**
 * ROUTES RÉCEPTIONS CONTENEUR ET MISE EN STOCK.
 *
 * Couche HTTP mince : toute la logique vit dans services/receptions.js, qui
 * orchestre lui-même services/stock-operations.js. Rien n'est réécrit ici.
 *
 *   GET  /stock/receptions                 liste
 *   GET  /stock/receptions/:id             détail + lignes
 *   GET  /stock/receptions/:id/putaways    historique des rangements
 *   GET  /stock/receptions/:id/report      rapport CSV
 *   POST /stock/receptions                 création manuelle
 *   POST /stock/receptions/import-preview  analyse Excel — N'ÉCRIT RIEN
 *   POST /stock/receptions/import          création depuis Excel
 *   POST /stock/receptions/:id/putaway     mise en stock d'une ligne
 *
 * Une réception ne modifie JAMAIS le stock. Seul /putaway le fait.
 * Isolation : tout est borné à l'entreprise active, 404 hors périmètre.
 */

const express = require("express");
const parser = require("../import-inventory/excel-inventory-parser");
const R = require("../services/receptions");

module.exports = function createStockReceptionsRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission, upload } = deps;
  const router = express.Router();
  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const canView = requirePermission("stock", "view");
  const canCreate = requirePermission("stock", "create");
  const canApply = requirePermission("stock", "validate");
  const userOf = (req) => ({ id: req.user.id, name: req.user.fullname || req.user.email, role: req.user.role });

  /* Regroupe les lignes Excel par (conteneur, date) : un conteneur déchargé sur
     plusieurs entrepôts reste UNE seule réception, ses lignes portant chacune
     leur destination. */
  function groupReceptions(rows) {
    const groups = new Map();
    for (const r of rows) {
      const key = `${r.container || "SANS"}|${r.date || "SANS"}`;
      if (!groups.has(key)) {
        groups.set(key, {
          container: r.container, containerRaw: r.containerRaw, date: r.date,
          warehouses: {}, lines: [], quantity: 0,
          status: r.container ? null : "TO_REVIEW_CONTAINER",
        });
      }
      const g = groups.get(key);
      g.lines.push(r);
      g.quantity += r.quantity;
      g.warehouses[r.warehouse] = (g.warehouses[r.warehouse] || 0) + r.quantity;
    }
    return [...groups.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  /* Rapproche chaque libellé reçu d'une fiche produit — sans jamais décider :
     une correspondance douteuse reste TO_REVIEW et bloque la mise en stock. */
  async function matchProducts(companyId, groups) {
    const db = (await pool.query(
      `SELECT id, name, reference, stock FROM products
        WHERE company_id=$1 AND COALESCE(is_active,TRUE)=TRUE`, [companyId]
    )).rows;
    const byNorm = new Map();
    db.forEach((p) => {
      const k = parser.normName(p.name);
      if (!byNorm.has(k)) byNorm.set(k, []);
      byNorm.get(k).push(p);
    });
    for (const g of groups) {
      for (const l of g.lines) {
        const hits = byNorm.get(l.norm) || [];
        if (hits.length === 1) {
          l.productId = hits[0].id;
          l.productName = hits[0].name;
          l.matchStatus = R.MATCH_STATUS.MATCHED;
        } else {
          l.productId = null;
          l.productName = null;
          l.matchStatus = R.MATCH_STATUS.REVIEW;
          l.reviewReason = hits.length > 1 ? "PLUSIEURS_CORRESPONDANCES" : "PRODUIT_INCONNU";
        }
      }
    }
    return groups;
  }

  /* Déclaré AVANT /stock/receptions/:id, sinon "dashboard" serait pris pour un
     identifiant. */
  router.get("/stock/receptions/dashboard", authenticateToken, canView, async (req, res) => {
    try {
      res.json(await R.receptionDashboard(pool, companyOf(req)));
    } catch (e) {
      console.error("receptions dashboard:", e);
      res.status(500).json({ error: "Erreur chargement des indicateurs." });
    }
  });

  // ---------------- ENTREPÔTS ----------------
  router.get("/stock/warehouses/summary", authenticateToken, canView, async (req, res) => {
    try {
      res.json(await R.warehouseSummary(pool, companyOf(req)));
    } catch (e) {
      console.error("warehouses summary:", e);
      res.status(500).json({ error: "Erreur chargement des entrepôts." });
    }
  });

  // ---------------- AIDE AU RAPPROCHEMENT ----------------
  router.get("/stock/receptions/lines/:lineId/suggestions", authenticateToken, canView,
    async (req, res) => {
      try {
        const companyId = companyOf(req);
        const line = (await pool.query(
          `SELECT id, received_label, unit, product_id, match_status
             FROM stock_reception_lines WHERE id=$1 AND company_id=$2`,
          [req.params.lineId, companyId]
        )).rows[0];
        if (!line) return res.status(404).json({ error: "Ligne introuvable." });
        const out = await R.suggestProducts(
          pool, companyId, req.query.q || line.received_label,
          Math.min(Number(req.query.limit) || 3, 20)
        );
        res.json({ line, ...out });
      } catch (e) {
        console.error("line suggestions:", e);
        res.status(500).json({ error: "Erreur de recherche de produits." });
      }
    });

  /* Association confirmée par l'utilisateur. Rien n'est appliqué sur la seule
     foi d'un score de similarité. */
  router.patch("/stock/receptions/lines/:lineId", authenticateToken, canCreate, async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.productId) return res.status(400).json({ error: "Produit requis." });
      const out = await R.confirmLineProduct(pool, {
        companyId: companyOf(req), lineId: Number(req.params.lineId),
        productId: Number(b.productId), applyToIdentical: Boolean(b.applyToIdentical),
        receptionId: b.receptionId ? Number(b.receptionId) : null,
      });
      res.json({ success: true, ...out });
    } catch (e) {
      console.error("line confirm:", e);
      res.status(e.httpStatus || 500).json({ error: e.message || "Erreur d'association.", code: e.code });
    }
  });

  /* Création de fiche : uniquement sur action explicite, jamais à la consultation. */
  router.post("/stock/receptions/lines/:lineId/product", authenticateToken, canCreate,
    async (req, res) => {
      try {
        const b = req.body || {};
        const out = await R.createProductForLine(pool, {
          companyId: companyOf(req), lineId: Number(req.params.lineId),
          name: b.name, unit: b.unit, category: b.category, reference: b.reference,
          user: userOf(req),
        });
        res.status(201).json({ success: true, ...out, stockImpact: 0 });
      } catch (e) {
        console.error("line create product:", e);
        res.status(e.httpStatus || 500).json({ error: e.message || "Erreur de création.", code: e.code, details: e.details });
      }
    });

  // ---------------- LISTE ----------------
  router.get("/stock/receptions", authenticateToken, canView, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT r.*,
                COUNT(l.id)::int AS line_count,
                COALESCE(SUM(l.quantity_received),0)::numeric AS quantity_received,
                COALESCE(SUM(l.quantity_putaway),0)::numeric  AS quantity_putaway,
                COALESCE(SUM(l.quantity_received - l.quantity_putaway),0)::numeric AS quantity_pending,
                COUNT(*) FILTER (WHERE l.match_status='TO_REVIEW')::int AS to_review,
                STRING_AGG(DISTINCT l.warehouse_code, ', ') AS warehouses,
                u.fullname AS created_by_name
           FROM stock_receptions r
           LEFT JOIN stock_reception_lines l ON l.reception_id=r.id AND l.company_id=r.company_id
           LEFT JOIN users u ON u.id=r.created_by
          WHERE r.company_id=$1
          GROUP BY r.id, u.fullname
          ORDER BY r.reception_date DESC, r.id DESC`,
        [companyOf(req)]
      );
      res.json(rows.map((r) => ({ ...r, status_label: R.STATUS_FR[r.status] || r.status })));
    } catch (e) {
      console.error("receptions list:", e);
      res.status(500).json({ error: "Erreur chargement des réceptions." });
    }
  });

  // ---------------- DÉTAIL ----------------
  router.get("/stock/receptions/:id", authenticateToken, canView, async (req, res) => {
    try {
      const companyId = companyOf(req);
      const reception = (await pool.query(
        /* Les entrepôts desservis viennent des LIGNES : un conteneur peut être
           déchargé sur plusieurs entrepôts, l'en-tête ne porte que le défaut. */
        `SELECT r.*, u.fullname AS created_by_name,
                (SELECT STRING_AGG(DISTINCT l.warehouse_code, ', ')
                   FROM stock_reception_lines l
                  WHERE l.reception_id=r.id AND l.company_id=r.company_id) AS warehouses
           FROM stock_receptions r
           LEFT JOIN users u ON u.id=r.created_by
          WHERE r.id=$1 AND r.company_id=$2`,
        [req.params.id, companyId]
      )).rows[0];
      if (!reception) return res.status(404).json({ error: "Réception introuvable." });

      const lines = (await pool.query(
        `SELECT l.*, p.name AS product_name, p.stock AS product_stock,
                (l.quantity_received - l.quantity_putaway) AS quantity_remaining
           FROM stock_reception_lines l
           LEFT JOIN products p ON p.id=l.product_id AND p.company_id=l.company_id
          WHERE l.reception_id=$1 AND l.company_id=$2
          ORDER BY l.line_no`,
        [req.params.id, companyId]
      )).rows;

      res.json({
        reception: { ...reception, status_label: R.STATUS_FR[reception.status] || reception.status },
        lines,
        totals: await R.receptionTotals(pool, companyId, req.params.id),
      });
    } catch (e) {
      console.error("reception detail:", e);
      res.status(500).json({ error: "Erreur chargement de la réception." });
    }
  });

  router.get("/stock/receptions/:id/putaways", authenticateToken, canView, async (req, res) => {
    try {
      const companyId = companyOf(req);
      const { rows } = await pool.query(
        `SELECT pa.*, p.name AS product_name, p.reference AS product_reference,
                u.fullname AS created_by_name,
                l.received_label, l.unit, l.line_no,
                r.reception_number, r.container_number, r.reception_date
           FROM stock_putaways pa
           LEFT JOIN products p ON p.id=pa.product_id
           LEFT JOIN users u ON u.id=pa.created_by
           LEFT JOIN stock_reception_lines l ON l.id=pa.reception_line_id
           LEFT JOIN stock_receptions r ON r.id=pa.reception_id
          WHERE pa.reception_id=$1 AND pa.company_id=$2
          ORDER BY pa.id`,
        [req.params.id, companyId]
      );
      res.json(rows);
    } catch (e) {
      console.error("putaways list:", e);
      res.status(500).json({ error: "Erreur chargement des mises en stock." });
    }
  });

  // ---------------- IMPORT-PREVIEW — n'écrit rien ----------------
  router.post("/stock/receptions/import-preview", authenticateToken, canView,
    upload.single("file"), async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu." });
        const companyId = companyOf(req);
        const rows = parser.readReceptionSheets(req.file.buffer);
        const groups = await matchProducts(companyId, groupReceptions(rows));

        /* Réceptions déjà enregistrées : le rejeu ne doit pas créer de doublon. */
        const existing = (await pool.query(
          `SELECT container_number, reception_date::text AS reception_date, reception_number
             FROM stock_receptions WHERE company_id=$1 AND container_number IS NOT NULL`,
          [companyId]
        )).rows;
        const known = new Map(existing.map((e) => [`${e.container_number}|${e.reception_date}`, e.reception_number]));

        res.json({
          fileName: req.file.originalname,
          receptions: groups.map((g) => ({
            container: g.container, containerRaw: g.containerRaw, date: g.date,
            warehouses: g.warehouses, lineCount: g.lines.length, quantity: g.quantity,
            toReview: g.lines.filter((l) => l.matchStatus === R.MATCH_STATUS.REVIEW).length,
            alreadyImported: known.get(`${g.container}|${g.date}`) || null,
            status: g.status,
            lines: g.lines.map((l) => ({
              label: l.desc.trim(), warehouse: l.warehouse, quantity: l.quantity,
              unit: l.unit, sheet: l.sheet, excelRow: l.excelRow,
              productId: l.productId, productName: l.productName,
              matchStatus: l.matchStatus, reviewReason: l.reviewReason || null,
            })),
          })),
          totals: {
            receptions: groups.length,
            lines: rows.length,
            quantity: rows.reduce((s, r) => s + r.quantity, 0),
            multiWarehouse: groups.filter((g) => Object.keys(g.warehouses).length > 1).length,
            /* Preuve explicite : analyser ne touche aucun stock. */
            stockImpact: 0,
          },
        });
      } catch (e) {
        console.error("receptions import-preview:", e);
        res.status(500).json({ error: e.message || "Erreur d'analyse du fichier." });
      }
    });

  // ---------------- IMPORT — crée les réceptions, AUCUN mouvement ----------------
  router.post("/stock/receptions/import", authenticateToken, canCreate,
    upload.single("file"), async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu." });
        const companyId = companyOf(req);
        const groups = await matchProducts(companyId, groupReceptions(parser.readReceptionSheets(req.file.buffer)));
        const created = [], skipped = [];

        for (const g of groups) {
          const dup = (await pool.query(
            `SELECT reception_number FROM stock_receptions
              WHERE company_id=$1 AND container_number=$2 AND reception_date=$3::date`,
            [companyId, g.container, g.date]
          )).rows[0];
          if (dup) { skipped.push({ container: g.container, date: g.date, reason: "ALREADY_IMPORTED", reception_number: dup.reception_number }); continue; }

          const first = g.lines[0];
          const out = await R.createReception(pool, {
            companyId, warehouseCode: first.warehouse,
            containerNumber: g.container, receptionDate: g.date,
            source: "Import Excel", sourceFile: req.file.originalname, user: userOf(req),
            lines: g.lines.map((l) => ({
              label: l.desc.trim(), quantity: l.quantity, unit: l.unit,
              warehouseCode: l.warehouse, productId: l.productId,
              matchStatus: l.matchStatus, sheet: l.sheet, excelRow: l.excelRow,
            })),
          });
          created.push({
            reception_number: out.reception.reception_number, id: out.reception.id,
            container: g.container, date: g.date, lines: out.lineCount, quantity: g.quantity,
          });
        }
        res.status(201).json({ success: true, created, skipped, stockImpact: 0 });
      } catch (e) {
        console.error("receptions import:", e);
        res.status(e.httpStatus || 500).json({ error: e.message || "Erreur d'import.", code: e.code });
      }
    });

  // ---------------- CRÉATION MANUELLE ----------------
  router.post("/stock/receptions", authenticateToken, canCreate, async (req, res) => {
    try {
      const b = req.body || {};
      const out = await R.createReception(pool, {
        companyId: companyOf(req), warehouseCode: b.warehouseCode || "W-EM2S-A",
        containerNumber: b.containerNumber || null, receptionDate: b.receptionDate || null,
        source: b.source || "Saisie manuelle", notes: b.notes || null,
        lines: b.lines || [], user: userOf(req),
      });
      res.status(201).json({ success: true, ...out, stockImpact: 0 });
    } catch (e) {
      console.error("reception create:", e);
      res.status(e.httpStatus || 500).json({ error: e.message || "Erreur de création.", code: e.code });
    }
  });

  // ---------------- MISE EN STOCK ----------------
  router.post("/stock/receptions/:id/putaway", authenticateToken, canApply, async (req, res) => {
    try {
      const b = req.body || {};
      const out = await R.putaway(pool, {
        companyId: companyOf(req), receptionId: Number(req.params.id),
        lineId: Number(b.lineId), quantity: Number(b.quantity),
        productId: b.productId ? Number(b.productId) : null,
        locationCode: b.locationCode || null, locationId: b.locationId || null,
        user: userOf(req),
      });
      res.status(201).json({ success: true, ...out });
    } catch (e) {
      console.error("reception putaway:", e);
      res.status(e.httpStatus || 500).json({ error: e.message || "Erreur de mise en stock.", code: e.code });
    }
  });

  /* Mise en stock de plusieurs lignes. Chaque ligne reste une transaction
     indépendante : une ligne en échec n'annule pas celles déjà rangées, et le
     détail de l'échec est renvoyé ligne par ligne plutôt que masqué. */
  router.post("/stock/receptions/:id/putaway-bulk", authenticateToken, canApply, async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: "Aucune ligne sélectionnée." });
    const done = [], failed = [];
    for (const it of items) {
      try {
        const out = await R.putaway(pool, {
          companyId: companyOf(req), receptionId: Number(req.params.id),
          lineId: Number(it.lineId), quantity: Number(it.quantity),
          productId: it.productId ? Number(it.productId) : null,
          locationCode: it.locationCode || null, locationId: it.locationId || null,
          user: userOf(req),
        });
        done.push({ lineId: Number(it.lineId), ...out });
      } catch (e) {
        failed.push({ lineId: Number(it.lineId), error: e.message, code: e.code || "ERROR" });
      }
    }
    res.status(failed.length && !done.length ? 409 : 201).json({
      success: !failed.length, done, failed,
      quantityPutaway: done.reduce((s, d) => s + Number(d.movement?.quantity || 0), 0),
    });
  });

  // ---------------- RAPPORT CSV ----------------
  router.get("/stock/receptions/:id/report", authenticateToken, canView, async (req, res) => {
    try {
      const companyId = companyOf(req);
      const rec = (await pool.query(
        `SELECT * FROM stock_receptions WHERE id=$1 AND company_id=$2`, [req.params.id, companyId]
      )).rows[0];
      if (!rec) return res.status(404).json({ error: "Réception introuvable." });
      const lines = (await pool.query(
        `SELECT l.*, p.name AS product_name FROM stock_reception_lines l
           LEFT JOIN products p ON p.id=l.product_id
          WHERE l.reception_id=$1 AND l.company_id=$2 ORDER BY l.line_no`,
        [req.params.id, companyId]
      )).rows;
      const esc = (v) => { const s = String(v == null ? "" : v); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const head = ["reception", "container", "date", "ligne", "libelle_recu", "produit",
        "entrepot", "qte_recue", "qte_rangee", "reste", "unite", "statut_matching"];
      const body = lines.map((l) => [rec.reception_number, rec.container_number, rec.reception_date,
        l.line_no, l.received_label, l.product_name || "", l.warehouse_code,
        l.quantity_received, l.quantity_putaway,
        Number(l.quantity_received) - Number(l.quantity_putaway), l.unit, l.match_status]);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="reception-${rec.reception_number}.csv"`);
      res.send("﻿" + [head, ...body].map((r) => r.map(esc).join(",")).join("\n"));
    } catch (e) {
      console.error("reception report:", e);
      res.status(500).json({ error: "Erreur génération du rapport." });
    }
  });

  return router;
};

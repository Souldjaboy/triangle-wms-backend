"use strict";
const express = require("express");
const S = require("../digital-twin/service");
const { error } = require("../digital-twin/model");
module.exports = function createDigitalTwinRouter({
  pool,
  authenticateToken,
  getEffectiveCompanyId,
}) {
  const router = express.Router();
  router.use(authenticateToken);
  router.use((req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    next();
  });
  const integer = (v) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n <= 0)
      throw error("Identifiant invalide.");
    return n;
  };
  const handle =
    (fn, write = false) =>
    async (req, res) => {
      let db;
      try {
        const ctx = await S.context(pool, req, getEffectiveCompanyId);
        db = await pool.connect();
        await db.query(
          write ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        await db.query("SET LOCAL statement_timeout = '10s'");
        const out = await fn(db, ctx, req);
        await db.query("COMMIT");
        res.json(out);
      } catch (e) {
        if (db) await db.query("ROLLBACK").catch(() => {});
        if (!e.status) console.error("digital-twin", e.code || e.message);
        res
          .status(e.status || 503)
          .json({
            error: e.status
              ? e.message
              : "Module indisponible : vérifier les prérequis et les permissions.",
            code: e.status ? "DIGITAL_TWIN_ERROR" : "DIGITAL_TWIN_UNAVAILABLE",
          });
      } finally {
        db?.release();
      }
    };
  router.get(
    "/warehouses",
    handle(async (db, ctx) => {
      const rows = await S.warehouses(db, ctx),
        items = [];
      for (const w of rows) {
        const data = await S.snapshot(db, ctx, w.id),
          root = data.nodes.find((n) => n.kind === "warehouse");
        items.push({
          ...w,
          metrics: root?.metrics || null,
          zones: data.nodes.filter((n) => n.kind === "zone").length,
          racks: data.nodes.filter((n) => n.kind === "rack").length,
          aisles: data.nodes.filter((n) => n.kind === "aisle").length,
          configured: !!data.layout,
          unmapped: data.unmapped.length,
          unallocated: data.unallocated.length,
          locations: data.locations.length,
          preview: data.nodes
            .filter((n) => n.kind === "zone")
            .map((n) => ({
              id: n.id,
              code: n.code,
              geometry: n.geometry,
              metrics: n.metrics,
            })),
        });
      }
      return {
        warehouses: items,
        capabilities: { configure: ctx.canConfigure, publish: ctx.canPublish },
        as_of: new Date().toISOString(),
      };
    }),
  );
  router.get(
    "/warehouses/:id",
    handle((db, ctx, req) => S.snapshot(db, ctx, integer(req.params.id))),
  );
  router.get(
    "/warehouses/:id/layouts",
    handle(async (db, ctx, req) => {
      if (!ctx.canConfigure) throw error("Configuration non autorisée.", 403);
      const id = integer(req.params.id);
      await S.requireWarehouse(db, ctx, id);
      return (
        await db.query(
          "SELECT id,base_id,state,created_at,published_at,created_by FROM dt_layouts WHERE company_id=$1 AND warehouse_id=$2 ORDER BY id DESC LIMIT 50",
          [ctx.companyId, id],
        )
      ).rows;
    }),
  );
  router.get(
    "/warehouses/:id/layouts/:layoutId",
    handle(async (db, ctx, req) => {
      if (!ctx.canConfigure) throw error("Configuration non autorisée.", 403);
      const id = integer(req.params.id);
      await S.requireWarehouse(db, ctx, id);
      const layout = (
        await db.query(
          "SELECT id,base_id,state,high_threshold FROM dt_layouts WHERE id=$1 AND company_id=$2 AND warehouse_id=$3",
          [integer(req.params.layoutId), ctx.companyId, id],
        )
      ).rows[0];
      if (!layout) throw error("Version introuvable.", 404);
      return { ...layout, nodes: await S.nodes(db, layout.id) };
    }),
  );
  router.post(
    "/warehouses/:id/layouts",
    handle(
      (db, ctx, req) =>
        S.saveDraft(db, ctx, req, integer(req.params.id), req.body),
      true,
    ),
  );
  router.post(
    "/warehouses/:id/layouts/:layoutId/publish",
    handle((db, ctx, req) => {
      if (req.body?.confirmed !== true)
        throw error("Validation explicite du plan requise.");
      return S.publish(
        db,
        ctx,
        req,
        integer(req.params.id),
        integer(req.params.layoutId),
      );
    }, true),
  );
  router.get(
    "/warehouses/:id/locations/:locationId",
    handle(async (db, ctx, req) => {
      const id = integer(req.params.id),
        locId = integer(req.params.locationId);
      await S.requireWarehouse(db, ctx, id);
      const location = (await S.locations(db, ctx, id)).find(
        (l) => Number(l.id) === locId,
      );
      if (!location) throw error("Emplacement introuvable.", 404);
      const stock = (await S.balances(db, ctx, id)).filter(
        (b) => Number(b.location_id) === locId,
      );
      const before = req.query.before ? integer(req.query.before) : null;
      // Ne révèle ni le nom, ni l'identifiant d'une contrepartie non autorisée.
      const allowed = (await S.warehouses(db, ctx)).map((w) => w.id);
      const movements = (
        await db.query(
          `SELECT m.id,m.type,m.quantity,m.status,m.created_at,m.product_name,m.product_reference,
      m.location_stock_before,m.location_stock_after,m.destination_stock_before,m.destination_stock_after,
      CASE WHEN m.source_warehouse_id=ANY($4::int[]) THEN m.source_location_id END AS source_location_id,
      CASE WHEN m.destination_warehouse_id=ANY($4::int[]) THEN m.destination_location_id END AS destination_location_id
      FROM stock_movements m WHERE m.company_id=$1 AND (m.location_id=$2 OR m.source_location_id=$2 OR m.destination_location_id=$2)
      AND ($3::int IS NULL OR m.id<$3) ORDER BY m.id DESC LIMIT 51`,
          [ctx.companyId, locId, before, allowed],
        )
      ).rows;
      return {
        location,
        balances: stock,
        movements: movements.slice(0, 50),
        next_cursor: movements.length > 50 ? movements[49].id : null,
        lots_serials:
          "Traçabilité par lot et série à vérifier dans le schéma réel",
      };
    }),
  );
  router.get(
    "/search",
    handle(async (db, ctx, req) => {
      const q = String(req.query.q || "").trim();
      if (q.length < 2 || q.length > 100)
        throw error("Recherche : entre 2 et 100 caractères.");
      const allowed = (await S.warehouses(db, ctx)).map((w) => w.id);
      // Échappe les jokers : la recherche est littérale et toujours paramétrée.
      const term = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
      const after = req.query.after ? integer(req.query.after) : 0;
      const rows = (
        await db.query(
          `WITH RECURSIVE matching_nodes AS (
      SELECT n.id,n.layout_id,n.location_id FROM dt_nodes n JOIN dt_layouts d ON d.id=n.layout_id
      WHERE d.company_id=$1 AND d.warehouse_id=ANY($2::int[]) AND d.state='published' AND concat_ws(' ',n.code,n.name) ILIKE $3
      UNION
      SELECT child.id,child.layout_id,child.location_id FROM dt_nodes child JOIN matching_nodes parent ON child.parent_id=parent.id AND child.layout_id=parent.layout_id
    ) SELECT l.id AS location_id,l.warehouse_id,l.full_code,l.emplacement_code,l.bin_code,
      COALESCE(jsonb_agg(jsonb_build_object('product_id',p.id,'name',p.name,'reference',p.reference,'unit',p.unit,'quantity',b.quantity,'reserved_quantity',b.reserved_quantity)) FILTER(WHERE p.id IS NOT NULL),'[]'::jsonb) AS products
      FROM locations l LEFT JOIN stock_location_balances b ON b.location_id=l.id AND b.company_id=l.company_id
      LEFT JOIN products p ON p.id=b.product_id AND p.company_id=b.company_id
      WHERE l.company_id=$1 AND l.warehouse_id=ANY($2::int[]) AND l.id>$4 AND
      (concat_ws(' ',l.full_code,l.emplacement_code,l.bin_code,l.warehouse_code,l.zone,l.rayon,l.etagere) ILIKE $3
       OR concat_ws(' ',p.name,p.reference,p.barcode) ILIKE $3
       OR l.id IN(SELECT location_id FROM matching_nodes WHERE location_id IS NOT NULL)
       OR EXISTS(SELECT 1 FROM warehouses w WHERE w.id=l.warehouse_id AND w.company_id=l.company_id AND concat_ws(' ',w.name,w.code) ILIKE $3))
      GROUP BY l.id ORDER BY l.id LIMIT 101`,
          [ctx.companyId, allowed, term, after],
        )
      ).rows;
      return {
        results: rows.slice(0, 100),
        next_cursor: rows.length > 100 ? rows[99].location_id : null,
        scope: "Emplacements accessibles — quantités réparties uniquement",
      };
    }),
  );
  return router;
};

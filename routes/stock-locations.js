"use strict";

/**
 * ROUTES DU STOCK PAR EMPLACEMENT.
 *
 * Couche HTTP mince : toute la logique vit dans services/stock-locations.js,
 * et la définition d'un « vrai bac » dans services/location-rules.js. Rien
 * n'est réécrit ici.
 *
 *   GET  /stock/locations/tree                arborescence entrepôt→row→loc→level→bin
 *   GET  /stock/locations/bins                bacs exploitables, avec quantités
 *   POST /stock/locations/bins                création d'un vrai bac
 *   GET  /stock/products/:id/balances         répartition d'un produit
 *   GET  /stock/allocation/pending            produits restant à localiser
 *   POST /stock/products/:id/allocate         répartition manuelle
 *   POST /stock/locations/entry               entrée dans un bac précis
 *   POST /stock/locations/exit                sortie immédiate d'un bac
 *   POST /stock/locations/reserve             préparation : réserve sans déduire
 *   POST /stock/locations/reservations/:id/release   annulation
 *   POST /stock/locations/reservations/:id/validate  validation : déduit
 *   POST /stock/locations/transfer            bac → bac, stock global inchangé
 *   GET  /stock/locations/integrity           écarts stock / somme des balances
 *
 * Les emplacements non physiques — rebut, bin non précisé, plage « BIN1-2 »,
 * composantes générées — ne sont JAMAIS proposés comme destination.
 */

const express = require("express");
const L = require("../services/stock-locations");
const rules = require("../services/location-rules");

module.exports = function createStockLocationsRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission } = deps;
  const router = express.Router();
  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const canView = requirePermission("stock", "view");
  const canCreate = requirePermission("stock", "create");
  const canApply = requirePermission("stock", "validate");
  const userOf = (req) => ({ id: req.user.id, name: req.user.fullname || req.user.email, role: req.user.role });

  const fail = (res, e, defaut) => {
    console.error(defaut, e);
    res.status(e.httpStatus || 500).json({ error: e.message || defaut, code: e.code, details: e.details });
  };

  /* Une opération = une transaction. Les services écrivent dans le client
     fourni ; l'échec annule tout. */
  const tx = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally { client.release(); }
  };

  /* Filtre SQL des bacs exploitables — même règle que le moteur. */
  const BAC_REEL = `
    COALESCE(TRIM(l.bin_code), '') <> ''
    AND l.bin_code !~* '${rules.SQL.WRITE_OFF}'
    AND l.bin_code !~* '${rules.SQL.NON_PRECISE}'
    AND TRIM(l.bin_code) !~* '${rules.SQL.RANGE}'
    AND COALESCE(l.warehouse_code,'')   !~* '${rules.SQL.WRITE_OFF}'
    AND COALESCE(l.emplacement_code,'') !~* '${rules.SQL.WRITE_OFF}'
    AND UPPER(TRIM(COALESCE(NULLIF(l.rayon_code,''), l.zone,  ''))) !~ '${rules.SQL.PLACEHOLDER}'
    AND UPPER(TRIM(COALESCE(NULLIF(l.case_code,''),  l.rayon, ''))) !~ '${rules.SQL.PLACEHOLDER}'`;

  const VIVANT = `COALESCE(l.is_active, TRUE) = TRUE AND l.merged_into_location_id IS NULL`;

  const COMPOSANTES = `
    l.id, l.warehouse_id, l.warehouse_code,
    COALESCE(NULLIF(l.rayon_code,''), l.zone)    AS row_code,
    COALESCE(NULLIF(l.case_code,''),  l.rayon)   AS loc_code,
    COALESCE(NULLIF(l.level_code,''), l.etagere) AS lvl_code,
    l.bin_code, l.full_code, l.emplacement_code, l.occupancy_status`;

  // ---------------------------------------------------- arborescence
  router.get("/stock/locations/tree", authenticateToken, canView, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT ${COMPOSANTES},
                COALESCE(SUM(b.quantity), 0)::numeric          AS quantity,
                COALESCE(SUM(b.reserved_quantity), 0)::numeric AS reserved
           FROM locations l
           LEFT JOIN stock_location_balances b
                  ON b.location_id = l.id AND b.company_id = l.company_id
          WHERE l.company_id = $1 AND ${VIVANT} AND ${BAC_REEL}
          GROUP BY l.id
          ORDER BY l.warehouse_code, 3, 4, 5, l.bin_code`,
        [companyOf(req)]
      );
      /* Arborescence prête à alimenter des sélecteurs dépendants : un bin
         n'apparaît jamais sous un rayon auquel il n'appartient pas. */
      const arbre = {};
      for (const r of rows) {
        const w = r.warehouse_code || "—", ro = r.row_code || "—";
        const lo = r.loc_code || "—", lv = r.lvl_code || "—";
        arbre[w] ??= {};
        arbre[w][ro] ??= {};
        arbre[w][ro][lo] ??= {};
        arbre[w][ro][lo][lv] ??= [];
        arbre[w][ro][lo][lv].push({
          id: r.id, bin: r.bin_code, code: r.full_code || r.emplacement_code,
          quantity: Number(r.quantity), reserved: Number(r.reserved),
          available: Number(r.quantity) - Number(r.reserved),
          status: Number(r.quantity) > 0 ? "OCCUPIED" : "EMPTY",
        });
      }
      res.json({ tree: arbre, bins: rows.length });
    } catch (e) { fail(res, e, "Erreur chargement des emplacements."); }
  });

  router.get("/stock/locations/bins", authenticateToken, canView, async (req, res) => {
    try {
      res.json(await L.availableLocations(pool, companyOf(req), {
        warehouseId: req.query.warehouseId ? Number(req.query.warehouseId) : null,
        onlyEmpty: req.query.onlyEmpty === "1",
      }));
    } catch (e) { fail(res, e, "Erreur chargement des bacs."); }
  });

  /* Création d'un vrai bac — typiquement BIN1 / BIN2 issus d'une plage.
     Créer le contenant ne place AUCUN stock : la répartition reste manuelle. */
  router.post("/stock/locations/bins", authenticateToken, canCreate, async (req, res) => {
    try {
      const b = req.body || {};
      const companyId = companyOf(req);
      const champs = {
        warehouse: String(b.warehouse || "").trim().toUpperCase(),
        row: String(b.row || "").trim().toUpperCase(),
        location: String(b.location || "").trim().toUpperCase(),
        level: String(b.level || "").trim().toUpperCase(),
        bin: String(b.bin || "").trim().toUpperCase(),
      };
      for (const [k, v] of Object.entries(champs)) {
        if (!v) return res.status(400).json({ error: `Composante « ${k} » obligatoire.`, code: "MISSING_PART" });
      }
      const candidat = {
        warehouse_code: champs.warehouse, rayon_code: champs.row,
        case_code: champs.location, level_code: champs.level, bin_code: champs.bin,
      };
      const motif = rules.rejectionReason(candidat);
      if (motif) {
        return res.status(409).json({
          error: `Ce n'est pas un bac exploitable : ${rules.MOTIF_FR[motif]}.`, code: motif,
        });
      }

      const out = await tx(async (client) => {
        const wh = (await client.query(
          `SELECT id, code FROM warehouses WHERE company_id=$1 AND UPPER(code)=UPPER($2) LIMIT 1`,
          [companyId, champs.warehouse]
        )).rows[0];
        if (!wh) {
          const e = new Error(`Entrepôt ${champs.warehouse} introuvable.`);
          e.httpStatus = 404; e.code = "WAREHOUSE_NOT_FOUND"; throw e;
        }
        const full = [champs.warehouse, champs.row, champs.location, champs.level, champs.bin].join("-");
        const deja = (await client.query(
          `SELECT id FROM locations WHERE company_id=$1 AND UPPER(COALESCE(full_code,''))=UPPER($2) LIMIT 1`,
          [companyId, full]
        )).rows[0];
        if (deja) return { location: deja, created: false, full_code: full };

        const emplacement = [champs.warehouse, champs.row, champs.location, champs.level].join("-");
        const { rows } = await client.query(
          /* zone/rayon/etagere sont en varchar, rayon_code/case_code/level_code
             en text : réutiliser le MÊME paramètre pour les deux empêche
             Postgres d'en déduire un type. On les passe donc séparément. */
          `INSERT INTO locations
             (warehouse_id, warehouse_code, zone, rayon, etagere, emplacement_code,
              rayon_code, case_code, level_code, bin_code, status, company_id,
              full_code, is_active, occupancy_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Disponible',$11,$12,TRUE,'EMPTY')
           RETURNING *`,
          [wh.id, wh.code, champs.row, champs.location, champs.level, emplacement,
           champs.row, champs.location, champs.level, champs.bin, companyId, full]
        );
        return { location: rows[0], created: true, full_code: full };
      });
      res.status(out.created ? 201 : 200).json({ success: true, ...out, stockImpact: 0 });
    } catch (e) { fail(res, e, "Erreur de création du bac."); }
  });

  // ---------------------------------------------------- répartition
  router.get("/stock/products/:id/balances", authenticateToken, canView, async (req, res) => {
    try {
      const companyId = companyOf(req);
      const produit = (await pool.query(
        `SELECT id, name, reference, stock::numeric AS stock, unit,
                COALESCE(location_managed, FALSE) AS location_managed
           FROM products WHERE id=$1 AND company_id=$2`,
        [req.params.id, companyId]
      )).rows[0];
      if (!produit) return res.status(404).json({ error: "Produit introuvable." });

      const balances = await L.productBalances(pool, companyId, produit.id);
      const reparti = balances.reduce((s, b) => s + Number(b.quantity), 0);
      res.json({
        product: produit,
        balances: balances.map((b) => ({
          ...b, quantity: Number(b.quantity),
          reserved_quantity: Number(b.reserved_quantity),
          available: Number(b.available),
          status: Number(b.quantity) > 0 ? "OCCUPIED" : "EMPTY",
        })),
        totals: {
          stock: Number(produit.stock), reparti,
          /* Ce qui reste à localiser : le stock existe, on ignore juste où. */
          aLocaliser: Number(produit.stock) - reparti,
          reserve: balances.reduce((s, b) => s + Number(b.reserved_quantity), 0),
        },
      });
    } catch (e) { fail(res, e, "Erreur chargement de la répartition."); }
  });

  /* Produits dont la répartition physique n'est pas établie. */
  router.get("/stock/allocation/pending", authenticateToken, canView, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT p.id, p.name, p.reference, p.stock::numeric AS stock, p.unit,
                p.location_code, p.warehouse,
                COALESCE(SUM(b.quantity), 0)::numeric AS reparti
           FROM products p
           LEFT JOIN stock_location_balances b
                  ON b.product_id = p.id AND b.company_id = p.company_id
          WHERE p.company_id = $1 AND COALESCE(p.is_active, TRUE) = TRUE
            AND COALESCE(p.location_managed, FALSE) = FALSE
          GROUP BY p.id
          ORDER BY p.stock DESC NULLS LAST, p.name`,
        [companyOf(req)]
      );
      const items = rows.map((r) => ({
        ...r, stock: Number(r.stock), reparti: Number(r.reparti),
        aLocaliser: Number(r.stock) - Number(r.reparti),
      }));
      res.json({
        items,
        totals: {
          produits: items.length,
          unites: items.reduce((s, i) => s + i.stock, 0),
          aLocaliser: items.reduce((s, i) => s + i.aLocaliser, 0),
          stockNul: items.filter((i) => i.stock <= 0).length,
        },
      });
    } catch (e) { fail(res, e, "Erreur chargement des produits à localiser."); }
  });

  /* Répartition manuelle. Le service refuse toute somme différente du stock. */
  router.post("/stock/products/:id/allocate", authenticateToken, canApply, async (req, res) => {
    try {
      const allocations = Array.isArray(req.body?.allocations) ? req.body.allocations : [];
      const out = await tx((client) => L.allocateProduct(client, {
        companyId: companyOf(req), productId: Number(req.params.id),
        allocations, user: userOf(req),
      }));
      res.status(201).json({ success: true, ...out });
    } catch (e) { fail(res, e, "Erreur de répartition."); }
  });

  // ---------------------------------------------------- opérations
  const operation = (chemin, permission, fn, defaut) =>
    router.post(chemin, authenticateToken, permission, async (req, res) => {
      try {
        const out = await tx((client) => fn(client, req));
        res.status(201).json({ success: true, ...out });
      } catch (e) { fail(res, e, defaut); }
    });

  operation("/stock/locations/entry", canApply, (client, req) => L.entryAtLocation(client, {
    companyId: companyOf(req), productId: Number(req.body?.productId),
    locationId: Number(req.body?.locationId), quantity: Number(req.body?.quantity),
    reason: req.body?.reason || "Entrée", user: userOf(req),
  }), "Erreur d'entrée en stock.");

  operation("/stock/locations/exit", canApply, (client, req) => L.exitFromLocation(client, {
    companyId: companyOf(req), productId: Number(req.body?.productId),
    locationId: Number(req.body?.locationId), quantity: Number(req.body?.quantity),
    reason: req.body?.reason || "Sortie", user: userOf(req),
  }), "Erreur de sortie.");

  /* Préparer une sortie : le stock physique ne bouge PAS, seul le disponible
     baisse. Seule la validation déduit. */
  operation("/stock/locations/reserve", canCreate, (client, req) => L.reserveAtLocation(client, {
    companyId: companyOf(req), productId: Number(req.body?.productId),
    locationId: Number(req.body?.locationId), quantity: Number(req.body?.quantity),
    user: userOf(req),
  }), "Erreur de réservation.");

  operation("/stock/locations/reservations/:id/release", canCreate, (client, req) =>
    L.releaseReservation(client, {
      companyId: companyOf(req), reservationId: Number(req.params.id), user: userOf(req),
    }), "Erreur de libération.");

  operation("/stock/locations/reservations/:id/validate", canApply, (client, req) =>
    L.consumeReservation(client, {
      companyId: companyOf(req), reservationId: Number(req.params.id),
      reason: req.body?.reason || "Sortie validée", user: userOf(req),
    }), "Erreur de validation de sortie.");

  operation("/stock/locations/transfer", canApply, (client, req) =>
    L.transferBetweenLocations(client, {
      companyId: companyOf(req), productId: Number(req.body?.productId),
      sourceLocationId: Number(req.body?.sourceLocationId),
      destinationLocationId: Number(req.body?.destinationLocationId),
      quantity: Number(req.body?.quantity),
      reason: req.body?.reason || "Transfert interne", user: userOf(req),
    }), "Erreur de transfert.");

  /* Réservations actives d'un produit, pour pouvoir les annuler ou valider. */
  router.get("/stock/products/:id/reservations", authenticateToken, canView, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT r.*, l.full_code, l.emplacement_code, l.bin_code, u.fullname AS created_by_name
           FROM stock_reservations r
           JOIN locations l ON l.id = r.location_id
           LEFT JOIN users u ON u.id = r.created_by
          WHERE r.company_id=$1 AND r.product_id=$2 AND r.status='ACTIVE'
          ORDER BY r.id`,
        [companyOf(req), req.params.id]
      );
      res.json(rows);
    } catch (e) { fail(res, e, "Erreur chargement des réservations."); }
  });

  router.get("/stock/locations/integrity", authenticateToken, canView, async (req, res) => {
    try {
      const ecarts = await L.checkIntegrity(pool, companyOf(req));
      res.json({ ok: ecarts.length === 0, ecarts });
    } catch (e) { fail(res, e, "Erreur de contrôle d'intégrité."); }
  });

  return router;
};

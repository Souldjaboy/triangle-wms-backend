"use strict";

/**
 * ADMINISTRATION DES EMPLACEMENTS — API.
 *
 * L'écran historique des emplacements créait un enregistrement unique nommé
 * « 1,2,3 » lorsqu'on demandait un « Full Bin ». Les bacs 1, 2 et 3 n'ont donc
 * jamais existé, et c'est pour cela qu'on les cherche en vain. Cette API les
 * fait exister, sans jamais déplacer le stock de sa place actuelle.
 *
 *   GET   /stock/locations/inventory        tous les bacs, occupés ou libres
 *   GET   /stock/locations/hierarchy        arborescence complète, sans filtre
 *   GET   /stock/locations/levels           niveaux d'une étagère + rangs
 *   POST  /stock/locations/bins/bulk        création en série, avec aperçu
 *   PATCH /stock/locations/bins/:id         renommer, activer, archiver
 *   POST  /stock/locations/bins/:id/split   découper « 1,2,3 » en vrais bacs
 *   POST  /stock/locations/reorganize/preview   aperçu d'un plan de renommage
 *   POST  /stock/locations/reorganize/apply     application atomique
 *   GET   /stock/locations/audit            journal des modifications
 *
 * TOUTES ces routes exigent un droit sur `stock.emplacement`, contrôlé au
 * serveur. Masquer un bouton n'a jamais empêché un appel direct.
 *
 * AUCUNE route de ce fichier n'écrit une quantité de stock. Déplacer de la
 * marchandise passe par /stock/locations/transfer et son moteur transactionnel.
 */

const express = require("express");
const H = require("../services/location-hierarchy");
const rules = require("../services/location-rules");
const L = require("../services/stock-locations");

module.exports = function createLocationsAdminRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission } = deps;
  const router = express.Router();

  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const userOf = (req) => ({
    id: req.user?.id,
    name: req.user?.fullname || req.user?.email || `#${req.user?.id}`,
  });

  const canView = requirePermission("stock.emplacement", "view");
  const canCreate = requirePermission("stock.emplacement", "create");
  const canUpdate = requirePermission("stock.emplacement", "update");
  const canArchive = requirePermission("stock.emplacement", "archive");
  const canReorganize = requirePermission("stock.emplacement", "reorganize");
  const canAudit = requirePermission("stock.emplacement", "audit");

  const fail = (res, e, defaut) => {
    console.error(defaut, e.message || e);
    res.status(e.httpStatus || 500).json({ error: e.message || defaut, code: e.code, details: e.details });
  };

  /* Sans entreprise déterminée, on refuse explicitement : filtrer sur une
     société inexistante rendrait une liste vide indiscernable d'un droit
     manquant. */
  const sansSociete = (res) =>
    res.status(409).json({
      error: "Aucune entreprise active. Sélectionnez l'entreprise à administrer.",
      code: "NO_ACTIVE_COMPANY",
    });

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

  /* Composantes résolues : la colonne moderne si elle est renseignée, sinon
     l'historique. Une seule définition, partagée par toutes les routes. */
  const COMPOSANTES = `
    l.id, l.warehouse_id, l.warehouse_code,
    ${H.EXPR.ROW}   AS row_code,
    ${H.EXPR.SHELF} AS shelf_code,
    ${H.EXPR.LEVEL} AS level_code,
    ${H.EXPR.BIN}   AS bin_code,
    l.full_code, l.emplacement_code, l.previous_full_code,
    COALESCE(l.is_active, TRUE) AS is_active,
    l.archived_at, l.level_rank, l.bin_rank, l.occupancy_status`;

  /**
   * Les produits présents dans chaque bac.
   *
   * Un bac peut en contenir plusieurs : rien dans le modèle ne l'interdit, et
   * supposer le contraire ferait disparaître de l'écran tout ce qui dépasse
   * le premier produit.
   */
  const CONTENU = `
    COALESCE((
      SELECT json_agg(json_build_object(
               'product_id', p.id, 'reference', p.reference, 'name', p.name,
               'unit', p.unit, 'quantity', b.quantity::numeric,
               'reserved', b.reserved_quantity::numeric,
               'available', (b.quantity - b.reserved_quantity)::numeric)
             ORDER BY p.name)
        FROM stock_location_balances b
        JOIN products p ON p.id = b.product_id
       WHERE b.location_id = l.id AND b.company_id = l.company_id AND b.quantity > 0
    ), '[]'::json) AS contenu`;

  /** Quantités agrégées d'un bac. */
  const QUANTITES = `
    COALESCE((SELECT SUM(b.quantity) FROM stock_location_balances b
               WHERE b.location_id = l.id AND b.company_id = l.company_id), 0)::numeric AS quantity,
    COALESCE((SELECT SUM(b.reserved_quantity) FROM stock_location_balances b
               WHERE b.location_id = l.id AND b.company_id = l.company_id), 0)::numeric AS reserved,
    COALESCE((SELECT COUNT(*) FROM stock_location_balances b
               WHERE b.location_id = l.id AND b.company_id = l.company_id AND b.quantity > 0), 0)::int AS nb_produits`;

  /**
   * Enrichit une ligne brute : statut d'occupation, exploitabilité, et le
   * motif quand le bac n'est pas utilisable comme destination.
   *
   * On ne CACHE jamais un bac inexploitable : on l'affiche en disant pourquoi.
   * Un bac absent de l'écran est un bac que personne ne corrigera.
   */
  const decorer = (r) => {
    const quantity = Number(r.quantity || 0);
    const reserved = Number(r.reserved || 0);
    const motif = rules.rejectionReason({
      warehouse_code: r.warehouse_code, rayon_code: r.row_code,
      case_code: r.shelf_code, level_code: r.level_code, bin_code: r.bin_code,
      emplacement_code: r.emplacement_code,
    });
    const archive = Boolean(r.archived_at);
    const actif = r.is_active !== false && !archive;
    /* Un emplacement AMBIGU nomme plusieurs bacs à la fois, ou n'en nomme
       aucun précisément : « 1,2,3 », « BIN1-2 », « FULLBIN ». Il n'est pas
       exploitable, mais il porte souvent du stock — le masquer condamnerait
       ce stock à rester introuvable. On l'affiche donc avec ce qu'il faut
       pour le régulariser. */
    const composite = H.estBinComposite(r.bin_code);
    const ambigu = composite || ["LOCATION_UNRESOLVED", "LOCATION_UNRESOLVED_RANGE",
      "LEGACY_FULLBIN", "LEGACY_PLACEHOLDER"].includes(String(motif));
    const suggeres = composite
      ? H.splitCompositeBin(r.bin_code)
      : rules.binsFromRange({ bin_code: r.bin_code }).map((b) => b.bin);
    return {
      ...r,
      quantity, reserved,
      available: quantity - reserved,
      nb_produits: Number(r.nb_produits || 0),
      code: r.full_code || r.emplacement_code || "",
      /* EMPTY | OCCUPIED | PARTIAL : « partiellement occupé » signifie qu'une
         partie du contenu est réservée, donc immobilisée sans être sortie. */
      statut: archive ? "ARCHIVED"
            : ambigu ? "A_REGULARISER"
            : !actif ? "DISABLED"
            : quantity <= 0 ? "EMPTY"
            : reserved > 0 && reserved < quantity ? "PARTIAL"
            : "OCCUPIED",
      statut_libelle: archive ? "Archivé"
            : ambigu ? "Emplacement historique à régulariser"
            : !actif ? "Désactivé"
            : quantity <= 0 ? "Libre"
            : reserved > 0 && reserved < quantity ? "Partiellement occupé"
            : "Occupé",
      exploitable: motif === null && actif,
      motif,
      motif_libelle: motif ? rules.MOTIF_FR[motif] : null,
      ambigu,
      composite,
      /* Les bacs que cette ligne aurait dû être. Des CANDIDATS à créer, jamais
         une répartition : savoir que trois bacs existent ne dit pas lequel
         contient quoi. */
      bins_suggeres: suggeres,
      regularisable: ambigu && !archive,
      is_top: H.estNiveauTop(r.level_code),
    };
  };

  /* ═══════════════════════════════════════════════════════ LECTURE ══ */

  /**
   * TOUS LES BACS — libres, occupés, partiellement occupés, désactivés.
   *
   * Aucun bac n'est retiré de la liste parce qu'il contient déjà un produit :
   * c'est précisément ce qu'on veut voir. Les archivés ne sortent que sur
   * demande explicite.
   */
  router.get("/stock/locations/inventory", authenticateToken, canView, async (req, res) => {
    try {
      const companyId = companyOf(req);
      if (!companyId) return sansSociete(res);

      const params = [companyId];
      const where = ["l.company_id = $1"];

      if (String(req.query.archived || "") !== "1") where.push("l.archived_at IS NULL");
      if (req.query.warehouse) where.push(`UPPER(${H.EXPR.WAREHOUSE}) = UPPER($${params.push(req.query.warehouse)})`);
      if (req.query.row) where.push(`UPPER(${H.EXPR.ROW}) = UPPER($${params.push(req.query.row)})`);
      if (req.query.shelf) where.push(`UPPER(${H.EXPR.SHELF}) = UPPER($${params.push(req.query.shelf)})`);
      if (req.query.level) where.push(`UPPER(${H.EXPR.LEVEL}) = UPPER($${params.push(req.query.level)})`);

      /* Recherche : code du bac, chemin complet, ou produit rangé dedans —
         nom, référence, SKU, code-barres selon ce que la table possède. */
      if (String(req.query.q || "").trim()) {
        const q = `%${String(req.query.q).trim()}%`;
        const i = params.push(q);
        where.push(`(
          l.full_code ILIKE $${i} OR l.emplacement_code ILIKE $${i}
          OR ${H.EXPR.BIN} ILIKE $${i} OR ${H.EXPR.ROW} ILIKE $${i}
          OR ${H.EXPR.SHELF} ILIKE $${i} OR ${H.EXPR.LEVEL} ILIKE $${i}
          OR EXISTS (SELECT 1 FROM stock_location_balances b
                       JOIN products p ON p.id = b.product_id
                      WHERE b.location_id = l.id AND b.company_id = l.company_id
                        AND b.quantity > 0
                        AND (p.name ILIKE $${i} OR p.reference ILIKE $${i}))
        )`);
      }

      const { rows } = await pool.query(
        `SELECT ${COMPOSANTES}, ${QUANTITES}, ${CONTENU}
           FROM locations l
          WHERE ${where.join(" AND ")}
          ORDER BY l.warehouse_code, 3, 4,
                   COALESCE(l.level_rank, 8999), 5,
                   COALESCE(l.bin_rank, 999999), 6`,
        params
      );

      const bacs = rows.map(decorer);
      const filtre = String(req.query.statut || "TOUS").toUpperCase();
      const visibles = filtre === "TOUS" ? bacs : bacs.filter((b) => b.statut === filtre);

      res.json({
        bins: visibles,
        total: bacs.length,
        /* Compteurs calculés sur l'ensemble, pas sur la page filtrée : sinon
           l'onglet « Libres » afficherait « 0 occupés ». */
        compteurs: {
          TOUS: bacs.length,
          EMPTY: bacs.filter((b) => b.statut === "EMPTY").length,
          OCCUPIED: bacs.filter((b) => b.statut === "OCCUPIED").length,
          PARTIAL: bacs.filter((b) => b.statut === "PARTIAL").length,
          DISABLED: bacs.filter((b) => b.statut === "DISABLED").length,
          A_REGULARISER: bacs.filter((b) => b.statut === "A_REGULARISER").length,
          ARCHIVED: bacs.filter((b) => b.statut === "ARCHIVED").length,
          composites: bacs.filter((b) => b.composite).length,
          inexploitables: bacs.filter((b) => !b.exploitable && b.statut !== "ARCHIVED").length,
        },
      });
    } catch (e) { fail(res, e, "Erreur de lecture des emplacements."); }
  });

  /**
   * ARBORESCENCE COMPLÈTE — entrepôt → rayon → étagère → niveau → bacs.
   *
   * Contrairement à /stock/locations/tree, qui ne sert que les destinations
   * valides pour une opération de stock, celle-ci montre TOUT : c'est l'écran
   * d'administration, pas un sélecteur.
   */
  router.get("/stock/locations/hierarchy", authenticateToken, canView, async (req, res) => {
    try {
      const companyId = companyOf(req);
      if (!companyId) return sansSociete(res);
      const { rows } = await pool.query(
        `SELECT ${COMPOSANTES}, ${QUANTITES}
           FROM locations l
          WHERE l.company_id = $1 AND l.archived_at IS NULL
          ORDER BY l.warehouse_code, 3, 4,
                   COALESCE(l.level_rank, 8999), 5,
                   COALESCE(l.bin_rank, 999999), 6`,
        [companyId]
      );

      const arbre = [];
      const trouver = (liste, nom, extra = {}) => {
        let n = liste.find((x) => x.nom === nom);
        if (!n) { n = { nom, quantite: 0, bins: 0, enfants: [], ...extra }; liste.push(n); }
        return n;
      };

      for (const brut of rows) {
        const b = decorer(brut);
        const w = trouver(arbre, b.warehouse_code || "—", { type: "WAREHOUSE" });
        const r = trouver(w.enfants, b.row_code || "—", { type: "ROW" });
        const sh = trouver(r.enfants, b.shelf_code || "—", { type: "SHELF" });
        const lv = trouver(sh.enfants, b.level_code || "—", {
          type: "LEVEL", rang: b.level_rank ?? H.levelRank(b.level_code), is_top: b.is_top,
        });
        lv.enfants.push({ type: "BIN", ...b });
        for (const n of [w, r, sh, lv]) { n.quantite += b.quantity; n.bins += 1; }
      }
      /* Les niveaux se rangent par rang : « Top » après Level 3 comme après
         Level 4, sans qu'on ait à déclarer la hauteur de l'étagère. */
      for (const w of arbre) for (const r of w.enfants) for (const sh of r.enfants) {
        sh.enfants.sort((a, b) => (a.rang ?? 8999) - (b.rang ?? 8999));
      }
      res.json({ hierarchy: arbre, bins: rows.length });
    } catch (e) { fail(res, e, "Erreur de lecture de l'arborescence."); }
  });

  /** Les niveaux existants d'une étagère, avec leur rang et leur occupation. */
  router.get("/stock/locations/levels", authenticateToken, canView, async (req, res) => {
    try {
      const companyId = companyOf(req);
      if (!companyId) return sansSociete(res);
      const { rows } = await pool.query(
        `SELECT ${H.EXPR.LEVEL} AS level_code,
                MIN(COALESCE(l.level_rank, 8999))::int AS rang,
                COUNT(*)::int AS bins,
                COALESCE(SUM((SELECT SUM(b.quantity) FROM stock_location_balances b
                               WHERE b.location_id = l.id AND b.company_id = l.company_id)), 0)::numeric AS quantite
           FROM locations l
          WHERE l.company_id = $1 AND l.archived_at IS NULL
            AND UPPER(${H.EXPR.WAREHOUSE}) = UPPER($2)
            AND UPPER(${H.EXPR.ROW}) = UPPER($3)
            AND UPPER(${H.EXPR.SHELF}) = UPPER($4)
          GROUP BY 1 ORDER BY 2, 1`,
        [companyId, req.query.warehouse || "", req.query.row || "", req.query.shelf || ""]
      );
      res.json({
        levels: rows.map((r) => ({
          ...r, quantite: Number(r.quantite),
          is_top: H.estNiveauTop(r.level_code),
          /* Un niveau vide peut être archivé ; un niveau occupé, jamais. */
          archivable: Number(r.quantite) === 0,
        })),
      });
    } catch (e) { fail(res, e, "Erreur de lecture des niveaux."); }
  });


  /* ═══════════════════════════════════════════════════════ ÉCRITURE ══ */

  /** L'entrepôt de l'entreprise appelante, jamais celui d'une autre. */
  async function entrepotDe(runner, companyId, code) {
    const { rows } = await runner.query(
      `SELECT id, code FROM warehouses WHERE company_id = $1 AND UPPER(code) = UPPER($2) LIMIT 1`,
      [companyId, String(code || "").trim()]
    );
    if (!rows[0]) {
      throw new H.HierarchyError(`Entrepôt « ${code} » introuvable dans cette entreprise.`,
        "WAREHOUSE_NOT_FOUND", 404);
    }
    return rows[0];
  }

  /** Le bac visé, à condition qu'il appartienne à l'entreprise appelante. */
  async function bacDe(runner, companyId, id, { verrou = false } = {}) {
    const { rows } = await runner.query(
      `SELECT l.*, ${H.EXPR.ROW} AS row_code, ${H.EXPR.SHELF} AS shelf_code,
              ${H.EXPR.LEVEL} AS level_code_resolu, ${H.EXPR.BIN} AS bin_code_resolu,
              COALESCE((SELECT SUM(b.quantity) FROM stock_location_balances b
                         WHERE b.location_id = l.id AND b.company_id = l.company_id), 0)::numeric AS quantite
         FROM locations l
        WHERE l.id = $1 AND l.company_id = $2 ${verrou ? "FOR UPDATE OF l" : ""}`,
      [Number(id) || 0, companyId]
    );
    if (!rows[0]) throw new H.HierarchyError("Emplacement introuvable.", "LOCATION_NOT_FOUND", 404);
    return rows[0];
  }

  /** Le code est-il déjà porté par un AUTRE emplacement de l'entreprise ? */
  async function codeOccupe(runner, companyId, code, saufId = 0) {
    const { rows } = await runner.query(
      `SELECT id FROM locations
        WHERE company_id = $1 AND archived_at IS NULL AND id <> $3
          AND UPPER(COALESCE(full_code, emplacement_code, '')) = UPPER($2) LIMIT 1`,
      [companyId, code, Number(saufId) || 0]
    );
    return rows[0]?.id || null;
  }

  const journaliser = (client, companyId, req, o) =>
    client.query(
      `INSERT INTO location_audit_log
         (company_id, location_id, action, scope, old_value, new_value, reason,
          batch_id, quantity_before, quantity_after, changed_by, changed_by_name, context)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [companyId, o.locationId || null, o.action, o.scope || "BIN",
       o.avant ?? null, o.apres ?? null, String(o.reason || ""), o.batchId || null,
       o.quantiteAvant ?? null, o.quantiteApres ?? null,
       req.user?.id || null, userOf(req).name, String(o.context || "")]
    );

  /**
   * CRÉATION EN SÉRIE.
   *
   * « BIN-01 à BIN-10 », préfixe et largeur au choix. `preview=1` ne crée
   * rien : il montre ce qui serait créé et ce qui existe déjà, pour qu'on ne
   * découvre pas les doublons après coup.
   */
  router.post("/stock/locations/bins/bulk", authenticateToken, canCreate, async (req, res) => {
    try {
      const companyId = companyOf(req);
      if (!companyId) return sansSociete(res);
      const b = req.body || {};
      const chemin = {
        warehouse: String(b.warehouse || "").trim().toUpperCase(),
        row: String(b.row || "").trim().toUpperCase(),
        shelf: String(b.shelf || b.location || "").trim().toUpperCase(),
        level: String(b.level || "").trim().toUpperCase(),
      };
      for (const [k, v] of Object.entries(chemin)) {
        if (!v) return res.status(400).json({ error: `Composante « ${k} » obligatoire.`, code: "MISSING_PART" });
      }

      const codes = H.generateBinCodes({
        prefix: b.prefix ?? "BIN", start: b.start ?? 1, end: b.end ?? 1,
        padding: b.padding ?? 0, separator: b.separator ?? "",
      });

      /* Chaque code est confronté à la règle du vrai bac AVANT toute écriture :
         créer un bac nommé « REBUT » ou « BIN1-2 » ne ferait que reproduire le
         problème qu'on répare. */
      const candidats = codes.map((bin) => {
        const parts = { ...chemin, bin };
        const full = H.composeFullCode(parts);
        const motif = rules.rejectionReason({
          warehouse_code: chemin.warehouse, rayon_code: chemin.row,
          case_code: chemin.shelf, level_code: chemin.level, bin_code: bin,
        });
        return { bin, full_code: full, motif, motif_libelle: motif ? rules.MOTIF_FR[motif] : null };
      });

      const { rows: existants } = await pool.query(
        `SELECT UPPER(COALESCE(full_code, emplacement_code, '')) AS code FROM locations
          WHERE company_id = $1 AND UPPER(COALESCE(full_code, emplacement_code,'')) = ANY($2::text[])`,
        [companyId, candidats.map((c) => c.full_code.toUpperCase())]
      );
      const deja = new Set(existants.map((e) => e.code));
      const plan = candidats.map((c) => ({
        ...c,
        existe: deja.has(c.full_code.toUpperCase()),
        creable: !c.motif && !deja.has(c.full_code.toUpperCase()),
      }));

      const apercu = String(req.query.preview || "") === "1" || b.preview === true;
      const resume = {
        demandes: plan.length,
        a_creer: plan.filter((p) => p.creable).length,
        deja_presents: plan.filter((p) => p.existe).length,
        refuses: plan.filter((p) => p.motif).length,
      };
      if (apercu) return res.json({ preview: true, chemin, plan, resume, stockImpact: 0 });

      const aCreer = plan.filter((p) => p.creable);
      if (!aCreer.length) {
        return res.status(409).json({
          error: "Aucun bac à créer : tous existent déjà ou sont refusés par la règle.",
          code: "NOTHING_TO_CREATE", plan, resume,
        });
      }

      const out = await tx(async (client) => {
        const wh = await entrepotDe(client, companyId, chemin.warehouse);
        const lot = `BULK-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const crees = [];
        const emplacement = H.composeEmplacementCode(chemin);
        for (const p of aCreer) {
          /* zone/rayon/etagere sont en varchar et rayon_code/case_code/level_code
             en text : on passe des paramètres distincts pour que Postgres
             n'ait pas à déduire un type commun. */
          const { rows } = await client.query(
            `INSERT INTO locations
               (warehouse_id, warehouse_code, zone, rayon, etagere, emplacement_code,
                rayon_code, case_code, level_code, bin_code, status, company_id,
                full_code, is_active, occupancy_status, level_rank, bin_rank)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Disponible',$11,$12,TRUE,'EMPTY',$13,$14)
             RETURNING id, full_code`,
            [wh.id, wh.code, chemin.row, chemin.shelf, chemin.level, emplacement,
             chemin.row, chemin.shelf, chemin.level, p.bin, companyId, p.full_code,
             H.levelRank(chemin.level), H.binRank(p.bin)]
          );
          crees.push(rows[0]);
          await journaliser(client, companyId, req, {
            locationId: rows[0].id, action: "CREATE", scope: "BIN",
            apres: p.full_code, batchId: lot, quantiteAvant: 0, quantiteApres: 0,
            reason: String(b.reason || "Création en série"),
          });
        }
        return { batchId: lot, crees };
      });

      /* Créer un contenant ne place AUCUN stock : les bacs naissent vides. */
      res.status(201).json({ success: true, ...out, resume, plan, stockImpact: 0 });
    } catch (e) { fail(res, e, "Erreur de création en série."); }
  });

  /**
   * MODIFICATION D'UN BAC — renommer, déplacer, activer, désactiver, archiver.
   *
   * Le renommage ne touche que du texte : `locations.id` ne change jamais, et
   * les balances qui s'y rattachent restent exactement où elles sont.
   */
  router.patch("/stock/locations/bins/:id", authenticateToken, async (req, res, next) => {
    /* Archiver relève d'un droit distinct de renommer : on choisit le garde
       selon ce que la requête demande réellement. */
    const garde = req.body?.archive === true ? canArchive : canUpdate;
    return garde(req, res, next);
  }, async (req, res) => {
    try {
      const companyId = companyOf(req);
      if (!companyId) return sansSociete(res);
      const b = req.body || {};

      const out = await tx(async (client) => {
        const bac = await bacDe(client, companyId, req.params.id, { verrou: true });
        const quantite = Number(bac.quantite);
        const codeAvant = bac.full_code || bac.emplacement_code || "";

        // ── archivage : jamais sur un bac qui contient encore quelque chose
        if (b.archive === true) {
          if (quantite > 0) {
            throw new H.HierarchyError(
              `Ce bac contient encore ${quantite} unité(s). Videz-le par un transfert avant de l'archiver.`,
              "BIN_NOT_EMPTY", 409, { quantite }
            );
          }
          await client.query(
            `UPDATE locations SET archived_at = now(), archived_by = $2, is_active = FALSE,
                    occupancy_status = 'INACTIVE', updated_at = now()
              WHERE id = $1 AND company_id = $3`,
            [bac.id, req.user?.id || null, companyId]
          );
          await journaliser(client, companyId, req, {
            locationId: bac.id, action: "ARCHIVE", avant: codeAvant, apres: codeAvant,
            quantiteAvant: 0, quantiteApres: 0, reason: String(b.reason || ""),
          });
          return { archived: true, id: bac.id, code: codeAvant };
        }

        // ── activation / désactivation
        if (typeof b.is_active === "boolean") {
          await client.query(
            `UPDATE locations SET is_active = $2,
                    occupancy_status = CASE WHEN $2 THEN
                      (CASE WHEN $4::numeric > 0 THEN 'OCCUPIED' ELSE 'EMPTY' END)
                      ELSE 'INACTIVE' END,
                    updated_at = now()
              WHERE id = $1 AND company_id = $3`,
            [bac.id, b.is_active, companyId, quantite]
          );
          await journaliser(client, companyId, req, {
            locationId: bac.id, action: b.is_active ? "ACTIVATE" : "DEACTIVATE",
            avant: codeAvant, apres: codeAvant,
            quantiteAvant: quantite, quantiteApres: quantite,
            reason: String(b.reason || ""),
          });
        }

        // ── renommage / déplacement
        const parts = {
          warehouse: bac.warehouse_code,
          row: String(b.row ?? bac.row_code ?? "").trim().toUpperCase(),
          shelf: String(b.shelf ?? bac.shelf_code ?? "").trim().toUpperCase(),
          level: String(b.level ?? bac.level_code_resolu ?? "").trim().toUpperCase(),
          bin: String(b.bin ?? bac.bin_code_resolu ?? "").trim().toUpperCase(),
        };
        const codeApres = H.composeFullCode(parts);
        if (codeApres === codeAvant) {
          return { id: bac.id, code: codeAvant, renamed: false, quantite };
        }
        if (!parts.bin) {
          throw new H.HierarchyError("Un bac doit porter un code.", "MISSING_BIN", 400);
        }
        const occupant = await codeOccupe(client, companyId, codeApres, bac.id);
        if (occupant) {
          throw new H.HierarchyError(
            `Le code « ${codeApres} » est déjà porté par l'emplacement ${occupant}.`,
            "CODE_ALREADY_USED", 409, { occupePar: occupant }
          );
        }

        await client.query(
          /* Même précaution qu'ailleurs : $2 alimente une colonne text et une
             colonne varchar, on lui donne donc son type plutôt que de laisser
             Postgres hésiter. */
          `UPDATE locations
              SET rayon_code = $2::text, zone = $2::text,
                  case_code = $3::text, rayon = $3::text,
                  level_code = $4::text, etagere = $4::text, bin_code = $5::text,
                  level_rank = $6, bin_rank = $7,
                  emplacement_code = $8, full_code = $9,
                  previous_full_code = $10, renamed_at = now(), updated_at = now()
            WHERE id = $1 AND company_id = $11`,
          [bac.id, parts.row, parts.shelf, parts.level, parts.bin,
           H.levelRank(parts.level), H.binRank(parts.bin),
           H.composeEmplacementCode(parts), codeApres, codeAvant, companyId]
        );
        await journaliser(client, companyId, req, {
          locationId: bac.id, action: "RENAME", avant: codeAvant, apres: codeApres,
          quantiteAvant: quantite, quantiteApres: quantite, reason: String(b.reason || ""),
        });

        /* Le stock ne bouge pas d'un renommage : on le vérifie plutôt que de
           l'affirmer. */
        const { rows } = await client.query(
          `SELECT COALESCE(SUM(quantity),0)::numeric AS q FROM stock_location_balances
            WHERE company_id = $1 AND location_id = $2`,
          [companyId, bac.id]
        );
        if (Number(rows[0].q) !== quantite) {
          throw new H.HierarchyError(
            "Le stock du bac a changé pendant le renommage : rien n'est appliqué.",
            "STOCK_CHANGED_DURING_RENAME", 409
          );
        }
        return { id: bac.id, code: codeApres, ancien_code: codeAvant, renamed: true, quantite };
      });

      res.json({ success: true, ...out, stockImpact: 0 });
    } catch (e) { fail(res, e, "Erreur de modification du bac."); }
  });

  /**
   * DÉCOUPAGE D'UN BAC COMPOSITE — la réparation du « Full Bin ».
   *
   * Un enregistrement nommé « 1,2,3 » n'est pas un bac : c'est trois bacs
   * notés sur une seule ligne par l'ancien écran. On crée les bacs manquants,
   * VIDES, et on ne touche pas au stock du composite : savoir que trois bacs
   * existent ne dit pas lequel contient quoi. La répartition reste humaine.
   */
  router.post("/stock/locations/bins/:id/split", authenticateToken, canCreate, async (req, res) => {
    try {
      const companyId = companyOf(req);
      if (!companyId) return sansSociete(res);
      const prefix = String(req.body?.prefix ?? "").trim().toUpperCase();

      const out = await tx(async (client) => {
        const bac = await bacDe(client, companyId, req.params.id, { verrou: true });
        const binBrut = bac.bin_code_resolu;
        if (!H.estBinComposite(binBrut)) {
          throw new H.HierarchyError(
            `« ${binBrut} » n'est pas un bac composite : il n'y a rien à découper.`,
            "NOT_A_COMPOSITE", 400
          );
        }
        const codes = H.splitCompositeBin(binBrut, { prefix });
        const chemin = {
          warehouse: bac.warehouse_code,
          row: bac.row_code, shelf: bac.shelf_code, level: bac.level_code_resolu,
        };
        const lot = `SPLIT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const wh = await entrepotDe(client, companyId, chemin.warehouse);
        const emplacement = H.composeEmplacementCode(chemin);
        const crees = [];
        const existants = [];

        for (const code of codes) {
          const full = H.composeFullCode({ ...chemin, bin: code });
          const occupant = await codeOccupe(client, companyId, full);
          if (occupant) { existants.push({ bin: code, full_code: full, id: occupant }); continue; }
          const { rows } = await client.query(
            `INSERT INTO locations
               (warehouse_id, warehouse_code, zone, rayon, etagere, emplacement_code,
                rayon_code, case_code, level_code, bin_code, status, company_id,
                full_code, is_active, occupancy_status, level_rank, bin_rank)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Disponible',$11,$12,TRUE,'EMPTY',$13,$14)
             RETURNING id, full_code, bin_code`,
            [wh.id, wh.code, chemin.row, chemin.shelf, chemin.level, emplacement,
             chemin.row, chemin.shelf, chemin.level, code, companyId, full,
             H.levelRank(chemin.level), H.binRank(code)]
          );
          crees.push(rows[0]);
          await journaliser(client, companyId, req, {
            locationId: rows[0].id, action: "SPLIT", apres: full, batchId: lot,
            avant: bac.full_code || bac.emplacement_code,
            quantiteAvant: 0, quantiteApres: 0,
            reason: String(req.body?.reason || `Découpage du composite « ${binBrut} »`),
          });
        }
        return {
          batchId: lot, composite: { id: bac.id, bin: binBrut, quantite: Number(bac.quantite) },
          crees, existants,
        };
      });

      res.status(201).json({
        success: true, ...out, stockImpact: 0,
        message: out.crees.length
          ? `${out.crees.length} bac(s) créé(s), vide(s). Le stock reste dans « ${out.composite.bin} » : ` +
            `transférez-le bac par bac pour dire ce qui va où.`
          : "Tous les bacs de ce composite existaient déjà.",
      });
    } catch (e) { fail(res, e, "Erreur de découpage du bac composite."); }
  });

  /**
   * RÉGULARISER UN EMPLACEMENT HISTORIQUE AMBIGU.
   *
   * « 1,2,3 », « BIN1-2 » : une ligne qui nomme plusieurs bacs. Elle porte du
   * stock réel, mais ne dit pas lequel de ces bacs le contient. Aucune
   * répartition automatique n'est donc possible — et aucune n'est tentée.
   *
   * L'utilisateur dit, produit par produit, combien va dans quel bac. Le
   * serveur vérifie que l'arithmétique tombe juste :
   *
   *     somme(répartitions) + reliquat = quantité présente
   *
   * Le reliquat est ce qu'on assume de laisser sur place, faute de savoir. Il
   * est explicite, jamais déduit : un écart silencieux serait du stock perdu.
   *
   * Chaque déplacement est un VRAI mouvement de transfert, passé par le
   * moteur existant. L'emplacement d'origine n'est jamais supprimé : vidé, il
   * est archivé, et il garde son code, son id et son historique.
   *
   *   { repartitions: [{ product_id, bin, quantity }], reliquats: {product_id: n},
   *     reason }
   */
  router.post("/stock/locations/bins/:id/regulariser", authenticateToken, canCreate, async (req, res) => {
    try {
      const companyId = companyOf(req);
      if (!companyId) return sansSociete(res);
      const b = req.body || {};
      const motif = String(b.reason || "").trim();
      if (!motif) {
        return res.status(400).json({
          error: "Motif obligatoire : une régularisation se relit des mois plus tard.",
          code: "REASON_REQUIRED",
        });
      }
      const repartitions = Array.isArray(b.repartitions) ? b.repartitions : [];
      if (!repartitions.length) {
        return res.status(400).json({ error: "Aucune répartition transmise.", code: "NO_ALLOCATION" });
      }

      const out = await tx(async (client) => {
        const source = await bacDe(client, companyId, req.params.id, { verrou: true });
        const codeSource = source.full_code || source.emplacement_code || String(source.id);
        const binSource = source.bin_code_resolu;
        const motifRegle = rules.rejectionReason({
          warehouse_code: source.warehouse_code, rayon_code: source.row_code,
          case_code: source.shelf_code, level_code: source.level_code_resolu,
          bin_code: binSource, emplacement_code: source.emplacement_code,
        });
        if (!H.estBinComposite(binSource) && !motifRegle) {
          throw new H.HierarchyError(
            `« ${codeSource} » est un bac exploitable : il n'y a rien à régulariser. ` +
            `Utilisez un transfert ordinaire.`,
            "NOT_AMBIGUOUS", 400
          );
        }

        /* Ce que la source contient RÉELLEMENT, verrouillé. On ne fait pas
           confiance aux quantités envoyées par le navigateur. */
        const { rows: presents } = await client.query(
          `SELECT b.product_id, b.quantity::numeric AS quantity,
                  b.reserved_quantity::numeric AS reserved, p.name, p.reference, p.unit
             FROM stock_location_balances b
             JOIN products p ON p.id = b.product_id
            WHERE b.company_id = $1 AND b.location_id = $2 AND b.quantity > 0
            ORDER BY b.product_id
            FOR UPDATE OF b`,
          [companyId, source.id]
        );
        if (!presents.length) {
          throw new H.HierarchyError(
            `« ${codeSource} » ne contient aucun stock : archivez-le simplement.`,
            "SOURCE_EMPTY", 409
          );
        }

        /* ── arithmétique, produit par produit ─────────────────────────── */
        const parProduit = new Map();
        for (const r of repartitions) {
          const pid = Number(r.product_id) || 0;
          const q = Number(r.quantity);
          const bin = String(r.bin || "").trim().toUpperCase();
          if (!pid || !bin) {
            throw new H.HierarchyError("Répartition incomplète : produit et bac requis.",
              "INVALID_ALLOCATION", 400);
          }
          if (!(q > 0)) {
            throw new H.HierarchyError(`Quantité invalide pour le bac ${bin}.`,
              "INVALID_QUANTITY", 400);
          }
          if (!parProduit.has(pid)) parProduit.set(pid, []);
          parProduit.get(pid).push({ bin, quantity: q });
        }

        const reliquats = b.reliquats || {};
        const controle = [];
        for (const p of presents) {
          const lignes = parProduit.get(Number(p.product_id)) || [];
          const somme = lignes.reduce((n, x) => n + x.quantity, 0);
          const reliquat = Number(reliquats[p.product_id] ?? reliquats[String(p.product_id)] ?? 0);
          const total = somme + reliquat;
          const present = Number(p.quantity);
          controle.push({
            product_id: p.product_id, name: p.name, present,
            reparti: somme, reliquat, total,
          });
          if (total !== present) {
            throw new H.HierarchyError(
              `Répartition incohérente pour « ${p.name} » : ${somme} réparti(s) + ${reliquat} de ` +
              `reliquat = ${total}, alors que le bac en contient ${present}. ` +
              `La somme doit être strictement égale à la quantité présente.`,
              "ALLOCATION_MISMATCH", 400,
              { product_id: p.product_id, present, reparti: somme, reliquat }
            );
          }
          /* Le réservé ne se déplace pas à l'aveugle : on refuse de sortir
             plus que le disponible. */
          const disponible = present - Number(p.reserved);
          if (somme > disponible) {
            throw new H.HierarchyError(
              `« ${p.name} » : ${somme} demandé(s) mais seulement ${disponible} disponible(s) ` +
              `(${p.reserved} réservé(s)). Libérez la réservation d'abord.`,
              "RESERVED_STOCK", 409, { product_id: p.product_id, disponible, reserved: Number(p.reserved) }
            );
          }
        }
        /* Un produit réparti qui n'est pas dans le bac : refus. */
        for (const pid of parProduit.keys()) {
          if (!presents.some((p) => Number(p.product_id) === pid)) {
            throw new H.HierarchyError(
              `Le produit ${pid} n'est pas présent dans « ${codeSource} ».`,
              "PRODUCT_NOT_IN_SOURCE", 400
            );
          }
        }

        /* ── création des bacs destinataires, puis transferts réels ────── */
        const lot = `REGUL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const chemin = {
          warehouse: source.warehouse_code, row: source.row_code,
          shelf: source.shelf_code, level: source.level_code_resolu,
        };
        const wh = await entrepotDe(client, companyId, chemin.warehouse);
        const emplacement = H.composeEmplacementCode(chemin);
        const binsCrees = [];
        const cible = new Map();   // bin -> location_id

        const binsVises = [...new Set(repartitions.map((r) => String(r.bin || "").trim().toUpperCase()))];
        for (const bin of binsVises) {
          const refus = rules.rejectionReason({ ...chemin, warehouse_code: chemin.warehouse,
            rayon_code: chemin.row, case_code: chemin.shelf, level_code: chemin.level, bin_code: bin });
          if (refus) {
            throw new H.HierarchyError(
              `« ${bin} » ne peut pas servir de destination : ${rules.MOTIF_FR[refus]}.`,
              refus, 409
            );
          }
          const full = H.composeFullCode({ ...chemin, bin });
          const { rows: deja } = await client.query(
            `SELECT id FROM locations WHERE company_id=$1 AND archived_at IS NULL
               AND UPPER(COALESCE(full_code, emplacement_code,''))=UPPER($2) LIMIT 1`,
            [companyId, full]
          );
          if (deja[0]) { cible.set(bin, deja[0].id); continue; }
          const { rows } = await client.query(
            `INSERT INTO locations
               (warehouse_id, warehouse_code, zone, rayon, etagere, emplacement_code,
                rayon_code, case_code, level_code, bin_code, status, company_id,
                full_code, is_active, occupancy_status, level_rank, bin_rank)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Disponible',$11,$12,TRUE,'EMPTY',$13,$14)
             RETURNING id, full_code, bin_code`,
            [wh.id, wh.code, chemin.row, chemin.shelf, chemin.level, emplacement,
             chemin.row, chemin.shelf, chemin.level, bin, companyId, full,
             H.levelRank(chemin.level), H.binRank(bin)]
          );
          cible.set(bin, rows[0].id);
          binsCrees.push(rows[0]);
          await journaliser(client, companyId, req, {
            locationId: rows[0].id, action: "CREATE", scope: "BIN", apres: full,
            batchId: lot, quantiteAvant: 0, quantiteApres: 0,
            reason: `Régularisation de « ${codeSource} » : ${motif}`,
          });
        }

        const mouvements = [];
        for (const [pid, lignes] of parProduit) {
          for (const ligne of lignes) {
            /* Le moteur de transfert existant, avec ses verrous, ses contrôles
               et son écriture de mouvement. La seule tolérance : une source
               historique — c'est précisément ce qu'on vide. */
            const r = await L.transferBetweenLocations(client, {
              companyId, productId: pid,
              sourceLocationId: source.id,
              destinationLocationId: cible.get(ligne.bin),
              quantity: ligne.quantity,
              user: userOf(req),
              reason: `Régularisation « ${codeSource} » → ${ligne.bin} : ${motif}`,
              legacySource: true,
            });
            mouvements.push({
              product_id: pid, bin: ligne.bin, quantity: ligne.quantity,
              movement_id: r.movement?.id,
            });
          }
        }

        /* ── l'origine : vidée, elle s'archive ; sinon elle reste visible ── */
        const { rows: reste } = await client.query(
          `SELECT COALESCE(SUM(quantity),0)::numeric AS q FROM stock_location_balances
            WHERE company_id=$1 AND location_id=$2`,
          [companyId, source.id]
        );
        const restant = Number(reste[0].q);
        let archivee = false;
        if (restant === 0) {
          await client.query(
            `UPDATE locations SET archived_at = now(), archived_by = $2, is_active = FALSE,
                    occupancy_status = 'INACTIVE',
                    previous_full_code = COALESCE(previous_full_code, full_code, emplacement_code),
                    updated_at = now()
              WHERE id = $1 AND company_id = $3`,
            [source.id, req.user?.id || null, companyId]
          );
          archivee = true;
        }
        await journaliser(client, companyId, req, {
          locationId: source.id, action: archivee ? "ARCHIVE" : "REGULARIZE",
          scope: "BIN", avant: codeSource, apres: codeSource, batchId: lot,
          quantiteAvant: presents.reduce((n, p) => n + Number(p.quantity), 0),
          quantiteApres: restant,
          reason: `Régularisation : ${motif}`,
        });

        return {
          batchId: lot, source: { id: source.id, code: codeSource, bin: binSource },
          controle, bins_crees: binsCrees, mouvements,
          reliquat_total: restant, archivee,
        };
      });

      res.status(201).json({
        success: true, ...out,
        message: out.archivee
          ? `Emplacement « ${out.source.code} » régularisé et archivé. Il reste en base avec son historique.`
          : `Emplacement « ${out.source.code} » partiellement régularisé : ${out.reliquat_total} unité(s) y restent.`,
      });
    } catch (e) { fail(res, e, "Erreur de régularisation."); }
  });

  /* ═════════════════════════════════════════════════ RÉORGANISATION ══ */

  /**
   * LE PLAN INVERSE.
   *
   * Défaire « A→B, B→C » n'est pas défaire chaque ligne dans l'ordre : appliqué
   * tel quel, « B→A » puis « C→B » écraserait A avant de l'avoir libéré. On
   * inverse donc chaque correspondance ET on renverse leur ordre — le même
   * raisonnement que celui qui a rendu la réorganisation possible à l'aller.
   *
   * Le moteur de renommage passe de toute façon par des codes temporaires, ce
   * qui rend l'ordre indifférent ; le renversement garde surtout le plan
   * LISIBLE pour celui qui doit le relire avant de le soumettre.
   */
  const inverser = (mappings) =>
    (Array.isArray(mappings) ? mappings : [])
      .slice()
      .reverse()
      .map((m) => ({
        scope: m.scope, warehouse: m.warehouse || "",
        from: m.to, to: m.from, path: m.path || {},
      }));

  /**
   * RELIRE UNE RÉORGANISATION — et préparer son retour arrière.
   *
   * Ne défait RIEN. Rend le plan appliqué, le plan inverse calculé, et
   * l'aperçu de ce que ce dernier ferait s'il était soumis. Le retour arrière
   * passe ensuite par le même couple preview / apply que n'importe quelle
   * réorganisation, avec sa confirmation et son motif : un « annuler » qui
   * s'exécuterait d'un clic serait plus dangereux que le renommage initial.
   */
  router.get("/stock/locations/reorganize/:batchId", authenticateToken, canReorganize, async (req, res) => {
    try {
      const companyId = companyOf(req);
      if (!companyId) return sansSociete(res);
      const lot = String(req.params.batchId || "");

      const { rows } = await pool.query(
        `SELECT a.*, l.full_code, l.emplacement_code
           FROM location_audit_log a
           LEFT JOIN locations l ON l.id = a.location_id
          WHERE a.company_id = $1 AND a.batch_id = $2
          ORDER BY a.id`,
        [companyId, lot]
      );
      if (!rows.length) {
        return res.status(404).json({ error: "Réorganisation introuvable.", code: "BATCH_NOT_FOUND" });
      }

      const synthese = rows.find((r) => r.action === "REORGANIZE" && r.scope === "BATCH");
      let mappings = [];
      try { mappings = JSON.parse(synthese?.context || "{}").mappings || []; } catch { mappings = []; }
      const renommages = rows.filter((r) => r.action === "RENAME");
      const mappingsInverse = inverser(mappings);

      /* L'aperçu du retour arrière est calculé sur l'état ACTUEL : entre-temps
         d'autres renommages ont pu avoir lieu, et c'est précisément ce que
         l'aperçu doit révéler avant qu'on soumette quoi que ce soit. */
      let apercuRetour = null;
      let erreurRetour = null;
      if (mappingsInverse.length) {
        try {
          apercuRetour = await H.planifierRenommage(pool, companyId, mappingsInverse);
        } catch (e) { erreurRetour = e.message; }
      }

      res.json({
        batch_id: lot,
        applique_le: synthese?.changed_at || renommages[0]?.changed_at || null,
        applique_par: synthese?.changed_by_name || renommages[0]?.changed_by_name || "",
        motif: synthese?.reason || renommages[0]?.reason || "",
        quantite_avant: Number(synthese?.quantity_before ?? 0),
        quantite_apres: Number(synthese?.quantity_after ?? 0),
        /* Le plan tel qu'il a été appliqué, bac par bac. */
        plan_applique: renommages.map((r) => ({
          location_id: r.location_id,
          code_avant: r.old_value, code_apres: r.new_value,
          quantite: Number(r.quantity_before ?? 0),
          code_actuel: r.full_code || r.emplacement_code || null,
        })),
        mappings,
        /* À soumettre tel quel à /reorganize/preview puis /apply. Rien n'est
           exécuté ici. */
        mappings_inverse: mappingsInverse,
        apercu_retour: apercuRetour,
        erreur_retour: erreurRetour,
        avertissement:
          "Ce retour arrière n'est pas exécuté. Relisez l'aperçu, puis soumettez " +
          "« mappings_inverse » à la prévisualisation habituelle avec un motif.",
      });
    } catch (e) { fail(res, e, "Erreur de lecture de la réorganisation."); }
  });


  /** APERÇU d'un plan de renommage. Aucune écriture, aucun verrou. */
  router.post("/stock/locations/reorganize/preview", authenticateToken, canReorganize, async (req, res) => {
    try {
      const companyId = companyOf(req);
      if (!companyId) return sansSociete(res);
      const plan = await H.planifierRenommage(pool, companyId, req.body?.mappings);
      res.json({ preview: true, ...plan });
    } catch (e) { fail(res, e, "Erreur de préparation du plan."); }
  });

  /**
   * APPLICATION ATOMIQUE.
   *
   * Le plan est REFAIT dans la transaction : appliquer un aperçu calculé il y
   * a dix minutes reviendrait à renommer d'après un état qui n'existe plus.
   */
  router.post("/stock/locations/reorganize/apply", authenticateToken, canReorganize, async (req, res) => {
    try {
      const companyId = companyOf(req);
      if (!companyId) return sansSociete(res);
      const motif = String(req.body?.reason || "").trim();
      if (!motif) {
        return res.status(400).json({
          error: "Motif obligatoire : une réorganisation se relit des mois plus tard.",
          code: "REASON_REQUIRED",
        });
      }

      const out = await tx(async (client) => {
        const plan = await H.planifierRenommage(client, companyId, req.body?.mappings);
        if (!plan.applicable) {
          throw new H.HierarchyError(
            plan.cibles.length
              ? "Conflits de codes : le plan ne peut pas s'appliquer tel quel."
              : "Aucun emplacement ne correspond à ce plan.",
            plan.cibles.length ? "PLAN_NOT_APPLICABLE" : "PLAN_EMPTY", 409,
            { collisions: plan.collisions, doublons: plan.doublons }
          );
        }
        const r = await H.appliquerRenommage(client, {
          companyId, plan, user: userOf(req), reason: motif,
          context: String(req.body?.context || ""),
        });

        /* LIGNE DE SYNTHÈSE DU LOT.
           Sans elle, on saurait quels bacs ont été renommés mais pas selon
           quelle règle : impossible de proposer le chemin inverse des mois
           plus tard. On archive donc le plan lui-même, pas seulement ses
           effets. */
        const correspondances = plan.correspondances.map((c) => ({
          scope: c.scope, warehouse: c.warehouse, from: c.from, to: c.to, path: c.path,
        }));
        await client.query(
          `INSERT INTO location_audit_log
             (company_id, location_id, action, scope, old_value, new_value, reason,
              batch_id, quantity_before, quantity_after, changed_by, changed_by_name, context)
           VALUES ($1,NULL,'REORGANIZE','BATCH',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [companyId,
           `${plan.resume.bins} bac(s) avant renommage`,
           `${plan.resume.bins} bac(s) après renommage`,
           motif, r.batchId, r.quantiteAvant, r.quantiteApres,
           req.user?.id || null, userOf(req).name,
           JSON.stringify({ mappings: correspondances })]
        );

        return { ...r, resume: plan.resume, cibles: plan.cibles,
                 mappings_inverse: inverser(correspondances) };
      });

      res.json({ success: true, ...out, stockImpact: 0 });
    } catch (e) { fail(res, e, "Erreur d'application de la réorganisation."); }
  });

  /** JOURNAL — consultable, jamais modifiable depuis l'application. */
  router.get("/stock/locations/audit", authenticateToken, canAudit, async (req, res) => {
    try {
      const companyId = companyOf(req);
      if (!companyId) return sansSociete(res);
      const params = [companyId];
      const where = ["a.company_id = $1"];
      if (req.query.location_id) where.push(`a.location_id = $${params.push(Number(req.query.location_id))}`);
      if (req.query.batch_id) where.push(`a.batch_id = $${params.push(String(req.query.batch_id))}`);
      const { rows } = await pool.query(
        `SELECT a.*, l.full_code, l.emplacement_code
           FROM location_audit_log a
           LEFT JOIN locations l ON l.id = a.location_id
          WHERE ${where.join(" AND ")}
          ORDER BY a.changed_at DESC, a.id DESC LIMIT 300`,
        params
      );
      res.json({ entries: rows });
    } catch (e) { fail(res, e, "Erreur de lecture du journal des emplacements."); }
  });

  return router;
};

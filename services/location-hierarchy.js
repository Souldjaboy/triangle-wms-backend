"use strict";

/**
 * HIÉRARCHIE DES EMPLACEMENTS — MODÈLE PLAT.
 *
 * `locations` ne connaît pas les rayons : elle ne connaît que des bacs, dont
 * chacun recopie le nom de son rayon, de son étagère et de son niveau. Un
 * rayon n'existe donc que comme la valeur commune d'un ensemble de lignes.
 *
 * Ce module en tire les conséquences plutôt que de les contourner :
 *
 *   1. L'IDENTITÉ D'UN BAC EST SON id, JAMAIS SON CODE.
 *      Renommer ne crée ni ne supprime aucune ligne : on met à jour du texte.
 *      Le stock vit dans `stock_location_balances.location_id` — il ne peut
 *      donc pas bouger du fait d'un renommage, par construction et non par
 *      précaution.
 *
 *   2. RENOMMER EN MASSE SE HEURTE À L'INDEX UNIQUE.
 *      `locations_full_code_uidx (company_id, full_code)` interdit deux bacs
 *      de même code. Renommer B → C alors que C existe échouerait à
 *      mi-parcours. On passe donc par des codes temporaires : tout le lot est
 *      d'abord déplacé hors de l'espace des noms définitifs, puis reposé
 *      dessus. Une seule transaction : ou tout le plan s'applique, ou rien.
 *
 *   3. « TOP » N'EST PAS UN TEXTE DÉCORATIF.
 *      Trié alphabétiquement, « Top » tombe entre « 3 » et « 4 ». Le rang
 *      d'affichage (`level_rank`) le range là où il est physiquement : au
 *      sommet, quel que soit le nombre de niveaux de l'étagère.
 *
 * Ce module ne fait AUCUNE écriture de stock. Déplacer de la marchandise
 * relève de services/stock-locations.js et de son moteur de transfert.
 */

const rules = require("./location-rules");

/* Les quatre échelons nommables, du plus large au plus fin. Chacun porte son
   couple de colonnes : la moderne, et l'historique qu'il faut tenir à jour
   pour que l'ancien écran et le nouveau montrent la même chose. */
const ECHELONS = {
  ROW:   { moderne: "rayon_code", historique: "zone",    label: "rayon" },
  SHELF: { moderne: "case_code",  historique: "rayon",   label: "étagère" },
  LEVEL: { moderne: "level_code", historique: "etagere", label: "niveau" },
  BIN:   { moderne: "bin_code",   historique: null,      label: "bac" },
};

/** Expression SQL donnant la valeur effective d'un échelon. */
const EXPR = {
  WAREHOUSE: "COALESCE(l.warehouse_code, '')",
  ROW:   "COALESCE(NULLIF(l.rayon_code,''), l.zone,    '')",
  SHELF: "COALESCE(NULLIF(l.case_code,''),  l.rayon,   '')",
  LEVEL: "COALESCE(NULLIF(l.level_code,''), l.etagere, '')",
  BIN:   "COALESCE(l.bin_code, '')",
};

const s = (v) => String(v ?? "").trim();
const up = (v) => s(v).toUpperCase();

/** Composantes d'une ligne, quelle que soit la génération de colonnes. */
function partsOf(row = {}) {
  return {
    warehouse: s(row.warehouse_code),
    row: s(row.row_code || row.rayon_code || row.zone),
    shelf: s(row.loc_code || row.case_code || row.rayon),
    level: s(row.lvl_code || row.level_code || row.etagere),
    bin: s(row.bin_code),
  };
}

/** Le code complet d'un bac. Même règle qu'en migration 061. */
function composeFullCode(parts) {
  return [parts.warehouse, parts.row, parts.shelf, parts.level, parts.bin]
    .map(s).filter(Boolean).join("-");
}

/** Le code d'emplacement historique : tout sauf le bac. */
function composeEmplacementCode(parts) {
  return [parts.warehouse, parts.row, parts.shelf, parts.level]
    .map(s).filter(Boolean).join("-");
}

/* ------------------------------------------------------------ les niveaux */

const TOP_RE = /(TOP|HAUT|SUP)/i;
const RANG_TOP = 9000;
const RANG_INCONNU = 8999;

/**
 * Rang d'affichage d'un niveau.
 *
 * « Top » vaut 9000 : il passe après Level 3 comme après Level 4, sans qu'on
 * ait à déclarer combien de niveaux porte l'étagère. Ajouter un Level 4 plus
 * tard ne déplace donc pas le Top, et n'exige aucun développement.
 */
function levelRank(code) {
  const v = up(code);
  if (!v) return RANG_INCONNU;
  if (TOP_RE.test(v)) return RANG_TOP;
  const m = v.match(/(\d+)/);
  return m ? Math.min(Number(m[1]), RANG_INCONNU - 1) : RANG_INCONNU;
}

function binRank(code) {
  const m = up(code).match(/(\d+)/);
  return m ? Math.min(Number(m[1]), 999999) : 999999;
}

const estNiveauTop = (code) => TOP_RE.test(up(code));

/* --------------------------------------------------- création en série */

/**
 * Codes d'une série de bacs : préfixe, bornes, largeur du nombre.
 *
 * « BIN-01 à BIN-10 » n'est pas la même chose que « BIN-1 à BIN-10 » : la
 * largeur décide du tri alphabétique des étiquettes. On la rend donc
 * explicite plutôt que de la deviner.
 */
function generateBinCodes({ prefix = "BIN", start = 1, end = 1, padding = 0, separator = "" } = {}) {
  const debut = Math.floor(Number(start));
  const fin = Math.floor(Number(end));
  if (!Number.isFinite(debut) || !Number.isFinite(fin)) {
    throw new HierarchyError("Bornes de série invalides.", "INVALID_RANGE", 400);
  }
  if (debut < 0 || fin < debut) {
    throw new HierarchyError("La borne de fin doit être supérieure ou égale à la borne de début.", "INVALID_RANGE", 400);
  }
  if (fin - debut + 1 > 500) {
    throw new HierarchyError("Série trop longue : 500 bacs au maximum en une fois.", "RANGE_TOO_LARGE", 400);
  }
  const large = Math.max(0, Math.min(Number(padding) || 0, 6));
  const out = [];
  for (let i = debut; i <= fin; i += 1) {
    out.push(`${up(prefix)}${separator}${String(i).padStart(large, "0")}`);
  }
  return out;
}

/* ------------------------------------------- bacs composites « 1,2,3 » */

/**
 * L'ancien écran « Full Bin » envoyait UN SEUL enregistrement dont le bac
 * s'appelait « 1,2,3 ». Les bacs 1, 2 et 3 n'ont donc jamais existé : c'est
 * la raison pour laquelle on les cherche en vain dans les listes.
 *
 * On sait quels bacs auraient dû exister. On ne sait PAS lequel contient
 * quoi : le découpage produit donc des contenants vides, et le stock reste
 * là où il est jusqu'à ce qu'un humain le réparte.
 */
const COMPOSITE_RE = /^\s*(?:BIN[\s_-]*)?\d+\s*(?:[,;+]\s*(?:BIN[\s_-]*)?\d+\s*)+$/i;

function estBinComposite(binCode) {
  return COMPOSITE_RE.test(s(binCode));
}

function splitCompositeBin(binCode, { prefix = "" } = {}) {
  if (!estBinComposite(binCode)) return [];
  const nums = s(binCode).match(/\d+/g) || [];
  const uniques = [...new Set(nums.map((n) => String(Number(n))))];
  return uniques.map((n) => `${up(prefix)}${n}`);
}

/* -------------------------------------------------------------- erreurs */

class HierarchyError extends Error {
  constructor(message, code = "HIERARCHY_ERROR", httpStatus = 400, details = null) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/* ------------------------------------------------- plan de renommage */

/**
 * Une correspondance : « sous cet entrepôt, à cet échelon, ce nom devient
 * celui-là ». Les chemins parents restreignent la portée — renommer le niveau
 * « 3 » ne doit pas renommer le niveau 3 de tous les rayons de l'entrepôt.
 */
function normaliserCorrespondance(m = {}) {
  const scope = up(m.scope || "ROW");
  if (!ECHELONS[scope]) {
    throw new HierarchyError(`Échelon « ${m.scope} » inconnu.`, "UNKNOWN_SCOPE", 400);
  }
  const from = up(m.from);
  const to = up(m.to);
  if (!from) throw new HierarchyError("Valeur d'origine manquante.", "MISSING_FROM", 400);
  if (!to) throw new HierarchyError("Nouveau nom manquant.", "MISSING_TO", 400);
  return {
    scope,
    from,
    to,
    warehouse: up(m.warehouse),
    path: {
      row: up(m.path?.row),
      shelf: up(m.path?.shelf),
      level: up(m.path?.level),
    },
  };
}

/** Clauses SQL restreignant une correspondance à sa portée exacte. */
function clausesDePortee(c, params) {
  const where = [`UPPER(${EXPR[c.scope]}) = $${params.push(c.from)}`];
  if (c.warehouse) where.push(`UPPER(${EXPR.WAREHOUSE}) = $${params.push(c.warehouse)}`);
  if (c.path.row && c.scope !== "ROW") where.push(`UPPER(${EXPR.ROW}) = $${params.push(c.path.row)}`);
  if (c.path.shelf && !["ROW", "SHELF"].includes(c.scope)) {
    where.push(`UPPER(${EXPR.SHELF}) = $${params.push(c.path.shelf)}`);
  }
  if (c.path.level && c.scope === "BIN") {
    where.push(`UPPER(${EXPR.LEVEL}) = $${params.push(c.path.level)}`);
  }
  return where.join(" AND ");
}

/**
 * APERÇU. Aucune écriture.
 *
 * Rend, pour chaque correspondance, les bacs touchés, leur code avant et
 * après, le stock qu'ils portent, et les collisions. Le total du stock est
 * calculé des deux côtés : un renommage qui changerait ce total serait un
 * bug, et l'aperçu doit permettre de le voir AVANT d'appliquer.
 */
async function planifierRenommage(runner, companyId, correspondances) {
  const liste = (Array.isArray(correspondances) ? correspondances : []).map(normaliserCorrespondance);
  if (!liste.length) throw new HierarchyError("Aucune correspondance transmise.", "NO_MAPPING", 400);

  const cibles = new Map();   // location_id -> { avant, apres, quantite }
  const parCorrespondance = [];

  for (const c of liste) {
    const params = [companyId];
    const portee = clausesDePortee(c, params);
    const { rows } = await runner.query(
      `SELECT l.id, l.warehouse_code, l.full_code, l.emplacement_code,
              ${EXPR.ROW}   AS row_code,
              ${EXPR.SHELF} AS shelf_code,
              ${EXPR.LEVEL} AS level_code,
              ${EXPR.BIN}   AS bin_code,
              COALESCE((SELECT SUM(b.quantity) FROM stock_location_balances b
                         WHERE b.location_id = l.id AND b.company_id = l.company_id), 0)::numeric AS quantite,
              COALESCE((SELECT COUNT(*) FROM stock_location_balances b
                         WHERE b.location_id = l.id AND b.company_id = l.company_id AND b.quantity > 0), 0)::int AS produits
         FROM locations l
        WHERE l.company_id = $1 AND l.archived_at IS NULL AND ${portee}
        ORDER BY l.id`,
      params
    );

    for (const r of rows) {
      const avant = partsOf(r);
      /* row_code / shelf_code / level_code sortent déjà résolus du SELECT. */
      avant.row = s(r.row_code); avant.shelf = s(r.shelf_code);
      avant.level = s(r.level_code); avant.bin = s(r.bin_code);
      const apres = { ...avant };
      if (c.scope === "ROW") apres.row = c.to;
      if (c.scope === "SHELF") apres.shelf = c.to;
      if (c.scope === "LEVEL") apres.level = c.to;
      if (c.scope === "BIN") apres.bin = c.to;

      /* Deux correspondances qui viseraient le même bac se contrediraient :
         on applique la première et on signale, plutôt que d'en perdre une
         silencieusement. */
      const deja = cibles.get(r.id);
      if (deja) {
        deja.conflitsInternes.push(`${c.scope} ${c.from}→${c.to}`);
        continue;
      }
      cibles.set(r.id, {
        id: r.id,
        codeAvant: r.full_code || r.emplacement_code || composeFullCode(avant),
        codeApres: composeFullCode(apres),
        avant, apres,
        quantite: Number(r.quantite),
        produits: Number(r.produits),
        conflitsInternes: [],
      });
    }
    parCorrespondance.push({ ...c, bins: rows.length });
  }

  const cible = [...cibles.values()];
  /* Les bacs que le plan ne touche pas mais dont le code est déjà pris :
     c'est là que se produit la collision « B devient C alors que C existe ».
     Elle n'est bloquante que si le C existant n'est pas lui-même renommé. */
  const codesApres = new Set(cible.map((t) => up(t.codeApres)));
  const idsTouches = new Set(cible.map((t) => t.id));
  const { rows: occupants } = await runner.query(
    `SELECT l.id, UPPER(COALESCE(l.full_code, l.emplacement_code, '')) AS code
       FROM locations l
      WHERE l.company_id = $1 AND l.archived_at IS NULL
        AND UPPER(COALESCE(l.full_code, l.emplacement_code, '')) = ANY($2::text[])`,
    [companyId, [...codesApres]]
  );
  const collisions = occupants
    .filter((o) => !idsTouches.has(o.id))
    .map((o) => ({ code: o.code, occupePar: o.id }));

  /* Deux bacs différents qui viseraient le même code final : impossible. */
  const vus = new Map();
  const doublons = [];
  for (const t of cible) {
    const k = up(t.codeApres);
    if (vus.has(k)) doublons.push({ code: t.codeApres, ids: [vus.get(k), t.id] });
    else vus.set(k, t.id);
  }

  const totalAvant = cible.reduce((n, t) => n + t.quantite, 0);
  return {
    correspondances: parCorrespondance,
    cibles: cible,
    resume: {
      bins: cible.length,
      rayons: new Set(cible.map((t) => t.avant.row)).size,
      etageres: new Set(cible.map((t) => `${t.avant.row}|${t.avant.shelf}`)).size,
      niveaux: new Set(cible.map((t) => `${t.avant.row}|${t.avant.shelf}|${t.avant.level}`)).size,
      produits: cible.reduce((n, t) => n + t.produits, 0),
      quantiteAvant: totalAvant,
      /* Un renommage ne crée ni ne détruit de stock : l'après est l'avant.
         On le calcule tout de même à l'application, et on refuse si l'égalité
         est rompue. */
      quantiteApres: totalAvant,
    },
    collisions,
    doublons,
    applicable: collisions.length === 0 && doublons.length === 0 && cible.length > 0,
  };
}

/**
 * APPLICATION. À appeler DANS une transaction déjà ouverte.
 *
 * Deux temps, pour ne jamais heurter l'index unique :
 *   1. tous les bacs du lot reçoivent un code temporaire, hors de l'espace
 *      des noms définitifs ;
 *   2. chacun reçoit son code final.
 *
 * Aucun `INSERT`, aucun `DELETE` : seuls des `UPDATE` de colonnes textuelles.
 * `location_id` ne bouge pas, donc les balances non plus.
 */
async function appliquerRenommage(client, { companyId, plan, user, reason = "", batchId, context = "" }) {
  if (!plan?.applicable) {
    throw new HierarchyError(
      "Plan non applicable : conflits de codes à résoudre d'abord.",
      "PLAN_NOT_APPLICABLE", 409,
      { collisions: plan?.collisions || [], doublons: plan?.doublons || [] }
    );
  }
  const lot = batchId || `REORG-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ids = plan.cibles.map((t) => t.id);

  /* Verrou pris dans un ordre déterministe : deux réorganisations lancées en
     même temps s'attendent au lieu de s'interbloquer. */
  const { rows: verrous } = await client.query(
    `SELECT id, company_id,
            COALESCE((SELECT SUM(b.quantity) FROM stock_location_balances b
                       WHERE b.location_id = locations.id AND b.company_id = locations.company_id), 0)::numeric AS q
       FROM locations WHERE company_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR UPDATE`,
    [companyId, ids]
  );
  if (verrous.length !== ids.length) {
    throw new HierarchyError(
      "Un emplacement du plan a disparu ou a changé d'entreprise depuis l'aperçu.",
      "PLAN_STALE", 409
    );
  }
  const quantiteAvant = verrous.reduce((n, r) => n + Number(r.q), 0);

  // ── temps 1 : sortir tout le lot de l'espace des noms définitifs
  for (const t of plan.cibles) {
    await client.query(
      `UPDATE locations SET full_code = $2, updated_at = now() WHERE id = $1 AND company_id = $3`,
      [t.id, `__REORG__${lot}__${t.id}`, companyId]
    );
  }

  // ── temps 2 : poser les noms finaux
  for (const t of plan.cibles) {
    const p = t.apres;
    await client.query(
      /* zone/rayon/etagere sont en varchar, rayon_code/case_code/level_code en
         text. Un même paramètre servant aux deux, Postgres ne sait pas quel
         type en déduire et refuse la requête : on le type explicitement en
         text, que la colonne varchar accepte à l'affectation. */
      `UPDATE locations
          SET rayon_code = $2::text, zone    = $2::text,
              case_code  = $3::text, rayon   = $3::text,
              level_code = $4::text, etagere = $4::text,
              bin_code   = $5::text,
              level_rank = $6, bin_rank = $7,
              emplacement_code = $8,
              full_code = $9,
              previous_full_code = $10,
              renamed_at = now(),
              updated_at = now()
        WHERE id = $1 AND company_id = $11`,
      [t.id, p.row, p.shelf, p.level, p.bin,
       levelRank(p.level), binRank(p.bin),
       composeEmplacementCode(p), t.codeApres, t.codeAvant, companyId]
    );
    await client.query(
      `INSERT INTO location_audit_log
         (company_id, location_id, action, scope, old_value, new_value, reason,
          batch_id, quantity_before, quantity_after, changed_by, changed_by_name, context)
       VALUES ($1,$2,'RENAME',$3,$4,$5,$6,$7,$8,$8,$9,$10,$11)`,
      [companyId, t.id, "BIN", t.codeAvant, t.codeApres, s(reason), lot,
       t.quantite, user?.id || null, s(user?.name || user?.fullname || user?.email), s(context)]
    );
  }

  /* CONTRÔLE FINAL. Le stock des bacs touchés doit être identique à ce qu'il
     était avant. S'il ne l'est pas, quelque chose a écrit du stock pendant la
     réorganisation : on refuse, et la transaction annule tout. */
  const { rows: apres } = await client.query(
    `SELECT COALESCE(SUM(b.quantity), 0)::numeric AS q
       FROM stock_location_balances b
      WHERE b.company_id = $1 AND b.location_id = ANY($2::int[])`,
    [companyId, ids]
  );
  const quantiteApres = Number(apres[0]?.q || 0);
  if (quantiteApres !== quantiteAvant) {
    throw new HierarchyError(
      `Le stock des emplacements touchés a changé pendant la réorganisation : ` +
      `${quantiteAvant} avant, ${quantiteApres} après. Rien n'est appliqué.`,
      "STOCK_CHANGED_DURING_RENAME", 409, { quantiteAvant, quantiteApres }
    );
  }

  return { batchId: lot, bins: plan.cibles.length, quantiteAvant, quantiteApres };
}

module.exports = {
  ECHELONS, EXPR, RANG_TOP, RANG_INCONNU, HierarchyError,
  partsOf, composeFullCode, composeEmplacementCode,
  levelRank, binRank, estNiveauTop,
  generateBinCodes, estBinComposite, splitCompositeBin,
  normaliserCorrespondance, planifierRenommage, appliquerRenommage,
  rules,
};

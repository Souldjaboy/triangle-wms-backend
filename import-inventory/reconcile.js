"use strict";

/**
 * RÉCONCILIATION inventaire Excel <-> stock Triangle (phase PREVIEW).
 *
 * Compare, classe, et n'écrit RIEN. La décision reste humaine : aucun produit
 * ambigu n'est fusionné automatiquement, aucune quantité n'est inventée.
 *
 * Matching à quatre niveaux (§6) :
 *   1. nom exact        -> sûr
 *   2. nom normalisé    -> sûr
 *   3. plusieurs candidats normalisés -> AMBIGUOUS_PRODUCT
 *   4. proximité >= 86% -> SUGGESTION uniquement, jamais une fusion
 */

const { normName, similarity } = require("./excel-inventory-parser");

const ACTIONS = {
  MATCH: "MATCH",                         // stock identique, aucun mouvement
  MOVEMENT_ONLY: "MOVEMENT_ONLY",         // IN/OUT à passer, solde final cohérent
  QUANTITY_CONFLICT: "QUANTITY_CONFLICT", // écart -> ajustement d'inventaire à valider
  NEW_PRODUCT: "NEW_PRODUCT",
  AMBIGUOUS_PRODUCT: "AMBIGUOUS_PRODUCT", // décision humaine obligatoire
  TO_REVIEW: "TO_REVIEW",                 // quantité absente dans le fichier
};

/* Un produit peut apparaître sur plusieurs lignes/emplacements : on agrège par
   nom normalisé pour n'obtenir QU'UNE fiche produit (§22). */
function aggregateExcel(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.norm)) {
      map.set(r.norm, { desc: r.desc, norm: r.norm, unit: r.unit, qty: 0, in: 0, out: 0, emptyQty: 0, lines: [] });
    }
    const a = map.get(r.norm);
    a.qty += r.qty.n; a.in += r.in.n; a.out += r.out.n;
    if (r.qty.empty) a.emptyQty++;
    a.lines.push(r);
  }
  return [...map.values()];
}

function reconcile(excelRows, dbProducts, { fuzzyThreshold = 0.86 } = {}) {
  const byNorm = new Map();
  for (const p of dbProducts) {
    const k = normName(p.name);
    if (!byNorm.has(k)) byNorm.set(k, []);
    byNorm.get(k).push(p);
  }

  const items = aggregateExcel(excelRows).map((a) => {
    let match = null, level = null, confidence = 1, suggestions = [];

    const exact = dbProducts.filter((p) => String(p.name).trim() === a.desc.trim());
    if (exact.length === 1) { match = exact[0]; level = "EXACT"; }
    else {
      const nm = byNorm.get(a.norm) || [];
      if (nm.length === 1) { match = nm[0]; level = "NORMALISE"; }
      else if (nm.length > 1) { level = "AMBIGU_DB"; suggestions = nm.map((p) => p.name); }
      else {
        const cands = dbProducts
          .map((p) => ({ p, s: similarity(a.norm, normName(p.name)) }))
          .filter((x) => x.s >= fuzzyThreshold)
          .sort((x, y) => y.s - x.s)
          .slice(0, 3);
        if (cands.length) {
          level = "FUZZY_SUGGESTION"; confidence = cands[0].s;
          suggestions = cands.map((c) => `${c.p.name} (${(c.s * 100).toFixed(0)}%)`);
        } else level = "NOUVEAU";
      }
    }

    const dbStock = match ? Number(match.stock || 0) : null;
    const expected = a.qty + a.in - a.out;   // stock physique attendu après mouvements
    const delta = match ? expected - dbStock : null;

    let action;
    if (level === "NOUVEAU") action = ACTIONS.NEW_PRODUCT;
    else if (level === "FUZZY_SUGGESTION" || level === "AMBIGU_DB") action = ACTIONS.AMBIGUOUS_PRODUCT;
    else if (a.emptyQty > 0) action = ACTIONS.TO_REVIEW;   // ne jamais inventer une quantité
    else if (delta === 0 && a.in === 0 && a.out === 0) action = ACTIONS.MATCH;
    else if (delta === 0) action = ACTIONS.MOVEMENT_ONLY;
    else action = ACTIONS.QUANTITY_CONFLICT;

    return { ...a, match, level, confidence, suggestions, dbStock, expected, delta, action };
  });

  const matched = items.filter((i) => i.match);
  const seen = new Set(matched.map((i) => String(i.match.product_id)));
  const totals = {
    dbProducts: dbProducts.length,
    dbStock: dbProducts.reduce((s, p) => s + Number(p.stock || 0), 0),
    excelProducts: items.length,
    excelQty: items.reduce((s, i) => s + i.qty, 0),
    excelIn: items.reduce((s, i) => s + i.in, 0),
    excelOut: items.reduce((s, i) => s + i.out, 0),
    /* Produits présents en base mais ABSENTS du fichier : leur stock ne doit
       surtout pas être remis à zéro — le fichier ne les couvre simplement pas. */
    dbOnly: dbProducts.filter((p) => !seen.has(String(p.product_id))),
  };
  totals.excelExpected = totals.excelQty + totals.excelIn - totals.excelOut;
  totals.byAction = Object.fromEntries(
    Object.values(ACTIONS).map((k) => [k, items.filter((i) => i.action === k).length])
  );
  return { items, totals };
}

module.exports = { reconcile, aggregateExcel, ACTIONS };

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

/* ALIAS VALIDÉS MANUELLEMENT — fautes de frappe confirmées par le responsable.
   Chaque entrée est une DÉCISION HUMAINE tracée, jamais une déduction du
   moteur : la proximité orthographique ne suffit jamais à fusionner seule.
   « ONE ONE 168X85X43 » n'y figure PAS volontairement : 168 et 186 peuvent
   désigner deux dimensions réellement différentes, cela reste à vérifier. */
const VALIDATED_ALIASES = new Map([
  ["VIENJIC URINOIR", "VIENJIC URINOIRE"],
  ["OFFICIENCY AMPLIFIER", "EFFICIENCY AMPLIFIER"],
  ["PROFESSIONNAL SOUND SYSTEME", "PROFESSIONAL SOUND SYSTHEME"],
  ["TOURNIQUE D'ENTREE", "TOURNIQUET D'ENTREE"],
  ["TOURNIAUET D'ENTREE", "TOURNIQUET D'ENTREE"],
]);

const ACTIONS = {
  MATCH: "MATCH",                         // stock identique, aucun mouvement
  MOVEMENT_ONLY: "MOVEMENT_ONLY",         // IN/OUT à passer, solde final cohérent
  QUANTITY_CONFLICT: "QUANTITY_CONFLICT", // écart -> ajustement d'inventaire à valider
  NEW_PRODUCT: "NEW_PRODUCT",
  AMBIGUOUS_PRODUCT: "AMBIGUOUS_PRODUCT", // décision humaine obligatoire
  TO_REVIEW: "TO_REVIEW",                 // quantité absente : stock DB conservé
  DB_ONLY: "DB_ONLY",                     // en base, absent du fichier : intouché
};

/* Motifs de mise en attente, repris tels quels dans le preview. */
const REVIEW_REASONS = {
  MISSING_EXCEL_QUANTITY: "MISSING_EXCEL_QUANTITY",
  AMBIGUOUS_DIMENSIONS: "AMBIGUOUS_DIMENSIONS",
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

  let items = aggregateExcel(excelRows).map((a) => {
    let match = null, level = null, confidence = 1, suggestions = [];

    const exact = dbProducts.filter((p) => String(p.name).trim() === a.desc.trim());
    const aliasTarget = VALIDATED_ALIASES.get(a.norm);
    if (exact.length === 1) { match = exact[0]; level = "EXACT"; }
    else if (aliasTarget) {
      // Faute de frappe validée : on réutilise la fiche existante, sans en créer.
      const t = byNorm.get(normName(aliasTarget)) || [];
      if (t.length === 1) { match = t[0]; level = "ALIAS_VALIDE"; }
      else { level = "ALIAS_CIBLE_INTROUVABLE"; suggestions = [aliasTarget]; }
    }
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
    let expected = a.qty + a.in - a.out;   // stock physique attendu après mouvements
    let action, reviewReason = null;

    if (level === "NOUVEAU") action = ACTIONS.NEW_PRODUCT;
    else if (level === "FUZZY_SUGGESTION" || level === "AMBIGU_DB" || level === "ALIAS_CIBLE_INTROUVABLE") {
      action = ACTIONS.AMBIGUOUS_PRODUCT;
      if (/^ONE ONE /.test(a.norm)) reviewReason = REVIEW_REASONS.AMBIGUOUS_DIMENSIONS;
    }
    else if (a.emptyQty > 0) {
      /* Une cellule vide ne vaut PAS zéro : on conserve le stock de la base et
         on demande une vérification humaine. Aucun mouvement n'est proposé. */
      action = ACTIONS.TO_REVIEW;
      reviewReason = REVIEW_REASONS.MISSING_EXCEL_QUANTITY;
      expected = dbStock !== null ? dbStock : expected;
    }
    else if (expected - dbStock === 0 && a.in === 0 && a.out === 0) action = ACTIONS.MATCH;
    else if (expected - dbStock === 0) action = ACTIONS.MOVEMENT_ONLY;
    else action = ACTIONS.QUANTITY_CONFLICT;

    const delta = match ? expected - dbStock : null;
    return { ...a, match, level, confidence, suggestions, dbStock, expected, delta, action, reviewReason };
  });

  /* FUSION POST-ALIAS : plusieurs libellés Excel peuvent désigner la MÊME fiche
     (« TOURNIQUE », « TOURNIAUET » -> « TOURNIQUET D'ENTREE »). Sans ce
     regroupement, chacun produirait ses propres mouvements sur le même produit
     et le stock serait compté plusieurs fois. */
  const merged = [];
  const byProduct = new Map();
  for (const it of items) {
    const key = it.match ? `P${it.match.product_id}` : null;
    if (!key) { merged.push(it); continue; }
    if (!byProduct.has(key)) {
      byProduct.set(key, { ...it, mergedFrom: [it.desc] });
      merged.push(byProduct.get(key));
      continue;
    }
    const t = byProduct.get(key);
    t.qty += it.qty; t.in += it.in; t.out += it.out;
    t.emptyQty += it.emptyQty;
    t.lines = t.lines.concat(it.lines);
    t.mergedFrom.push(it.desc);
    if (it.level === "ALIAS_VALIDE" || t.level === "ALIAS_VALIDE") t.level = "ALIAS_VALIDE";
  }
  /* Reclassement après fusion : les totaux ont changé. */
  for (const t of merged) {
    if (!t.match) continue;
    if (t.emptyQty > 0) {
      /* Une cellule QUANTITIES vide rend le COMPTAGE PHYSIQUE inexploitable :
         on ne propose donc aucun ajustement d'inventaire. Mais les IN/OUT sont
         des mouvements explicites et restent appliqués — les suspendre ferait
         perdre des entrées réelles. Le stock de référence reste celui de la
         base, auquel on applique les mouvements. */
      t.action = ACTIONS.TO_REVIEW;
      t.reviewReason = REVIEW_REASONS.MISSING_EXCEL_QUANTITY;
      t.expected = t.dbStock + t.in - t.out;
      t.adjustmentAllowed = false;
    } else {
      t.expected = t.qty + t.in - t.out;
      if (t.expected - t.dbStock === 0 && t.in === 0 && t.out === 0) t.action = ACTIONS.MATCH;
      else if (t.expected - t.dbStock === 0) t.action = ACTIONS.MOVEMENT_ONLY;
      else t.action = ACTIONS.QUANTITY_CONFLICT;
      t.adjustmentAllowed = true;
    }
    t.delta = t.expected - t.dbStock;
  }
  items = merged;

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
    /* Produits en base mais absents du fichier : le fichier ne les couvre pas,
       leur stock est CONSERVÉ tel quel. Aucune modification automatique. */
    dbOnly: dbProducts.filter((p) => !seen.has(String(p.product_id))).map((p) => ({
      action: ACTIONS.DB_ONLY, desc: p.name, match: p, dbStock: Number(p.stock || 0),
      expected: Number(p.stock || 0), delta: 0, qty: 0, in: 0, out: 0,
      reviewReason: "NOT_PRESENT_IN_EXCEL", lines: [],
    })),
  };
  totals.excelExpected = totals.excelQty + totals.excelIn - totals.excelOut;
  totals.byAction = Object.fromEntries(
    Object.values(ACTIONS).filter((k) => k !== ACTIONS.DB_ONLY)
      .map((k) => [k, items.filter((i) => i.action === k).length])
  );
  return { items, totals };
}

module.exports = { reconcile, aggregateExcel, ACTIONS, REVIEW_REASONS, VALIDATED_ALIASES };

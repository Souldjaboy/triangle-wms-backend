"use strict";

/**
 * PLANIFICATEUR D'EXÉCUTION (phase PREVIEW, §46).
 *
 * Transforme la réconciliation en liste d'opérations à exécuter, SANS rien
 * écrire. Permet de savoir AVANT de confirmer quels documents seront créés.
 *
 * Règles :
 *  - un IN  -> vraie ENTRÉE de stock, regroupée en BON D'ENTRÉE ;
 *  - un OUT -> vraie SORTIE de stock, regroupée en BON DE SORTIE
 *    (y compris les gros OUT de faux plafond : ce sont des sorties réelles,
 *     décision du responsable, pas des ajustements) ;
 *  - un AJUSTEMENT D'INVENTAIRE n'est proposé QUE s'il subsiste un écart après
 *    application des IN/OUT — et jamais quand le comptage physique est douteux
 *    (cellule QUANTITIES vide) ;
 *  - une réception container est une étape de TRAÇABILITÉ : elle ne rajoute
 *    jamais de stock par-dessus le IN correspondant.
 */

const { ACTIONS } = require("./reconcile");

function planOperations(recon, { warehouse = "W-EM2S-A" } = {}) {
  const entries = [], exits = [], adjustments = [], newProducts = [], blocked = [];

  for (const it of recon.items) {
    if (it.action === ACTIONS.AMBIGUOUS_PRODUCT) {
      blocked.push({ desc: it.desc, reason: it.reviewReason || "AMBIGUOUS", suggestions: it.suggestions });
      continue;                                  // jamais de fusion automatique
    }
    if (it.action === ACTIONS.NEW_PRODUCT) {
      newProducts.push({ desc: it.desc, unit: it.unit, initialStock: it.expected, lines: it.lines.length });
    }
    const productRef = it.match ? { id: it.match.product_id, name: it.match.name } : { id: null, name: it.desc };

    if (it.in > 0) entries.push({ product: productRef, quantity: it.in, unit: it.unit, lines: it.lines.length });
    if (it.out > 0) exits.push({ product: productRef, quantity: it.out, unit: it.unit, lines: it.lines.length });

    /* Écart RÉSIDUEL, après application des mouvements connus. */
    if (it.match && it.adjustmentAllowed && it.delta !== 0) {
      adjustments.push({
        product: productRef, stockBefore: it.dbStock, counted: it.qty,
        in: it.in, out: it.out, expected: it.expected, delta: it.delta,
        reason: "Régularisation inventaire Excel",
      });
    }
  }

  const sum = (a) => a.reduce((s, x) => s + x.quantity, 0);
  const stockBefore = recon.totals.dbStock;
  const totalIn = sum(entries), totalOut = sum(exits);
  const totalAdj = adjustments.reduce((s, a) => s + a.delta, 0);

  return {
    documents: {
      /* Un bon par entrepôt et par nature : le regroupement fin par container
         sera affiné quand les réceptions seront rapprochées. */
      goodsReceiptNotes: entries.length ? 1 : 0,
      goodsIssueNotes: exits.length ? 1 : 0,
      inventories: 1,
      inventoryAdjustments: adjustments.length,
      newProducts: newProducts.length,
    },
    entries, exits, adjustments, newProducts, blocked,
    totals: {
      warehouse, stockBefore, totalIn, totalOut, totalAdjustments: totalAdj,
      /* Équation vérifiable exigée au §47. */
      stockAfter: stockBefore + totalIn - totalOut + totalAdj,
      untouchedDbOnly: recon.totals.dbOnly.length,
      untouchedDbOnlyStock: recon.totals.dbOnly.reduce((s, i) => s + i.dbStock, 0),
    },
  };
}

module.exports = { planOperations };

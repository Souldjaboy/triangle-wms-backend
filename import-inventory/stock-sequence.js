"use strict";

/**
 * SÉQUENCE DE STOCK — SOURCE UNIQUE DE VÉRITÉ.
 *
 * Le preview et l'exécution doivent appliquer EXACTEMENT le même enchaînement.
 * Tant que deux calculs coexistaient, une opération pouvait être déclarée
 * valide à l'analyse puis échouer à l'exécution : c'est précisément ce qui
 * s'est produit, le preview ignorant les produits nouveaux.
 *
 * Ordre reproduit, identique à celui de execute.js :
 *   1. création du produit (stock initial 0 pour un NEW_PRODUCT)
 *   2. ajustement préalable — alignement sur la quantité physique constatée
 *   3. entrées
 *   4. sorties
 *   5. write-off
 */

/**
 * @returns {{steps: {step,stock}[], finalStock: number, failure: object|null}}
 */
function computeStockSequence({
  isNew = false,
  dbStock = 0,
  countedQuantity = null,   // quantité physique du fichier, null si non fiable
  adjustmentAllowed = true,
  inQty = 0,
  outQty = 0,
  writeOffQty = 0,
}) {
  const steps = [];
  /* Un produit créé par l'import démarre à 0 : son stock ne vient QUE des
     mouvements qui suivent, jamais de la colonne QUANTITIES. */
  let stock = isNew ? 0 : Number(dbStock || 0);
  steps.push({ step: "INITIAL", stock });

  if (!isNew && adjustmentAllowed && countedQuantity !== null && countedQuantity !== stock) {
    stock = Number(countedQuantity);
    steps.push({ step: "AJUSTEMENT_PREALABLE", stock });
  }
  if (inQty > 0) { stock += Number(inQty); steps.push({ step: "ENTREE", stock }); }
  if (outQty > 0) { stock -= Number(outQty); steps.push({ step: "SORTIE", stock }); }
  if (writeOffQty > 0) { stock -= Number(writeOffQty); steps.push({ step: "WRITE_OFF", stock }); }

  const failure = steps.find((s) => s.stock < 0) || null;
  return { steps, finalStock: stock, failure };
}

module.exports = { computeStockSequence };

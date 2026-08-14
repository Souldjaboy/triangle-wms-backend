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

/* Nouveaux rebuts constatés dans la feuille WRITE OFF. Les 161 unités
   historiques déjà enregistrées ne sont JAMAIS recréées : seuls les articles
   absents de l'historique sont proposés. */
function planWriteOffs(newWriteOffs, dbProducts, existingWriteOffNames = new Set()) {
  const { normName } = require("./excel-inventory-parser");
  const out = [];
  for (const w of newWriteOffs || []) {
    const key = normName(w.desc);
    if (existingWriteOffNames.has(key)) continue;          // déjà enregistré
    const p = dbProducts.find((x) => normName(x.name) === key);
    out.push({
      product: p ? { id: p.product_id, name: p.name } : { id: null, name: w.desc },
      quantity: w.quantity, reason: "Write-off inventaire Excel",
      known: Boolean(p),
    });
  }
  return out;
}

function planOperations(recon, { warehouse = "W-EM2S-A", writeOffs = [] } = {}) {
  const entries = [], exits = [], adjustments = [], newProducts = [], blocked = [];
  /* AJUSTEMENTS PRÉALABLES : quand la sortie du fichier dépasse ce que la base
     connaît, la sortie est impossible telle quelle. Le comptage physique fait
     foi : on régularise D'ABORD le stock sur la quantité constatée, PUIS on
     passe la vraie sortie complète. Sans cela la sortie serait refusée (409)
     ou, pire, raboterait le stock en silence. Ces ajustements sont marqués
     distinctement : ce ne sont pas des entrées commerciales. */
  const preAdjustments = [];

  for (const it of recon.items) {
    if (it.action === ACTIONS.AMBIGUOUS_PRODUCT) {
      blocked.push({ desc: it.desc, reason: it.reviewReason || "AMBIGUOUS", suggestions: it.suggestions });
      continue;                                  // jamais de fusion automatique
    }
    if (it.action === ACTIONS.NEW_PRODUCT) {
      newProducts.push({ desc: it.desc, unit: it.unit, initialStock: it.expected, lines: it.lines.length });
    }
    const productRef = it.match ? { id: it.match.product_id, name: it.match.name } : { id: null, name: it.desc };

    /* MODÈLE : on aligne d'abord le stock sur la QUANTITÉ PHYSIQUEMENT
       CONSTATÉE, puis on applique les mouvements connus. C'est l'ordre décidé
       (« ajustement d'abord, puis sortie ») et le seul mathématiquement juste :
       le comptage du magasin est un état, les IN/OUT sont des variations qui
       s'appliquent APRÈS cet état.
       Calculer l'ajustement comme (attendu - stock base) double-comptait les
       mouvements, puisque « attendu » les contient déjà. */
    if (it.match && it.adjustmentAllowed) {
      const delta = it.qty - it.dbStock;          // écart de comptage pur
      if (delta !== 0) {
        preAdjustments.push({
          product: productRef, stockBefore: it.dbStock, counted: it.qty, delta,
          out: it.out, in: it.in,
          reason: "Régularisation inventaire avant application des mouvements Excel",
          kind: "AJUSTEMENT_PREALABLE",
        });
      }
    }
    if (it.in > 0) entries.push({ product: productRef, quantity: it.in, unit: it.unit, lines: it.lines.length });
    if (it.out > 0) exits.push({ product: productRef, quantity: it.out, unit: it.unit, lines: it.lines.length });

    /* Écart RÉSIDUEL, après application des mouvements connus. */
    /* Ajustement FINAL : écart RÉSIDUEL après comptage + mouvements. Avec le
       modèle ci-dessus il est nul par construction ; on le calcule quand même
       pour le prouver et détecter toute incohérence. */
    if (it.match && it.adjustmentAllowed) {
      const pre = it.qty - it.dbStock;
      const residual = it.expected - (it.dbStock + pre + it.in - it.out);
      if (residual !== 0) {
        adjustments.push({
          product: productRef, stockBefore: it.dbStock, counted: it.qty,
          in: it.in, out: it.out, expected: it.expected, delta: residual,
          reason: "Écart résiduel après mouvements",
        });
      }
    }
  }

  /* SIMULATION PAR PRODUIT — on rejoue la séquence exacte qu'exécutera
     l'orchestrateur et on vérifie qu'aucune étape ne passe sous zéro. Sans
     cela, l'erreur n'apparaîtrait qu'au moment de l'exécution : le backend
     refuserait proprement (409) et annulerait tout, mais l'utilisateur ne
     l'apprendrait qu'APRÈS avoir confirmé. */
  const blockingErrors = [];
  for (const it of recon.items) {
    if (!it.match || it.action === ACTIONS.AMBIGUOUS_PRODUCT) continue;
    const pre = preAdjustments.find((p) => p.product.id === it.match.product_id);
    const steps = [];
    let stock = it.dbStock;
    if (pre) { stock = pre.counted; steps.push({ step: "AJUSTEMENT_PREALABLE", stock }); }
    if (it.in > 0) { stock += it.in; steps.push({ step: "ENTREE", stock }); }
    if (it.out > 0) { stock -= it.out; steps.push({ step: "SORTIE", stock }); }
    const wo = writeOffs.find((w) => w.product.id === it.match.product_id);
    if (wo) { stock -= wo.quantity; steps.push({ step: "WRITE_OFF", stock }); }
    const bad = steps.find((x) => x.stock < 0);
    if (bad) {
      blockingErrors.push({
        product: { id: it.match.product_id, name: it.match.name },
        dbStock: it.dbStock, counted: it.qty, in: it.in, out: it.out,
        writeOff: wo ? wo.quantity : 0,
        failingStep: bad.step, stockAtFailure: bad.stock, steps,
        message: "Cette opération produirait un stock négatif.",
      });
    }
  }

  const sum = (a) => a.reduce((s, x) => s + x.quantity, 0);
  const stockBefore = recon.totals.dbStock;
  const totalIn = sum(entries), totalOut = sum(exits);
  const totalPre = preAdjustments.reduce((s, a) => s + a.delta, 0);
  const totalAdj = adjustments.reduce((s, a) => s + a.delta, 0);

  return {
    documents: {
      /* Un bon par entrepôt et par nature : le regroupement fin par container
         sera affiné quand les réceptions seront rapprochées. */
      goodsReceiptNotes: entries.length ? 1 : 0,
      goodsIssueNotes: exits.length ? 1 : 0,
      inventories: 1,
      priorAdjustments: preAdjustments.length,
      writeOffs: writeOffs.length,
      inventoryAdjustments: adjustments.length,
      newProducts: newProducts.length,
    },
    preAdjustments, entries, exits, adjustments, newProducts, blocked, writeOffs,
    blockingErrors,
    totals: {
      warehouse, stockBefore,
      totalPriorAdjustments: totalPre, totalIn, totalOut, totalAdjustments: totalAdj,
      totalWriteOff: writeOffs.reduce((s, w) => s + w.quantity, 0),
      /* Équation vérifiable : les ajustements préalables s'appliquent AVANT
         les mouvements, les ajustements finaux après. */
      stockAfter: stockBefore + totalPre + totalIn - totalOut
        - writeOffs.reduce((s, w) => s + w.quantity, 0) + totalAdj,
      blockingErrors: blockingErrors.length,
      /* Tant qu'il reste une erreur bloquante, l'import ne doit pas être
         proposé à la confirmation. */
      canExecute: blockingErrors.length === 0,
      untouchedDbOnly: recon.totals.dbOnly.length,
      untouchedDbOnlyStock: recon.totals.dbOnly.reduce((s, i) => s + i.dbStock, 0),
    },
  };
}

module.exports = { planOperations, planWriteOffs };

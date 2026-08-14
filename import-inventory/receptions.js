"use strict";

/**
 * RAPPROCHEMENT DES RÉCEPTIONS CONTAINERS ET DÉTECTION DES TRANSFERTS.
 *
 * Une réception et une entrée de stock sont DEUX ÉTAPES DU MÊME FLUX :
 *   container reçu -> réception -> bon d'entrée -> mouvement IN -> stock
 * Le stock ne doit donc augmenter qu'UNE seule fois. Quand un IN correspondant
 * existe déjà dans le plan, la réception ne sert qu'à la traçabilité : elle ne
 * crée aucun second mouvement.
 */

const { normName } = require("./excel-inventory-parser");

const RECEPTION_STATUS = {
  MATCHED: "MATCHED_RECEPTION",       // un IN du plan couvre cette réception
  UNMATCHED: "UNMATCHED_RECEPTION",   // reçue mais aucun IN correspondant
  DUPLICATE: "POSSIBLE_DUPLICATE",    // plusieurs lignes identiques, à confirmer
};

function reconcileReceptions(receptions, planEntries) {
  /* Entrées du plan, indexées par produit normalisé. */
  const inByProduct = new Map();
  for (const e of planEntries) {
    const k = normName(e.product.name);
    inByProduct.set(k, (inByProduct.get(k) || 0) + e.quantity);
  }

  const seen = new Map();               // détection des lignes en double
  const items = receptions.map((r) => {
    const key = `${r.norm}|${r.quantity}|${r.container || ""}|${r.date || ""}`;
    const dup = seen.has(key);
    seen.set(key, (seen.get(key) || 0) + 1);

    const planned = inByProduct.get(r.norm) || 0;
    let status;
    if (dup) status = RECEPTION_STATUS.DUPLICATE;
    else if (planned > 0) status = RECEPTION_STATUS.MATCHED;
    else status = RECEPTION_STATUS.UNMATCHED;

    return {
      ...r, status,
      plannedIn: planned,
      /* Aucune réception n'ajoute de stock : les MATCHED sont couvertes par le
         IN du plan, les UNMATCHED et DUPLICATE demandent une décision humaine
         plutôt qu'une entrée créée d'office. */
      createsStock: false,
    };
  });

  const count = (s) => items.filter((i) => i.status === s).length;
  return {
    items,
    totals: {
      total: items.length,
      matched: count(RECEPTION_STATUS.MATCHED),
      unmatched: count(RECEPTION_STATUS.UNMATCHED),
      duplicates: count(RECEPTION_STATUS.DUPLICATE),
      quantityReceived: items.reduce((s, i) => s + i.quantity, 0),
      /* Preuve de non-double-comptage : aucune réception n'augmente le stock. */
      quantityAddedToStock: 0,
    },
  };
}

/* Emplacement Excel d'une ligne, au format du modèle de localisation existant. */
function excelLocation(line, warehouse = "W-EM2S-A") {
  const bins = ["A", "B", "C"].filter((_, i) => line.bins && line.bins[i]);
  return {
    warehouse,
    row: line.row || null,
    location: line.loc || null,
    level: line.level || null,
    bins,
    /* Plusieurs bins cochés décrivent l'occupation physique. Le fichier ne
       donne AUCUNE répartition par bin : on ne l'invente pas. */
    binDistribution: bins.length > 1 ? "UNKNOWN" : "SINGLE",
    code: [warehouse, line.row, line.loc, line.level ? `L${line.level}` : null,
           bins.length ? `BIN${bins.join("")}` : null].filter(Boolean).join("-"),
  };
}

/**
 * Détecte les produits dont SEUL l'emplacement change. Le stock global reste
 * strictement identique : on génère un transfert interne, jamais une
 * entrée/sortie externe.
 */
/**
 * Détecte les produits dont SEUL l'emplacement change.
 *
 * On compare les COMPOSANTES (rayon, case/location, niveau), pas la chaîne
 * assemblée : la base écrit « W/EM2S-A-M-M3-L2-BIN1 » et le fichier décrit
 * ROW=M, LOCATION=M3, LEVEL=2. Comparer les codes complets produirait des
 * centaines de faux transferts dus à la seule différence de convention.
 *
 * Le stock global reste strictement identique : on génère un transfert
 * interne, jamais une entrée/sortie externe.
 */
function detectTransfers(reconItems, { warehouse = "W-EM2S-A" } = {}) {
  const norm = (v) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const transfers = [];
  for (const it of reconItems) {
    if (!it.match || !it.lines || it.lines.length === 0) continue;
    const line = it.lines[0];
    const target = excelLocation(line, warehouse);

    /* Composantes côté base. Si elles ne sont pas renseignées, on ne peut RIEN
       conclure : on s'abstient plutôt que d'inventer un déplacement. */
    const dbRow = it.match.rayon_code ?? it.match.rayon;
    const dbCase = it.match.case_code ?? it.match.etagere;
    const dbLevel = it.match.level_code;
    if (dbRow == null && dbCase == null && dbLevel == null) continue;

    const same =
      norm(dbRow) === norm(line.row) &&
      norm(dbCase) === norm(line.loc) &&
      norm(dbLevel) === norm(line.level);
    if (same) continue;

    transfers.push({
      product: { id: it.match.product_id, name: it.match.name },
      quantity: it.dbStock,                      // le stock global ne change pas
      sourceWarehouse: it.match.warehouse || warehouse,
      sourceLocation: it.match.location_code || null,
      sourceParts: { row: dbRow, location: dbCase, level: dbLevel },
      destinationWarehouse: target.warehouse,
      destinationLocation: target.code,
      destinationParts: { row: line.row, location: line.loc, level: line.level },
      bins: target.bins,
      binDistribution: target.binDistribution,
      stockImpact: 0,
    });
  }
  return transfers;
}

module.exports = { reconcileReceptions, detectTransfers, excelLocation, RECEPTION_STATUS };

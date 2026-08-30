"use strict";

/**
 * MOUVEMENTS RÉPARTIS SUR PLUSIEURS EMPLACEMENTS.
 *
 * Le moteur d'emplacements sait entrer, sortir et transférer — mais à un seul
 * bac à la fois. Or un produit vit rarement dans un seul : sortir trente
 * unités d'un stock de quatre-vingts réparti sur trois rayons demande de
 * puiser dans plusieurs bacs, et le magasinier doit dire lesquels. Sans cela,
 * l'écran n'affiche qu'un total dont personne ne sait où il se trouve.
 *
 * Chaque ligne est appliquée par le moteur existant : aucune balance n'est
 * écrite directement, chaque bac produit son mouvement traçable. Les lignes
 * partagent une seule transaction — une sortie de trente unités prise dans
 * deux bacs est un geste, pas deux. Si la seconde échoue, la première est
 * annulée.
 */

const L = require("./stock-locations");

const nombre = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));

class ErreurRepartition extends Error {
  constructor(message, code = "ALLOCATION_INVALID", httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Contrôle la forme de la répartition avant d'écrire quoi que ce soit.
 * Un total qui ne tombe pas juste doit être refusé ici, pas découvert à
 * mi-parcours après avoir déjà vidé un bac.
 */
function verifierRepartition(lignes, quantiteTotale) {
  if (!Array.isArray(lignes) || lignes.length === 0) {
    throw new ErreurRepartition("Aucun emplacement sélectionné.", "NO_ALLOCATION");
  }

  const vues = new Set();
  let somme = 0;

  for (const ligne of lignes) {
    const locationId = nombre(ligne.locationId ?? ligne.location_id);
    const quantite = nombre(ligne.quantity ?? ligne.quantite);

    if (!Number.isFinite(locationId) || locationId <= 0) {
      throw new ErreurRepartition("Emplacement manquant sur une des lignes.", "MISSING_LOCATION");
    }
    if (!Number.isFinite(quantite) || quantite <= 0) {
      throw new ErreurRepartition(
        `Quantité invalide pour l'emplacement ${locationId} : une répartition se fait en quantités strictement positives.`,
        "INVALID_QUANTITY"
      );
    }
    /* Deux lignes sur le même bac cacheraient un double comptage : la somme
       semblerait juste alors qu'un seul bac supporterait tout. */
    if (vues.has(locationId)) {
      throw new ErreurRepartition(
        `L'emplacement ${locationId} apparaît deux fois : regroupez la quantité sur une seule ligne.`,
        "DUPLICATE_LOCATION"
      );
    }
    vues.add(locationId);
    somme += quantite;
  }

  const total = nombre(quantiteTotale);
  if (Number.isFinite(total) && somme !== total) {
    throw new ErreurRepartition(
      `La répartition totalise ${somme} alors que l'opération porte sur ${total}. ` +
      `Ajustez les quantités : l'écart doit être nul.`,
      "ALLOCATION_MISMATCH"
    );
  }

  return { somme, lignes: [...vues].length };
}

/**
 * Sortie répartie. Chaque ligne passe par exitFromLocation, qui verrouille le
 * bac, vérifie le disponible en tenant compte du réservé, refuse le négatif et
 * crée le mouvement.
 */
async function sortieRepartie(client, { companyId, productId, quantity, allocations, user, reason }) {
  const { somme } = verifierRepartition(allocations, quantity);

  const detail = [];
  for (const ligne of allocations) {
    const locationId = Number(ligne.locationId ?? ligne.location_id);
    const quantite = Number(ligne.quantity ?? ligne.quantite);
    const r = await L.exitFromLocation(client, {
      companyId, productId, locationId, quantity: quantite, user,
      reason: reason || "Sortie répartie",
    });
    detail.push({ location_id: locationId, quantity: quantite, ...r });
  }

  return { sens: "Sortie", quantite: somme, emplacements: detail.length, detail };
}

/** Entrée répartie, symétrique de la sortie. */
async function entreeRepartie(client, { companyId, productId, quantity, allocations, user, reason }) {
  const { somme } = verifierRepartition(allocations, quantity);

  const detail = [];
  for (const ligne of allocations) {
    const locationId = Number(ligne.locationId ?? ligne.location_id);
    const quantite = Number(ligne.quantity ?? ligne.quantite);
    const r = await L.entryAtLocation(client, {
      companyId, productId, locationId, quantity: quantite, user,
      reason: reason || "Entrée répartie",
    });
    detail.push({ location_id: locationId, quantity: quantite, ...r });
  }

  return { sens: "Entrée", quantite: somme, emplacements: detail.length, detail };
}

/**
 * Ce que le magasinier doit voir avant de choisir : le total, et où il est.
 * Un écran qui n'annonce qu'un total oblige à deviner dans quel bac puiser.
 */
async function repartitionDisponible(client, { companyId, productId }) {
  const { rows } = await client.query(
    `SELECT b.location_id, b.quantity, b.reserved_quantity,
            (b.quantity - b.reserved_quantity) AS disponible,
            l.full_code, l.emplacement_code, l.warehouse_code,
            l.rayon_code, l.case_code, l.level_code, l.bin_code,
            l.occupancy_status, l.is_active
       FROM stock_location_balances b
       JOIN locations l ON l.id = b.location_id
      WHERE b.company_id = $1 AND b.product_id = $2
      ORDER BY l.rayon_code, l.case_code, l.level_code, l.bin_code`,
    [companyId, productId]
  );

  const total = rows.reduce((t, r) => t + Number(r.quantity || 0), 0);
  const reserve = rows.reduce((t, r) => t + Number(r.reserved_quantity || 0), 0);
  return {
    total,
    reserve,
    disponible: total - reserve,
    emplacements: rows.map((r) => ({
      location_id: r.location_id,
      code: r.full_code || r.emplacement_code,
      entrepot: r.warehouse_code, rayon: r.rayon_code, case: r.case_code,
      niveau: r.level_code, bin: r.bin_code,
      quantite: Number(r.quantity || 0),
      reservee: Number(r.reserved_quantity || 0),
      disponible: Number(r.disponible || 0),
      statut: r.occupancy_status,
      actif: r.is_active !== false,
    })),
  };
}

module.exports = {
  ErreurRepartition, verifierRepartition,
  sortieRepartie, entreeRepartie, repartitionDisponible,
};

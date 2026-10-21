"use strict";

/**
 * CORRIGER UNE DEMANDE DE STOCK DÉJÀ VALIDÉE OU REÇUE.
 *
 * Une demande suit BROUILLON → EN_ATTENTE → VALIDEE → RECUE, et seule la
 * RÉCEPTION déplace du stock. D'où trois gestes, de plus en plus lourds :
 *
 *   MODIFICATION    tant que la demande n'est pas validée, elle n'a rien
 *                   produit : on la corrige, avec motif et historique.
 *   DÉVALIDATION    une demande validée dont AUCUN stock n'a bougé retourne
 *                   EN_ATTENTE. Rien à défaire — il n'y a rien eu.
 *   CONTRE-PASSATION une réception a déplacé du stock. Chaque mouvement
 *                   reçoit son inverse, les quantités reçues reviennent à
 *                   zéro, la demande redevient VALIDEE. Les mouvements
 *                   d'origine RESTENT, marqués annulés.
 *
 * POURQUOI NE PAS SIMPLEMENT REMETTRE LE STOCK COMME AVANT
 *
 * Parce que le stock d'aujourd'hui est la somme des mouvements. Un UPDATE
 * direct sur `products.stock` ferait coïncider le chiffre une fois, puis le
 * premier inventaire trouverait un écart que plus personne ne peut expliquer.
 * Tout passe donc par `adjustGlobalStock`, le même chemin que la réception,
 * avec le signe opposé — y compris le refus d'un mouvement sans emplacement
 * sur un produit géré par bac.
 */

const STATUS = Object.freeze({
  DRAFT: "BROUILLON", PENDING: "EN_ATTENTE", VALIDATED: "VALIDEE", REJECTED: "REFUSEE",
  PARTIAL: "PARTIELLEMENT_RECUE", RECEIVED: "RECUE", CANCELLED: "ANNULEE",
});

/* Les états où la demande n'a RIEN produit : aucune contre-passation requise. */
const SANS_EFFET = [STATUS.DRAFT, STATUS.PENDING, STATUS.VALIDATED, STATUS.REJECTED];
/* Les états où du stock a bougé. */
const AVEC_STOCK = [STATUS.PARTIAL, STATUS.RECEIVED];

/* Les champs d'en-tête qu'une modification peut toucher. Le type de demande
   n'en fait pas partie : changer une entrée en sortie n'est pas une
   correction, c'est une autre demande. */
const CHAMPS = Object.freeze({
  supplier_name:    "Fournisseur",
  source_warehouse: "Entrepôt source",
  target_warehouse: "Entrepôt destination",
  source_location:  "Emplacement source",
  target_location:  "Emplacement destination",
  motif:            "Motif de la demande",
  observations:     "Observations",
});

function erreur(message, code, httpStatus, extra = {}) {
  const e = new Error(message);
  e.code = code; e.httpStatus = httpStatus;
  Object.assign(e, extra);
  return e;
}

const nomDe = (u) => u?.name || u?.fullname || u?.email || "Utilisateur";
const nombre = (v) => Math.round(Number(v || 0) * 1000) / 1000;

async function charger(client, companyId, id, { verrou = false } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM stock_requests WHERE id = $1 AND company_id = $2${verrou ? " FOR UPDATE" : ""}`,
    [id, companyId]);
  if (!rows[0]) throw erreur("Demande introuvable dans cette société.", "REQUEST_NOT_FOUND", 404);
  return rows[0];
}

async function journaliser(client, demande, {
  action, reason, statutAvant, statutApres, details = {},
  lignes = 0, quantite = 0, utilisateur = null,
}) {
  await client.query(
    `INSERT INTO stock_request_corrections
       (company_id, request_id, action, reason, status_before, status_after,
        details, lines_affected, quantity_reversed, acted_by, acted_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)`,
    [demande.company_id, demande.id, action, reason, statutAvant, statutApres,
     JSON.stringify(details), lignes, quantite,
     utilisateur?.id || null, nomDe(utilisateur)]);

  await client.query(
    `UPDATE stock_requests
        SET last_correction_at = now(), last_correction_by = $1,
            corrections_count = corrections_count + 1, updated_at = now()
      WHERE id = $2`, [utilisateur?.id || null, demande.id]);
}

/**
 * MODIFIER UNE DEMANDE QUI N'A RIEN PRODUIT.
 */
async function modifier(client, {
  companyId, requestId, modifications = {}, lignes = null, motif = "", utilisateur = null,
}) {
  const raison = String(motif || "").trim();
  if (raison.length < 5) {
    throw erreur("Un motif de modification est obligatoire (5 caractères minimum).",
      "REASON_REQUIRED", 400);
  }

  const d = await charger(client, companyId, requestId, { verrou: true });

  if (AVEC_STOCK.includes(d.status)) {
    throw erreur(
      `La demande ${d.reference} a déjà déplacé du stock (${d.status}). `
      + `Contre-passez la réception d'abord : la modifier maintenant laisserait `
      + `les mouvements déjà écrits sans rapport avec ce qu'elle dit.`,
      "REQUEST_ALREADY_RECEIVED", 409, { statut: d.status });
  }
  if (d.status === STATUS.CANCELLED) {
    throw erreur(`La demande ${d.reference} est annulée : elle ne se modifie plus.`,
      "REQUEST_CANCELLED", 409);
  }

  /* Ce qui change VRAIMENT. Un champ renvoyé identique par un formulaire ne
     doit pas peupler l'historique : il le noierait. */
  const changes = {};
  const colonnes = [];
  const valeurs = [];
  for (const [champ, libelle] of Object.entries(CHAMPS)) {
    if (!(champ in modifications)) continue;
    const nouvelle = String(modifications[champ] ?? "");
    const ancienne = String(d[champ] ?? "");
    if (ancienne === nouvelle) continue;
    changes[champ] = { libelle, avant: ancienne, apres: nouvelle };
    valeurs.push(nouvelle);
    colonnes.push(`${champ} = $${valeurs.length}`);
  }

  /* Les lignes, s'il y en a. On remplace par ce qui est envoyé plutôt que de
     fusionner : une ligne retirée du formulaire doit disparaître. */
  let changementLignes = null;
  if (Array.isArray(lignes)) {
    const avant = (await client.query(
      `SELECT * FROM stock_request_lines WHERE request_id = $1 ORDER BY line_no`, [d.id])).rows;
    if (avant.some((l) => Number(l.quantity_received) > 0)) {
      throw erreur(
        "Une ligne de cette demande a déjà été réceptionnée : contre-passez d'abord.",
        "LINE_ALREADY_RECEIVED", 409);
    }
    if (!lignes.length) {
      throw erreur("Une demande sans ligne n'a pas de sens : supprimez-la plutôt.",
        "NO_LINE", 400);
    }
    for (const [i, l] of lignes.entries()) {
      if (!(Number(l.quantity_requested) > 0)) {
        throw erreur(`Ligne ${i + 1} : la quantité doit être supérieure à zéro.`,
          "INVALID_QUANTITY", 400);
      }
      if (!l.product_id && !String(l.product_reference || "").trim()) {
        throw erreur(`Ligne ${i + 1} : produit obligatoire.`, "PRODUCT_REQUIRED", 400);
      }
    }
    await client.query(`DELETE FROM stock_request_lines WHERE request_id = $1`, [d.id]);
    for (const [i, l] of lignes.entries()) {
      await client.query(
        `INSERT INTO stock_request_lines
           (company_id, request_id, line_no, product_id, product_reference, product_name,
            unit, quantity_requested, quantity_received, unit_price, warehouse,
            location_code, observation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$12)`,
        [companyId, d.id, i + 1, l.product_id || null,
         l.product_reference || null, l.product_name || null, l.unit || null,
         nombre(l.quantity_requested), l.unit_price || null, l.warehouse || null,
         l.location_code || null, l.observation || null]);
    }
    changementLignes = {
      avant: avant.map((l) => ({ produit: l.product_name, quantite: Number(l.quantity_requested) })),
      apres: lignes.map((l) => ({ produit: l.product_name, quantite: nombre(l.quantity_requested) })),
    };
  }

  if (!colonnes.length && !changementLignes) {
    throw erreur("Aucune modification : les valeurs envoyées sont identiques.",
      "NOTHING_TO_CHANGE", 400);
  }

  let apres = d;
  if (colonnes.length) {
    valeurs.push(d.id);
    const { rows } = await client.query(
      `UPDATE stock_requests SET ${colonnes.join(", ")}, updated_at = now()
        WHERE id = $${valeurs.length} RETURNING *`, valeurs);
    apres = rows[0];
  }

  /* Une demande validée que l'on modifie retourne EN ATTENTE : le validateur
     a approuvé un contenu qui n'est plus celui-là. */
  let statutApres = apres.status;
  if (apres.status === STATUS.VALIDATED) {
    const { rows } = await client.query(
      `UPDATE stock_requests
          SET status = $2, validated_by = NULL, validated_at = NULL, updated_at = now()
        WHERE id = $1 RETURNING *`, [d.id, STATUS.PENDING]);
    apres = rows[0];
    statutApres = STATUS.PENDING;
  }

  await journaliser(client, d, {
    action: "MODIFICATION", reason: raison,
    statutAvant: d.status, statutApres,
    details: { champs: changes, lignes: changementLignes },
    lignes: changementLignes ? changementLignes.apres.length : 0,
    utilisateur,
  });

  return {
    demande: apres, changes, lignes: changementLignes,
    revalidation_requise: d.status === STATUS.VALIDATED,
  };
}

/**
 * DÉVALIDER — reprendre une validation qui n'a rien produit.
 */
async function devalider(client, { companyId, requestId, motif = "", utilisateur = null }) {
  const raison = String(motif || "").trim();
  if (raison.length < 10) {
    throw erreur("Motif obligatoire (10 caractères minimum) : il restera attaché à la demande.",
      "REASON_REQUIRED", 400);
  }

  const d = await charger(client, companyId, requestId, { verrou: true });
  if (d.status !== STATUS.VALIDATED) {
    throw erreur(
      d.status === STATUS.PARTIAL || d.status === STATUS.RECEIVED
        ? `La demande ${d.reference} a déjà déplacé du stock : contre-passez la réception.`
        : `La demande ${d.reference} n'est pas validée (${d.status}) : il n'y a pas de validation à reprendre.`,
      d.status === STATUS.PARTIAL || d.status === STATUS.RECEIVED
        ? "REQUEST_ALREADY_RECEIVED" : "REQUEST_NOT_VALIDATED",
      409, { statut: d.status });
  }

  /* Ceinture et bretelles : on vérifie qu'aucun mouvement n'existe vraiment,
     plutôt que de s'en remettre au seul statut. */
  const { rows: mouvements } = await client.query(
    `SELECT l.movement_id FROM stock_request_lines l
      WHERE l.request_id = $1 AND l.movement_id IS NOT NULL`, [d.id]);
  if (mouvements.length) {
    throw erreur(
      `La demande ${d.reference} est marquée validée mais porte ${mouvements.length} `
      + `mouvement(s) de stock : contre-passez-la plutôt que de la dévalider.`,
      "MOVEMENTS_EXIST", 409, { mouvements: mouvements.length });
  }

  const { rows } = await client.query(
    `UPDATE stock_requests
        SET status = $2, validated_by = NULL, validated_at = NULL, updated_at = now()
      WHERE id = $1 RETURNING *`, [d.id, STATUS.PENDING]);

  await journaliser(client, d, {
    action: "DEVALIDATION", reason: raison,
    statutAvant: d.status, statutApres: STATUS.PENDING,
    details: { validee_par: d.validated_by, validee_le: d.validated_at },
    utilisateur,
  });

  return { demande: rows[0], stock_impacte: false };
}

/**
 * CONTRE-PASSER UNE RÉCEPTION.
 *
 * `stockLocations` est injecté : c'est le MÊME moteur que la réception, donc
 * les mêmes garde-fous — refus d'un mouvement sans emplacement sur un produit
 * géré par bac, refus d'un stock négatif.
 */
async function contrepasser(client, {
  companyId, requestId, motif = "", utilisateur = null, stockLocations,
  annulerEnsuite = false,
}) {
  const raison = String(motif || "").trim();
  if (raison.length < 10) {
    throw erreur("Motif obligatoire (10 caractères minimum) : il restera attaché à la demande.",
      "REASON_REQUIRED", 400);
  }
  if (!stockLocations || typeof stockLocations.adjustGlobalStock !== "function") {
    throw erreur("Moteur de stock absent : contre-passation impossible.", "ENGINE_MISSING", 500);
  }

  const d = await charger(client, companyId, requestId, { verrou: true });
  if (!AVEC_STOCK.includes(d.status)) {
    throw erreur(
      `La demande ${d.reference} n'a déplacé aucun stock (${d.status}) : `
      + `il n'y a rien à contre-passer. Modifiez-la ou annulez-la.`,
      "NOTHING_TO_REVERSE", 409, { statut: d.status });
  }

  const { rows: lignes } = await client.query(
    `SELECT * FROM stock_request_lines
      WHERE request_id = $1 AND quantity_received > 0 ORDER BY line_no FOR UPDATE`, [d.id]);
  if (!lignes.length) {
    throw erreur(
      `La demande ${d.reference} est marquée ${d.status} mais aucune ligne ne porte `
      + `de quantité reçue. Rien à contre-passer — signalez cette incohérence.`,
      "NO_RECEIVED_LINE", 409);
  }

  /* Le sens inverse de celui qu'a appliqué la réception. Un inventaire n'est
     pas contre-passable de cette façon : il a fixé le stock à une valeur
     comptée, il ne l'a pas augmenté ni diminué d'une quantité connue. */
  if (d.request_type === "inventaire") {
    throw erreur(
      `La demande ${d.reference} est un inventaire : elle a fixé le stock à une `
      + `valeur comptée, pas ajouté ni retiré une quantité. La contre-passer `
      + `supposerait de connaître le stock d'avant, que rien ne garantit encore `
      + `exact aujourd'hui. Faites un nouvel inventaire.`,
      "INVENTORY_NOT_REVERSIBLE", 409, { statut: d.status });
  }

  const SENS = { entree: -1, sortie: 1, transfert: 1 };
  const signe = SENS[d.request_type];
  if (!signe) {
    throw erreur(`Type de demande « ${d.request_type} » : contre-passation non définie.`,
      "TYPE_NOT_REVERSIBLE", 409);
  }
  const MOUVEMENT = { entree: "Sortie", sortie: "Entrée", transfert: "Transfert" };

  const faites = [];
  let quantiteTotale = 0;

  for (const ligne of lignes) {
    const quantite = nombre(ligne.quantity_received);
    if (!(quantite > 0)) continue;

    const { rows: produits } = await client.query(
      `SELECT id, reference, name, stock FROM products
        WHERE id = $1 AND company_id = $2 FOR UPDATE`, [ligne.product_id, companyId]);
    const produit = produits[0];
    if (!produit) {
      throw erreur(`Ligne ${ligne.line_no} : produit introuvable, contre-passation impossible.`,
        "PRODUCT_NOT_FOUND", 409);
    }

    const delta = signe * quantite;

    /* Le mouvement inverse, écrit AVANT l'ajustement : s'il échoue, la
       transaction annule tout, et l'on n'a jamais de stock bougé sans trace. */
    const { rows: inverses } = await client.query(
      `INSERT INTO stock_movements
         (type, product_reference, product_name, quantity, source_warehouse,
          destination_warehouse, reason, status, approval_status, company_id,
          created_by, validated_by, validated_at, product_id,
          reverses_movement_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Validé','Validé',$8,$9,$9,NOW(),$10,$11,NOW(),NOW())
       RETURNING id`,
      [MOUVEMENT[d.request_type], produit.reference, produit.name, quantite,
       d.target_warehouse, d.source_warehouse,
       `Contre-passation de la demande ${d.reference} — ${raison}`,
       companyId, utilisateur?.id || null, produit.id, ligne.movement_id || null]);

    await stockLocations.adjustGlobalStock(client, {
      companyId, productId: produit.id, delta,
      user: { id: utilisateur?.id || null, name: nomDe(utilisateur), role: utilisateur?.role },
      reason: `Contre-passation ${d.reference}`,
      type: MOUVEMENT[d.request_type],
      locationId: ligne.location_id || null,
      origin: "contre-passation de demande",
    });

    /* Le mouvement d'origine porte la marque de son annulation : le journal
       se lit sans avoir à chercher quelle ligne défait quelle autre. */
    if (ligne.movement_id) {
      await client.query(
        `UPDATE stock_movements
            SET cancelled_at = now(), cancelled_by = $1, cancel_reason = $2, updated_at = NOW()
          WHERE id = $3 AND company_id = $4`,
        [utilisateur?.id || null, raison, ligne.movement_id, companyId]);
    }

    await client.query(
      `UPDATE stock_request_lines SET quantity_received = 0, movement_id = NULL WHERE id = $1`,
      [ligne.id]);

    faites.push({
      ligne: ligne.line_no, produit: produit.name, quantite,
      delta, mouvement_origine: ligne.movement_id, mouvement_inverse: inverses[0].id,
    });
    quantiteTotale += quantite;
  }

  const statutApres = annulerEnsuite ? STATUS.CANCELLED : STATUS.VALIDATED;
  const { rows } = await client.query(
    `UPDATE stock_requests
        SET status = $2, received_by = NULL, received_at = NULL,
            ${annulerEnsuite ? "cancelled_by = $3, cancelled_at = now(), cancel_reason = $4, cancelled_by_name = $5," : ""}
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    annulerEnsuite
      ? [d.id, statutApres, utilisateur?.id || null, raison, nomDe(utilisateur)]
      : [d.id, statutApres]);

  await journaliser(client, d, {
    action: annulerEnsuite ? "ANNULATION" : "CONTREPASSATION",
    reason: raison, statutAvant: d.status, statutApres,
    details: { mouvements: faites },
    lignes: faites.length, quantite: quantiteTotale,
    utilisateur,
  });

  return {
    demande: rows[0], mouvements: faites,
    quantite_contrepassee: quantiteTotale,
    stock_impacte: true,
    /* Ce qui n'a PAS eu lieu, et qu'on confond : rien n'a été effacé. */
    nature: "Contre-passation : les mouvements d'origine sont conservés et marqués annulés.",
  };
}

/** L'historique des corrections d'une demande, du plus récent au plus ancien. */
async function historique(runner, companyId, requestId) {
  const { rows } = await runner.query(
    `SELECT c.*, u.fullname AS auteur
       FROM stock_request_corrections c
       LEFT JOIN users u ON u.id = c.acted_by
      WHERE c.company_id = $1 AND c.request_id = $2
      ORDER BY c.acted_at DESC, c.id DESC`, [companyId, requestId]);
  return rows;
}

module.exports = {
  STATUS, SANS_EFFET, AVEC_STOCK, CHAMPS,
  modifier, devalider, contrepasser, historique, charger,
};

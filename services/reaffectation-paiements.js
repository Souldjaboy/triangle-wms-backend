"use strict";

/**
 * RÉAFFECTER UN PAIEMENT À LA BONNE FACTURE.
 *
 * L'argent est entré et il reste entré. Seule son imputation change.
 *
 * CE QUI DISTINGUE CE GESTE DES AUTRES, ET POURQUOI IL FAUT LE DIRE.
 *
 *   • RÉAFFECTATION — l'imputation change, l'argent ne bouge pas. Aucune
 *     écriture de trésorerie n'est créée : le compte a déjà été crédité le
 *     jour de l'encaissement. En créer une seconde doublerait les recettes.
 *   • CONTREPASSATION (152) — l'argent ressort des comptes. Des écritures
 *     inverses sont posées.
 *   • REMBOURSEMENT — l'argent revient physiquement au client. C'est un
 *     mouvement bancaire réel, qui se constate séparément.
 *
 * Confondre les trois est la façon la plus simple de fausser un résultat.
 *
 * DEUX RÈGLES TENUES ICI.
 *
 * 1. LES SOLDES SE RECALCULENT, ILS NE SE DÉDUISENT PAS. Les deux factures
 *    sont reconstruites depuis la somme réelle de leurs paiements non
 *    contrepassés (services/soldes-factures.js). « ancien − montant » dérive.
 *
 * 2. LE DÉPLACEMENT EST ATOMIQUE. Le paiement n'est jamais « détaché » : il
 *    passe d'une facture à l'autre en une seule écriture, dans une
 *    transaction. Il n'existe donc aucun instant où il serait libre, et
 *    attribuable deux fois.
 */

const S = require("./soldes-factures");
/* `toLocaleString("fr-FR")` sépare les milliers par une espace FINE
   INSÉCABLE (U+202F). Dans un message d'erreur, elle est invisible mais bien
   présente : une recherche sur « 100 000 » tapé au clavier ne trouve rien, et
   un journal la rend par un caractère de remplacement. Le formateur partagé
   la remplace par une espace ordinaire — le même qui corrigeait
   « 450 /000 FCFA » sur les bons de livraison. */
const { nombreFr } = require("./format-pdf");

const erreur = (message, code, httpStatus = 400, extra = {}) => {
  const e = new Error(message);
  e.code = code; e.httpStatus = httpStatus;
  Object.assign(e, extra);
  return e;
};

const nomDe = (u) => u?.name || u?.fullname || "Utilisateur";
const nombre = (v) => Number(v || 0);
const MOTIF_MINIMUM = 10;

/* Les clients, pour que l'historique porte des noms et pas des numéros. */
const CLIENTS = Object.freeze({ SABLE: "sand_customers", CIMENT: "cement_customers" });

async function chargerPaiement(client, { companyId, product, paymentId, verrou = false }) {
  const p = S.produitDe(product);
  const { rows } = await client.query(
    `SELECT * FROM ${p.paiements}
      WHERE id = $1 AND company_id = $2${verrou ? " FOR UPDATE" : ""}`,
    [paymentId, companyId]);
  if (!rows[0]) throw erreur("Paiement introuvable dans cette société.", "PAYMENT_NOT_FOUND", 404);
  return rows[0];
}

async function chargerFacture(client, { companyId, product, invoiceId, verrou = false }) {
  const p = S.produitDe(product);
  const { rows } = await client.query(
    `SELECT i.*, COALESCE(c.name, '') AS client_name
       FROM ${p.factures} i
       LEFT JOIN ${CLIENTS[p.cle]} c ON c.id = i.customer_id AND c.company_id = i.company_id
      WHERE i.id = $1 AND i.company_id = $2${verrou ? " FOR UPDATE OF i" : ""}`,
    [invoiceId, companyId]);
  if (!rows[0]) throw erreur("Facture introuvable dans cette société.", "INVOICE_NOT_FOUND", 404);
  return rows[0];
}

/* ─────────────────────────────────────────────────────────────────────────
   L'HISTORIQUE D'UN PAIEMENT
   Tout ce qui lui est arrivé : son imputation d'origine, ses déplacements,
   sa contrepassation éventuelle.
   ───────────────────────────────────────────────────────────────────────── */
async function historiquePaiement(client, { companyId, product, paymentId }) {
  const p = S.produitDe(product);
  const paiement = await chargerPaiement(client, { companyId, product, paymentId });
  const { rows: mouvements } = await client.query(
    `SELECT * FROM payment_reallocations
      WHERE company_id = $1 AND product = $2 AND payment_id = $3
      ORDER BY created_at, id`,
    [companyId, p.cle, paymentId]);
  const { rows: contrepassation } = await client.query(
    `SELECT * FROM ${p.contrepassations}
      WHERE company_id = $1 AND original_payment_id = $2`,
    [companyId, paymentId]);
  return {
    paiement,
    facture_actuelle: Number(paiement.invoice_id),
    facture_origine: paiement.original_invoice_id ? Number(paiement.original_invoice_id) : null,
    reaffectations: mouvements,
    contrepasse: contrepassation.length > 0,
    contrepassation: contrepassation[0] || null,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   LES FACTURES VERS LESQUELLES ON PEUT DÉPLACER
   ───────────────────────────────────────────────────────────────────────── */
async function ciblesPossibles(client, { companyId, product, paymentId, recherche = null, limite = 50 }) {
  const p = S.produitDe(product);
  const paiement = await chargerPaiement(client, { companyId, product, paymentId });
  const params = [companyId, paiement.invoice_id];
  let filtre = "";
  if (recherche) {
    params.push(recherche);
    filtre = `AND (i.invoice_number ILIKE '%' || $${params.length} || '%'
                   OR c.name ILIKE '%' || $${params.length} || '%')`;
  }
  params.push(limite);
  const { rows } = await client.query(
    `SELECT i.id, i.invoice_number, i.invoice_date, i.total_amount,
            i.paid_amount, i.remaining_amount, i.status,
            COALESCE(c.name,'') AS client_name
       FROM ${p.factures} i
       LEFT JOIN ${CLIENTS[p.cle]} c ON c.id = i.customer_id AND c.company_id = i.company_id
      WHERE i.company_id = $1
        AND i.id <> $2
        AND i.status <> 'ANNULEE'
        ${filtre}
      ORDER BY i.remaining_amount DESC, i.invoice_date DESC
      LIMIT $${params.length}`, params);
  return rows.map((r) => ({
    id: Number(r.id),
    numero: r.invoice_number,
    date: r.invoice_date,
    client: r.client_name,
    montant: nombre(r.total_amount),
    paye: nombre(r.paid_amount),
    restant: nombre(r.remaining_amount),
    statut: r.status,
    /* Ce que le déplacement produirait sur cette facture — calculé ici pour
       que l'écran n'ait pas à le refaire, et que les deux ne divergent pas. */
    depassement: Math.max(nombre(paiement.amount) - nombre(r.remaining_amount), 0),
  }));
}

/* ─────────────────────────────────────────────────────────────────────────
   DÉPLACER
   ───────────────────────────────────────────────────────────────────────── */
async function reaffecter(client, {
  companyId, product, paymentId, versFactureId, motif,
  accepterDepassement = false, utilisateur,
}) {
  const p = S.produitDe(product);
  const m = String(motif || "").trim();
  if (m.length < MOTIF_MINIMUM) {
    throw erreur(
      `Motif obligatoire (${MOTIF_MINIMUM} caractères minimum) : il restera attaché au paiement et à la facture.`,
      "REASON_REQUIRED", 400);
  }

  /* L'ordre des verrous est fixe — paiement, puis factures par identifiant
     croissant. Deux réaffectations croisées qui verrouilleraient dans
     l'ordre inverse se bloqueraient l'une l'autre. */
  const paiement = await chargerPaiement(client, { companyId, product, paymentId, verrou: true });

  if (await S.estContrepasse(client, { companyId, product, paymentId })) {
    throw erreur(
      `Le paiement ${paiement.payment_number} a été contrepassé : l'argent est ressorti des comptes. Il n'y a plus rien à réaffecter.`,
      "PAYMENT_REVERSED", 409);
  }
  if (Number(paiement.invoice_id) === Number(versFactureId)) {
    throw erreur(
      `Le paiement ${paiement.payment_number} est déjà imputé à cette facture.`,
      "SAME_INVOICE", 409);
  }

  const ids = [Number(paiement.invoice_id), Number(versFactureId)].sort((a, b) => a - b);
  const verrouillees = {};
  for (const id of ids) {
    verrouillees[id] = await chargerFacture(client, { companyId, product, invoiceId: id, verrou: true });
  }
  const source = verrouillees[Number(paiement.invoice_id)];
  const cible = verrouillees[Number(versFactureId)];

  if (cible.status === "ANNULEE") {
    throw erreur(
      `La facture ${cible.invoice_number} est annulée : un encaissement ne s'impute pas sur une facture qui n'existe plus commercialement.`,
      "TARGET_CANCELLED", 409);
  }

  /* Le trop-perçu se décide, il ne se subit pas. */
  const depassement = Math.max(nombre(paiement.amount) - nombre(cible.remaining_amount), 0);
  if (depassement > 0 && !accepterDepassement) {
    throw erreur(
      `La facture ${cible.invoice_number} ne doit plus que ${nombreFr(cible.remaining_amount)} FCFA, et ce paiement en porte ${nombreFr(paiement.amount)}. Le déplacer la mettrait en trop-perçu de ${nombreFr(depassement)} FCFA.`,
      "OVERPAY_NOT_ACCEPTED", 409,
      { depassement, restant_cible: nombre(cible.remaining_amount), montant: nombre(paiement.amount) });
  }

  /* Le déplacement, en une écriture. Le paiement n'est jamais sans facture. */
  const { rows: deplace } = await client.query(
    `UPDATE ${p.paiements}
        SET invoice_id = $3::bigint,
            original_invoice_id = COALESCE(original_invoice_id, invoice_id),
            reallocated_at = now(),
            reallocation_count = reallocation_count + 1
      WHERE id = $1 AND company_id = $2
      RETURNING *`,
    [paymentId, companyId, versFactureId]);

  const { rows: trace } = await client.query(
    `INSERT INTO payment_reallocations
       (company_id, product, payment_id, payment_number, amount, payment_date,
        from_invoice_id, from_invoice_number, from_customer,
        to_invoice_id, to_invoice_number, to_customer,
        reason, overpay_accepted, overpay_amount, created_by, created_by_name)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [companyId, p.cle, paymentId, paiement.payment_number, paiement.amount,
      paiement.payment_date, source.id, source.invoice_number, source.client_name,
      cible.id, cible.invoice_number, cible.client_name,
      m, depassement > 0, depassement,
      utilisateur?.id || null, nomDe(utilisateur)]);

  /* Les deux factures, reconstruites depuis leurs paiements réels. */
  const sourceApres = await S.recomputerFacture(client, { companyId, product, invoiceId: source.id });
  const cibleApres = await S.recomputerFacture(client, { companyId, product, invoiceId: cible.id });

  return {
    paiement: deplace[0],
    reaffectation: trace[0],
    source: { avant: resume(source), apres: resume(sourceApres) },
    cible: { avant: resume(cible), apres: resume(cibleApres) },
    depassement,
  };
}

const resume = (f) => (f ? {
  id: Number(f.id), numero: f.invoice_number, statut: f.status,
  montant: nombre(f.total_amount), paye: nombre(f.paid_amount),
  restant: nombre(f.remaining_amount),
} : null);

/* ─────────────────────────────────────────────────────────────────────────
   ANNULER UNE RÉAFFECTATION
   Remet le paiement là où il était. On ne supprime pas la ligne : deux
   lignes lisibles valent mieux qu'un trou.
   ───────────────────────────────────────────────────────────────────────── */
async function annulerReaffectation(client, { companyId, reallocationId, motif, utilisateur }) {
  const m = String(motif || "").trim();
  if (m.length < MOTIF_MINIMUM) {
    throw erreur(`Motif obligatoire (${MOTIF_MINIMUM} caractères minimum).`, "REASON_REQUIRED", 400);
  }
  const { rows } = await client.query(
    `SELECT * FROM payment_reallocations
      WHERE id = $1 AND company_id = $2 FOR UPDATE`, [reallocationId, companyId]);
  const trace = rows[0];
  if (!trace) throw erreur("Réaffectation introuvable.", "REALLOCATION_NOT_FOUND", 404);
  if (trace.reverted_at) {
    throw erreur("Cette réaffectation a déjà été annulée.", "ALREADY_REVERTED", 409);
  }

  const p = S.produitDe(trace.product);
  const paiement = await chargerPaiement(client, {
    companyId, product: trace.product, paymentId: trace.payment_id, verrou: true,
  });

  /* On n'annule que la DERNIÈRE réaffectation. Revenir en arrière au milieu
     d'une chaîne laisserait le paiement sur une facture qu'aucune ligne ne
     désigne, et l'historique deviendrait impossible à relire. */
  const { rows: posterieures } = await client.query(
    `SELECT id FROM payment_reallocations
      WHERE company_id = $1 AND product = $2 AND payment_id = $3
        AND reverted_at IS NULL AND id > $4`,
    [companyId, trace.product, trace.payment_id, trace.id]);
  if (posterieures.length) {
    throw erreur(
      `Ce paiement a été réaffecté ${posterieures.length} fois depuis. Annulez d'abord la plus récente.`,
      "NOT_LAST_REALLOCATION", 409);
  }
  if (Number(paiement.invoice_id) !== Number(trace.to_invoice_id)) {
    throw erreur(
      "Le paiement n'est plus sur la facture que cette réaffectation lui avait donnée : l'annuler le déplacerait au mauvais endroit.",
      "PAYMENT_MOVED_SINCE", 409);
  }

  await client.query(
    `UPDATE ${p.paiements}
        SET invoice_id = $3::bigint, reallocated_at = now(),
            reallocation_count = GREATEST(reallocation_count - 1, 0)
      WHERE id = $1 AND company_id = $2`,
    [trace.payment_id, companyId, trace.from_invoice_id]);

  const { rows: majTrace } = await client.query(
    `UPDATE payment_reallocations
        SET reverted_at = now(), reverted_by = $2, reverted_by_name = $3, revert_reason = $4
      WHERE id = $1 RETURNING *`,
    [trace.id, utilisateur?.id || null, nomDe(utilisateur), m]);

  const source = await S.recomputerFacture(client, {
    companyId, product: trace.product, invoiceId: trace.from_invoice_id });
  const cible = await S.recomputerFacture(client, {
    companyId, product: trace.product, invoiceId: trace.to_invoice_id });

  return { reaffectation: majTrace[0], revenue_sur: resume(source), retiree_de: resume(cible) };
}

/* ─────────────────────────────────────────────────────────────────────────
   LES PAIEMENTS D'UNE FACTURE, avec leur provenance
   ───────────────────────────────────────────────────────────────────────── */
async function paiementsDeFacture(client, { companyId, product, invoiceId }) {
  const p = S.produitDe(product);
  const { rows } = await client.query(
    `SELECT pay.*,
            (SELECT 1 FROM ${p.contrepassations} r
              WHERE r.company_id = pay.company_id AND r.original_payment_id = pay.id
              LIMIT 1) IS NOT NULL AS contrepasse,
            (SELECT row_to_json(x) FROM (
               SELECT from_invoice_number, from_customer, reason, created_by_name, created_at
                 FROM payment_reallocations
                WHERE company_id = pay.company_id AND product = $3
                  AND payment_id = pay.id AND reverted_at IS NULL
                ORDER BY id DESC LIMIT 1) x) AS venu_de
       FROM ${p.paiements} pay
      WHERE pay.company_id = $1 AND pay.invoice_id = $2
      ORDER BY pay.payment_date, pay.id`,
    [companyId, invoiceId, p.cle]);
  return rows;
}

module.exports = {
  MOTIF_MINIMUM, erreur,
  chargerPaiement, chargerFacture,
  historiquePaiement, ciblesPossibles,
  reaffecter, annulerReaffectation, paiementsDeFacture,
};

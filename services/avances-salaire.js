"use strict";

/**
 * AVANCES SUR SALAIRE — le solde est la seule vérité.
 *
 * Tout part du solde restant, jamais du montant initial. C'est ce qui rend
 * impossible la double retenue, le sur-remboursement et le remboursement
 * anticipé mal compté : une avance de 25 000 déjà remboursée de 20 000 ne
 * peut plus rendre que 5 000, quelle que soit la voie empruntée.
 *
 * Trois façons de rembourser, un seul journal :
 *   • la retenue automatique sur une paie, guidée par l'échéancier ;
 *   • le versement direct au comptoir, qui rentre de l'argent en caisse ;
 *   • la contrepassation, qui défait un remboursement sans l'effacer.
 */

const T = require("../services/tresorerie");

const francs = T.francs;
const erreur = T.erreur;

/**
 * L'échéancier d'une avance versée.
 *
 * Une mensualité de 0 signifie « en une seule fois » : une échéance unique du
 * montant total. Sinon, autant d'échéances que nécessaire, la DERNIÈRE
 * absorbant le reste — 25 000 par 7 000 donne 7 000 × 3 puis 4 000, pas
 * 7 000 × 4 qui prendrait 3 000 de trop.
 */
function planifier(montant, mensualite) {
  const total = francs(montant);
  const pas = francs(mensualite);
  if (pas <= 0 || pas >= total) return [total];

  const echeances = [];
  let restant = total;
  while (restant > 0) {
    const part = Math.min(pas, restant);
    echeances.push(part);
    restant -= part;
  }
  return echeances;
}

/** Le code de période décalé de `n` mois. */
function periodeDecalee(code, n) {
  const [annee, mois] = String(code).split("-").map(Number);
  const total = (annee * 12 + (mois - 1)) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/**
 * (Re)pose l'échéancier d'une avance.
 *
 * Seules les échéances À VENIR sont remplacées : celles déjà retenues sur une
 * paie appartiennent au passé et ne se réécrivent pas. Les nouveaux rangs
 * REPRENNENT donc après le dernier rang existant, au lieu de repartir de 1 —
 * sinon un rééchelonnement écraserait l'échéance n°1 déjà retenue, qui
 * redeviendrait « à venir » et serait prélevée une seconde fois.
 */
async function poserEcheancier(client, { companyId, advanceId, montant, mensualite, premierCode }) {
  await client.query(
    `DELETE FROM salary_advance_installments WHERE advance_id = $1 AND status = 'A_VENIR'`,
    [advanceId]
  );
  const { rows: dernier } = await client.query(
    `SELECT COALESCE(max(rank), 0) AS rang FROM salary_advance_installments WHERE advance_id = $1`,
    [advanceId]
  );
  const depart = Number(dernier[0]?.rang || 0);

  const parts = planifier(montant, mensualite);
  for (let i = 0; i < parts.length; i += 1) {
    await client.query(
      `INSERT INTO salary_advance_installments
         (company_id, advance_id, rank, period_code, amount_due)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (advance_id, rank) DO UPDATE
         SET period_code = EXCLUDED.period_code, amount_due = EXCLUDED.amount_due,
             amount_taken = 0, status = 'A_VENIR', updated_at = now()`,
      [companyId, advanceId, depart + i + 1, periodeDecalee(premierCode, i), parts[i]]
    );
  }
  return parts;
}

/** Le statut qui découle du solde — jamais posé à la main. */
function statutSelonSolde(solde, montantVerse) {
  if (francs(solde) === 0) return "REMBOURSEE";
  if (francs(solde) < francs(montantVerse)) return "EN_REMBOURSEMENT";
  return "VERSEE";
}

/**
 * Enregistre un remboursement et met le solde à jour, dans la même
 * transaction. Refuse tout ce qui dépasse le solde : c'est ici que se joue
 * l'interdiction du sur-remboursement, avant même la contrainte de la base.
 */
async function rembourser(client, {
  companyId, advanceId, montant, origine, installmentId = null, payrollItemId = null,
  bankId = null, caisseId = null, reference = "", reason = "",
  reversesRepaymentId = null, userId = null, userName = "",
  transactionId = null,
}) {
  const { rows: avances } = await client.query(
    `SELECT * FROM salary_advances WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [advanceId, companyId]
  );
  const avance = avances[0];
  if (!avance) throw erreur("Avance introuvable.", "ADVANCE_NOT_FOUND", 404);

  const somme = francs(montant);
  const soldeAvant = francs(avance.balance);

  /* Un remboursement positif ne peut pas dépasser ce qui reste dû. Une
     contrepassation, elle, est négative : elle REND du solde. */
  if (somme > 0 && somme > soldeAvant) {
    throw erreur(
      `Il ne reste que ${soldeAvant.toLocaleString("fr-FR")} FCFA à rembourser sur cette avance ; ${somme.toLocaleString("fr-FR")} ont été saisis.`,
      "ADVANCE_OVERPAYMENT", 409,
      { solde: soldeAvant, saisi: somme }
    );
  }
  const soldeApres = soldeAvant - somme;
  if (soldeApres < 0 || soldeApres > francs(avance.amount_paid)) {
    throw erreur("Ce mouvement mettrait le solde hors de ses bornes.", "ADVANCE_BALANCE_INVALID", 409);
  }

  const { rows: lignes } = await client.query(
    `INSERT INTO salary_advance_repayments
       (company_id, advance_id, installment_id, payroll_item_id, amount, origin,
        balance_before, balance_after, bank_id, caisse_id, accounting_transaction_id,
        reference, reverses_repayment_id, reason, performed_by, performed_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [companyId, advanceId, installmentId, payrollItemId, somme, origine,
     soldeAvant, soldeApres, bankId, caisseId, transactionId,
     reference, reversesRepaymentId, reason, userId, userName]
  );

  await client.query(
    `UPDATE salary_advances SET balance = $1, status = $2, updated_at = now() WHERE id = $3`,
    [soldeApres, statutSelonSolde(soldeApres, avance.amount_paid), advanceId]
  );

  if (installmentId) {
    await client.query(
      `UPDATE salary_advance_installments
          SET amount_taken = amount_taken + $1,
              status = CASE WHEN amount_taken + $1 >= amount_due THEN 'RETENUE' ELSE status END,
              updated_at = now()
        WHERE id = $2`,
      [somme, installmentId]
    );
  }

  return { remboursement: lignes[0], solde_avant: soldeAvant, solde_apres: soldeApres };
}

/**
 * Ce qu'il faut retenir sur la paie d'un employé pour une période donnée.
 *
 * Plafonné par le solde ET par le net disponible : une retenue ne doit jamais
 * rendre un salaire négatif. Ce qui n'a pas pu être retenu reste dû, et sera
 * repris à la période suivante.
 */
async function retenueDue(client, { companyId, employeeId, periodCode, netDisponible }) {
  const { rows } = await client.query(
    `SELECT i.id AS installment_id, i.advance_id, i.amount_due, i.amount_taken,
            a.balance, a.reference
       FROM salary_advance_installments i
       JOIN salary_advances a ON a.id = i.advance_id
      WHERE i.company_id = $1
        AND a.employee_id = $2
        AND i.period_code <= $3
        AND i.status = 'A_VENIR'
        AND a.balance > 0
        AND a.status IN ('VERSEE', 'EN_REMBOURSEMENT')
      ORDER BY i.period_code, i.rank`,
    [companyId, employeeId, periodCode]
  );

  const retenues = [];
  let reste = francs(netDisponible);
  for (const e of rows) {
    if (reste <= 0) break;
    const du = Math.min(
      francs(e.amount_due) - francs(e.amount_taken),
      francs(e.balance),
      reste
    );
    if (du <= 0) continue;
    retenues.push({ ...e, montant: du });
    reste -= du;
  }
  return retenues;
}

module.exports = {
  francs, erreur, planifier, periodeDecalee, poserEcheancier,
  statutSelonSolde, rembourser, retenueDue,
};

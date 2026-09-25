"use strict";

/**
 * ÉLÉMENTS DE PAIE — PRIMES, HEURES SUPPLÉMENTAIRES, RETENUES AUTORISÉES.
 *
 * Une prime n'est pas un calcul, c'est une décision. Elle est donc rattachée au
 * SALARIÉ et à la PÉRIODE, jamais à une ligne de paie — une ligne de paie se
 * refait, une décision reste.
 *
 * C'est la leçon du défaut trouvé sur `payroll_item_adjustments` : rattachée à
 * `payroll_item_id` en ON DELETE CASCADE, elle disparaissait au premier
 * recalcul, motif et auteur compris. Trois primes et un vrai salaire ont ainsi
 * vécu dans un endroit que le recalcul détruit.
 *
 * Ici, un recalcul RELIT. Rien à réparer, rien à ressaisir.
 */

const T = require("./tresorerie");
const francs = T.francs;
const erreur = T.erreur;

/** Le catalogue, tel qu'il est en base : les types évoluent sans toucher au code. */
async function typesActifs(client) {
  const { rows } = await client.query(
    `SELECT type_key, kind, label, sign, uses_quantity, requires_label, sort_order
       FROM payroll_element_types WHERE is_active
      ORDER BY sort_order, label`
  );
  return rows;
}

async function typeDe(client, typeKey) {
  const { rows } = await client.query(
    `SELECT * FROM payroll_element_types WHERE type_key = $1 AND is_active`, [typeKey]
  );
  return rows[0] || null;
}

/**
 * Le montant d'un élément.
 *
 * Pour ce qui se compte — des heures — le montant est le produit, calculé par
 * le serveur. Le laisser saisir à côté de la quantité et du taux ouvrirait un
 * troisième chiffre qui pourrait contredire les deux autres, et le bulletin
 * afficherait « 8 h × 1 500 = 15 000 » sans que personne ne sache lequel croire.
 *
 * Une correction reste possible : elle passe par `montantForce`, et l'appelant
 * exige alors un motif. Le produit théorique est conservé pour l'audit.
 */
function calculerMontant({ type, quantity, unitAmount, amount, montantForce = false }) {
  if (type.uses_quantity) {
    const heures = francs(quantity);
    const taux = francs(unitAmount);
    if (heures <= 0) throw erreur("Nombre d'heures obligatoire et supérieur à zéro.", "QUANTITY_REQUIRED", 400);
    if (taux <= 0) throw erreur("Taux horaire obligatoire et supérieur à zéro.", "UNIT_AMOUNT_REQUIRED", 400);
    const produit = francs(heures * taux);
    if (montantForce) {
      const force = francs(amount);
      if (force < 0) throw erreur("Montant corrigé invalide.", "AMOUNT_INVALID", 400);
      return { montant: force, produit, corrige: force !== produit };
    }
    return { montant: produit, produit, corrige: false };
  }

  const montant = francs(amount);
  if (montant <= 0) throw erreur("Montant obligatoire et supérieur à zéro.", "AMOUNT_REQUIRED", 400);
  return { montant, produit: null, corrige: false };
}

/**
 * Les éléments actifs d'une période, par salarié.
 *
 * Le lien vers la ligne de paie n'est pas stocké : il se déduit de
 * (company_id, employee_id, period_code). C'est précisément ce qui fait qu'un
 * recalcul n'a rien à recoller.
 */
async function elementsDeLaPeriode(client, { companyId, periodCode, employeeId = null }) {
  const { rows } = await client.query(
    `SELECT e.*, t.kind, t.label AS type_label, t.sign, t.uses_quantity
       FROM payroll_elements e
       JOIN payroll_element_types t ON t.type_key = e.type_key
      WHERE e.company_id = $1 AND e.period_code = $2 AND e.status = 'ACTIF'
        AND ($3::int IS NULL OR e.employee_id = $3)
      ORDER BY e.employee_id, t.sort_order, e.id`,
    [companyId, periodCode, employeeId]
  );
  return rows;
}

/**
 * Les totaux par salarié, prêts à entrer dans le calcul du net.
 *
 * Chaque composante reste séparée : « ne jamais afficher uniquement un net
 * inexpliqué » suppose de savoir, à la fin, d'où vient chaque franc.
 */
function totauxParSalarie(elements) {
  const parSalarie = new Map();
  for (const e of elements) {
    const cle = Number(e.employee_id);
    if (!parSalarie.has(cle)) {
      parSalarie.set(cle, {
        primes_total: 0, heures_sup_total: 0, heures_sup_heures: 0,
        retenues_autres_total: 0, details: [],
      });
    }
    const t = parSalarie.get(cle);
    const montant = francs(e.amount);
    if (e.kind === "HEURES_SUP") {
      t.heures_sup_total = francs(t.heures_sup_total + montant);
      t.heures_sup_heures = francs(t.heures_sup_heures + francs(e.quantity));
    } else if (Number(e.sign) < 0) {
      t.retenues_autres_total = francs(t.retenues_autres_total + montant);
    } else {
      t.primes_total = francs(t.primes_total + montant);
    }
    t.details.push({
      id: e.id, type_key: e.type_key, kind: e.kind, type_label: e.type_label,
      label: e.label, quantity: e.quantity, unit_amount: e.unit_amount,
      amount: montant, sign: Number(e.sign), reason: e.reason,
      created_by_name: e.created_by_name, created_at: e.created_at,
    });
  }
  return parSalarie;
}

/** Les totaux d'un seul salarié, zéros compris : l'appelant n'a jamais à tester. */
const AUCUN = Object.freeze({
  primes_total: 0, heures_sup_total: 0, heures_sup_heures: 0,
  retenues_autres_total: 0, details: [],
});

function totauxDe(parSalarie, employeeId) {
  return parSalarie.get(Number(employeeId)) || AUCUN;
}

module.exports = {
  francs, erreur, typesActifs, typeDe, calculerMontant,
  elementsDeLaPeriode, totauxParSalarie, totauxDe, AUCUN,
};

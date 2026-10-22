"use strict";

/**
 * LE SOLDE D'UNE FACTURE DE VENTE — UNE SEULE IMPLÉMENTATION.
 *
 * Le solde se RECONSTRUIT depuis la somme réelle des paiements non
 * contrepassés. Jamais « ancien montant − montant retiré » : au moindre
 * incident, une transaction interrompue, un paiement saisi deux fois, l'écart
 * s'installe et plus personne ne sait lequel des deux chiffres est le bon.
 *
 * Ce fichier existe parce que le même calcul vivait en deux exemplaires, dans
 * les routeurs d'annulation du sable et du ciment, et qu'un troisième
 * s'apprêtait à naître avec la réaffectation des paiements. Trois copies d'une
 * règle comptable finissent toujours par dire trois choses.
 *
 * DEUX DIFFÉRENCES RÉELLES ENTRE LES PRODUITS, QUI NE SONT PAS DES OUBLIS.
 *
 * 1. Une VENTE de ciment porte les statuts de paiement (PAYEE,
 *    PARTIELLEMENT_PAYEE) ; une vente de SABLE non — sa contrainte n'accepte
 *    que BROUILLON, VALIDEE, ANNULEE, REMPLACEE. On synchronise donc les
 *    montants dans les deux cas, et le statut seulement pour le ciment.
 *    Écrire « PAYEE » sur une vente de sable violerait la contrainte.
 *
 * 2. Une vente de ciment facturée dont plus rien n'est réglé retourne à
 *    FACTUREE, pas à IMPAYEE : « impayée » appartient au vocabulaire des
 *    factures, pas à celui des ventes.
 */

const PRODUITS = Object.freeze({
  SABLE: Object.freeze({
    cle: "SABLE", libelle: "Sable",
    factures: "sand_invoices", paiements: "sand_payments",
    contrepassations: "sand_payment_reversals", ventes: "sand_sales",
    /* La contrainte de sand_sales n'accepte pas de statut de paiement. */
    statutVente: false,
  }),
  CIMENT: Object.freeze({
    cle: "CIMENT", libelle: "Ciment",
    factures: "cement_invoices", paiements: "cement_payments",
    contrepassations: "cement_payment_reversals", ventes: "cement_sales",
    statutVente: true,
  }),
});

function produitDe(cle) {
  const p = PRODUITS[String(cle || "").toUpperCase()];
  if (!p) throw new Error(`Produit inconnu pour un solde de facture : « ${cle} ».`);
  return p;
}

/**
 * Recalcule le solde d'une facture, et répercute sur sa vente.
 *
 * @returns la ligne de facture telle qu'elle est après recalcul.
 */
async function recomputerFacture(client, { companyId, product, invoiceId }) {
  const p = produitDe(product);

  const { rows } = await client.query(
    `UPDATE ${p.factures} i
        SET paid_amount = s.total,
            remaining_amount = GREATEST(i.total_amount - s.total, 0),
            status = CASE
              WHEN i.cancelled_at IS NOT NULL THEN i.status
              WHEN s.total >= i.total_amount AND i.total_amount > 0 THEN 'PAYEE'
              WHEN s.total > 0 THEN 'PARTIELLEMENT_PAYEE'
              ELSE 'IMPAYEE' END,
            updated_at = NOW()
       FROM (SELECT COALESCE(SUM(pay.amount), 0) AS total
               FROM ${p.paiements} pay
              WHERE pay.company_id = $1 AND pay.invoice_id = $2
                AND NOT EXISTS (SELECT 1 FROM ${p.contrepassations} r
                                 WHERE r.company_id = pay.company_id
                                   AND r.original_payment_id = pay.id)) s
      WHERE i.id = $2 AND i.company_id = $1
      RETURNING i.*`,
    [companyId, invoiceId]);

  const facture = rows[0];
  if (!facture || !facture.sale_id) return facture || null;

  /* La vente porte les mêmes montants que sa facture : les laisser diverger
     ferait dire deux choses différentes à deux écrans.

     Les types sont donnés explicitement : le même paramètre sert de valeur à
     affecter ET de terme de comparaison, et PostgreSQL refuse alors de
     deviner lequel. */
  if (p.statutVente) {
    await client.query(
      `UPDATE ${p.ventes}
          SET paid_amount = $3::numeric, remaining_amount = $4::numeric,
              status = CASE WHEN $4::numeric <= 0 THEN 'PAYEE'
                            WHEN $3::numeric > 0 THEN 'PARTIELLEMENT_PAYEE'
                            ELSE 'FACTUREE' END,
              updated_at = NOW()
        WHERE id = $1::int AND company_id = $2::int
          AND status <> 'ANNULEE'`,
      [facture.sale_id, companyId,
        Number(facture.paid_amount), Number(facture.remaining_amount)]);
  } else {
    /* Sable : les montants seulement. Le statut de la vente dit où en est la
       VENTE (brouillon, validée, annulée), pas où en est son règlement. */
    await client.query(
      `UPDATE ${p.ventes}
          SET paid_amount = $3::numeric, remaining_amount = $4::numeric,
              updated_at = NOW()
        WHERE id = $1::int AND company_id = $2::int
          AND status <> 'ANNULEE'`,
      [facture.sale_id, companyId,
        Number(facture.paid_amount), Number(facture.remaining_amount)]);
  }

  return facture;
}

/** Ce paiement a-t-il été contrepassé ? Un paiement contrepassé n'affecte plus rien. */
async function estContrepasse(client, { companyId, product, paymentId }) {
  const p = produitDe(product);
  const { rows } = await client.query(
    `SELECT 1 FROM ${p.contrepassations}
      WHERE company_id = $1 AND original_payment_id = $2 LIMIT 1`,
    [companyId, paymentId]);
  return rows.length > 0;
}

module.exports = { PRODUITS, produitDe, recomputerFacture, estContrepasse };

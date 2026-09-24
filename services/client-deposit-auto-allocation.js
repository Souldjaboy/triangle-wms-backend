"use strict";

const T = require("./tresorerie");

const ACTIVITIES = {
  ciment: "cement_invoices",
  sable: "sand_invoices",
};

/**
 * Affecte automatiquement les dépôts disponibles d'un client à une facture.
 *
 * REGLE COMPTABLE :
 * - aucun nouvel encaissement banque/caisse ;
 * - l'argent est déjà entré lors du dépôt ;
 * - débit Avances reçues des clients ;
 * - crédit Créances clients.
 *
 * FIFO :
 * dépôt le plus ancien utilisé en premier.
 */
async function autoAllocateClientDeposits({
  client,
  companyId,
  activity,
  invoiceId,
  userId,
  userName,
  createAccountingEntry,
}) {

  const table = ACTIVITIES[activity];

  if (!table) {
    throw new Error(`Activité dépôt inconnue : ${activity}`);
  }

  if (typeof createAccountingEntry !== "function") {
    throw new Error(
      "createAccountingEntry indisponible pour l'affectation automatique."
    );
  }

  const { rows: invoiceRows } = await client.query(
    `SELECT
       id,
       customer_id,
       invoice_number,
       total_amount,
       paid_amount,
       remaining_amount,
       status
     FROM ${table}
     WHERE id=$1
       AND company_id=$2
     FOR UPDATE`,
    [invoiceId, companyId]
  );

  const invoice = invoiceRows[0];

  if (!invoice) {
    throw new Error(
      `Facture ${activity} ${invoiceId} introuvable.`
    );
  }

  /*
   * Une vente sans client identifié ne peut pas consommer
   * un dépôt client.
   */
  if (!invoice.customer_id) {
    return {
      invoice,
      totalAllocated: 0,
      allocations: [],
      reason: "NO_CUSTOMER",
    };
  }

  let remaining = T.francs(
    invoice.remaining_amount ??
    (
      T.francs(invoice.total_amount) -
      T.francs(invoice.paid_amount)
    )
  );

  if (remaining <= 0) {
    return {
      invoice,
      totalAllocated: 0,
      allocations: [],
      reason: "ALREADY_PAID",
    };
  }


  /*
   * Verrouillage FIFO.
   * Seuls les dépôts de :
   * - la même entreprise,
   * - la même activité,
   * - le même client
   * peuvent être utilisés.
   */
  const { rows: deposits } = await client.query(
    `SELECT *
     FROM client_deposits
     WHERE company_id=$1
       AND activity=$2
       AND customer_id=$3
       AND status='ACTIF'
       AND available_amount > 0
     ORDER BY business_date, id
     FOR UPDATE`,
    [
      companyId,
      activity,
      invoice.customer_id,
    ]
  );

  if (!deposits.length) {
    return {
      invoice,
      totalAllocated: 0,
      allocations: [],
      reason: "NO_DEPOSIT",
    };
  }

  const allocations = [];

  for (const deposit of deposits) {

    if (remaining <= 0) break;

    const available =
      T.francs(deposit.available_amount);

    const amount =
      Math.min(available, remaining);

    if (amount <= 0) continue;

    const after =
      available - amount;


    const { rows: allocationRows } =
      await client.query(
        `INSERT INTO client_deposit_allocations
           (
             company_id,
             deposit_id,
             activity,
             invoice_id,
             invoice_number,
             amount,
             available_before,
             available_after,
             reason,
             performed_by,
             performed_by_name
           )
         VALUES
           ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          companyId,
          deposit.id,
          activity,
          invoice.id,
          invoice.invoice_number || "",
          amount,
          available,
          after,
          "Affectation automatique à la validation de la facture",
          userId || null,
          userName || "Utilisateur",
        ]
      );

    const allocation =
      allocationRows[0];


    await client.query(
      `UPDATE client_deposits
       SET
         available_amount=$1::numeric,
         status=
           CASE
             WHEN $1::numeric <= 0
             THEN 'EPUISE'
             ELSE 'ACTIF'
           END,
         updated_at=NOW()
       WHERE id=$2`,
      [
        after,
        deposit.id,
      ]
    );


    /*
     * IMPORTANT :
     * aucune banque,
     * aucune caisse,
     * aucun deuxième encaissement.
     */
    await createAccountingEntry(client, {
      companyId,
      sourceType:
        "client_deposit_allocation",
      sourceId:
        allocation.id,
      accountLabel:
        "Avances reçues des clients",
      debit:
        amount,
      credit:
        0,
      description:
        `Imputation automatique dépôt ${deposit.reference} sur facture ${invoice.invoice_number || invoice.id}`,
      createdBy:
        userId || null,
    });


    await createAccountingEntry(client, {
      companyId,
      sourceType:
        "client_deposit_allocation",
      sourceId:
        allocation.id,
      accountLabel:
        "Créances clients",
      debit:
        0,
      credit:
        amount,
      description:
        `Imputation automatique dépôt ${deposit.reference} sur facture ${invoice.invoice_number || invoice.id}`,
      createdBy:
        userId || null,
    });


    allocations.push({
      allocation_id:
        allocation.id,

      deposit_id:
        deposit.id,

      deposit_reference:
        deposit.reference,

      amount,

      available_before:
        available,

      available_after:
        after,
    });

    remaining -= amount;
  }


  const totalAllocated =
    allocations.reduce(
      (sum, row) =>
        sum + T.francs(row.amount),
      0
    );


  /*
   * Aucun dépôt finalement utilisé :
   * on laisse la facture telle quelle.
   */
  if (totalAllocated <= 0) {
    return {
      invoice,
      totalAllocated: 0,
      allocations: [],
      reason: "NOTHING_ALLOCATED",
    };
  }


  const paid =
    Math.min(
      T.francs(invoice.total_amount),
      T.francs(invoice.paid_amount) +
      totalAllocated
    );

  const finalRemaining =
    Math.max(
      0,
      T.francs(invoice.total_amount) -
      paid
    );

  const status =
    finalRemaining <= 0
      ? "PAYEE"
      : paid > 0
        ? "PARTIELLEMENT_PAYEE"
        : "IMPAYEE";


  const { rows: updatedRows } =
    await client.query(
      `UPDATE ${table}
       SET
         paid_amount=$1::numeric,
         remaining_amount=$2::numeric,
         status=$3,
         updated_at=NOW()
       WHERE id=$4
         AND company_id=$5
       RETURNING *`,
      [
        paid,
        finalRemaining,
        status,
        invoice.id,
        companyId,
      ]
    );


  return {
    invoice:
      updatedRows[0],

    totalAllocated,

    allocations,

    depositRemaining:
      deposits.reduce(
        (sum, d) =>
          sum +
          Math.max(
            0,
            T.francs(d.available_amount) -
            (
              allocations.find(
                a => a.deposit_id === d.id
              )?.amount || 0
            )
          ),
        0
      ),

    reason:
      "ALLOCATED",
  };
}


module.exports = {
  autoAllocateClientDeposits,
};

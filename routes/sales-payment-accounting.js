"use strict";

/**
 * PHASE 3 — Encaissement d'une facture de vente vers la comptabilité.
 *
 * Logique PARTAGÉE entre Ciment et Sable : un seul chemin financier, aucune
 * duplication. Rien n'est écrit ici hors de la transaction passée par l'appelant
 * — le `client` reçu est déjà dans un BEGIN, donc un échec à n'importe quelle
 * étape annule TOUT (paiement, solde, transaction, écritures).
 *
 * Deux destinations possibles :
 *   BANQUE  -> accounting_banks.current_balance de l'entreprise ACTIVE
 *   ESPECES -> treasury_accounts.current_balance (trésorerie générale, jamais
 *              une caisse POS)
 *
 * Isolation : la banque est verrouillée ET filtrée par company_id. Une facture
 * FAT & MAT ne peut donc jamais alimenter une banque Triangle.
 */

const CASH_LABEL = "Trésorerie interne";

/* Banques actives de l'entreprise active — sert au sélecteur du modal comme à
   la validation serveur. Aucune donnée comptable au-delà du strict nécessaire. */
async function listActiveBanks(runner, companyId) {
  const { rows } = await runner.query(
    `SELECT id, bank_name, account_number, currency
       FROM accounting_banks
      WHERE company_id = $1 AND is_active = TRUE
      ORDER BY bank_name`,
    [companyId]
  );
  return rows;
}

/**
 * Encaisse un paiement déjà créé : déplace l'argent, écrit la transaction et
 * les écritures équilibrées, puis renvoie de quoi rattacher le tout.
 *
 * @returns {{transaction: object, destination: {type, bank_id, label}}}
 */
async function recordSalePaymentAccounting(client, {
  companyId,
  module,            // "cement" | "sand"
  payment,           // ligne cement_payments / sand_payments déjà insérée
  amount,
  invoiceNumber,
  partnerName,
  bankId,            // null => espèces
  userId,
  accounting,
}) {
  if (!accounting || typeof accounting.nextAccountingNumber !== "function"
      || typeof accounting.createAccountingEntry !== "function") {
    throw new Error("Helpers comptables absents : encaissement impossible.");
  }

  const isCement = module === "cement";
  const salesAccount = isCement ? "Ventes ciment" : "Ventes sable";
  const sourceType = isCement ? "cement_payment" : "sand_payment";

  let destinationLabel = CASH_LABEL;
  let destinationType = "CASH";

  if (bankId) {
    /* Verrou + filtre company_id : une banque d'une autre entreprise ou
       désactivée est simplement introuvable ici. */
    const bank = (await client.query(
      `SELECT * FROM accounting_banks
        WHERE id = $1 AND company_id = $2 AND is_active = TRUE
        FOR UPDATE`,
      [bankId, companyId]
    )).rows[0];
    if (!bank) {
      const err = new Error("Banque invalide ou inactive.");
      err.httpStatus = 400;
      err.code = "INVALID_BANK";
      throw err;
    }
    await client.query(
      `UPDATE accounting_banks
          SET current_balance = COALESCE(current_balance, 0) + $1,
              updated_at = CURRENT_TIMESTAMP,
              updated_by = $2
        WHERE id = $3 AND company_id = $4`,
      [amount, userId, bank.id, companyId]
    );
    destinationLabel = bank.bank_name;
    destinationType = "BANK";
  } else {
    // Trésorerie générale : créée à 0 si elle n'existe pas encore.
    await client.query(
      `INSERT INTO treasury_accounts (company_id, currency, initial_balance, current_balance, updated_by)
       SELECT $1, 'FCFA', 0, 0, $2
        WHERE NOT EXISTS (SELECT 1 FROM treasury_accounts WHERE company_id = $1)`,
      [companyId, userId]
    );
    await client.query(
      `UPDATE treasury_accounts
          SET current_balance = COALESCE(current_balance, 0) + $1,
              updated_by = $2, updated_at = NOW()
        WHERE company_id = $3`,
      [amount, userId, companyId]
    );
  }

  const transactionNumber = await accounting.nextAccountingNumber(
    client, "accounting_transactions", "transaction_number",
    isCement ? "ENC-CIM" : "ENC-SAB", companyId
  );

  const transaction = (await client.query(
    `INSERT INTO accounting_transactions
       (company_id, transaction_number, transaction_type, source_type, source_id,
        bank_id, caisse_id, amount, currency, direction, category, partner_name,
        description, status, source_label, destination_label,
        created_by, validated_by, validated_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,'FCFA','entrée',$8,$9,$10,'validé',$11,$12,
             $13,$13,CURRENT_TIMESTAMP,NOW(),NOW())
     RETURNING *`,
    [
      companyId, transactionNumber,
      isCement ? "encaissement_ciment" : "encaissement_sable",
      sourceType, payment.id,
      bankId || null, amount,
      isCement ? "Vente de ciment" : "Vente de sable",
      partnerName || null,
      `Encaissement facture ${invoiceNumber}`,
      isCement ? "Ciment" : "Sable",
      destinationLabel,
      userId,
    ]
  )).rows[0];

  // Deux écritures ÉQUILIBRÉES : l'argent entre, la vente est créditée.
  await accounting.createAccountingEntry(client, {
    companyId, sourceType, sourceId: payment.id,
    accountLabel: destinationLabel, debit: amount, credit: 0,
    description: `Encaissement facture ${invoiceNumber}`, createdBy: userId,
  });
  await accounting.createAccountingEntry(client, {
    companyId, sourceType, sourceId: payment.id,
    accountLabel: salesAccount, debit: 0, credit: amount,
    description: `Encaissement facture ${invoiceNumber}`, createdBy: userId,
  });

  return {
    transaction,
    destination: { type: destinationType, bank_id: bankId || null, label: destinationLabel },
  };
}

module.exports = { listActiveBanks, recordSalePaymentAccounting, CASH_LABEL };

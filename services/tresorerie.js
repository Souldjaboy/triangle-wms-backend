"use strict";

/**
 * UN SEUL CHEMIN POUR TOUT MOUVEMENT D'ARGENT.
 *
 * Avant ce service, chaque module refaisait la même séquence à sa façon :
 * verrouiller le compte, vérifier le solde, le mettre à jour, écrire la
 * transaction, écrire les deux écritures équilibrées. Cinq gestes recopiés
 * cinq fois, avec cinq occasions d'en oublier un — et c'est toujours le même
 * qu'on oublie : la seconde écriture, celle qui équilibre.
 *
 * Ce que ce service garantit à chaque appel :
 *
 *   • le compte est verrouillé (`FOR UPDATE`) avant lecture du solde, donc
 *     deux paiements simultanés ne peuvent pas passer tous les deux sur un
 *     solde qui ne suffisait que pour un ;
 *   • un débit qui dépasse le solde est refusé, avec le montant manquant ;
 *   • le solde ne bouge JAMAIS sans transaction ni écritures ;
 *   • les deux écritures sont écrites ensemble, débit et crédit égaux ;
 *   • rien n'est validé hors d'une transaction PostgreSQL — l'appelant fournit
 *     un `client` déjà en transaction, et un échec plus loin annule tout.
 *
 * Ce que ce service ne fait PAS : décider si l'opération est permise. Les
 * droits, les statuts métier et l'idempotence appartiennent à l'appelant.
 */

const COMPTES = Object.freeze({ BANQUE: "banque", CAISSE: "caisse", TRESORERIE: "tresorerie" });

function erreur(message, code, httpStatus, extra = {}) {
  const e = new Error(message);
  e.code = code; e.httpStatus = httpStatus;
  Object.assign(e, extra);
  return e;
}

/** Arrondi au franc : le FCFA n'a pas de centime, et un demi-franc traîné de
    calcul en calcul finit par faire diverger un solde d'un franc. */
const francs = (v) => Math.round(Number(v || 0));

/**
 * Le compte visé, verrouillé, sous une forme commune aux trois natures.
 * @returns {{type:string, id:number|null, solde:number, libelle:string}}
 */
async function chargerCompte(client, companyId, { bankId, caisseId }) {
  if (bankId) {
    const { rows } = await client.query(
      `SELECT id, bank_name, current_balance, is_active
         FROM accounting_banks WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [bankId, companyId]
    );
    if (!rows[0]) throw erreur("Banque introuvable dans cette société.", "BANK_NOT_FOUND", 404);
    if (rows[0].is_active === false) throw erreur("Cette banque est désactivée.", "BANK_INACTIVE", 409);
    return { type: COMPTES.BANQUE, id: rows[0].id, solde: francs(rows[0].current_balance), libelle: rows[0].bank_name || "Banque" };
  }

  if (caisseId) {
    const { rows } = await client.query(
      `SELECT id, nom_caisse, solde_actuel, actif
         FROM caisses WHERE id = $1 AND company_id = $2 FOR UPDATE`,
      [caisseId, companyId]
    );
    if (!rows[0]) throw erreur("Caisse introuvable dans cette société.", "CASHBOX_NOT_FOUND", 404);
    if (rows[0].actif === false) throw erreur("Cette caisse est fermée.", "CASHBOX_INACTIVE", 409);
    return { type: COMPTES.CAISSE, id: rows[0].id, solde: francs(rows[0].solde_actuel), libelle: rows[0].nom_caisse || "Caisse" };
  }

  const { rows } = await client.query(
    `SELECT id, current_balance FROM treasury_accounts WHERE company_id = $1 FOR UPDATE`,
    [companyId]
  );
  if (!rows[0]) throw erreur("Aucun compte de trésorerie pour cette société.", "TREASURY_NOT_FOUND", 404);
  return { type: COMPTES.TRESORERIE, id: rows[0].id, solde: francs(rows[0].current_balance), libelle: "Trésorerie" };
}

async function appliquerSolde(client, compte, delta, userId) {
  if (compte.type === COMPTES.BANQUE) {
    await client.query(
      `UPDATE accounting_banks SET current_balance = current_balance + $1, updated_by = $2, updated_at = now()
        WHERE id = $3`, [delta, userId || null, compte.id]);
  } else if (compte.type === COMPTES.CAISSE) {
    await client.query(
      `UPDATE caisses SET solde_actuel = solde_actuel + $1, updated_at = now() WHERE id = $2`,
      [delta, compte.id]);
  } else {
    await client.query(
      `UPDATE treasury_accounts SET current_balance = current_balance + $1, updated_by = $2, updated_at = now()
        WHERE id = $3`, [delta, userId || null, compte.id]);
  }
}

/**
 * Un mouvement d'argent, dans un sens ou dans l'autre.
 *
 * @param {object} p
 * @param {'sortie'|'entrée'} p.sens
 * @param {number} p.montant        toujours POSITIF ; c'est `sens` qui décide
 * @param {string} p.prefixe        préfixe du numéro (AVA, REMB-AVA, DEP…)
 * @param {string} p.typeOperation  `accounting_transactions.transaction_type`
 * @param {string} p.compteCharge   libellé du compte de contrepartie
 * @param {Function} p.nextAccountingNumber
 * @param {Function} p.createAccountingEntry
 */
async function mouvement(client, {
  companyId, sens, montant, bankId = null, caisseId = null,
  prefixe, typeOperation, sourceType, sourceId, description,
  compteCharge, partenaire = "", reference = "", userId = null,
  nextAccountingNumber, createAccountingEntry,
}) {
  const somme = francs(montant);
  if (!(somme > 0)) throw erreur("Le montant doit être supérieur à zéro.", "AMOUNT_INVALID", 400);
  if (sens !== "sortie" && sens !== "entrée") {
    throw erreur("Sens de mouvement invalide.", "DIRECTION_INVALID", 400);
  }

  const compte = await chargerCompte(client, companyId, { bankId, caisseId });

  if (sens === "sortie" && compte.solde < somme) {
    throw erreur(
      `Solde insuffisant sur ${compte.libelle} : ${compte.solde.toLocaleString("fr-FR")} FCFA disponibles, ${somme.toLocaleString("fr-FR")} demandés.`,
      "INSUFFICIENT_FUNDS", 409,
      { disponible: compte.solde, demande: somme, manquant: somme - compte.solde }
    );
  }

  await appliquerSolde(client, compte, sens === "sortie" ? -somme : somme, userId);

  const numero = await nextAccountingNumber(
    client, "accounting_transactions", "transaction_number", prefixe, companyId);

  const { rows: transactions } = await client.query(
    `INSERT INTO accounting_transactions
       (company_id, transaction_number, transaction_type, source_type, source_id,
        bank_id, caisse_id, amount, currency, direction, category, partner_name,
        description, status, source_label, destination_label, created_by, validated_by, validated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'FCFA',$9,$10,$11,$12,'validé',$13,$14,$15,$15,now())
     RETURNING *`,
    [companyId, numero, typeOperation, sourceType, sourceId,
     compte.type === COMPTES.BANQUE ? compte.id : null,
     compte.type === COMPTES.CAISSE ? compte.id : null,
     somme, sens, compteCharge, partenaire,
     `${description}${reference ? ` — réf. ${reference}` : ""}`,
     sens === "sortie" ? compte.libelle : compteCharge,
     sens === "sortie" ? compteCharge : compte.libelle,
     userId || null]
  );

  /* Les deux écritures partent ensemble. Une sortie débite la charge et
     crédite le compte ; une entrée fait l'inverse. Écrire l'une sans l'autre
     déséquilibrerait le journal sans que rien ne s'en plaigne. */
  await createAccountingEntry(client, {
    companyId, sourceType, sourceId,
    accountLabel: compteCharge,
    debit: sens === "sortie" ? somme : 0,
    credit: sens === "sortie" ? 0 : somme,
    description, createdBy: userId || null,
  });
  await createAccountingEntry(client, {
    companyId, sourceType, sourceId,
    accountLabel: compte.libelle,
    debit: sens === "sortie" ? 0 : somme,
    credit: sens === "sortie" ? somme : 0,
    description, createdBy: userId || null,
  });

  return {
    transaction: transactions[0],
    compte: { type: compte.type, id: compte.id, libelle: compte.libelle },
    solde_avant: compte.solde,
    solde_apres: sens === "sortie" ? compte.solde - somme : compte.solde + somme,
    montant: somme,
  };
}

const debiter  = (client, p) => mouvement(client, { ...p, sens: "sortie" });
const crediter = (client, p) => mouvement(client, { ...p, sens: "entrée" });

module.exports = { COMPTES, francs, erreur, chargerCompte, mouvement, debiter, crediter };

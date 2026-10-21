"use strict";

/**
 * TRANSFERT INTERNE DE FONDS — DÉPLACER N'EST NI ENCAISSER NI DÉPENSER.
 *
 * LE DÉFAUT CORRIGÉ
 *
 * Déplacer 5 000 000 FCFA de la banque BDM vers la caisse ne fait entrer ni
 * sortir un franc de l'entreprise : le total de ses fonds est identique avant
 * et après. Enregistré comme une sortie au départ et une entrée à l'arrivée,
 * le même argent gonfle les charges ET le chiffre d'affaires — et le bénéfice
 * du mois devient faux dans les deux sens à la fois, sans que rien ne le
 * signale.
 *
 * Les deux mouvements existent quand même : un solde qui bouge sans écriture
 * est intraçable. Ils portent simplement `show_in_financial_movements = FALSE`,
 * et les agrégats d'exploitation les ignorent.
 *
 * LES DEUX ÉCRITURES COMPTABLES, ELLES, S'ÉQUILIBRENT ENTRE LES DEUX COMPTES
 *
 * Un transfert débite le compte d'arrivée et crédite le compte de départ. Aucun
 * compte de charge ni de produit n'intervient — c'est un reclassement d'actif,
 * pas une opération d'exploitation. C'est précisément ce qui fait que le
 * résultat ne bouge pas.
 *
 * L'ORDRE DES VERROUS
 *
 * Deux transferts simultanés en sens inverse — banque → caisse et caisse →
 * banque — se bloqueraient mutuellement si chacun verrouillait d'abord sa
 * source. Les deux comptes sont donc verrouillés dans un ordre CANONIQUE,
 * indépendant du sens du transfert.
 */

const T = require("./tresorerie");

const KINDS = { BANQUE: "BANQUE", CAISSE: "CAISSE", TRESORERIE: "TRESORERIE" };
const STATUT = { ACTIF: "ACTIF", ANNULE: "ANNULE" };

const erreur = T.erreur;
const francs = T.francs;

/** La désignation d'un compte, telle que l'appelant la fournit. */
function normaliserCompte(c, role) {
  const kind = String(c?.kind || c?.type || "").toUpperCase();
  if (!KINDS[kind]) {
    throw erreur(`Nature de compte ${role} invalide : attendu BANQUE, CAISSE ou TRESORERIE.`,
      "ACCOUNT_KIND_INVALID", 400);
  }
  const id = kind === KINDS.TRESORERIE ? null : Number(c?.id || 0) || null;
  if (kind !== KINDS.TRESORERIE && !id) {
    throw erreur(`Identifiant du compte ${role} obligatoire.`, "ACCOUNT_ID_REQUIRED", 400);
  }
  return { kind, id };
}

/* L'ordre canonique : la nature d'abord, l'identifiant ensuite. Deux appels
   concurrents verrouillent donc dans la même séquence, quel que soit le sens
   du transfert. */
const rang = (c) => `${c.kind}#${String(c.id ?? 0).padStart(12, "0")}`;

/** Charge les deux comptes, verrouillés, dans l'ordre canonique. */
async function chargerLesDeux(client, companyId, source, destination) {
  const paires = [["source", source], ["destination", destination]]
    .sort((a, b) => (rang(a[1]) < rang(b[1]) ? -1 : 1));
  const charges = {};
  for (const [role, c] of paires) {
    charges[role] = await T.chargerCompte(client, companyId, {
      bankId: c.kind === KINDS.BANQUE ? c.id : null,
      caisseId: c.kind === KINDS.CAISSE ? c.id : null,
    });
  }
  return charges;
}

/** Une jambe du transfert : un mouvement de solde et sa transaction. */
async function jambe(client, {
  companyId, compte, sens, montant, reference, libelleContrepartie,
  typeOperation, transfertId, description, userId, dateOperation,
  nextAccountingNumber, reverseDe = null,
}) {
  /* `T.mouvement` n'est pas réutilisé ici : il écrit systématiquement une paire
     charge/compte, et c'est précisément ce qu'un transfert ne doit pas faire.
     Le verrouillage et le contrôle de solde, eux, viennent bien de `T`. */
  const numero = await nextAccountingNumber(
    client, "accounting_transactions", "transaction_number",
    sens === "sortie" ? "TRF-S" : "TRF-E", companyId);

  /* `source_id` est un integer et `internal_transfer_id` un bigint : un seul
     paramètre pour les deux et PostgreSQL refuse de deviner son type. */
  const { rows } = await client.query(
    `INSERT INTO accounting_transactions
       (company_id, transaction_number, transaction_type, source_type, source_id,
        bank_id, caisse_id, amount, currency, direction, category, partner_name,
        description, status, source_label, destination_label,
        operation_date, created_by, validated_by, validated_at,
        /* LE CŒUR DE LA CORRECTION : ces deux colonnes disent que ce mouvement
           déplace de l'argent sans l'encaisser ni le dépenser. */
        is_internal_transfer, show_in_financial_movements, internal_transfer_id,
        reverses_transaction_id)
     VALUES ($1,$2,$3,'internal_transfer',$4::int,$5::int,$6::int,$7::numeric,'FCFA',
             $8,'TRANSFERT_INTERNE','',$9,'validé',$10,$11,$12::date,$13::int,$13::int,
             now(),TRUE,FALSE,$14::bigint,$15::int)
     RETURNING *`,
    [companyId, numero, typeOperation, transfertId,
     compte.type === T.COMPTES.BANQUE ? compte.id : null,
     compte.type === T.COMPTES.CAISSE ? compte.id : null,
     montant, sens, description,
     sens === "sortie" ? compte.libelle : libelleContrepartie,
     sens === "sortie" ? libelleContrepartie : compte.libelle,
     dateOperation, userId || null, transfertId, reverseDe]
  );
  return rows[0];
}

/**
 * LE TRANSFERT.
 *
 * Atomique par construction : tout se passe dans la transaction du `client`
 * reçu. Soit les deux soldes bougent et les deux écritures existent, soit rien.
 */
async function transferer(client, {
  companyId, source, destination, montant, dateOperation = null,
  motif = "", utilisateur = null, nextAccountingNumber, createAccountingEntry,
}) {
  const somme = francs(montant);
  if (!(somme > 0)) throw erreur("Le montant doit être supérieur à zéro.", "AMOUNT_INVALID", 400);

  const s = normaliserCompte(source, "source");
  const d = normaliserCompte(destination, "destination");
  if (s.kind === d.kind && String(s.id ?? "") === String(d.id ?? "")) {
    throw erreur("La source et la destination sont le même compte : rien à déplacer.",
      "SAME_ACCOUNT", 400);
  }
  const raison = String(motif || "").trim();
  if (raison.length < 5) {
    throw erreur("Motif du transfert obligatoire (5 caractères minimum).", "REASON_REQUIRED", 400);
  }
  const jour = dateOperation && /^\d{4}-\d{2}-\d{2}$/.test(String(dateOperation))
    ? String(dateOperation) : new Date().toISOString().slice(0, 10);

  const { source: cs, destination: cd } = await chargerLesDeux(client, companyId, s, d);

  if (cs.solde < somme) {
    throw erreur(
      `Solde insuffisant sur ${cs.libelle} : ${cs.solde.toLocaleString("fr-FR")} FCFA `
      + `disponibles, ${somme.toLocaleString("fr-FR")} demandés.`,
      "INSUFFICIENT_FUNDS", 409,
      { disponible: cs.solde, demande: somme, manquant: somme - cs.solde });
  }

  const reference = await nextAccountingNumber(
    client, "internal_fund_transfers", "reference", "TRF", companyId);

  const { rows: creees } = await client.query(
    `INSERT INTO internal_fund_transfers
       (company_id, reference, transfer_date, amount,
        source_kind, source_id, source_label, source_balance_before, source_balance_after,
        destination_kind, destination_id, destination_label,
        destination_balance_before, destination_balance_after,
        status, reason, created_by, created_by_name)
     VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'ACTIF',$15,$16,$17)
     RETURNING *`,
    [companyId, reference, jour, somme,
     s.kind, s.id, cs.libelle, cs.solde, cs.solde - somme,
     d.kind, d.id, cd.libelle, cd.solde, cd.solde + somme,
     raison, utilisateur?.id || null, utilisateur?.name || utilisateur?.fullname || ""]
  );
  const transfert = creees[0];

  /* Les soldes. La source d'abord, pour que l'insuffisance se voie avant que
     la destination n'ait bougé — même si le contrôle ci-dessus l'a déjà vue. */
  await appliquer(client, cs, -somme, utilisateur?.id);
  await appliquer(client, cd, somme, utilisateur?.id);

  const description = `Transfert interne ${reference} : ${cs.libelle} → ${cd.libelle}`
    + `${raison ? ` — ${raison}` : ""}`;

  const sortie = await jambe(client, {
    companyId, compte: cs, sens: "sortie", montant: somme, reference,
    libelleContrepartie: cd.libelle, typeOperation: "transfert_interne_sortie",
    transfertId: transfert.id, description, userId: utilisateur?.id,
    dateOperation: jour, nextAccountingNumber,
  });
  const entree = await jambe(client, {
    companyId, compte: cd, sens: "entrée", montant: somme, reference,
    libelleContrepartie: cs.libelle, typeOperation: "transfert_interne_entree",
    transfertId: transfert.id, description, userId: utilisateur?.id,
    dateOperation: jour, nextAccountingNumber,
  });

  /* LES ÉCRITURES. Débit du compte d'arrivée, crédit du compte de départ :
     aucun compte de charge ni de produit, parce qu'il ne s'agit pas d'une
     opération d'exploitation. C'est ce qui fait que le résultat ne bouge pas. */
  if (typeof createAccountingEntry === "function") {
    await createAccountingEntry(client, {
      companyId, sourceType: "internal_transfer", sourceId: transfert.id,
      accountLabel: cd.libelle, debit: somme, credit: 0,
      description, createdBy: utilisateur?.id || null,
    });
    await createAccountingEntry(client, {
      companyId, sourceType: "internal_transfer", sourceId: transfert.id,
      accountLabel: cs.libelle, debit: 0, credit: somme,
      description, createdBy: utilisateur?.id || null,
    });
  }

  const { rows: finales } = await client.query(
    `UPDATE internal_fund_transfers
        SET debit_transaction_id = $1, credit_transaction_id = $2, updated_at = now()
      WHERE id = $3 RETURNING *`, [sortie.id, entree.id, transfert.id]);

  return {
    transfert: finales[0],
    sortie, entree,
    source: { ...cs, solde_avant: cs.solde, solde_apres: cs.solde - somme },
    destination: { ...cd, solde_avant: cd.solde, solde_apres: cd.solde + somme },
    montant: somme,
    /* Un transfert ne change pas le total des fonds : on le dit, et le test le
       vérifie. */
    variation_fonds_totaux: 0,
  };
}

async function appliquer(client, compte, delta, userId) {
  if (compte.type === T.COMPTES.BANQUE) {
    await client.query(
      `UPDATE accounting_banks SET current_balance = current_balance + $1,
              updated_by = $2, updated_at = now() WHERE id = $3`,
      [delta, userId || null, compte.id]);
  } else if (compte.type === T.COMPTES.CAISSE) {
    await client.query(
      `UPDATE caisses SET solde_actuel = solde_actuel + $1, updated_at = now() WHERE id = $2`,
      [delta, compte.id]);
  } else {
    await client.query(
      `UPDATE treasury_accounts SET current_balance = current_balance + $1,
              updated_by = $2, updated_at = now() WHERE id = $3`,
      [delta, userId || null, compte.id]);
  }
}

/**
 * ANNULER UN TRANSFERT — par contre-passation, jamais par effacement.
 *
 * Les deux mouvements d'origine restent. Deux mouvements inverses s'y ajoutent,
 * marqués comme contre-écritures de leurs jambes respectives, et les soldes
 * reviennent à ce qu'ils étaient. Quatre mouvements au total : c'est la seule
 * façon de pouvoir expliquer, six mois plus tard, pourquoi un solde a bougé
 * deux fois dans la même journée.
 */
async function annuler(client, {
  companyId, transfertId, motif = "", utilisateur = null,
  nextAccountingNumber, createAccountingEntry,
}) {
  const raison = String(motif || "").trim();
  if (raison.length < 10) {
    throw erreur("Motif d'annulation obligatoire (10 caractères minimum) : il restera attaché au transfert.",
      "REASON_REQUIRED", 400);
  }

  const { rows } = await client.query(
    `SELECT * FROM internal_fund_transfers
      WHERE id = $1 AND company_id = $2 FOR UPDATE`, [transfertId, companyId]);
  const t = rows[0];
  if (!t) throw erreur("Transfert introuvable dans cette société.", "TRANSFER_NOT_FOUND", 404);
  if (t.status === STATUT.ANNULE) {
    throw erreur(`Ce transfert est déjà annulé le ${new Date(t.cancelled_at).toLocaleDateString("fr-FR")}.`,
      "ALREADY_CANCELLED", 409);
  }

  const somme = francs(t.amount);
  const s = { kind: t.source_kind, id: t.source_id };
  const d = { kind: t.destination_kind, id: t.destination_id };
  const { source: cs, destination: cd } = await chargerLesDeux(client, companyId, s, d);

  /* L'argent revient de la destination vers la source : c'est la destination
     qui doit pouvoir le rendre. Si elle a été dépensée entre-temps, on refuse
     plutôt que de créer un solde négatif silencieux. */
  if (cd.solde < somme) {
    throw erreur(
      `Annulation impossible : ${cd.libelle} ne porte plus que `
      + `${cd.solde.toLocaleString("fr-FR")} FCFA, il en faudrait ${somme.toLocaleString("fr-FR")}. `
      + `Les fonds ont été utilisés depuis le transfert.`,
      "INSUFFICIENT_FUNDS_FOR_REVERSAL", 409,
      { disponible: cd.solde, requis: somme });
  }

  await appliquer(client, cd, -somme, utilisateur?.id);
  await appliquer(client, cs, somme, utilisateur?.id);

  const description = `Annulation du transfert ${t.reference} — ${raison}`;
  const contreSortie = await jambe(client, {
    companyId, compte: cd, sens: "sortie", montant: somme, reference: t.reference,
    libelleContrepartie: cs.libelle, typeOperation: "annulation_transfert_sortie",
    transfertId: t.id, description, userId: utilisateur?.id,
    dateOperation: new Date().toISOString().slice(0, 10), nextAccountingNumber,
    reverseDe: t.credit_transaction_id,
  });
  const contreEntree = await jambe(client, {
    companyId, compte: cs, sens: "entrée", montant: somme, reference: t.reference,
    libelleContrepartie: cd.libelle, typeOperation: "annulation_transfert_entree",
    transfertId: t.id, description, userId: utilisateur?.id,
    dateOperation: new Date().toISOString().slice(0, 10), nextAccountingNumber,
    reverseDe: t.debit_transaction_id,
  });

  if (typeof createAccountingEntry === "function") {
    await createAccountingEntry(client, {
      companyId, sourceType: "internal_transfer_reversal", sourceId: t.id,
      accountLabel: cs.libelle, debit: somme, credit: 0,
      description, createdBy: utilisateur?.id || null,
    });
    await createAccountingEntry(client, {
      companyId, sourceType: "internal_transfer_reversal", sourceId: t.id,
      accountLabel: cd.libelle, debit: 0, credit: somme,
      description, createdBy: utilisateur?.id || null,
    });
  }

  /* Les jambes d'origine portent la marque de leur annulation : on les lit
     telles quelles dans un journal, sans avoir à chercher la contre-écriture. */
  await client.query(
    `UPDATE accounting_transactions
        SET cancelled_at = now(), cancelled_by = $1, cancel_reason = $2, updated_at = now()
      WHERE company_id = $3 AND id = ANY($4::int[])`,
    [utilisateur?.id || null, raison, companyId,
     [t.debit_transaction_id, t.credit_transaction_id].filter(Boolean)]);

  const { rows: finales } = await client.query(
    `UPDATE internal_fund_transfers
        SET status = 'ANNULE', cancelled_by = $1, cancelled_by_name = $2,
            cancelled_at = now(), cancel_reason = $3,
            reversal_debit_transaction_id = $4, reversal_credit_transaction_id = $5,
            updated_at = now()
      WHERE id = $6 RETURNING *`,
    [utilisateur?.id || null, utilisateur?.name || utilisateur?.fullname || "",
     raison, contreSortie.id, contreEntree.id, t.id]);

  return {
    transfert: finales[0], contreSortie, contreEntree,
    source: { ...cs, solde_apres: cs.solde + somme },
    destination: { ...cd, solde_apres: cd.solde - somme },
    montant: somme, variation_fonds_totaux: 0,
  };
}

/** Le total des fonds d'une société, toutes natures confondues. */
async function fondsTotaux(runner, companyId) {
  const { rows } = await runner.query(
    `SELECT COALESCE((SELECT SUM(current_balance) FROM accounting_banks WHERE company_id = $1), 0)
          + COALESCE((SELECT SUM(solde_actuel) FROM caisses WHERE company_id = $1), 0)
          + COALESCE((SELECT SUM(current_balance) FROM treasury_accounts WHERE company_id = $1), 0)
            AS total`, [companyId]);
  return francs(rows[0].total);
}

module.exports = { KINDS, STATUT, transferer, annuler, fondsTotaux, normaliserCompte };

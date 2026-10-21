"use strict";

/**
 * CORRIGER UN BON D'ENCAISSEMENT OU DE DÉCAISSEMENT.
 *
 * Un bon validé a déplacé de l'argent. Le corriger ne peut donc pas vouloir
 * dire le réécrire : le solde, la transaction et les deux écritures existent
 * déjà, et personne ne pourrait plus expliquer l'écart.
 *
 * D'où deux gestes, et un seul est libre :
 *
 *   • AVANT validation, le bon n'a rien produit. On le modifie, et chaque
 *     champ touché laisse sa valeur d'avant dans l'historique, avec un motif.
 *   • APRÈS validation, on CONTRE-PASSE. Les écritures d'origine restent et
 *     portent la marque de leur annulation ; des écritures inverses s'y
 *     ajoutent ; le solde revient. Le bon passe ANNULÉ, pas « supprimé ».
 *
 * Ce que cela ferme : un bon validé puis « refusé » laissait l'argent déplacé
 * et le bon marqué refusé. La dépense pesait toujours sur le résultat, et
 * aucun écran ne la montrait comme active.
 */

const T = require("./tresorerie");

const STATUTS = Object.freeze({
  BROUILLON: "brouillon", SOUMIS: "soumis", VALIDE: "validé",
  REFUSE: "refusé", ANNULE: "annulé",
});
/* Les seuls états où un bon n'a encore rien produit. */
const MODIFIABLES = [STATUTS.BROUILLON, STATUTS.SOUMIS];

const erreur = T.erreur;
const francs = T.francs;

/* Les champs qu'une modification peut toucher. `voucher_type` n'en fait pas
   partie : changer un encaissement en décaissement n'est pas une correction,
   c'est un autre bon. */
const CHAMPS = Object.freeze({
  amount:           { libelle: "Montant", nombre: true },
  origin:           { libelle: "Origine" },
  beneficiary:      { libelle: "Bénéficiaire" },
  bank_id:          { libelle: "Banque", identifiant: true },
  caisse_id:        { libelle: "Caisse", identifiant: true },
  partner_name:     { libelle: "Partenaire" },
  reason:           { libelle: "Motif du bon" },
  expense_category: { libelle: "Catégorie" },
  description:      { libelle: "Description" },
});

const nomDe = (u) => u?.name || u?.fullname || "Utilisateur";

async function charger(client, companyId, bonId, { verrou = false } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM cash_vouchers WHERE id = $1 AND company_id = $2${verrou ? " FOR UPDATE" : ""}`,
    [bonId, companyId]);
  if (!rows[0]) throw erreur("Bon introuvable dans cette société.", "VOUCHER_NOT_FOUND", 404);
  return rows[0];
}

async function journaliser(client, bon, {
  action, changes = {}, reason = "", statutAvant = null, statutApres = null,
  montantAvant = null, montantApres = null, utilisateur = null,
}) {
  await client.query(
    `INSERT INTO cash_voucher_history
       (company_id, voucher_id, action, changes, reason, status_before, status_after,
        amount_before, amount_after, acted_by, acted_by_name)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11)`,
    [bon.company_id, bon.id, action, JSON.stringify(changes), reason,
     statutAvant, statutApres, montantAvant, montantApres,
     utilisateur?.id || null, nomDe(utilisateur)]);
}

/**
 * MODIFIER UN BON QUI N'A RIEN PRODUIT.
 *
 * Refuse dès que le bon a été validé : à ce stade, la correction s'appelle une
 * contre-passation, et le message le dit plutôt que de laisser croire à un
 * problème de droits.
 */
async function modifier(client, { companyId, bonId, modifications = {}, motif = "", utilisateur = null }) {
  const bon = await charger(client, companyId, bonId, { verrou: true });

  if (bon.status === STATUTS.VALIDE) {
    throw erreur(
      `Le bon ${bon.voucher_number} est validé : l'argent a déjà bougé. `
      + `Pour le corriger, annulez-le — la contre-passation remettra le solde `
      + `et conservera les écritures d'origine.`,
      "VOUCHER_ALREADY_VALIDATED", 409, { statut: bon.status });
  }
  if (bon.status === STATUTS.ANNULE) {
    throw erreur(`Le bon ${bon.voucher_number} est annulé : il ne se modifie plus.`,
      "VOUCHER_CANCELLED", 409);
  }
  if (!MODIFIABLES.includes(bon.status) && bon.status !== STATUTS.REFUSE) {
    throw erreur(`État « ${bon.status} » : ce bon ne peut pas être modifié.`,
      "VOUCHER_NOT_EDITABLE", 409);
  }

  const raison = String(motif || "").trim();
  if (raison.length < 5) {
    throw erreur("Un motif de modification est obligatoire (5 caractères minimum).",
      "REASON_REQUIRED", 400);
  }

  /* Ce qui change VRAIMENT. Un champ renvoyé identique par un formulaire ne
     doit pas apparaître dans l'historique : il le noierait. */
  const changes = {};
  const colonnes = [];
  const valeurs = [];
  for (const [champ, regle] of Object.entries(CHAMPS)) {
    if (!(champ in modifications)) continue;
    let nouvelle = modifications[champ];
    if (regle.nombre) {
      nouvelle = francs(nouvelle);
      if (!(nouvelle > 0)) {
        throw erreur("Le montant doit être supérieur à zéro.", "AMOUNT_INVALID", 400);
      }
    } else if (regle.identifiant) {
      nouvelle = Number(nouvelle) || null;
    } else {
      nouvelle = String(nouvelle ?? "");
    }
    const ancienne = regle.nombre ? francs(bon[champ])
      : regle.identifiant ? (bon[champ] === null ? null : Number(bon[champ]))
      : String(bon[champ] ?? "");
    if (String(ancienne) === String(nouvelle)) continue;
    changes[champ] = { libelle: regle.libelle, avant: ancienne, apres: nouvelle };
    valeurs.push(nouvelle);
    colonnes.push(`${champ} = $${valeurs.length}`);
  }

  if (!colonnes.length) {
    throw erreur("Aucune modification : les valeurs envoyées sont identiques.",
      "NOTHING_TO_CHANGE", 400);
  }

  /* Un bon ne peut pas viser à la fois une banque et une caisse : le solde
     bougerait d'un côté et l'écriture de l'autre. */
  const banqueFinale = "bank_id" in changes ? changes.bank_id.apres : bon.bank_id;
  const caisseFinale = "caisse_id" in changes ? changes.caisse_id.apres : bon.caisse_id;
  if (banqueFinale && caisseFinale) {
    throw erreur("Un bon vise une banque OU une caisse, pas les deux.",
      "ACCOUNT_AMBIGUOUS", 400);
  }

  valeurs.push(utilisateur?.id || null, bon.id);
  const { rows } = await client.query(
    `UPDATE cash_vouchers SET ${colonnes.join(", ")},
            updated_by = $${valeurs.length - 1}, updated_at = now()
      WHERE id = $${valeurs.length} RETURNING *`, valeurs);

  await journaliser(client, bon, {
    action: "MODIFICATION", changes, reason: raison,
    statutAvant: bon.status, statutApres: rows[0].status,
    montantAvant: francs(bon.amount), montantApres: francs(rows[0].amount),
    utilisateur,
  });

  return { bon: rows[0], changes };
}

/** Le compte que ce bon fait bouger, verrouillé. */
const compteDu = (client, bon) => T.chargerCompte(client, bon.company_id, {
  bankId: bon.bank_id || null, caisseId: bon.caisse_id || null,
});

/**
 * CONTRE-PASSER UN BON VALIDÉ.
 *
 * La transaction d'origine est retrouvée par son origine (source_type +
 * source_id) et non par une colonne ajoutée récemment : les bons validés
 * avant cette migration doivent pouvoir être annulés eux aussi.
 */
async function annuler(client, {
  companyId, bonId, motif = "", utilisateur = null,
  nextAccountingNumber, createJournalEntry,
}) {
  const raison = String(motif || "").trim();
  if (raison.length < 10) {
    throw erreur("Motif d'annulation obligatoire (10 caractères minimum) : il restera attaché au bon.",
      "REASON_REQUIRED", 400);
  }

  const bon = await charger(client, companyId, bonId, { verrou: true });
  if (bon.status === STATUTS.ANNULE) {
    throw erreur(`Le bon ${bon.voucher_number} est déjà annulé.`, "ALREADY_CANCELLED", 409);
  }
  if (bon.status !== STATUTS.VALIDE) {
    throw erreur(
      `Le bon ${bon.voucher_number} n'est pas validé (état « ${bon.status} ») : `
      + `il n'a déplacé aucun argent, il n'y a rien à contre-passer. Modifiez-le ou refusez-le.`,
      "VOUCHER_NOT_VALIDATED", 409, { statut: bon.status });
  }

  const montant = francs(bon.amount);
  const sensOrigine = bon.voucher_type === "encaissement" ? "entrée" : "sortie";
  /* L'inverse : un encaissement annulé fait ressortir l'argent, un
     décaissement annulé le fait rentrer. */
  const sensInverse = sensOrigine === "entrée" ? "sortie" : "entrée";

  const compte = await compteDu(client, bon);

  /* Annuler un encaissement reprend l'argent au compte : s'il n'y est plus,
     on refuse plutôt que de creuser un solde négatif en silence. */
  if (sensInverse === "sortie" && compte.solde < montant) {
    throw erreur(
      `Annulation impossible : ${compte.libelle} ne porte plus que `
      + `${compte.solde.toLocaleString("fr-FR")} FCFA, il en faudrait `
      + `${montant.toLocaleString("fr-FR")}. Les fonds ont été utilisés depuis la validation.`,
      "INSUFFICIENT_FUNDS_FOR_REVERSAL", 409,
      { disponible: compte.solde, requis: montant });
  }

  await appliquerSolde(client, compte, sensInverse === "entrée" ? montant : -montant, utilisateur?.id);

  /* La transaction d'origine : par son origine, pour que les bons antérieurs
     à cette migration soient traités comme les autres. */
  const { rows: origines } = await client.query(
    `SELECT * FROM accounting_transactions
      WHERE company_id = $1 AND source_type = 'cash_voucher' AND source_id = $2
        AND cancelled_at IS NULL AND is_internal_transfer = FALSE
      ORDER BY id LIMIT 1`, [companyId, bon.id]);
  const origine = origines[0] || null;

  const numero = await nextAccountingNumber(
    client, "accounting_transactions", "transaction_number",
    bon.voucher_type === "encaissement" ? "ANN-ENC" : "ANN-DEC", companyId);
  const description = `Annulation du bon ${bon.voucher_number} — ${raison}`;

  const { rows: contre } = await client.query(
    `INSERT INTO accounting_transactions
       (company_id, transaction_number, transaction_type, source_type, source_id,
        bank_id, caisse_id, amount, currency, direction, category, partner_id, partner_name,
        description, status, source_label, destination_label, operation_date,
        created_by, validated_by, validated_at, reverses_transaction_id)
     VALUES ($1,$2,$3,'cash_voucher_reversal',$4::int,$5::int,$6::int,$7::numeric,'FCFA',
             $8,$9,$10::int,$11,$12,'validé',$13,$14,CURRENT_DATE,$15::int,$15::int,now(),$16::int)
     RETURNING *`,
    [companyId, numero,
     bon.voucher_type === "encaissement" ? "annulation_encaissement" : "annulation_decaissement",
     bon.id, bon.bank_id || null, bon.caisse_id || null, montant, sensInverse,
     bon.expense_category || "", bon.partner_id || null, bon.partner_name || "",
     description,
     sensInverse === "sortie" ? compte.libelle : (bon.origin || "Annulation"),
     sensInverse === "sortie" ? (bon.beneficiary || "Annulation") : compte.libelle,
     utilisateur?.id || null, origine?.id || null]);

  /* La transaction d'origine porte la marque de son annulation : un journal se
     lit alors sans avoir à chercher la contre-écriture. */
  if (origine) {
    await client.query(
      `UPDATE accounting_transactions
          SET cancelled_at = now(), cancelled_by = $1, cancel_reason = $2, updated_at = now()
        WHERE id = $3`, [utilisateur?.id || null, raison, origine.id]);
  }

  /* Les écritures inverses : les mêmes comptes, débit et crédit échangés. */
  if (typeof createJournalEntry === "function") {
    const compteTresorerie = {
      account_code: bon.bank_id ? "52" : "57",
      account_name: bon.bank_id ? "Banque" : "Caisse",
      bank_id: bon.bank_id || null, caisse_id: bon.caisse_id || null,
    };
    const contrepartie = bon.voucher_type === "encaissement"
      ? { account_code: "75", account_name: "Autres produits", partner_id: bon.partner_id || null }
      : {
          account_code: bon.expense_category === "achat" ? "60" : "65",
          account_name: bon.expense_category === "achat" ? "Achats" : "Autres charges",
          partner_id: bon.partner_id || null,
        };
    await createJournalEntry(client, {
      companyId, label: description, moduleSource: "cash_voucher_reversal", sourceId: bon.id,
      lines: bon.voucher_type === "encaissement"
        /* L'encaissement avait débité le compte et crédité le produit :
           l'inverse crédite le compte et débite le produit. */
        ? [{ ...contrepartie, debit: montant, credit: 0 },
           { ...compteTresorerie, debit: 0, credit: montant }]
        : [{ ...compteTresorerie, debit: montant, credit: 0 },
           { ...contrepartie, debit: 0, credit: montant }],
      createdBy: utilisateur?.id || null,
    });
  }

  const { rows: finales } = await client.query(
    `UPDATE cash_vouchers
        SET status = 'annulé', cancelled_at = now(), cancelled_by = $1,
            cancelled_by_name = $2, cancel_reason = $3,
            transaction_id = COALESCE(transaction_id, $4),
            reversal_transaction_id = $5, updated_by = $1, updated_at = now()
      WHERE id = $6 RETURNING *`,
    [utilisateur?.id || null, nomDe(utilisateur), raison,
     origine?.id || null, contre[0].id, bon.id]);

  await journaliser(client, bon, {
    action: "ANNULATION", reason: raison,
    statutAvant: bon.status, statutApres: STATUTS.ANNULE,
    montantAvant: montant, montantApres: montant,
    changes: {
      contre_passation: {
        libelle: "Contre-passation",
        transaction_origine: origine?.transaction_number || null,
        transaction_inverse: contre[0].transaction_number,
        compte: compte.libelle,
        solde_avant: compte.solde,
        solde_apres: sensInverse === "entrée" ? compte.solde + montant : compte.solde - montant,
      },
    },
    utilisateur,
  });

  return {
    bon: finales[0], origine, contrepassation: contre[0],
    compte: {
      ...compte,
      solde_apres: sensInverse === "entrée" ? compte.solde + montant : compte.solde - montant,
    },
    montant,
    /* Dit explicitement ce qui n'a PAS eu lieu : aucune instruction bancaire. */
    nature: "Contre-passation comptable. Aucun remboursement bancaire n'a été demandé.",
  };
}

async function appliquerSolde(client, compte, delta, userId) {
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

/** L'historique d'un bon, du plus récent au plus ancien. */
async function historique(runner, companyId, bonId) {
  const { rows } = await runner.query(
    `SELECT h.*, u.fullname AS auteur
       FROM cash_voucher_history h
       LEFT JOIN users u ON u.id = h.acted_by
      WHERE h.company_id = $1 AND h.voucher_id = $2
      ORDER BY h.acted_at DESC, h.id DESC`, [companyId, bonId]);
  return rows;
}

module.exports = { STATUTS, MODIFIABLES, CHAMPS, modifier, annuler, historique, journaliser, charger };

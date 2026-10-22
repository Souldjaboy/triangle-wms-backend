"use strict";

/**
 * LES FACTURES QUI SE RESSEMBLENT.
 *
 * DEUX FACTURES DU MÊME CLIENT, DU MÊME MONTANT, NE SONT PAS UN DOUBLON.
 * C'est le point de départ de tout ce fichier. Un client qui loue un camion
 * au mois reçoit douze factures identiques par an ; les annuler parce
 * qu'elles se ressemblent ferait disparaître onze créances réelles.
 *
 * À l'inverse, deux factures émises pour LA MÊME VENTE réclament deux fois le
 * même travail, et le client paie double s'il ne s'en aperçoit pas.
 *
 * Rien, dans un montant et une date, ne permet de trancher à coup sûr. Ce
 * module ne tranche donc pas : il RASSEMBLE LES SIGNAUX et les présente. Une
 * personne décide, et sa décision est conservée — pour qu'une paire examinée
 * ne revienne pas à chaque passage.
 *
 * LES SIGNAUX, ET CE QU'ILS VALENT
 *
 *   MEME_VENTE          décisif. Deux factures pour une seule vente sont un
 *                       doublon technique, sauf remplacement explicite.
 *   MEME_REFERENCE      presque décisif : la même référence d'opération.
 *   SERIE_REGULIERE     fort dans l'autre sens. Trois factures ou plus, même
 *                       client, même montant, à intervalles réguliers : c'est
 *                       un abonnement, pas une erreur de saisie.
 *   MEME_JOUR           suspect. Deux factures identiques le même jour
 *                       s'expliquent rarement autrement que par un double clic.
 *   ECART_UN_MOIS       en faveur du renouvellement.
 *   LIVRAISONS_DISTINCTES  en faveur de deux factures légitimes : deux
 *                       livraisons, deux prestations.
 *   PAIEMENTS_DES_DEUX_COTES  les deux ont été réglées : si c'est un doublon,
 *                       le client a payé deux fois et il faut le rembourser.
 *                       Jamais une neutralisation silencieuse.
 *
 * NEUTRALISER N'EST PAS SUPPRIMER. La facture reste, annulée, désignant celle
 * qui fait foi ; ses encaissements sont déplacés vers elle par la
 * réaffectation (aucune écriture nouvelle, aucun second encaissement).
 */

const S = require("./soldes-factures");
const R = require("./reaffectation-paiements");

const erreur = R.erreur;
const nomDe = (u) => u?.name || u?.fullname || "Utilisateur";
const francs = (v) => Math.round(Number(v || 0));

const VERDICTS = Object.freeze({
  A_EXAMINER: "A_EXAMINER",
  DOUBLON_CONFIRME: "DOUBLON_CONFIRME",
  RENOUVELLEMENT: "RENOUVELLEMENT",
  FACTURES_DISTINCTES: "FACTURES_DISTINCTES",
});

const SIGNAUX = Object.freeze({
  MEME_VENTE: "Les deux factures portent sur la même vente",
  MEME_REFERENCE: "Même référence d'opération",
  MEME_JOUR: "Émises le même jour",
  ECART_UN_MOIS: "Séparées d'environ un mois",
  SERIE_REGULIERE: "Font partie d'une série régulière (abonnement probable)",
  LIVRAISONS_DISTINCTES: "Rattachées à deux livraisons différentes",
  PAIEMENTS_DES_DEUX_COTES: "Les deux ont reçu des encaissements",
  UNE_SEULE_PAYEE: "Une seule des deux a été réglée",
  AUCUNE_PAYEE: "Aucune des deux n'a été réglée",
  UNE_IMPRIMEE: "Une seule des deux a été imprimée",
});

/* Les tables, par produit. Le même raccourci que partout ailleurs. */
const CLIENTS = Object.freeze({ SABLE: "sand_customers", CIMENT: "cement_customers" });

const jour = (d) => {
  if (!d) return null;
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
         + `-${String(d.getDate()).padStart(2, "0")}`;
  }
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : null;
};
const ecartJours = (a, b) => {
  const x = jour(a), y = jour(b);
  if (!x || !y) return null;
  return Math.abs(Math.round((new Date(y) - new Date(x)) / 86400000));
};

/**
 * Les paires de factures qui se ressemblent, avec leurs signaux.
 *
 * Ne renvoie QUE ce qui n'a pas encore été tranché : une paire déclarée
 * « renouvellement » ne doit plus remonter, sinon la liste de suspects
 * réapparaît à chaque passage et personne ne la lit plus.
 */
async function paquetsSuspects(client, { companyId, product, inclureTranchees = false, limite = 200 }) {
  const p = S.produitDe(product);

  const { rows: factures } = await client.query(
    `SELECT i.id, i.invoice_number, i.invoice_date, i.total_amount, i.paid_amount,
            i.remaining_amount, i.status, i.customer_id, i.sale_id,
            i.operation_reference, i.destination,
            COALESCE(c.name,'') AS client_name,
            i.duplicate_of_invoice_id,
            (SELECT count(*)::int FROM ${p.paiements} pay
              WHERE pay.company_id = i.company_id AND pay.invoice_id = i.id) AS nb_paiements,
            (SELECT COALESCE(sum(pay.amount),0) FROM ${p.paiements} pay
              WHERE pay.company_id = i.company_id AND pay.invoice_id = i.id) AS encaisse
       FROM ${p.factures} i
       LEFT JOIN ${CLIENTS[p.cle]} c ON c.id = i.customer_id AND c.company_id = i.company_id
      WHERE i.company_id = $1
        AND i.status <> 'ANNULEE'
        AND i.neutralized_at IS NULL
      ORDER BY i.invoice_date NULLS LAST, i.id`,
    [companyId]);

  const { rows: tranchees } = await client.query(
    `SELECT invoice_a_id, invoice_b_id, verdict, verdict_reason, decided_by_name, decided_at
       FROM v_paires_tranchees WHERE company_id = $1 AND product = $2`,
    [companyId, p.cle]);
  const dejaVue = new Map(tranchees.map((t) => [`${t.invoice_a_id}-${t.invoice_b_id}`, t]));

  /* Regroupement par client et montant : c'est la ressemblance de départ.
     Tout le reste sert à la DÉFAIRE, pas à la confirmer. */
  const groupes = new Map();
  for (const f of factures) {
    const cle = `${f.customer_id || f.client_name || "?"}#${francs(f.total_amount)}`;
    if (!groupes.has(cle)) groupes.set(cle, []);
    groupes.get(cle).push(f);
  }

  const paires = [];
  for (const [, groupe] of groupes) {
    if (groupe.length < 2) continue;

    /* Une série régulière se juge sur le GROUPE entier, pas sur une paire :
       trois factures à un mois d'intervalle, c'est un abonnement ; deux
       seulement, on ne peut rien en dire. */
    const dates = groupe.map((f) => jour(f.invoice_date)).filter(Boolean).sort();
    let serieReguliere = false;
    if (dates.length >= 3) {
      const ecarts = [];
      for (let i = 1; i < dates.length; i += 1) ecarts.push(ecartJours(dates[i - 1], dates[i]));
      const moyenne = ecarts.reduce((a, b) => a + b, 0) / ecarts.length;
      /* Des intervalles proches les uns des autres, et d'au moins trois
         semaines : mensuel, bimensuel, trimestriel. */
      serieReguliere = moyenne >= 21 && ecarts.every((e) => Math.abs(e - moyenne) <= 5);
    }

    /* Dans une SÉRIE RÉGULIÈRE, on ne compare que les factures CONSÉCUTIVES.
       Quatre factures mensuelles donnent six paires si on les croise toutes,
       et la liste de suspects devient illisible pour un abonnement qui n'a
       rien d'anormal. Trois paires consécutives suffisent à le montrer. */
    const ordonne = [...groupe].sort((x, y) =>
      new Date(jour(x.invoice_date) || 0) - new Date(jour(y.invoice_date) || 0));
    const aComparer = serieReguliere
      ? ordonne.slice(0, -1).map((f, k) => [f, ordonne[k + 1]])
      : ordonne.flatMap((f, k) => ordonne.slice(k + 1).map((g) => [f, g]));

    for (const couple of aComparer) {
      {
        const [a, b] = [...couple].sort((x, y) => Number(x.id) - Number(y.id));
        const cle = `${a.id}-${b.id}`;
        const verdictRendu = dejaVue.get(cle);
        if (verdictRendu && !inclureTranchees) continue;

        const ecart = ecartJours(a.invoice_date, b.invoice_date);
        const signaux = [];
        if (a.sale_id && b.sale_id && Number(a.sale_id) === Number(b.sale_id)) signaux.push("MEME_VENTE");
        if (a.operation_reference && a.operation_reference === b.operation_reference) signaux.push("MEME_REFERENCE");
        if (ecart === 0) signaux.push("MEME_JOUR");
        if (ecart !== null && ecart >= 26 && ecart <= 35) signaux.push("ECART_UN_MOIS");
        if (serieReguliere) signaux.push("SERIE_REGULIERE");
        /* Deux ventes différentes ne prouvent une prestation différente que
           si les factures ne sont pas du même jour : saisir deux fois la même
           livraison crée bel et bien deux ventes. */
        if (a.sale_id && b.sale_id && Number(a.sale_id) !== Number(b.sale_id)
            && ecart !== null && ecart >= 2) {
          signaux.push("LIVRAISONS_DISTINCTES");
        }
        if (a.nb_paiements > 0 && b.nb_paiements > 0) signaux.push("PAIEMENTS_DES_DEUX_COTES");
        else if (a.nb_paiements > 0 || b.nb_paiements > 0) signaux.push("UNE_SEULE_PAYEE");
        else signaux.push("AUCUNE_PAYEE");

        paires.push({
          cle,
          a: resume(a), b: resume(b),
          client: a.client_name || b.client_name,
          montant: francs(a.total_amount),
          ecart_jours: ecart,
          signaux,
          /* Une SUGGESTION, pas une décision. Elle sert à ordonner la liste,
             et l'écran doit le dire en toutes lettres. */
          suggestion: suggerer(signaux),
          verdict_rendu: verdictRendu || null,
        });
      }
    }
  }

  /* Les cas les plus nets d'abord : c'est par eux qu'on veut commencer. */
  const poids = { DOUBLON_CONFIRME: 0, A_EXAMINER: 1, RENOUVELLEMENT: 2, FACTURES_DISTINCTES: 3 };
  paires.sort((x, y) => (poids[x.suggestion] ?? 1) - (poids[y.suggestion] ?? 1));
  return paires.slice(0, limite);
}

const resume = (f) => ({
  id: Number(f.id), numero: f.invoice_number, date: jour(f.invoice_date),
  montant: francs(f.total_amount), paye: francs(f.paid_amount),
  restant: francs(f.remaining_amount), statut: f.status,
  vente_id: f.sale_id ? Number(f.sale_id) : null,
  reference_operation: f.operation_reference || "",
  nb_paiements: Number(f.nb_paiements || 0),
  encaisse: francs(f.encaisse),
});

/**
 * Ce que les signaux SUGGÈRENT. Jamais ce qu'ils décident.
 *
 * L'ordre compte : « même vente » l'emporte sur « série régulière », parce
 * qu'un abonnement n'émet pas deux factures pour la même vente.
 */
function suggerer(signaux) {
  if (signaux.includes("MEME_VENTE") || signaux.includes("MEME_REFERENCE")) {
    return VERDICTS.DOUBLON_CONFIRME;
  }
  /* « Même jour » passe AVANT « livraisons distinctes » : deux factures
     identiques émises le même jour pour le même client sont le double clic
     classique, et elles portent alors deux ventes différentes — c'est
     justement la trace de la double saisie, pas la preuve de deux
     prestations. L'ordre inverse faisait classer ces cas « distinctes ». */
  if (signaux.includes("MEME_JOUR")) return VERDICTS.DOUBLON_CONFIRME;
  if (signaux.includes("SERIE_REGULIERE")) return VERDICTS.RENOUVELLEMENT;
  if (signaux.includes("LIVRAISONS_DISTINCTES")) return VERDICTS.FACTURES_DISTINCTES;
  if (signaux.includes("ECART_UN_MOIS")) return VERDICTS.RENOUVELLEMENT;
  return VERDICTS.A_EXAMINER;
}

/* ─────────────────────────────────────────────────────────────────────────
   TRANCHER
   ───────────────────────────────────────────────────────────────────────── */
async function trancher(client, {
  companyId, product, factureA, factureB, verdict, motif, utilisateur,
}) {
  const p = S.produitDe(product);
  const v = String(verdict || "").toUpperCase();
  if (!VERDICTS[v] || v === VERDICTS.A_EXAMINER) {
    throw erreur(
      `Verdict attendu : ${["DOUBLON_CONFIRME", "RENOUVELLEMENT", "FACTURES_DISTINCTES"].join(", ")}.`,
      "VERDICT_INVALIDE", 400);
  }
  const m = String(motif || "").trim();
  if (m.length < 10) {
    throw erreur(
      "Motif obligatoire (10 caractères minimum) : c'est lui qui évitera de rouvrir ce dossier dans six mois.",
      "REASON_REQUIRED", 400);
  }

  const [idA, idB] = [Number(factureA), Number(factureB)].sort((x, y) => x - y);
  if (!idA || !idB || idA === idB) {
    throw erreur("Deux factures différentes sont attendues.", "PAIRE_INVALIDE", 400);
  }
  const a = await R.chargerFacture(client, { companyId, product, invoiceId: idA });
  const b = await R.chargerFacture(client, { companyId, product, invoiceId: idB });

  const ecart = ecartJours(a.invoice_date, b.invoice_date);
  const { rows } = await client.query(
    `INSERT INTO invoice_duplicate_reviews
       (company_id, product, invoice_a_id, invoice_a_number, invoice_b_id, invoice_b_number,
        client_name, amount, days_between, signals, verdict, verdict_reason,
        decided_by, decided_by_name, decided_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,now())
     ON CONFLICT (company_id, product, invoice_a_id, invoice_b_id) DO UPDATE
       SET verdict = EXCLUDED.verdict, verdict_reason = EXCLUDED.verdict_reason,
           decided_by = EXCLUDED.decided_by, decided_by_name = EXCLUDED.decided_by_name,
           decided_at = now(), updated_at = now()
     RETURNING *`,
    [companyId, p.cle, a.id, a.invoice_number, b.id, b.invoice_number,
      a.client_name || b.client_name || "", a.total_amount, ecart,
      JSON.stringify({ signaux: [], note: "verdict rendu à la main" }),
      v, m, utilisateur?.id || null, nomDe(utilisateur)]);
  return rows[0];
}

/* ─────────────────────────────────────────────────────────────────────────
   NEUTRALISER
   ───────────────────────────────────────────────────────────────────────── */
async function neutraliser(client, {
  companyId, examenId, conserver, motif, utilisateur, accepterPaiementsDesDeuxCotes = false,
}) {
  const m = String(motif || "").trim();
  if (m.length < 10) {
    throw erreur("Motif obligatoire (10 caractères minimum).", "REASON_REQUIRED", 400);
  }
  const { rows } = await client.query(
    `SELECT * FROM invoice_duplicate_reviews WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [examenId, companyId]);
  const examen = rows[0];
  if (!examen) throw erreur("Examen introuvable.", "REVIEW_NOT_FOUND", 404);
  if (examen.verdict !== VERDICTS.DOUBLON_CONFIRME) {
    throw erreur(
      `Cette paire est classée « ${examen.verdict.toLowerCase().replace(/_/g, " ")} » : on ne neutralise que ce qui a été confirmé doublon.`,
      "VERDICT_NON_DOUBLON", 409);
  }
  if (examen.neutralized_at) {
    throw erreur(
      `La facture ${examen.neutralized_invoice_id === Number(examen.invoice_a_id) ? examen.invoice_a_number : examen.invoice_b_number} a déjà été neutralisée.`,
      "ALREADY_NEUTRALIZED", 409);
  }

  const garder = Number(conserver);
  const ids = [Number(examen.invoice_a_id), Number(examen.invoice_b_id)];
  if (!ids.includes(garder)) {
    throw erreur("La facture à conserver doit être l'une des deux de la paire.", "KEEP_INVALIDE", 400);
  }
  const aNeutraliser = ids.find((x) => x !== garder);
  const product = examen.product;
  const p = S.produitDe(product);

  const conservee = await R.chargerFacture(client, { companyId, product, invoiceId: garder, verrou: true });
  const doublon = await R.chargerFacture(client, { companyId, product, invoiceId: aNeutraliser, verrou: true });

  if (doublon.status === "ANNULEE") {
    throw erreur(`La facture ${doublon.invoice_number} est déjà annulée.`, "ALREADY_CANCELLED", 409);
  }

  /* LE CAS QUI DOIT ARRÊTER TOUT LE MONDE. Si les deux factures ont reçu des
     encaissements, le client a probablement payé deux fois. Déplacer sans le
     dire mettrait la facture conservée en trop-perçu et ferait disparaître la
     question du remboursement. */
  const paiementsDoublon = await R.paiementsDeFacture(client, { companyId, product, invoiceId: doublon.id });
  const vivants = paiementsDoublon.filter((x) => !x.contrepasse);
  if (vivants.length && francs(conservee.paid_amount) > 0 && !accepterPaiementsDesDeuxCotes) {
    throw erreur(
      `Les deux factures ont reçu des encaissements : ${conservee.invoice_number} porte ${francs(conservee.paid_amount).toLocaleString("fr-FR")} FCFA et ${doublon.invoice_number} ${francs(doublon.paid_amount).toLocaleString("fr-FR")} FCFA. Si c'est bien un doublon, le client a payé deux fois et il faut le lui rembourser — ce n'est pas un simple déplacement. Confirmez explicitement pour continuer.`,
      "PAIEMENTS_DES_DEUX_COTES", 409,
      { paye_conservee: francs(conservee.paid_amount), paye_doublon: francs(doublon.paid_amount) });
  }

  /* Les encaissements légitimes suivent la facture qui fait foi. On passe par
     la réaffectation : aucune écriture de trésorerie n'est créée, le
     déplacement est atomique et laisse sa trace des deux côtés. */
  let deplaces = 0, montantDeplace = 0;
  for (const paiement of vivants) {
    await R.reaffecter(client, {
      companyId, product, paymentId: Number(paiement.id),
      versFactureId: conservee.id,
      motif: `doublon ${doublon.invoice_number} neutralisé : ${m}`,
      accepterDepassement: true,
      utilisateur,
    });
    deplaces += 1;
    montantDeplace += francs(paiement.amount);
  }

  /* La facture neutralisée : annulée, pointant vers celle qui fait foi.
     Pas supprimée — elle a pu être imprimée et remise. */
  await client.query(
    `UPDATE ${p.factures}
        SET status = 'ANNULEE', cancelled_at = COALESCE(cancelled_at, now()),
            duplicate_of_invoice_id = $3::bigint,
            neutralized_at = now(), neutralize_reason = $4,
            updated_at = NOW()
      WHERE id = $1 AND company_id = $2`,
    [doublon.id, companyId, conservee.id, m]);

  const apres = await S.recomputerFacture(client, { companyId, product, invoiceId: doublon.id });
  const conserveeApres = await S.recomputerFacture(client, { companyId, product, invoiceId: conservee.id });

  const { rows: maj } = await client.query(
    `UPDATE invoice_duplicate_reviews
        SET kept_invoice_id = $2, neutralized_invoice_id = $3,
            neutralized_at = now(), neutralized_by = $4, neutralized_by_name = $5,
            payments_moved = $6, amount_moved = $7, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [examen.id, conservee.id, doublon.id, utilisateur?.id || null, nomDe(utilisateur),
      deplaces, montantDeplace]);

  return {
    examen: maj[0],
    conservee: { numero: conservee.invoice_number, paye: francs(conserveeApres?.paid_amount),
                 restant: francs(conserveeApres?.remaining_amount) },
    neutralisee: { numero: doublon.invoice_number, statut: apres?.status || "ANNULEE" },
    paiements_deplaces: deplaces,
    montant_deplace: montantDeplace,
    avertissement: deplaces
      ? `${deplaces} encaissement(s) ont été portés sur ${conservee.invoice_number}. Aucune écriture de trésorerie n'a été créée : l'argent était déjà encaissé.`
      : "Aucun encaissement à déplacer : la facture neutralisée n'en portait pas.",
  };
}

async function listerExamens(client, { companyId, product = null, verdict = null, limite = 200 }) {
  const params = [companyId];
  const cond = ["company_id = $1"];
  if (product) { params.push(S.produitDe(product).cle); cond.push(`product = $${params.length}`); }
  if (verdict) { params.push(String(verdict).toUpperCase()); cond.push(`verdict = $${params.length}`); }
  params.push(limite);
  const { rows } = await client.query(
    `SELECT * FROM invoice_duplicate_reviews
      WHERE ${cond.join(" AND ")}
      ORDER BY decided_at DESC NULLS LAST, id DESC LIMIT $${params.length}`, params);
  return rows;
}

module.exports = {
  VERDICTS, SIGNAUX, suggerer,
  paquetsSuspects, trancher, neutraliser, listerExamens,
};

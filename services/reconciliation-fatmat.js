"use strict";

/**
 * RÉCONCILIER LES FACTURES FAT & MAT AVEC LES RELEVÉS DE LA DIRECTION.
 *
 * Trois relevés donnent un NOMBRE, une DATE et un TOTAL. La base, elle, porte
 * des factures. Ce module explique l'écart entre les deux — il ne le fait pas
 * disparaître.
 *
 * TROIS RÈGLES QUI GOUVERNENT TOUT CE FICHIER
 *
 * 1. AUCUN PAIEMENT N'EST INVENTÉ. Si un relevé dit « réglée » et que la base
 *    ne porte aucun encaissement, c'est une ANOMALIE à trancher par une
 *    personne, jamais un encaissement à créer. Créer le paiement ferait
 *    coïncider le tableau et perdre l'information qui comptait.
 *
 * 2. LA DATE DE FACTURE N'EST PAS LA DATE DE SAISIE. Une facture datée du
 *    09/09 peut avoir été enregistrée le 02/10. On lit donc les deux, et un
 *    écart important entre elles est signalé plutôt que supposé normal.
 *
 * 3. RIEN N'EST SUPPRIMÉ. Les factures en trop deviennent des CANDIDATES à
 *    l'annulation, avec leur montant, leurs paiements liés et les
 *    conséquences comptables. La décision revient à la direction.
 */

const francs = (v) => Math.round(Number(v || 0));

/* Ce qu'on peut reprocher à une facture. L'ordre est celui de la gravité :
   une facture peut cumuler plusieurs anomalies, la première nommée décide de
   son classement. */
const ANOMALIES = Object.freeze({
  DOUBLON_EXACT: "Même client, même date, même montant qu'une autre facture",
  DOUBLON_PROBABLE: "Même client et même montant qu'une autre facture, à quelques jours",
  PAYEE_SANS_PAIEMENT: "Marquée payée sans aucun encaissement enregistré",
  PAIEMENT_SANS_FACTURE: "Encaissement rattaché à une facture annulée",
  MONTANT_INCOHERENT: "Le payé plus le dû ne font pas le total",
  PAYE_SUPERIEUR_TOTAL: "Encaissé plus que le montant de la facture",
  VENTE_ANNULEE: "Rattachée à une vente annulée",
  SANS_CLIENT: "Aucun client rattaché",
  MONTANT_NUL: "Montant nul ou négatif",
  DATE_HORS_PERIODE: "Datée hors de la période des relevés",
  SAISIE_TARDIVE: "Enregistrée plus de 15 jours après sa date de facture",
  ANNULEE_AVEC_PAIEMENT: "Annulée alors qu'un encaissement non contrepassé subsiste",
  STATUT_INCOHERENT: "Le statut ne correspond pas aux montants",
});

/* Les factures que l'on garde quoi qu'il arrive : un document a été remis au
   client, ou de l'argent a réellement circulé. Les annuler demanderait une
   décision bien plus lourde qu'un nettoyage de doublons. */
const MOTIFS_CONSERVATION = Object.freeze({
  IMPRIMEE: "facture imprimée et remise au client",
  ENCAISSEE: "des encaissements y sont rattachés",
  LIVREE: "une livraison lui est rattachée",
  DANS_UN_RELEVE: "elle correspond à une ligne d'un relevé de la direction",
});

/* PostgreSQL rend une colonne DATE sous forme d'objet Date : la découper
   comme du texte donnait « Tue Sep 01 » et faussait toutes les comparaisons.
   On lit les composantes LOCALES — toISOString() repasserait par UTC et
   afficherait la veille en soirée. */
const jour = (d) => {
  if (!d) return null;
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
         + `-${String(d.getDate()).padStart(2, "0")}`;
  }
  const t = String(d);
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : null;
};
const ecartJours = (a, b) => {
  if (!a || !b) return null;
  return Math.round((new Date(jour(b)) - new Date(jour(a))) / 86400000);
};

/** Le relevé auquel une facture appartient, d'après sa date et son état. */
function releveDe(facture, reference) {
  const d = jour(facture.invoice_date);
  if (!d) return null;
  for (const r of reference.releves) {
    if (r.date_debut && r.date_fin) {
      if (d >= r.date_debut && d <= r.date_fin) return r.cle;
    } else if (r.date_releve && d <= r.date_releve) {
      /* Un relevé « au 09/09 » englobe tout ce qui précède, mais seulement si
         l'état correspond : une facture impayée du 05/09 appartient au relevé
         des impayées, pas à celui des réglées. */
      const payee = francs(facture.remaining_amount) <= 0;
      if (r.statut_attendu === "PAYEE" ? payee : !payee) return r.cle;
    }
  }
  return null;
}

/**
 * Examine une facture et rend la liste de ce qu'on peut lui reprocher.
 * Ne décide RIEN : c'est `classer` qui en tire des conséquences.
 */
function anomaliesDe(facture, contexte) {
  const out = [];
  const total = francs(facture.total_amount);
  const paye = francs(facture.paid_amount);
  const du = francs(facture.remaining_amount);
  const encaisse = francs(facture.encaisse_reel);
  const annulee = !!facture.cancelled_at;

  if (total <= 0) out.push("MONTANT_NUL");
  if (paye + du !== total) out.push("MONTANT_INCOHERENT");
  if (paye > total) out.push("PAYE_SUPERIEUR_TOTAL");

  /* La règle n° 1 : on constate, on n'invente pas. */
  if (!annulee && du <= 0 && total > 0 && encaisse <= 0) out.push("PAYEE_SANS_PAIEMENT");
  if (annulee && encaisse > 0) out.push("ANNULEE_AVEC_PAIEMENT");

  /* `sale_id` est NOT NULL et référencé : une facture SANS vente ne peut pas
     exister dans ce schéma. Ce qui existe, c'est une facture dont la vente a
     été annulée — la facture, elle, reste active. */
  if (facture.vente_annulee) out.push("VENTE_ANNULEE");
  if (!facture.customer_id) out.push("SANS_CLIENT");

  const d = jour(facture.invoice_date);
  if (d && (d < contexte.periode.du || d > contexte.periode.au)) out.push("DATE_HORS_PERIODE");

  /* La règle n° 2 : la date de saisie se lit séparément. */
  const retard = ecartJours(facture.invoice_date, facture.created_at);
  if (retard !== null && retard > 15) out.push("SAISIE_TARDIVE");

  const statutAttendu = annulee ? facture.status
    : du <= 0 && total > 0 ? "PAYEE"
    : paye > 0 ? "PARTIELLEMENT_PAYEE" : "IMPAYEE";
  if (!annulee && facture.status !== statutAttendu) out.push("STATUT_INCOHERENT");

  if (facture.doublon_exact_de) out.push("DOUBLON_EXACT");
  else if (facture.doublon_probable_de) out.push("DOUBLON_PROBABLE");

  return out;
}

/** Les raisons de conserver une facture, même en doublon apparent. */
function raisonsDeConserver(facture) {
  const out = [];
  if (Number(facture.print_count || 0) > 0 || facture.printed_at) out.push("IMPRIMEE");
  if (francs(facture.encaisse_reel) > 0) out.push("ENCAISSEE");
  if (facture.livraison_id) out.push("LIVREE");
  return out;
}

/**
 * Classe chaque facture : à conserver, candidate à l'annulation, ou à
 * examiner. Une candidate n'est JAMAIS annulée ici.
 */
function classer(factures, reference) {
  const contexte = { periode: reference.periode };

  /* Les doublons : même client, même montant. On marque le plus RÉCENT comme
     doublon du plus ancien — le premier saisi est présumé l'original. */
  const parCle = new Map();
  /* Trier sur le TEMPS, pas sur le texte. PostgreSQL rend des objets Date :
     les comparer en chaînes donne « Fri Sep 18 » avant « Tue Sep 15 », et
     l'outil désignait alors l'ORIGINAL comme doublon de sa copie — donc
     proposait d'annuler la mauvaise facture. */
  const instant = (d) => {
    if (!d) return Number.POSITIVE_INFINITY;
    const t = d instanceof Date ? d.getTime() : Date.parse(String(d));
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  const ordre = [...factures].sort((a, b) =>
    (instant(a.created_at) - instant(b.created_at)) || (a.id - b.id));
  for (const f of ordre) {
    const cle = `${f.customer_id || "?"}|${francs(f.total_amount)}`;
    const precedentes = parCle.get(cle) || [];
    for (const p of precedentes) {
      const ecart = Math.abs(ecartJours(p.invoice_date, f.invoice_date) ?? 999);
      if (ecart === 0) { f.doublon_exact_de = p.id; break; }
      if (ecart <= 5) { f.doublon_probable_de = p.id; break; }
    }
    precedentes.push(f);
    parCle.set(cle, precedentes);
  }

  const resultats = factures.map((f) => {
    const anomalies = anomaliesDe(f, contexte);
    const conservation = raisonsDeConserver(f);
    const releve = releveDe(f, reference);

    /* Une facture est CANDIDATE si elle fait double emploi et que rien ne
       l'ancre dans le réel. Dès qu'un document est sorti ou que de l'argent a
       circulé, elle se conserve — l'annuler demanderait une décision d'un
       tout autre ordre. */
    const faitDoublon = anomalies.includes("DOUBLON_EXACT") || anomalies.includes("DOUBLON_PROBABLE");
    const ancree = conservation.length > 0;
    const decision = f.cancelled_at ? "DEJA_ANNULEE"
      : faitDoublon && !ancree ? "CANDIDATE_ANNULATION"
      : faitDoublon && ancree ? "A_EXAMINER"
      : anomalies.length ? "A_EXAMINER"
      : "CONSERVER";

    return {
      id: f.id,
      numero: f.invoice_number,
      date_facture: jour(f.invoice_date),
      date_saisie: jour(f.created_at),
      client: f.customer_name || null,
      client_id: f.customer_id || null,
      operation: f.operation_reference || null,
      destination: f.destination || null,
      total: francs(f.total_amount),
      paye: francs(f.paid_amount),
      du: francs(f.remaining_amount),
      encaisse_reel: francs(f.encaisse_reel),
      paiements: Number(f.nb_paiements || 0),
      statut: f.status,
      annulee: !!f.cancelled_at,
      releve,
      decision,
      anomalies: anomalies.map((a) => ({ code: a, libelle: ANOMALIES[a] })),
      conservation: conservation.map((c) => ({ code: c, libelle: MOTIFS_CONSERVATION[c] })),
      doublon_de: f.doublon_exact_de || f.doublon_probable_de || null,
    };
  });

  return resultats;
}

/** Compare chaque relevé de la direction à ce que porte la base. */
function comparerReleves(resultats, reference) {
  return reference.releves.map((r) => {
    const siennes = resultats.filter((x) => x.releve === r.cle && !x.annulee);
    const nombre = siennes.length;
    const total = siennes.reduce((s, x) => s + x.total, 0);
    return {
      cle: r.cle, libelle: r.libelle,
      attendu: { nombre: r.nombre, total: r.total },
      trouve: { nombre, total },
      ecart: { nombre: nombre - r.nombre, total: total - r.total },
      concorde: nombre === r.nombre && total === r.total,
      factures: siennes.map((x) => x.numero),
    };
  });
}

/** Le rapport complet, prêt à être lu ou imprimé. */
function reconcilier(factures, reference) {
  const resultats = classer(factures, reference);
  const releves = comparerReleves(resultats, reference);

  const parDecision = {};
  for (const r of resultats) (parDecision[r.decision] ??= []).push(r);

  const anomaliesTotales = resultats.reduce((n, r) => n + r.anomalies.length, 0);
  const parAnomalie = {};
  for (const r of resultats) {
    for (const a of r.anomalies) parAnomalie[a.code] = (parAnomalie[a.code] || 0) + 1;
  }

  const candidates = parDecision.CANDIDATE_ANNULATION || [];

  return {
    factures: resultats,
    releves,
    totaux: {
      factures: resultats.length,
      actives: resultats.filter((r) => !r.annulee).length,
      annulees: resultats.filter((r) => r.annulee).length,
      montant_actif: resultats.filter((r) => !r.annulee).reduce((s, r) => s + r.total, 0),
      anomalies: anomaliesTotales,
    },
    par_anomalie: parAnomalie,
    a_conserver: (parDecision.CONSERVER || []).map((r) => r.numero),
    a_examiner: (parDecision.A_EXAMINER || []).map((r) => r.numero),
    candidates_annulation: candidates.map((r) => ({
      id: r.id, numero: r.numero, montant: r.total,
      doublon_de: r.doublon_de, paiements: r.paiements,
      /* De quoi juger sans rouvrir la base. */
      consequence: r.encaisse_reel > 0
        ? `ATTENTION : ${r.encaisse_reel.toLocaleString("fr-FR")} FCFA encaissés à contrepasser d'abord`
        : "aucun encaissement rattaché : l'annulation ne touche aucun solde",
    })),
    /* Ce que l'outil NE FAIT PAS, dit explicitement. */
    avertissement:
      "Rapport de lecture seule. Aucune facture n'a été annulée ni supprimée, "
      + "aucun paiement n'a été créé. Les candidates à l'annulation sont une "
      + "proposition : elles attendent une validation nominative.",
  };
}

module.exports = { ANOMALIES, MOTIFS_CONSERVATION, reconcilier, classer, comparerReleves, releveDe, anomaliesDe };

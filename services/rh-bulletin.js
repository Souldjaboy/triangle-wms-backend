"use strict";

/**
 * LE CALCUL D'UN BULLETIN DE SALAIRE.
 *
 * LA RÈGLE QUI GOUVERNE TOUT CE FICHIER : AUCUN TAUX N'EST ÉCRIT ICI.
 *
 * Les cotisations maliennes — ITS, INPS, AMO, CFE, CGS, TFP, TEJ — ont leur
 * catalogue dans `tax_types` et leurs taux dans `tax_rules`, chacun avec sa
 * référence de texte officiel et son statut de vérification. Ce module LIT
 * ces taux. S'il n'en trouve pas, il ne calcule rien : il le dit.
 *
 * Pourquoi c'est important plutôt que simplement prudent : un taux inventé
 * produit un bulletin d'allure parfaitement crédible, que le salarié signe,
 * que le comptable archive, et dont l'erreur ne se découvre qu'au premier
 * contrôle — avec des mois de régularisations derrière. Un bulletin qui
 * affiche « non paramétré » est inutilisable tout de suite, et c'est
 * exactement ce qu'on veut.
 *
 * Le module ne décide pas non plus du brut : il le reçoit. Les absences, les
 * retards et les avances sont calculés par le moteur de paie existant
 * (services/attendance-payroll.js) et transmis ici sous forme de lignes.
 */

const francs = (v) => Math.round(Number(v || 0));

/* Ce qu'une ligne de bulletin peut être. L'ordre est celui de l'impression. */
const NATURES = Object.freeze({
  GAIN: "GAIN",
  RETENUE_SALARIALE: "RETENUE_SALARIALE",
  CHARGE_PATRONALE: "CHARGE_PATRONALE",
});

function erreur(message, code, httpStatus = 400, extra = {}) {
  const e = new Error(message);
  e.code = code; e.httpStatus = httpStatus;
  Object.assign(e, extra);
  return e;
}

/**
 * Les taux applicables à une date, lus depuis `tax_rules`.
 *
 * Un taux n'est retenu que s'il est VÉRIFIÉ et porte une référence de texte
 * officiel. Un taux saisi sans source reste invisible au bulletin : c'est le
 * même geste que de ne pas l'avoir saisi.
 */
async function tauxApplicables(runner, companyId, dateReference) {
  const { rows } = await runner.query(
    `SELECT t.code, t.name, t.category, t.authority, t.base_label,
            r.rate_percent, r.fixed_amount, r.min_amount, r.max_amount, r.brackets,
            r.effective_from, r.effective_to, r.source_reference, r.verification_status
       FROM tax_rules r
       JOIN tax_types t ON t.id = r.tax_type_id
      WHERE (r.company_id = $1 OR r.company_id IS NULL)
        AND t.is_active
        AND r.effective_from <= $2::date
        AND (r.effective_to IS NULL OR r.effective_to >= $2::date)
        /* Le schéma n'admet que A_VERIFIER, VERIFIEE, OBSOLETE, CONTESTEE.
           On accepte les variantes voisines pour ne pas dépendre d'une
           orthographe, mais JAMAIS « A_VERIFIER » : un taux non vérifié ne
           doit pas calculer de retenue. */
        AND UPPER(COALESCE(r.verification_status,'')) IN
            ('VERIFIEE','VERIFIE','VERIFIED','VALIDE','VALIDATED')
        AND BTRIM(COALESCE(r.source_reference,'')) <> ''
      ORDER BY t.code, r.company_id NULLS LAST, r.effective_from DESC`,
    [companyId, dateReference]);

  /* Un taux propre à la société l'emporte sur un taux général : la requête
     les a déjà triés, on garde le premier vu par code. */
  const parCode = new Map();
  for (const r of rows) if (!parCode.has(r.code)) parCode.set(r.code, r);
  return parCode;
}

/** Applique un taux à une base, en respectant plancher et plafond. */
function appliquer(regle, base) {
  const b = francs(base);
  if (regle.fixed_amount != null && Number(regle.fixed_amount) > 0) {
    return francs(regle.fixed_amount);
  }
  if (regle.rate_percent == null) return null;

  let assiette = b;
  if (regle.min_amount != null && assiette < francs(regle.min_amount)) return 0;
  if (regle.max_amount != null) assiette = Math.min(assiette, francs(regle.max_amount));
  return francs((assiette * Number(regle.rate_percent)) / 100);
}

/**
 * LE BULLETIN.
 *
 * @param {object} p
 * @param {number} p.brut             rémunération brute du mois
 * @param {Array}  p.gains            [{libelle, montant}] primes, heures sup…
 * @param {Array}  p.retenues         [{libelle, montant}] avances, retenues décidées
 * @param {Map}    p.taux             sortie de `tauxApplicables`
 * @param {Array}  p.codesSalariaux   codes retenus sur le salarié
 * @param {Array}  p.codesPatronaux   codes à la charge de l'employeur
 */
function calculer({
  brut, gains = [], retenues = [], taux,
  codesSalariaux = ["ITS", "INPS", "AMO", "CGS"],
  codesPatronaux = ["INPS", "AMO", "CFE", "TFP", "TEJ"],
}) {
  const brutBase = francs(brut);
  if (!(brutBase > 0)) {
    throw erreur("La rémunération brute doit être supérieure à zéro.", "BRUT_INVALIDE");
  }

  const totalGains = gains.reduce((s, g) => s + francs(g.montant), 0);
  const brutTotal = brutBase + totalGains;

  const lignes = [];
  const manquants = [];

  const ajouter = (code, nature) => {
    const regle = taux.get(code);
    if (!regle) { manquants.push(code); return; }
    const montant = appliquer(regle, brutTotal);
    if (montant === null) { manquants.push(code); return; }
    lignes.push({
      code, nature,
      libelle: regle.name,
      organisme: regle.authority,
      base: brutTotal,
      taux: regle.rate_percent != null ? Number(regle.rate_percent) : null,
      montant_fixe: regle.fixed_amount != null ? francs(regle.fixed_amount) : null,
      montant,
      reference: regle.source_reference,
    });
  };

  for (const code of codesSalariaux) ajouter(code, NATURES.RETENUE_SALARIALE);
  for (const code of codesPatronaux) ajouter(code, NATURES.CHARGE_PATRONALE);

  const retenuesSalariales = lignes
    .filter((l) => l.nature === NATURES.RETENUE_SALARIALE)
    .reduce((s, l) => s + l.montant, 0);
  const chargesPatronales = lignes
    .filter((l) => l.nature === NATURES.CHARGE_PATRONALE)
    .reduce((s, l) => s + l.montant, 0);

  const autresRetenues = retenues.reduce((s, r) => s + francs(r.montant), 0);
  const net = brutTotal - retenuesSalariales - autresRetenues;

  /* LE POINT CENTRAL. Si un seul taux manque, le net affiché serait faux —
     trop élevé, et d'autant plus crédible. On le dit, et l'appelant décide
     s'il imprime quand même un bulletin marqué « non paramétré ». */
  /* INPS et AMO sont à la fois salariales et patronales : sans dédoublonnage,
     le message les citait deux fois et donnait l'impression de deux manques
     distincts. */
  const manquantsUniques = [...new Set(manquants)];
  const complet = manquantsUniques.length === 0;

  return {
    brut_base: brutBase,
    gains: gains.map((g) => ({ libelle: g.libelle, montant: francs(g.montant) })),
    total_gains: totalGains,
    brut_total: brutTotal,
    lignes,
    retenues_salariales: retenuesSalariales,
    charges_patronales: chargesPatronales,
    autres_retenues: retenues.map((r) => ({ libelle: r.libelle, montant: francs(r.montant) })),
    total_autres_retenues: autresRetenues,
    net_a_payer: complet ? net : null,
    cout_employeur: complet ? brutTotal + chargesPatronales : null,
    complet,
    cotisations_manquantes: manquantsUniques,
    avertissement: complet ? null
      : `Aucun taux vérifié pour : ${manquantsUniques.join(", ")}. `
        + "Le net à payer n'est PAS calculé : un bulletin incomplet qui afficherait "
        + "un net aurait l'air juste et ne le serait pas. Saisissez les taux avec "
        + "leur référence de texte officiel dans Fiscalité et cotisations.",
  };
}

module.exports = { NATURES, tauxApplicables, calculer, appliquer, francs };

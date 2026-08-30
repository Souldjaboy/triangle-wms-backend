"use strict";

/**
 * À QUELLE ENTREPRISE APPARTIENT CE QUE L'ON CRÉE.
 *
 * Un employé créé alors que l'administrateur travaillait dans FAT & MAT s'est
 * retrouvé dans Triangle, avec un badge Triangle. La cause tenait en une
 * ligne : la route de création lisait `req.body.company_id`, et se rabattait
 * sinon sur la société du compte administrateur. Le contexte de travail —
 * l'entreprise réellement active à l'écran — n'entrait jamais dans la
 * décision, et une valeur envoyée par le navigateur était acceptée telle
 * quelle.
 *
 * Deux règles ici :
 *
 *   1. l'entreprise vient du contexte authentifié, pas du corps de la
 *      requête ; un identifiant transmis n'est retenu que s'il correspond à
 *      une société que l'appelant a le droit d'administrer ;
 *   2. le badge se déduit de l'entreprise d'appartenance réelle, jamais d'un
 *      préfixe écrit en dur.
 */

/** Sociétés qu'un compte peut légitimement administrer. */
async function societesAutorisees(pool, user) {
  const estSuper =
    user?.is_super_admin === true ||
    String(user?.role || "").toLowerCase() === "super_admin";

  if (!estSuper) {
    const id = Number(user?.company_id || 0);
    return id ? [id] : [];
  }
  const { rows } = await pool.query(
    `SELECT id FROM companies WHERE COALESCE(status,'active') <> 'deleted' ORDER BY id`
  );
  return rows.map((r) => Number(r.id));
}

/**
 * L'entreprise dans laquelle l'action doit s'inscrire.
 *
 * `getEffectiveCompanyId` porte déjà le contexte de travail : il lit
 * l'en-tête d'entreprise active pour un super admin, et la société du compte
 * sinon. On le prend comme source, puis on vérifie que le résultat est bien
 * autorisé — un en-tête falsifié ne suffit donc pas.
 *
 * @returns {{ companyId:number, source:string, refus?:string }}
 */
async function resoudreSociete(pool, req, getEffectiveCompanyId) {
  const autorisees = await societesAutorisees(pool, req.user);
  if (!autorisees.length) {
    return { companyId: 0, source: "aucune", refus: "Ce compte n'est rattaché à aucune entreprise." };
  }

  const contexte = Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  if (contexte) {
    if (!autorisees.includes(contexte)) {
      return {
        companyId: 0,
        source: "contexte_refuse",
        refus: "Entreprise active non autorisée pour ce compte.",
      };
    }
    return { companyId: contexte, source: "contexte" };
  }

  /* Aucun contexte : on ne retient une valeur du corps que si elle désigne
     une société autorisée. C'est le seul endroit où le navigateur influe, et
     il ne peut proposer que ce qui lui est déjà permis. */
  const demandee = Number(req.body?.company_id || 0);
  if (demandee) {
    if (!autorisees.includes(demandee)) {
      return {
        companyId: 0,
        source: "corps_refuse",
        refus: "Entreprise demandée non autorisée pour ce compte.",
      };
    }
    return { companyId: demandee, source: "corps_valide" };
  }

  if (autorisees.length === 1) return { companyId: autorisees[0], source: "unique" };

  return {
    companyId: 0,
    source: "ambigu",
    refus:
      "Plusieurs entreprises sont accessibles : sélectionnez l'entreprise active avant de créer un compte.",
  };
}

/**
 * Attribue le prochain badge de l'entreprise.
 *
 * La séquence est incrémentée dans la même transaction que la création, et la
 * ligne `companies` est verrouillée le temps de l'opération : deux créations
 * simultanées obtiennent deux numéros, jamais le même.
 *
 * @param client un client déjà en transaction
 */
async function prochainBadge(client, companyId) {
  const { rows } = await client.query(
    `UPDATE companies
        SET badge_sequence = COALESCE(badge_sequence, 0) + 1
      WHERE id = $1
      RETURNING COALESCE(NULLIF(TRIM(badge_prefix), ''), 'ENT' || id) AS prefixe,
                badge_sequence`,
    [companyId]
  );
  if (!rows[0]) throw new Error(`Entreprise ${companyId} introuvable pour l'attribution du badge.`);
  const { prefixe, badge_sequence: numero } = rows[0];
  return `${prefixe}-EMP-${String(numero).padStart(3, "0")}`;
}

/**
 * Préfixe déduit du nom, pour une entreprise qui vient d'être créée et n'a pas
 * encore de préfixe choisi. Mêmes règles que la migration 064, afin que la
 * valeur calculée ici et celle posée en base ne divergent pas.
 */
function prefixeDepuisNom(nom, companyId) {
  const propre = String(nom || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
  return propre || `ENT${companyId}`;
}

module.exports = { societesAutorisees, resoudreSociete, prochainBadge, prefixeDepuisNom };

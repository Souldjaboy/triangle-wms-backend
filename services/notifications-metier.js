"use strict";

/**
 * NOTIFIER UNE FOIS, PAS QUARANTE.
 *
 * Chaque notification métier porte une clé d'ÉVÉNEMENT — pas de message.
 * « paie 12 soumise » n'a de sens qu'une fois, quel que soit le nombre de
 * fois où le code repasse dessus. L'insertion est donc un upsert : la
 * seconde tentative ne crée rien et ne réveille personne.
 *
 * Une notification répétée ne prévient pas davantage : au bout de quarante
 * lignes identiques, plus personne ne regarde la cloche.
 */

const TYPES = Object.freeze({
  PERIODE_A_CONTROLER:  "pointage",
  POINTAGE_VALIDE:      "pointage",
  ANOMALIE_POINTAGE:    "pointage",
  PAIE_PRETE:           "paie",
  PAIE_SOUMISE:         "paie",
  PAIE_REFUSEE:         "paie",
  PAIE_CORRECTION:      "paie",
  PAIE_VALIDEE:         "paie",
  PAIE_PAYEE:           "paie",
  DOCUMENT_DISPONIBLE:  "document",
  ECHEANCE_FISCALE:     "fiscalite",
  DEPOT_PRESQUE_EPUISE: "acompte",
  DEPOT_EPUISE:         "acompte",
  FACTURE_SUPERIEURE_AU_DEPOT: "acompte",
  ECHEANCE_AVANCE:      "avance",
});

/**
 * @param {object} p
 * @param {string} p.evenement  une des clés de TYPES
 * @param {string} p.cle        ce qui identifie CE fait précis, ex. `paie:12:soumise`
 * @param {number[]} p.destinataires  ids des comptes à prévenir
 */
async function notifier(client, {
  companyId, evenement, cle, titre, message,
  destinataires = [], priorite = "normale", lien = "",
  entite = "", entiteId = null,
}) {
  const type = TYPES[evenement] || "info";
  const cibles = destinataires.length ? destinataires : [null];
  let crees = 0;

  for (const userId of cibles) {
    const { rowCount } = await client.query(
      `INSERT INTO notifications
         (user_id, company_id, title, message, type, is_read, priority,
          related_entity_type, related_entity_id, action_url, event_key, created_at)
       VALUES ($1,$2,$3,$4,$5,false,$6,$7,$8,$9,$10, now())
       ON CONFLICT (company_id, COALESCE(user_id, 0), event_key)
         WHERE event_key IS NOT NULL
         DO NOTHING`,
      [userId, companyId, titre, message, type, priorite,
       entite, entiteId, lien, `${evenement}:${cle}`]
    );
    crees += rowCount;
  }
  return crees;
}

/**
 * Les comptes à prévenir pour une action donnée, dans une société.
 *
 * On interroge les DROITS plutôt que les rôles : prévenir « les comptables »
 * laisserait de côté celui à qui on vient d'accorder la préparation de la
 * paie par exception personnelle, et réveillerait celui à qui on l'a retirée.
 */
async function destinatairesPour(client, companyId, moduleKey, action) {
  const { rows } = await client.query(
    `SELECT DISTINCT u.id
       FROM users u
      WHERE u.company_id = $1
        AND COALESCE(u.is_active, true)
        AND (
          u.is_super_admin = true
          OR EXISTS (SELECT 1 FROM user_permission_overrides o
                      WHERE o.company_id = $1 AND o.user_id = u.id
                        AND o.module_key = $2 AND o.action = $3 AND o.effect = 'ALLOW')
          OR (
            EXISTS (SELECT 1 FROM role_permissions r
                     WHERE r.company_id = $1 AND lower(r.role) = lower(u.role)
                       AND r.module_key = $2 AND r.action = $3 AND r.allowed)
            AND NOT EXISTS (SELECT 1 FROM user_permission_overrides o
                             WHERE o.company_id = $1 AND o.user_id = u.id
                               AND o.module_key = $2 AND o.action = $3 AND o.effect = 'DENY')
          )
        )`,
    [companyId, moduleKey, action]
  );
  return rows.map((r) => Number(r.id));
}

module.exports = { TYPES, notifier, destinatairesPour };

"use strict";

/**
 * LES PÉRIODES DU 25 AU 24.
 *
 * La paie « de septembre » couvre le 25 août au 24 septembre inclus. Le mois
 * calendaire ne sait pas exprimer cela — d'où une table de périodes plutôt
 * qu'une date tronquée au mois.
 *
 * Deux règles gouvernent la génération :
 *
 *   • pas de trou : la période suivante commence le lendemain de la fin de
 *     la précédente, jamais deux jours après ;
 *   • pas de chevauchement : garanti par la base elle-même (contrainte
 *     d'exclusion, migration 081), pas seulement par ce code. Une paie qui
 *     recouvrirait la précédente paierait deux fois les mêmes journées, et
 *     rien dans l'application ne le remarquerait.
 *
 * Le jour de bascule est configurable par société (`period_start_day`,
 * 25 par défaut) : ce n'est pas une loi de la nature.
 */

const JOURS_OUVRES = { DIMANCHE: 7, SAMEDI: 6 };

function erreur(message, code, httpStatus) {
  const e = new Error(message);
  e.code = code; e.httpStatus = httpStatus;
  return e;
}

/** `2026-09-25` → `{ annee: 2026, mois: 9, jour: 25 }`, sans passer par Date. */
function decouper(iso) {
  const [a, m, j] = String(iso).split("-").map(Number);
  return { annee: a, mois: m, jour: j };
}

const iso = (annee, mois, jour) =>
  `${annee}-${String(mois).padStart(2, "0")}-${String(jour).padStart(2, "0")}`;

/**
 * Les bornes de la période de paie du mois `code` (AAAA-MM).
 *
 * La paie de septembre 2026 : du 25 août au 24 septembre.
 * Le mois du CODE est celui de la fin — c'est ainsi qu'on en parle.
 */
function bornes(code, jourBascule = 25) {
  if (!/^\d{4}-\d{2}$/.test(String(code || ""))) {
    throw erreur("Période attendue au format AAAA-MM.", "PERIOD_CODE_INVALID", 400);
  }
  const [annee, mois] = String(code).split("-").map(Number);
  const moisDebut = mois === 1 ? 12 : mois - 1;
  const anneeDebut = mois === 1 ? annee - 1 : annee;
  return {
    code,
    date_debut: iso(anneeDebut, moisDebut, jourBascule),
    date_fin: iso(annee, mois, jourBascule - 1),
  };
}

/** Le code de la période qui CONTIENT cette date. */
function codeContenant(dateIso, jourBascule = 25) {
  const { annee, mois, jour } = decouper(dateIso);
  /* Le 25 août appartient à septembre ; le 24 août appartient à août. */
  if (jour >= jourBascule) {
    return mois === 12 ? `${annee + 1}-01` : `${annee}-${String(mois + 1).padStart(2, "0")}`;
  }
  return `${annee}-${String(mois).padStart(2, "0")}`;
}

/** Le code du mois suivant. */
function codeSuivant(code) {
  const [annee, mois] = String(code).split("-").map(Number);
  return mois === 12 ? `${annee + 1}-01` : `${annee}-${String(mois + 1).padStart(2, "0")}`;
}

const STATUTS = Object.freeze([
  "OUVERTE", "EN_REVISION_POINTAGE", "POINTAGE_VALIDE", "PAIE_PREPAREE",
  "EN_ATTENTE_DIRECTION", "VALIDEE_DIRECTION", "AUTORISEE_AU_PAIEMENT",
  "PAYEE", "CLOTUREE", "ANNULEE",
]);

/**
 * Les transitions permises. Ce qui n'est pas listé est refusé — plutôt que
 * l'inverse : une machine à états qui interdit par défaut ne laisse pas
 * passer l'enchaînement auquel personne n'avait pensé.
 */
const TRANSITIONS = Object.freeze({
  OUVERTE:               ["EN_REVISION_POINTAGE", "ANNULEE"],
  EN_REVISION_POINTAGE:  ["POINTAGE_VALIDE", "OUVERTE", "ANNULEE"],
  POINTAGE_VALIDE:       ["PAIE_PREPAREE", "EN_REVISION_POINTAGE", "ANNULEE"],
  PAIE_PREPAREE:         ["EN_ATTENTE_DIRECTION", "POINTAGE_VALIDE", "ANNULEE"],
  EN_ATTENTE_DIRECTION:  ["VALIDEE_DIRECTION", "PAIE_PREPAREE", "ANNULEE"],
  VALIDEE_DIRECTION:     ["AUTORISEE_AU_PAIEMENT", "PAIE_PREPAREE", "ANNULEE"],
  AUTORISEE_AU_PAIEMENT: ["PAYEE", "ANNULEE"],
  PAYEE:                 ["CLOTUREE"],
  /* Une période close se rouvre — mais seulement vers la révision du
     pointage, et seulement avec un motif : c'est le geste qu'on veut voir
     dans un audit, pas un retour discret à l'état antérieur. */
  CLOTUREE:              ["EN_REVISION_POINTAGE"],
  ANNULEE:               [],
});

function assertTransition(depuis, vers) {
  if (!STATUTS.includes(vers)) throw erreur(`Statut inconnu : ${vers}.`, "PERIOD_STATUS_INVALID", 400);
  const permises = TRANSITIONS[depuis] || [];
  if (!permises.includes(vers)) {
    throw erreur(
      `Une période « ${depuis} » ne peut pas passer à « ${vers} ». Transitions possibles : ${permises.join(", ") || "aucune"}.`,
      "PERIOD_TRANSITION_INVALID", 409
    );
  }
  return vers;
}

/**
 * Ouvre la période `code` si elle n'existe pas, et toutes celles qui
 * manquent entre la dernière connue et elle — pour qu'aucun trou ne se crée
 * quand personne n'a ouvert la paie d'un mois.
 */
async function garantirPeriode(client, companyId, code) {
  const { rows: config } = await client.query(
    `SELECT COALESCE(period_start_day, 25) AS jour
       FROM attendance_company_configuration WHERE company_id = $1`,
    [companyId]
  );
  const jourBascule = Number(config[0]?.jour || 25);

  const { rows: derniere } = await client.query(
    `SELECT code, date_fin FROM attendance_periods
      WHERE company_id = $1 ORDER BY date_debut DESC LIMIT 1`,
    [companyId]
  );

  /* On remonte du dernier code connu jusqu'à celui demandé, en créant tout
     ce qui manque. Sans cela, ouvrir la paie de décembre après celle de
     septembre laisserait octobre et novembre sans période — et leurs
     journées n'appartiendraient à aucune paie. */
  const aCreer = [];
  if (derniere[0]) {
    let curseur = codeSuivant(derniere[0].code);
    let garde = 0;
    while (curseur <= code && garde < 240) { aCreer.push(curseur); curseur = codeSuivant(curseur); garde += 1; }
  } else {
    aCreer.push(code);
  }
  if (!aCreer.includes(code) && !derniere.some((d) => d.code === code)) aCreer.push(code);

  for (const c of aCreer) {
    const b = bornes(c, jourBascule);
    await client.query(
      `INSERT INTO attendance_periods (company_id, code, date_debut, date_fin)
       VALUES ($1,$2,$3::date,$4::date)
       ON CONFLICT (company_id, code) DO NOTHING`,
      [companyId, b.code, b.date_debut, b.date_fin]
    );
  }

  const { rows } = await client.query(
    `SELECT * FROM attendance_periods WHERE company_id = $1 AND code = $2`,
    [companyId, code]
  );
  if (!rows[0]) throw erreur("Période introuvable après création.", "PERIOD_NOT_CREATED", 500);
  return rows[0];
}

/**
 * Les jours attendus d'un employé sur une période.
 *
 * Le dimanche ne compte jamais. Le samedi dépend du réglage de la société.
 * Un jour férié ne compte pas comme attendu — et ne crée donc aucune absence
 * injustifiée. Si quelqu'un a travaillé ce jour-là, son pointage existe : on
 * ne l'efface pas, on ne le compte simplement pas comme dû.
 */
async function joursAttendus(client, companyId, employee, debut, fin) {
  const { rows: config } = await client.query(
    `SELECT COALESCE(saturday_mode, 'NORMAL') AS samedi
       FROM attendance_company_configuration WHERE company_id = $1`,
    [companyId]
  );
  const modeSamedi = String(config[0]?.samedi || "NORMAL");

  const { rows } = await client.query(
    `WITH jours AS (
       SELECT d::date AS jour, extract(isodow FROM d)::int AS isodow
         FROM generate_series($1::date, $2::date, interval '1 day') d
     )
     SELECT count(*)::int AS attendus
       FROM jours j
       JOIN attendance_schedule_days s
         ON s.schedule_id = $3 AND s.iso_weekday = j.isodow AND s.is_working_day
      WHERE j.isodow <> $4
        AND ($5 OR j.isodow <> $6)
        AND NOT EXISTS (
          SELECT 1 FROM attendance_holidays h
           WHERE h.company_id = $7 AND h.holiday_date = j.jour)`,
    [debut, fin, employee.schedule_id,
     JOURS_OUVRES.DIMANCHE,
     modeSamedi === "NORMAL",
     JOURS_OUVRES.SAMEDI,
     companyId]
  );
  return Number(rows[0]?.attendus || 0);
}

module.exports = {
  STATUTS, TRANSITIONS, JOURS_OUVRES,
  erreur, bornes, codeContenant, codeSuivant, assertTransition,
  garantirPeriode, joursAttendus,
};

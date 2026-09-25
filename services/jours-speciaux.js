"use strict";

/**
 * LE CALENDRIER ADMINISTRATIF — jours fériés, jours chômés, journées
 * exceptionnelles.
 *
 * CE QUE CE SERVICE NE FAIT PAS : interpréter. Il ne décide pas qu'un jour
 * chômé est payé, ni qu'une absence de pointage ce jour-là est excusable. Il
 * lit ce que l'administration a enregistré et le rend utilisable par le moteur
 * de paie et par le rapport. Deux décisions différentes sur le même type de
 * journée doivent pouvoir produire deux traitements différents — sans qu'une
 * ligne de code change.
 *
 * LA PORTÉE, ET POURQUOI ELLE EST RÉSOLUE ICI
 *
 * Une journée peut viser toute l'entreprise, un site, un entrepôt, un service,
 * une catégorie, ou une liste nominative. Le moteur de paie travaille en SQL
 * sur des journées et des salariés ; lui faire résoudre six sortes de portées
 * rendrait sa requête illisible. On développe donc la portée ICI, en paires
 * (salarié, date) explicites — quelques dizaines de lignes pour un mois — et le
 * SQL n'a plus qu'une jointure à faire.
 *
 * QUAND DEUX JOURNÉES SE SUPERPOSENT
 *
 * Le bureau ferme, l'entrepôt travaille : deux décisions le même jour, et un
 * salarié pourrait relever des deux. La plus PRÉCISE gagne — une décision
 * nominative l'emporte sur une décision de site, qui l'emporte sur une
 * décision d'entreprise. À précision égale, la plus récemment enregistrée
 * l'emporte, parce qu'une décision plus récente sur le même périmètre corrige
 * la précédente.
 */

/* Du plus précis au plus large. L'ordre EST la règle de résolution. */
const PRECISION = { SALARIES: 5, CATEGORIE: 4, SERVICE: 3, ENTREPOT: 2, SITE: 2, ENTREPRISE: 1 };

const AUCUNE = Object.freeze({
  jours_feries: 0, jours_chomes_payes: 0, jours_chomes_non_payes: 0,
  travail_jour_chome_jours: 0, repos_compensateur_jours: 0,
  retenue_jour_chome: 0, details: [],
});

async function typesActifs(client) {
  const { rows } = await client.query(
    `SELECT type_key, label, description, defaut_est_chome, defaut_est_paye,
            defaut_pointage_requis, defaut_impact_absence, defaut_impact_salaire,
            motif_obligatoire
       FROM attendance_special_day_types
      WHERE is_active ORDER BY sort_order, type_key`
  );
  return rows;
}

/**
 * Les journées actives d'une société sur un intervalle, avec leurs cibles.
 * Une seule requête : les cibles sont agrégées en tableaux.
 */
async function journeesDeLaPeriode(client, { companyId, debut, fin }) {
  const { rows } = await client.query(
    `SELECT s.*, t.label AS type_label,
            COALESCE(array_agg(DISTINCT c.site_id)     FILTER (WHERE c.site_id IS NOT NULL), '{}')     AS sites,
            COALESCE(array_agg(DISTINCT c.employee_id) FILTER (WHERE c.employee_id IS NOT NULL), '{}') AS salaries,
            COALESCE(array_agg(DISTINCT c.service)     FILTER (WHERE NULLIF(BTRIM(c.service), '') IS NOT NULL), '{}')   AS services,
            COALESCE(array_agg(DISTINCT c.categorie)   FILTER (WHERE NULLIF(BTRIM(c.categorie), '') IS NOT NULL), '{}') AS categories
       FROM attendance_special_days s
       JOIN attendance_special_day_types t ON t.type_key = s.type_key
       LEFT JOIN attendance_special_day_targets c ON c.special_day_id = s.id
      WHERE s.company_id = $1 AND s.status = 'ACTIF'
        AND s.day_date BETWEEN $2::date AND $3::date
      GROUP BY s.id, t.label
      ORDER BY s.day_date, s.id`,
    [companyId, debut, fin]
  );
  return rows;
}

/** Cette journée concerne-t-elle ce salarié ? */
function concerne(journee, salarie) {
  switch (journee.portee) {
    case "ENTREPRISE": return true;
    case "SITE":
    case "ENTREPOT":   return (journee.sites || []).map(Number).includes(Number(salarie.site_id));
    case "SERVICE":    return (journee.services || []).some((s) => norm(s) === norm(salarie.service));
    case "CATEGORIE":  return (journee.categories || []).some((c) => norm(c) === norm(salarie.categorie));
    case "SALARIES":   return (journee.salaries || []).map(Number).includes(Number(salarie.id));
    default:           return false;
  }
}
const norm = (v) => String(v || "").trim().toLowerCase();

/**
 * Pour chaque (salarié, date), LA journée qui s'applique — une seule.
 *
 * Retourne une Map indexée `${employee_id}|${AAAA-MM-JJ}`, prête à être passée
 * au moteur sous forme de tableau JSON.
 */
async function resolutionParSalarie(client, { companyId, debut, fin }) {
  const journees = await journeesDeLaPeriode(client, { companyId, debut, fin });
  if (!journees.length) return new Map();

  const { rows: salaries } = await client.query(
    `SELECT id, site_id, service, categorie FROM attendance_employees
      WHERE company_id = $1 AND active
        AND effective_from <= $3::date
        AND (effective_to IS NULL OR effective_to >= $2::date)`,
    [companyId, debut, fin]
  );

  const retenu = new Map();
  for (const j of journees) {
    const date = typeof j.day_date === "string" ? j.day_date.slice(0, 10)
      : new Date(j.day_date).toISOString().slice(0, 10);
    for (const s of salaries) {
      if (!concerne(j, s)) continue;
      const cle = `${s.id}|${date}`;
      const actuel = retenu.get(cle);
      if (actuel) {
        const mieux = PRECISION[j.portee] > PRECISION[actuel.portee]
          || (PRECISION[j.portee] === PRECISION[actuel.portee] && Number(j.id) > Number(actuel.id));
        if (!mieux) continue;
      }
      retenu.set(cle, { ...j, day_date: date, employee_id: s.id });
    }
  }
  return retenu;
}

/** Le tableau que le SQL du moteur attend, en une jointure sur (salarié, jour). */
function pourLeMoteur(resolution) {
  return [...resolution.values()].map((j) => ({
    employee_id: Number(j.employee_id),
    jour: j.day_date,
    special_day_id: Number(j.id),
    est_chome: j.est_chome === true,
    est_paye: j.est_paye === true,
    pointage_requis: j.pointage_requis === true,
    impact_absence: String(j.impact_absence || "AUCUNE"),
    impact_salaire: String(j.impact_salaire || "MAINTENU"),
    type_key: String(j.type_key || "AUTRE"),
    traitement: String(j.traitement_si_travaille || "AUCUN"),
  }));
}

/**
 * LES COMPENSATIONS DE CEUX QUI ONT TRAVAILLÉ UN JOUR CHÔMÉ.
 *
 * Elles deviennent des ÉLÉMENTS DE PAIE, pas un montant calculé à part : elles
 * suivent donc le même chemin qu'une prime saisie à la main, apparaissent au
 * même endroit sur le bulletin, et survivent au recalcul par le même
 * mécanisme.
 *
 * La duplication est impossible par construction, et non par précaution :
 * chaque ligne porte une référence d'origine unique — la journée, le salarié,
 * la date — et l'index unique de la migration 100 refuse la seconde. Un
 * recalcul RÉÉCRIT donc la même ligne.
 *
 * Deux règles de respect du geste humain :
 *   • une compensation annulée par quelqu'un n'est jamais ressuscitée ;
 *   • une compensation devenue sans objet — la journée a été désactivée, ou le
 *     salarié n'a finalement pas travaillé — est retirée automatiquement, sans
 *     être confondue avec une annulation décidée par une personne.
 */
async function genererCompensations(client, { companyId, periode, resolution, auteur = null, auteurNom = "" }) {
  const applicables = [...resolution.values()].filter(
    (j) => j.est_chome === true && j.traitement_si_travaille !== "AUCUN");
  const vivantes = [];

  for (const j of applicables) {
    /* A-t-il RÉELLEMENT travaillé ? On lit le pointage tel qu'il est, y compris
       régularisé — jamais on ne suppose la présence parce que la journée était
       chômée, ni l'inverse. */
    const { rows } = await client.query(
      `SELECT COALESCE(g.effective_check_in, r.check_in) AS arrivee,
              COALESCE(r.worked_minutes, 0) AS minutes,
              NULLIF(g.overridden_status, '') AS impose
         FROM (SELECT 1) AS _
         LEFT JOIN attendance_day_records_v2 r
           ON r.company_id = $1 AND r.employee_id = $2 AND r.work_date = $3::date
         LEFT JOIN attendance_regularizations g
           ON g.company_id = $1 AND g.employee_id = $2 AND g.work_date = $3::date`,
      [companyId, j.employee_id, j.day_date]
    );
    const p = rows[0] || {};
    const absentParDecision = p.impose && !["PRESENT", "LATE", "COMPLETED"].includes(p.impose);
    if (!p.arrivee || absentParDecision) continue;

    const { rows: sal } = await client.query(
      `SELECT daily_rate FROM attendance_salary_settings_v2
        WHERE company_id = $1 AND employee_id = $2 AND effective_from <= $3::date
        ORDER BY effective_from DESC LIMIT 1`,
      [companyId, j.employee_id, j.day_date]
    );
    const compensation = compensationDe(j, {
      dailyRate: sal[0]?.daily_rate || 0,
      heures: Number(p.minutes || 0) / 60,
    });
    if (!compensation) continue;

    const ref = referenceOrigine(j.id, j.employee_id, j.day_date);
    await client.query(
      `INSERT INTO payroll_elements
         (company_id, employee_id, period_code, type_key, quantity, unit_amount,
          amount, label, reason, source_kind, source_ref, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'JOUR_CHOME',$10,$11,$12)
       ON CONFLICT (company_id, source_kind, source_ref)
         WHERE source_kind <> 'MANUEL' AND source_ref <> ''
       DO UPDATE SET
         type_key = EXCLUDED.type_key, quantity = EXCLUDED.quantity,
         unit_amount = EXCLUDED.unit_amount, amount = EXCLUDED.amount,
         label = EXCLUDED.label, reason = EXCLUDED.reason,
         period_code = EXCLUDED.period_code,
         status = 'ACTIF', cancelled_at = NULL, cancel_reason = '',
         updated_at = now()
       /* Une annulation décidée par une personne n'est pas défaite par un
          recalcul. Un retrait automatique — cancelled_by NULL — l'est. */
       WHERE payroll_elements.status = 'ACTIF' OR payroll_elements.cancelled_by IS NULL`,
      [companyId, j.employee_id, periode.code, compensation.type_key,
       compensation.quantity, compensation.unit_amount, compensation.amount,
       `${j.label} — ${j.day_date}`,
       `Travail un jour chome (${j.type_label || j.type_key}) le ${j.day_date}. Traitement decide : ${j.traitement_si_travaille}.`,
       ref, auteur, auteurNom]
    );
    vivantes.push(ref);
  }

  /* Ce qui n'a plus d'objet est retiré — et se distingue d'une annulation
     humaine par l'absence d'auteur. */
  await client.query(
    `UPDATE payroll_elements
        SET status = 'ANNULE', cancelled_by = NULL, cancelled_at = now(),
            cancel_reason = 'Calendrier administratif : cette journee ne donne plus lieu a compensation.',
            updated_at = now()
      WHERE company_id = $1 AND period_code = $2 AND source_kind = 'JOUR_CHOME'
        AND status = 'ACTIF'
        AND NOT (source_ref = ANY($3::text[]))`,
    [companyId, periode.code, vivantes]
  );
  return vivantes.length;
}

/**
 * CE QUE VAUT LE TRAVAIL D'UN JOUR CHÔMÉ.
 *
 * Aucun taux n'est écrit ici : `compensation_montant` et `compensation_taux`
 * viennent de la décision enregistrée. Le service ne fait que l'arithmétique,
 * et refuse de compenser quand rien n'a été configuré — plutôt que d'appliquer
 * un pourcentage « raisonnable » que personne n'a décidé.
 */
function compensationDe(journee, { dailyRate, heures = 0 }) {
  const taux = Number(journee.compensation_taux || 0);
  const montant = Number(journee.compensation_montant || 0);
  const jour = Number(dailyRate || 0);
  switch (journee.traitement_si_travaille) {
    case "PRIME_FIXE":
      if (montant <= 0) return null;
      return { type_key: journee.compensation_type_key || "TRAVAIL_JOUR_CHOME",
               quantity: 1, unit_amount: arrondi(montant), amount: arrondi(montant) };
    case "MAJORATION": {
      /* Une majoration s'applique au taux journalier : c'est la seule base qui
         ait un sens pour une journée entière. */
      if (taux <= 0 || jour <= 0) return null;
      const m = arrondi(jour * taux);
      return { type_key: journee.compensation_type_key || "MAJORATION_JOUR_CHOME",
               quantity: 1, unit_amount: m, amount: m };
    }
    case "HEURES_SUP": {
      /* Le taux est ici un taux HORAIRE convenu, et les heures viennent du
         pointage réel : on ne suppose pas huit heures parce que la journée est
         entière. Sans heures pointées, il n'y a rien à majorer. */
      if (taux <= 0 || Number(heures) <= 0) return null;
      const m = arrondi(Number(heures) * taux);
      return { type_key: journee.compensation_type_key || "HEURES_SUP",
               quantity: arrondi(heures), unit_amount: arrondi(taux), amount: m };
    }
    case "AUTRE": {
      if (montant > 0) {
        return { type_key: journee.compensation_type_key || "PRIME_AUTRE",
                 quantity: 1, unit_amount: arrondi(montant), amount: arrondi(montant) };
      }
      if (taux > 0 && jour > 0) {
        const m = arrondi(jour * taux);
        return { type_key: journee.compensation_type_key || "PRIME_AUTRE",
                 quantity: 1, unit_amount: m, amount: m };
      }
      return null;
    }
    /* AUCUN et REPOS_COMPENSATEUR : rien de financier. Le repos compensateur
       est COMPTÉ (la journée est due au salarié) mais ne se paie pas. */
    default: return null;
  }
}
const arrondi = (v) => Math.round(Number(v || 0) * 100) / 100;

/**
 * La référence d'origine d'une compensation. Elle rend la duplication
 * impossible : un recalcul réécrit la même ligne, il n'en ajoute pas une
 * seconde. C'est le contrat de l'index unique posé par la migration 100.
 */
const referenceOrigine = (specialDayId, employeeId, jour) =>
  `JC:${specialDayId}:${employeeId}:${jour}`;

module.exports = {
  AUCUNE, PRECISION, typesActifs, journeesDeLaPeriode, concerne,
  resolutionParSalarie, pourLeMoteur, compensationDe, referenceOrigine,
  genererCompensations,
};

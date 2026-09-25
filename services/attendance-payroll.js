"use strict";

const ELEMENTS = require("./paie-elements");
const JS = require("./jours-speciaux");

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function calculatePayrollLine(input) {
  const monthly = input.monthly_salary == null ? null : money(input.monthly_salary);
  const daily = input.daily_rate == null ? null : money(input.daily_rate);
  /* BRUT et OFFICIEL. Le brut est ce que les pointages disent ; l'officiel est
     ce que l'entreprise retient après décision administrative. La paie se
     calcule sur l'officiel, l'audit se lit sur le brut, et le brut n'est jamais
     remis à zéro. */
  const absenceBrut = Math.max(0, Number(
    input.absence_days_brut != null ? input.absence_days_brut : input.absence_days || 0));
  /* Ce qui resterait retenu si la période ne posait AUCUNE exception : les
     journées déjà neutralisées par le calendrier administratif en sont sorties,
     celles que l'exception de période couvre y sont encore. C'est cette valeur
     qui chiffre ce que l'exception a coûté. */
  const absenceHorsException = Math.max(0, Number(
    input.absence_days_hors_exception != null ? input.absence_days_hors_exception : absenceBrut));
  const adjustments = money(input.adjustments);

  /* JOUR CHÔMÉ NON PAYÉ — une retenue, mais PAS une absence. Elle a sa propre
     colonne et sa propre ligne sur le bulletin : présenter ces francs comme une
     absence accuserait le salarié d'un manquement là où il n'y a qu'une journée
     que l'entreprise ne paie pas. */
  const retenueJourChome = money(input.retenue_jour_chome);
  /* LES RETARDS SUIVENT LA MÊME SÉPARATION, et se décident SÉPARÉMENT. Une
     période peut neutraliser ses absences et garder ses retards : ce sont deux
     décisions, chacune avec son motif et son auteur. Le brut reste lisible. */
  const lateBrut = Math.max(0, Number(
    input.late_minutes_brut != null ? input.late_minutes_brut : input.late_minutes || 0));
  const lateOfficiel = input.retards_non_retenus === true ? 0 : lateBrut;
  const retards = {
    late_minutes: lateOfficiel,
    late_minutes_brut: lateBrut,
    late_minutes_officiel: lateOfficiel,
    retards_neutralises: lateBrut - lateOfficiel,
  };
  const joursChomes = {
    jours_feries: Number(input.jours_feries || 0),
    jours_chomes_payes: Number(input.jours_chomes_payes || 0),
    jours_chomes_non_payes: Number(input.jours_chomes_non_payes || 0),
    travail_jour_chome_jours: Number(input.travail_jour_chome_jours || 0),
    repos_compensateur_jours: Number(input.repos_compensateur_jours || 0),
    retenue_jour_chome: retenueJourChome,
  };

  /* Les éléments de la période : primes, heures supplémentaires, retenues
     autorisées. Ils vivent hors de la ligne de paie et sont relus à chaque
     recalcul — c'est ce qui les fait survivre. */
  const primes = money(input.primes_total);
  const heuresSup = money(input.heures_sup_total);
  const heuresSupHeures = money(input.heures_sup_heures);
  const retenuesAutres = money(input.retenues_autres_total);
  const composantes = { primes_total: primes, heures_sup_total: heuresSup,
                        heures_sup_heures: heuresSupHeures,
                        retenues_autres_total: retenuesAutres };

  /* NON RÉMUNÉRÉ VOLONTAIREMENT — un directeur qui ne se verse pas de salaire.
     Sa base est zéro, et c'est un fait, pas une omission : la ligne est payable
     et ne bloque pas la paie. Ce cas ne se DÉDUIT jamais d'un salaire manquant ;
     il est posé explicitement sur la fiche du salarié. Les primes, elles,
     s'appliquent quand même : rien n'interdit d'indemniser quelqu'un qui n'a
     pas de salaire fixe. */
  if (input.non_remunere === true) {
    return {
      ...input, ...composantes, ...joursChomes, ...retards,
      monthly_salary: monthly ?? 0, daily_rate: daily ?? 0,
      absence_deduction: 0, absence_deduction_annulee: 0, adjustments,
      /* Rien à retenir sur un salaire qui n'existe pas : une journée chômée non
         payée ne peut pas coûter à qui ne perçoit rien. */
      retenue_jour_chome: 0,
      /* Les trois chemins de retour posent TOUS les trois valeurs. La colonne
         `absence_days` est NOT NULL : l'oublier sur un seul chemin — celui du
         directeur non rémunéré, par exemple — fait échouer toute la préparation
         avec une erreur qui ne nomme pas le cas. */
      absence_days: 0,
      absence_days_brut: absenceBrut, absence_days_officiel: 0,
      absences_neutralisees: absenceBrut,
      non_remunere: true,
      net_salary: Math.max(0, money(primes + heuresSup + adjustments - retenuesAutres)),
      status: "TO_PAY",
    };
  }

  /* Salaire non configuré : c'est une ANOMALIE, et elle doit se voir. La ligne
     reste BLOCKED et la soumission refuse. Traiter ce cas comme « non
     rémunéré » ferait passer un oubli pour une décision. */
  if (monthly == null || daily == null) {
    return { ...input, ...composantes, ...joursChomes, ...retards,
             absence_deduction: 0, absence_deduction_annulee: 0,
             absence_days: absenceBrut,
             absence_days_brut: absenceBrut, absence_days_officiel: absenceBrut,
             absences_neutralisees: 0,
             adjustments, net_salary: null, status: "BLOCKED" };
  }
  /* Ce qu'une absence aurait retiré. La période peut décider de ne pas le
     retirer — un mois où le pointage a été défaillant, par exemple. Les jours
     manquants restent alors comptés et VISIBLES sur le bulletin : ce qui
     change, c'est qu'ils ne coûtent rien. Affirmer à la place que la personne
     était présente serait écrire dans l'historique un fait que personne n'a
     constaté. */
  const retenueTheorique = money(absenceHorsException * daily);
  const exception = input.absences_non_retenues === true;
  const absenceDeduction = exception ? 0 : retenueTheorique;
  /* Le nombre d'absences OFFICIEL : zéro quand la période pose l'exception.
     Ce n'est pas une présence affirmée — les journées manquantes restent
     comptées dans le brut, et visibles. */
  const absenceOfficiel = exception ? 0 : absenceHorsException;
  return {
    ...input,
    ...composantes,
    ...joursChomes,
    ...retards,
    monthly_salary: monthly,
    daily_rate: daily,
    absence_days: absenceOfficiel,
    absence_days_brut: absenceBrut,
    absence_days_officiel: absenceOfficiel,
    absences_neutralisees: Math.max(0, absenceBrut - absenceOfficiel),
    absence_deduction: absenceDeduction,
    /* Ce que l'exception a coûté, chiffré. Sans cela, personne ne pourrait
       dire six mois plus tard ce que ce mois-là a représenté. */
    absence_deduction_annulee: exception ? retenueTheorique : 0,
    adjustments,
    /*   salaire de base
         + primes
         + heures supplémentaires
         + ajustements de pointage
         − retenue d'absence applicable
         − autres retenues autorisées
         = NET AVANT AVANCES
       La retenue d'avance est appliquée ensuite, par la préparation, parce
       qu'elle est plafonnée par ce net disponible. */
    /*   salaire de base
         + primes                     (dont compensation d'un jour chômé travaillé)
         + heures supplémentaires
         + ajustements de pointage
         − retenue d'absence applicable
         − retenue de jour chômé non payé   ← distincte de l'absence
         − autres retenues autorisées
         = NET AVANT AVANCES                                                */
    net_salary: Math.max(0, money(monthly + primes + heuresSup + adjustments
                                  - absenceDeduction - retenueJourChome - retenuesAutres)),
    status: "TO_PAY",
  };
}


/**
 * LA PAIE D'UNE PÉRIODE RÉELLE, DU 25 AU 24.
 *
 * `calculatePayroll()` (routes/attendance-workforce.js) calcule sur un mois
 * CIVIL. L'écran, lui, annonce une période du 25 au 24 : les deux ne
 * couvraient pas les mêmes journées, et personne ne pouvait le voir sans
 * recompter à la main. Une présence du 25 août tombait hors de la paie de
 * septembre alors qu'elle en fait partie, et une présence du 25 septembre y
 * tombait alors qu'elle appartient à octobre.
 *
 * Cette fonction part des BORNES de la période, telles qu'elles sont
 * enregistrées, et de la valeur EFFECTIVE de chaque journée :
 *
 *   1. une absence marquée par-dessus une régularisation l'emporte ;
 *   2. sinon la régularisation ;
 *   3. sinon le pointage brut ;
 *   4. sinon rien — et c'est une absence si la journée était due.
 *
 * Un jour non dû — dimanche, samedi chômé selon le réglage, jour férié — ne
 * compte ni comme attendu ni comme absence.
 */
async function calculerPaiePeriode(client, companyId, periode) {
  /* Le calendrier administratif d'abord : le moteur doit savoir ce qui est
     chômé AVANT de décider ce qui est une absence. Dans l'autre ordre, il
     faudrait défaire des absences déjà comptées — et chaque endroit qui les
     lit devrait refaire la soustraction. */
  const resolution = await JS.resolutionParSalarie(client, {
    companyId, debut: periode.date_debut, fin: periode.date_fin,
  });
  const pourLeMoteur = JS.pourLeMoteur(resolution);

  /* Les compensations de ceux qui ont travaillé un jour chômé deviennent des
     éléments de paie AVANT la lecture des éléments : elles sont ensuite lues
     comme n'importe quelle prime, et survivent donc au recalcul par le même
     mécanisme. L'index unique d'origine interdit le doublon. */
  await JS.genererCompensations(client, { companyId, periode, resolution });

  const { rows } = await client.query(
    `WITH cfg AS (
       SELECT COALESCE(saturday_mode, 'NORMAL') AS samedi,
              COALESCE(timezone, 'Africa/Bamako') AS tz
         FROM attendance_company_configuration WHERE company_id = $1
     ),
     /* LE CALENDRIER ADMINISTRATIF, déjà résolu par société, par salarié et par
        date. La portée — entreprise, site, entrepôt, service, catégorie,
        sélection nominative — est développée hors SQL : six sortes de portées
        dans cette requête l'auraient rendue illisible, et c'est cette requête
        qui décide de ce qu'on retient sur un salaire. */
     speciaux AS (
       SELECT (x->>'employee_id')::int  AS employee_id,
              (x->>'jour')::date        AS jour,
              (x->>'special_day_id')::bigint AS special_day_id,
              (x->>'est_chome')::boolean     AS est_chome,
              (x->>'est_paye')::boolean      AS est_paye,
              (x->>'pointage_requis')::boolean AS pointage_requis,
              x->>'impact_absence'  AS impact_absence,
              x->>'impact_salaire'  AS impact_salaire,
              x->>'type_key'        AS sp_type,
              x->>'traitement'      AS traitement
         FROM jsonb_array_elements(COALESCE($4::jsonb, '[]'::jsonb)) x
     ),
     jours AS (
       SELECT d::date AS jour, extract(isodow FROM d)::int AS isodow
         FROM generate_series(
          $2::date,
          LEAST(
            $3::date,
            (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Bamako')::date
          ),
          interval '1 day'
        ) d
     ),
     employes AS (
       SELECT e.id, e.employee_number, e.full_name, e.schedule_id, e.non_remunere
         FROM attendance_employees e
        WHERE e.company_id = $1 AND e.active
          AND e.effective_from <= $3::date
          AND (e.effective_to IS NULL OR e.effective_to >= $2::date)
     ),
     detail AS (
       SELECT e.id AS employee_id, e.employee_number, e.full_name,
              e.non_remunere, j.jour,
              /* PROGRAMMÉE : l'horaire du salarié prévoyait de travailler ce
                 jour-là. C'est la vue de la machine, celle du brut. */
              (d.id IS NOT NULL
               AND j.isodow <> 7
               AND ((SELECT samedi FROM cfg) = 'NORMAL' OR j.isodow <> 6)
               AND h.id IS NULL) AS programme,
              /* NEUTRALISÉE : une journée du calendrier administratif dont
                 l'absence de pointage ne vaut pas absence. C'est le cœur du
                 « pas de pointage + jour chômé payé ≠ absence » : la journée
                 sort des jours attendus AVANT qu'on compte les absences, et non
                 après, par une soustraction qu'il faudrait refaire partout. */
              (sp.special_day_id IS NOT NULL AND sp.impact_absence = 'AUCUNE') AS neutralisee,
              sp.special_day_id, sp.est_chome, sp.est_paye, sp.pointage_requis,
              sp.impact_salaire, sp.sp_type, sp.traitement,
              /* La personne était-elle là, au sens de la valeur retenue ? */
              CASE
                WHEN NULLIF(g.overridden_status, '') IS NOT NULL
                  THEN g.overridden_status IN ('PRESENT','LATE','COMPLETED')
                WHEN g.effective_check_in IS NOT NULL THEN true
                WHEN r.check_in IS NOT NULL THEN true
                ELSE false
              END AS presente,
              CASE
                WHEN NULLIF(g.overridden_status, '') IS NOT NULL
                  THEN CASE
                    WHEN g.overridden_status = 'LATE'
                      THEN COALESCE(r.late_minutes, 0)
                    ELSE 0
                  END
                WHEN g.effective_check_in IS NOT NULL
                  THEN 0
                ELSE COALESCE(r.late_minutes, 0)
              END AS retard
         FROM employes e
         CROSS JOIN jours j
         LEFT JOIN attendance_schedule_days d
           ON d.schedule_id = e.schedule_id AND d.iso_weekday = j.isodow AND d.is_working_day
         LEFT JOIN attendance_holidays h
           ON h.company_id = $1 AND h.holiday_date = j.jour
         LEFT JOIN attendance_day_records_v2 r
           ON r.company_id = $1 AND r.employee_id = e.id AND r.work_date = j.jour
         LEFT JOIN attendance_regularizations g
           ON g.company_id = $1 AND g.employee_id = e.id AND g.work_date = j.jour
         LEFT JOIN speciaux sp
           ON sp.employee_id = e.id AND sp.jour = j.jour
     ),
     totaux AS (
       SELECT employee_id, employee_number, full_name, bool_or(non_remunere) AS non_remunere,
              /* Attendus : les journées programmées que le calendrier n'a pas
                 neutralisées. Une journée chômée ne gonfle donc ni les jours
                 attendus ni les absences. */
              count(*) FILTER (WHERE programme AND NOT neutralisee)::int AS expected_days,
              count(*) FILTER (WHERE programme AND NOT neutralisee AND presente)::int AS attended_days,
              /* BRUT : ce que les pointages disent, calendrier et exception de
                 période mis de côté. Jamais remis à zéro. */
              count(*) FILTER (WHERE programme AND NOT presente)::int AS absence_days_brut,
              /* HORS EXCEPTION : ce qui resterait retenu sans l'exception de la
                 période — le calendrier administratif ayant déjà joué. */
              count(*) FILTER (WHERE programme AND NOT presente AND NOT neutralisee)::int
                AS absence_days_hors_exception,
              COALESCE(sum(retard) FILTER (WHERE presente), 0)::int AS late_minutes_brut,
              /* LES CATÉGORIES DE JOURNÉES, chacune comptée une seule fois.
                 Un férié n'est pas recompté en « jour chômé payé » : ce sont
                 deux lignes du résumé, pas deux fois la même journée. */
              count(*) FILTER (WHERE programme AND NOT presente
                               AND sp_type = 'JOUR_FERIE')::int AS jours_feries,
              count(*) FILTER (WHERE programme AND NOT presente AND est_chome AND est_paye
                               AND sp_type <> 'JOUR_FERIE')::int AS jours_chomes_payes,
              count(*) FILTER (WHERE programme AND NOT presente AND est_chome
                               AND NOT est_paye)::int AS jours_chomes_non_payes,
              /* Celui qui a réellement travaillé un jour chômé : son pointage
                 est conservé tel quel, et la journée est comptée à part — pas
                 dans les jours travaillés ordinaires. */
              count(*) FILTER (WHERE est_chome AND presente)::int AS travail_jour_chome_jours,
              count(*) FILTER (WHERE est_chome AND presente
                               AND traitement = 'REPOS_COMPENSATEUR')::int AS repos_compensateur_jours
         FROM detail
        GROUP BY employee_id, employee_number, full_name
     )
     SELECT t.employee_id AS id, t.employee_number, t.full_name, t.non_remunere,
            t.expected_days, t.attended_days,
            t.absence_days_brut, t.absence_days_hors_exception,
            t.late_minutes_brut,
            t.jours_feries, t.jours_chomes_payes, t.jours_chomes_non_payes,
            t.travail_jour_chome_jours, t.repos_compensateur_jours,
            s.monthly_salary, s.daily_rate,
            COALESCE((SELECT sum(a.amount) FROM attendance_salary_adjustments_v2 a
                       WHERE a.company_id = $1 AND a.employee_id = t.employee_id
                         AND a.work_date BETWEEN $2::date AND $3::date), 0) AS adjustments
       FROM totaux t
       LEFT JOIN LATERAL (
         SELECT monthly_salary, daily_rate
           FROM attendance_salary_settings_v2 v
          WHERE v.company_id = $1 AND v.employee_id = t.employee_id
            AND v.effective_from <= $3::date
          ORDER BY v.effective_from DESC LIMIT 1
       ) s ON true
      ORDER BY t.employee_number`,
    [companyId, periode.date_debut, periode.date_fin, JSON.stringify(pourLeMoteur)]
  );
  /* L'exception appartient à la PÉRIODE, pas à l'entreprise : la période
     suivante repart au comportement normal sans qu'on ait à défaire quoi que
     ce soit. */
  const exception = periode.absences_non_retenues === true;

  /* Les éléments de paie de la période, relus à chaque préparation. Une prime
     saisie avant un recalcul reste donc sur le bulletin après. */
  const elements = await ELEMENTS.elementsDeLaPeriode(client, {
    companyId, periodCode: periode.code,
  });
  const parSalarie = ELEMENTS.totauxParSalarie(elements);

  return rows.map((r) => {
    const t = ELEMENTS.totauxDe(parSalarie, r.id);
    /* Une journée chômée NON PAYÉE se retient, mais ce n'est pas une absence :
       la retenue est calculée ici, sur le taux journalier, et portée par sa
       propre colonne jusqu'au bulletin. */
    const retenueJourChome = Number(r.jours_chomes_non_payes || 0) * Number(r.daily_rate || 0);
    return calculatePayrollLine({
      ...r,
      retenue_jour_chome: retenueJourChome,
      absences_non_retenues: exception,
      retards_non_retenus: periode.retards_non_retenus === true,
      primes_total: t.primes_total,
      heures_sup_total: t.heures_sup_total,
      heures_sup_heures: t.heures_sup_heures,
      retenues_autres_total: t.retenues_autres_total,
      elements: t.details,
    });
  });
}

function assertPaymentMethod(value) {
  const method = String(value || "").trim().toUpperCase();
  const allowed = new Set(["CASH","BANK","CASHBOX","TRANSFER","CHECK","MOBILE_MONEY"]);
  if (!allowed.has(method)) {
    const error = new Error("Mode de paiement invalide.");
    error.httpStatus = 400;
    error.code = "PAYROLL_PAYMENT_METHOD_INVALID";
    throw error;
  }
  return method;
}

/**
 * OBSOLÈTE — NE DÉCIDE PLUS D'UN PAIEMENT.
 *
 * Cette fonction accordait la paie à quiconque portait le rôle « comptable »,
 * avant même de regarder les permissions. Un administrateur pouvait donc poser
 * DENY sur `paie|pay`, voir le bouton disparaître de l'écran — et le comptable
 * payait quand même en appelant la route directement. Le refus n'existait
 * qu'à l'écran.
 *
 * Deux moteurs décidaient d'un même paiement, et le mauvais gagnait parce
 * qu'il répondait le premier. Les routes de paie passent désormais toutes par
 * `requirePermission("paie", …)` : un seul moteur, celui que l'écran des
 * droits pilote.
 *
 * Les autorisations de `attendance_payroll_authorizations` ont été reportées
 * en exceptions personnelles par la migration 089 — personne n'a rien perdu,
 * et ce qui était accordé se voit maintenant à l'écran des droits.
 *
 * La fonction reste, sans le repli par rôle, pour les appelants historiques
 * qui n'ont pas encore de garde de permission. Elle n'accorde plus rien
 * qu'une ligne d'autorisation explicite ne dise.
 */
async function canManagePayroll(client, companyId, user, action = "prepare") {
  if (user?.is_super_admin === true) return true;
  const role = String(user?.role || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (role === "super_admin") return true;
  const column = action === "pay" ? "can_pay" : "can_prepare";
  const { rows } = await client.query(
    `SELECT 1 FROM attendance_payroll_authorizations
      WHERE company_id=$1 AND user_id=$2 AND ${column}=true LIMIT 1`,
    [companyId,user?.id]
  );
  return Boolean(rows[0]);
}

module.exports = { calculatePayrollLine, calculerPaiePeriode, assertPaymentMethod, canManagePayroll };

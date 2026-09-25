-- ═══════════════════════════════════════════════════════════════════════════
-- POURQUOI UNE AVANCE « EN REMBOURSEMENT » N'EST-ELLE PAS RETENUE SUR LA PAIE ?
--
-- LECTURE SEULE. Aucun INSERT, UPDATE, DELETE, DROP ni TRUNCATE.
-- Sans effet sur les données. Peut être lancé en production sans risque.
--
--   psql "$DATABASE_URL" -v periode="'2026-09'" -f scripts/diagnostic-avances-paie.sql
--
-- La période est le `code` de la période de paie examinée (attendance_periods.code).
-- À défaut de -v, 2026-09 est utilisée.
--
-- La retenue exige SIX conditions simultanées (services/avances-salaire.js,
-- retenueDue). Ce diagnostic dit, avance par avance, LAQUELLE manque.
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
\if :{?periode} \else \set periode '''2026-09''' \endif
\pset pager off

\echo ''
\echo '════ 1. LES AVANCES ENCORE DUES, ET CE QUE LA PAIE EN FERAIT ════'
SELECT
  a.company_id            AS societe,
  a.id                    AS avance,
  a.reference,
  e.employee_number       AS matricule,
  e.full_name             AS salarie,
  e.active                AS salarie_actif,
  a.status                AS statut_avance,
  a.balance               AS solde_du,
  a.installment_amount    AS mensualite_prevue,
  a.first_period_code     AS premier_code,
  (SELECT count(*) FROM salary_advance_installments i WHERE i.advance_id = a.id)      AS nb_echeances,
  (SELECT count(*) FROM salary_advance_installments i
    WHERE i.advance_id = a.id AND i.status = 'A_VENIR')                               AS nb_a_venir,
  (SELECT count(*) FROM salary_advance_installments i
    WHERE i.advance_id = a.id AND i.status = 'A_VENIR'
      AND i.company_id = a.company_id AND i.period_code <= :periode)                  AS nb_exigibles,
  CASE
    WHEN a.balance <= 0 THEN 'RIEN À RETENIR — soldée'
    WHEN a.status NOT IN ('VERSEE','EN_REMBOURSEMENT')
      THEN 'IGNORÉE — statut ' || a.status || ' hors périmètre de retenue'
    WHEN e.id IS NULL
      THEN 'ANOMALIE — employee_id ' || a.employee_id || ' ne correspond à AUCUNE fiche salarié'
    WHEN e.company_id <> a.company_id
      THEN 'ANOMALIE — fiche salarié en société ' || e.company_id || ', avance en société ' || a.company_id
    WHEN (SELECT count(*) FROM salary_advance_installments i WHERE i.advance_id = a.id) = 0
      THEN 'ANOMALIE — AUCUN échéancier : la retenue ne peut pas être calculée'
    WHEN (SELECT count(*) FROM salary_advance_installments i
           WHERE i.advance_id = a.id AND i.company_id <> a.company_id) > 0
      THEN 'ANOMALIE — échéance(s) rattachée(s) à une autre société'
    WHEN (SELECT count(*) FROM salary_advance_installments i
           WHERE i.advance_id = a.id AND i.period_code !~ '^[0-9]{4}-[0-9]{2}$') > 0
      THEN 'ANOMALIE — period_code malformé : ' ||
           (SELECT string_agg(DISTINCT i.period_code, ', ') FROM salary_advance_installments i
             WHERE i.advance_id = a.id AND i.period_code !~ '^[0-9]{4}-[0-9]{2}$')
    WHEN (SELECT count(*) FROM salary_advance_installments i
           WHERE i.advance_id = a.id AND i.status = 'A_VENIR') = 0
      THEN 'À VÉRIFIER — plus aucune échéance À VENIR alors que le solde est dû'
    WHEN (SELECT count(*) FROM salary_advance_installments i
           WHERE i.advance_id = a.id AND i.status = 'A_VENIR' AND i.period_code <= :periode) = 0
      THEN 'NORMAL — prochaine échéance après ' || :periode || ' (pas encore exigible)'
    ELSE 'RETENUE ATTENDUE : ' ||
      (SELECT COALESCE(sum(LEAST(i.amount_due - i.amount_taken, a.balance)), 0)::text
         FROM salary_advance_installments i
        WHERE i.advance_id = a.id AND i.status = 'A_VENIR'
          AND i.company_id = a.company_id AND i.period_code <= :periode) || ' FCFA'
  END AS verdict
FROM salary_advances a
LEFT JOIN attendance_employees e ON e.id = a.employee_id
WHERE a.balance > 0
ORDER BY a.company_id, e.employee_number NULLS FIRST, a.id;

\echo ''
\echo '════ 2. DÉTAIL DE CHAQUE ÉCHÉANCE DES AVANCES ENCORE DUES ════'
SELECT a.company_id AS societe, e.full_name AS salarie, a.reference,
       i.rank AS rang, i.period_code, i.status AS statut_echeance,
       i.amount_due AS du, i.amount_taken AS deja_retenu,
       i.company_id AS societe_echeance,
       (i.period_code ~ '^[0-9]{4}-[0-9]{2}$') AS code_bien_forme,
       (i.period_code <= :periode) AS exigible_pour_la_periode
  FROM salary_advances a
  JOIN salary_advance_installments i ON i.advance_id = a.id
  LEFT JOIN attendance_employees e ON e.id = a.employee_id
 WHERE a.balance > 0
 ORDER BY a.company_id, e.full_name, a.id, i.rank;

\echo ''
\echo '════ 3. CE QUE LA PAIE PRÉPARÉE A RÉELLEMENT RETENU ════'
SELECT r.company_id AS societe, r.id AS paie, r.period_month::text AS mois,
       r.status AS statut_paie,
       it.employee_id, it.employee_name AS salarie,
       it.monthly_salary AS salaire_base, it.absence_deduction AS retenue_absence,
       it.advance_deduction AS avance_retenue, it.net_salary AS net, it.status AS statut_ligne,
       (SELECT COALESCE(sum(balance),0) FROM salary_advances a WHERE a.employee_id = it.employee_id) AS solde_avances,
       CASE
         WHEN (SELECT COALESCE(sum(balance),0) FROM salary_advances a
                WHERE a.employee_id = it.employee_id
                  AND a.status IN ('VERSEE','EN_REMBOURSEMENT')) > 0
              AND COALESCE(it.advance_deduction,0) = 0
           THEN '⚠ AVANCE DUE MAIS RIEN RETENU — voir section 1'
         ELSE 'cohérent'
       END AS coherence
  FROM attendance_payroll_runs_v2 r
  JOIN attendance_payroll_items_v2 it ON it.payroll_run_id = r.id
 ORDER BY r.company_id, r.period_month DESC, it.employee_name;

\echo ''
\echo '════ 4. DOUBLE RETENUE ? (une même échéance retenue deux fois) ════'
SELECT i.advance_id, i.id AS echeance, i.period_code, i.amount_due AS du,
       i.amount_taken AS marque_retenu,
       count(rp.id) AS nb_remboursements_lies,
       COALESCE(sum(rp.amount),0) AS total_rembourse_sur_cette_echeance,
       CASE WHEN COALESCE(sum(rp.amount),0) > i.amount_due
            THEN '⚠ RETENU AU-DELÀ DU DÛ' ELSE 'cohérent' END AS verdict
  FROM salary_advance_installments i
  LEFT JOIN salary_advance_repayments rp ON rp.installment_id = i.id AND rp.origin = 'RETENUE_PAIE'
 GROUP BY i.id, i.advance_id, i.period_code, i.amount_due, i.amount_taken
HAVING count(rp.id) > 1 OR COALESCE(sum(rp.amount),0) > i.amount_due
 ORDER BY i.advance_id, i.id;

\echo ''
\echo '════ 5. LE SOLDE EST-IL COHÉRENT AVEC LE JOURNAL DES REMBOURSEMENTS ? ════'
SELECT a.company_id AS societe, e.full_name AS salarie, a.reference,
       a.amount_paid AS verse, a.balance AS solde_affiche,
       COALESCE(sum(rp.amount) FILTER (WHERE rp.origin <> 'CONTREPASSATION'), 0)
         - COALESCE(sum(rp.amount) FILTER (WHERE rp.origin = 'CONTREPASSATION'), 0) AS total_rembourse,
       a.amount_paid - (COALESCE(sum(rp.amount) FILTER (WHERE rp.origin <> 'CONTREPASSATION'), 0)
         - COALESCE(sum(rp.amount) FILTER (WHERE rp.origin = 'CONTREPASSATION'), 0)) AS solde_recalcule,
       CASE WHEN a.balance <> a.amount_paid - (COALESCE(sum(rp.amount) FILTER (WHERE rp.origin <> 'CONTREPASSATION'), 0)
              - COALESCE(sum(rp.amount) FILTER (WHERE rp.origin = 'CONTREPASSATION'), 0))
            THEN '⚠ ÉCART' ELSE 'cohérent' END AS verdict
  FROM salary_advances a
  LEFT JOIN salary_advance_repayments rp ON rp.advance_id = a.id
  LEFT JOIN attendance_employees e ON e.id = a.employee_id
 GROUP BY a.id, a.company_id, e.full_name, a.reference, a.amount_paid, a.balance
 ORDER BY verdict DESC, a.company_id, e.full_name;

\echo ''
\echo '════ 6. SALARIÉS EN DOUBLE (une avance peut viser la mauvaise fiche) ════'
SELECT company_id AS societe, full_name AS salarie,
       count(*) AS nb_fiches,
       string_agg(id::text || CASE WHEN active THEN ' (actif)' ELSE ' (retiré)' END, ', ' ORDER BY id) AS fiches
  FROM attendance_employees
 GROUP BY company_id, lower(full_name), full_name
HAVING count(*) > 1
 ORDER BY company_id, full_name;

\echo ''
\echo '════ 7. LA PÉRIODE DE PAIE EXAMINÉE ════'
SELECT company_id AS societe, code, date_debut, date_fin, status
  FROM attendance_periods ORDER BY company_id, code DESC LIMIT 10;

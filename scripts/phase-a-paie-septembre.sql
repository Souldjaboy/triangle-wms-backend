-- ═══════════════════════════════════════════════════════════════════════════
-- PHASE A — ÉTAT DE LA PAIE DE SEPTEMBRE 2026, AVANT TOUTE ÉCRITURE
--
-- LECTURE SEULE. Aucun INSERT, UPDATE, DELETE, DROP ni TRUNCATE.
-- Sans effet sur les données. Ne déclenche aucun paiement.
--
--   psql "$DATABASE_URL" -v societe=1 -v periode="'2026-09'" \
--        -f scripts/phase-a-paie-septembre.sql
--
-- Douze sections, dans l'ordre de la demande. La dernière calcule ce que la
-- paie donnera APRÈS l'exception d'absences, sans rien écrire : c'est ce
-- tableau qu'il faut lire avant de décider.
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
\if :{?societe} \else \set societe 1 \endif
\if :{?periode} \else \set periode '''2026-09''' \endif
\pset pager off

\echo ''
\echo '════ 1-2. LA PÉRIODE ════'
SELECT id, company_id AS societe, code, date_debut, date_fin, status,
       attendance_validated_by AS pointage_valide_par, attendance_validated_at AS le,
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_name='attendance_periods' AND column_name='absences_non_retenues')
            THEN 'colonne présente (migration 098 appliquée)'
            ELSE 'migration 098 PAS ENCORE appliquée' END AS exception_absences
  FROM attendance_periods WHERE company_id = :societe AND code = :periode;

\echo ''
\echo '════ 3. LA PAIE (payroll run) ════'
SELECT r.id AS paie, r.period_id, r.period_month::text AS mois, r.status AS statut,
       r.gross_amount AS brut, r.deductions_amount AS retenues,
       r.adjustments_amount AS ajustements, r.net_amount AS net,
       u.fullname AS preparee_par, r.prepared_at AS le
  FROM attendance_payroll_runs_v2 r
  LEFT JOIN users u ON u.id = r.prepared_by
 WHERE r.company_id = :societe AND to_char(r.period_month,'YYYY-MM') = :periode;

\echo ''
\echo '════ 4-6. SOUMISSION, AUTEUR, DÉCISION ════'
SELECT q.id AS demande, q.status AS statut, q.amount_submitted AS montant_soumis,
       q.submitted_by AS auteur_id, q.submitted_by_name AS auteur, q.submitted_at AS soumis_le,
       q.decided_by_name AS decide_par, q.decided_at AS decide_le, q.decision_reason AS motif,
       (SELECT is_super_admin FROM users WHERE id = q.submitted_by) AS auteur_est_super_admin,
       CASE
         WHEN q.status = 'EN_ATTENTE_DIRECTION'
           THEN '⚠ EN ATTENTE — c''est cette soumission qu''il faut retirer'
         ELSE 'close' END AS verdict
  FROM payroll_requests q
  JOIN attendance_payroll_runs_v2 r ON r.id = q.payroll_run_id
 WHERE q.company_id = :societe AND to_char(r.period_month,'YYYY-MM') = :periode
 ORDER BY q.submitted_at DESC;

\echo ''
\echo '════ 7. LES SALARIÉS ÉLIGIBLES, ET CE QUI LEUR MANQUE ════'
SELECT * FROM (
SELECT e.id, e.employee_number AS matricule, e.full_name AS salarie, e.active AS actif,
       e.effective_from, e.effective_to,
       s.monthly_salary AS salaire_mensuel, s.daily_rate AS taux_jour,
       (it.id IS NOT NULL) AS a_une_ligne_de_paie,
       u.is_active AS compte_actif,
       CASE
         WHEN NOT e.active THEN 'RETIRÉ — absent de la paie, normal'
         WHEN e.effective_from > p.date_fin THEN 'entré après la période — hors paie, normal'
         WHEN e.effective_to IS NOT NULL AND e.effective_to < p.date_debut THEN 'sorti avant la période — hors paie, normal'
         WHEN s.monthly_salary IS NULL AND s.daily_rate IS NULL THEN '⚠ AUCUN SALAIRE CONFIGURÉ — la ligne sera BLOCKED'
         WHEN s.monthly_salary IS NULL THEN '⚠ salaire mensuel absent — ligne BLOCKED'
         WHEN s.daily_rate IS NULL THEN '⚠ taux journalier absent — ligne BLOCKED'
         WHEN it.id IS NULL THEN '⚠ ÉLIGIBLE MAIS ABSENT DE LA PAIE'
         ELSE 'présent dans la paie' END AS verdict
  FROM attendance_employees e
  CROSS JOIN (SELECT date_debut, date_fin, id FROM attendance_periods
               WHERE company_id = :societe AND code = :periode) p
  LEFT JOIN LATERAL (
    SELECT monthly_salary, daily_rate FROM attendance_salary_settings_v2 v
     WHERE v.company_id = e.company_id AND v.employee_id = e.id
       AND v.effective_from <= p.date_fin
     ORDER BY v.effective_from DESC LIMIT 1) s ON true
  LEFT JOIN attendance_payroll_runs_v2 r
         ON r.company_id = :societe AND r.period_id = p.id
  LEFT JOIN attendance_payroll_items_v2 it ON it.payroll_run_id = r.id AND it.employee_id = e.id
  LEFT JOIN users u ON u.id = e.user_id
 WHERE e.company_id = :societe
) q ORDER BY (q.verdict LIKE '⚠%') DESC, q.matricule;

\echo ''
\echo '════ 7bis. DOUBLONS ÉVENTUELS ════'
SELECT 'fiche salarié en double' AS type, full_name AS valeur, count(*) AS nb
  FROM attendance_employees WHERE company_id = :societe
 GROUP BY lower(full_name), full_name HAVING count(*) > 1
UNION ALL
SELECT 'ligne de paie en double', it.employee_name, count(*)
  FROM attendance_payroll_items_v2 it
  JOIN attendance_payroll_runs_v2 r ON r.id = it.payroll_run_id
 WHERE r.company_id = :societe AND to_char(r.period_month,'YYYY-MM') = :periode
 GROUP BY it.employee_id, it.employee_name HAVING count(*) > 1;

\echo ''
\echo '════ 8-9. LES LIGNES DE PAIE : ÉTAT ACTUEL (avant exception) ════'
SELECT it.employee_name AS salarie, it.monthly_salary AS salaire_mensuel,
       it.expected_days AS jours_dus, it.attended_days AS jours_reconnus,
       it.absence_days AS absences, it.late_minutes AS retard_minutes,
       it.absence_deduction AS retenue_absence,
       it.advance_deduction AS avance_retenue,
       it.adjustments AS ajustements,
       it.net_salary AS net_actuel, it.status AS statut
  FROM attendance_payroll_items_v2 it
  JOIN attendance_payroll_runs_v2 r ON r.id = it.payroll_run_id
 WHERE r.company_id = :societe AND to_char(r.period_month,'YYYY-MM') = :periode
 ORDER BY it.employee_name;

\echo ''
\echo '════ 10. AVANCES ET REMBOURSEMENTS DE LA PÉRIODE ════'
SELECT e.full_name AS salarie, a.reference AS avance, a.status AS statut_avance,
       a.amount_paid AS verse, a.balance AS solde_du, a.installment_amount AS mensualite,
       i.period_code AS echeance, i.status AS statut_echeance,
       i.amount_due AS du, i.amount_taken AS deja_retenu,
       rp.id AS remboursement, rp.amount AS montant_rembourse,
       rp.payroll_item_id AS rattache_a_la_ligne,
       CASE WHEN rp.id IS NULL THEN 'aucun remboursement sur cette échéance'
            WHEN rp.payroll_item_id IS NULL THEN '⚠ retenue enregistrée HORS paie (sera affichée, pas recréée)'
            ELSE 'retenue produite par la paie' END AS verdict
  FROM salary_advances a
  JOIN attendance_employees e ON e.id = a.employee_id
  LEFT JOIN salary_advance_installments i ON i.advance_id = a.id
  LEFT JOIN salary_advance_repayments rp ON rp.installment_id = i.id AND rp.origin = 'RETENUE_PAIE'
 WHERE a.company_id = :societe
 ORDER BY e.full_name, a.reference, i.rank;

\echo ''
\echo '════ 11. AJUSTEMENTS SALARIAUX — l''origine des écarts (ex. Hawa +25 000) ════'
SELECT e.full_name AS salarie, adj.id, adj.work_date AS date_effet, adj.amount AS montant,
       adj.reason AS motif, u.fullname AS saisi_par, adj.created_at AS enregistre_le
  FROM attendance_salary_adjustments_v2 adj
  JOIN attendance_employees e ON e.id = adj.employee_id
  LEFT JOIN users u ON u.id = adj.created_by
  JOIN attendance_periods p ON p.company_id = :societe AND p.code = :periode
 WHERE adj.company_id = :societe
   AND adj.work_date BETWEEN p.date_debut AND p.date_fin
 ORDER BY e.full_name, adj.work_date;

\echo ''
\echo '════ 12. CE QUE LA PAIE DONNERA APRÈS L''EXCEPTION D''ABSENCES ════'
\echo '     (simulation — aucune écriture ; « net_apres » est le net attendu)'
SELECT it.employee_name AS salarie,
       it.monthly_salary AS salaire,
       it.absence_days AS absences_constatees,
       it.absence_deduction AS retenue_absence_avant,
       0::numeric AS retenue_absence_apres,
       it.advance_deduction AS avance_retenue,
       it.adjustments AS ajustements,
       it.net_salary AS net_avant,
       GREATEST(0, it.monthly_salary + it.adjustments - COALESCE(it.advance_deduction,0)) AS net_apres,
       (GREATEST(0, it.monthly_salary + it.adjustments - COALESCE(it.advance_deduction,0)) - it.net_salary) AS ecart
  FROM attendance_payroll_items_v2 it
  JOIN attendance_payroll_runs_v2 r ON r.id = it.payroll_run_id
 WHERE r.company_id = :societe AND to_char(r.period_month,'YYYY-MM') = :periode
 ORDER BY it.employee_name;

\echo ''
\echo '════ 12bis. TOTAUX ════'
SELECT count(*) AS nb_lignes,
       sum(it.monthly_salary) AS total_salaires,
       sum(it.absence_deduction) AS total_retenue_absence_avant,
       sum(COALESCE(it.advance_deduction,0)) AS total_avances_retenues,
       sum(it.adjustments) AS total_ajustements,
       sum(it.net_salary) AS total_net_avant,
       sum(GREATEST(0, it.monthly_salary + it.adjustments - COALESCE(it.advance_deduction,0))) AS total_net_apres
  FROM attendance_payroll_items_v2 it
  JOIN attendance_payroll_runs_v2 r ON r.id = it.payroll_run_id
 WHERE r.company_id = :societe AND to_char(r.period_month,'YYYY-MM') = :periode;

\echo ''
\echo '════ CONTRÔLE : AUCUNE AUTRE SOCIÉTÉ N''EST CONCERNÉE ════'
SELECT company_id AS societe, count(*) AS periodes_2026_09
  FROM attendance_periods WHERE code = :periode GROUP BY company_id ORDER BY company_id;

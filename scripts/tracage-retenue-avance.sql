-- ═══════════════════════════════════════════════════════════════════════════
-- POURQUOI UNE RETENUE EXISTE-T-ELLE SANS APPARAÎTRE SUR LA PAIE ?
--
-- LECTURE SEULE. Aucun INSERT, UPDATE, DELETE, DROP ni TRUNCATE.
--
--   psql "$DATABASE_URL" -v periode="'2026-09'" -f scripts/tracage-retenue-avance.sql
--
-- La différence entre un salarié dont la retenue s'affiche et un salarié dont
-- elle ne s'affiche pas tient à UNE colonne : salary_advance_repayments
-- .payroll_item_id. Quand elle pointe une ligne de paie, l'écran montre la
-- retenue. Quand elle est NULL, la retenue existe, le solde est à jour, et la
-- paie n'en sait rien — le bulletin annonce un net qui ne correspond pas à ce
-- que le salarié touche.
--
-- Ce script montre cette colonne pour chaque remboursement, et conclut.
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
\if :{?periode} \else \set periode '''2026-09''' \endif
\pset pager off

\echo ''
\echo '════ 1. LE JOURNAL DES REMBOURSEMENTS, AVEC SON LIEN VERS LA PAIE ════'
SELECT e.full_name AS salarie, a.reference AS avance,
       rp.id AS remboursement, rp.amount AS montant, rp.origin AS origine,
       rp.installment_id AS echeance, i.period_code AS periode_echeance,
       rp.payroll_item_id AS ligne_de_paie,
       CASE WHEN rp.payroll_item_id IS NULL
            THEN '⚠ AUCUN LIEN — invisible pour la paie'
            ELSE 'lié' END AS lien,
       rp.performed_by_name AS auteur, rp.created_at::date AS le,
       rp.balance_before AS solde_avant, rp.balance_after AS solde_apres
  FROM salary_advance_repayments rp
  JOIN salary_advances a ON a.id = rp.advance_id
  LEFT JOIN salary_advance_installments i ON i.id = rp.installment_id
  LEFT JOIN attendance_employees e ON e.id = a.employee_id
 ORDER BY e.full_name, a.reference, rp.created_at, rp.id;

\echo ''
\echo '════ 2. LA DIFFÉRENCE EXACTE ENTRE LES SALARIÉS ════'
\echo '     (comparez ici Souleymane, Hawa et Malamine)'
SELECT e.full_name AS salarie, a.reference AS avance, a.balance AS solde,
       count(rp.id)                                                AS nb_remboursements,
       count(rp.id) FILTER (WHERE rp.payroll_item_id IS NOT NULL)  AS lies_a_une_paie,
       count(rp.id) FILTER (WHERE rp.payroll_item_id IS NULL)      AS orphelins,
       COALESCE(sum(rp.amount) FILTER (WHERE rp.payroll_item_id IS NULL), 0) AS montant_orphelin,
       CASE
         WHEN count(rp.id) = 0 THEN 'aucun remboursement'
         WHEN count(rp.id) FILTER (WHERE rp.payroll_item_id IS NULL) = 0
           THEN 'SAIN — toutes les retenues sont rattachées à une paie'
         WHEN count(rp.id) FILTER (WHERE rp.payroll_item_id IS NOT NULL) = 0
           THEN '⚠ TOUTES les retenues sont orphelines (import historique probable)'
         ELSE '⚠ MÉLANGE : certaines retenues rattachées, d''autres non'
       END AS verdict
  FROM salary_advances a
  LEFT JOIN salary_advance_repayments rp ON rp.advance_id = a.id
  LEFT JOIN attendance_employees e ON e.id = a.employee_id
 GROUP BY a.id, e.full_name, a.reference, a.balance
 ORDER BY verdict DESC, e.full_name;

\echo ''
\echo '════ 3. RETENUE DE LA PÉRIODE : CE QUE LE JOURNAL DIT vs CE QUE LA PAIE AFFICHE ════'
WITH paie AS (
  SELECT r.id AS run_id, r.company_id, r.status AS statut_paie, it.id AS ligne_id,
         it.employee_id, it.employee_name, it.monthly_salary, it.adjustments,
         it.absence_deduction, it.advance_deduction, it.net_salary
    FROM attendance_payroll_runs_v2 r
    JOIN attendance_payroll_items_v2 it ON it.payroll_run_id = r.id
   WHERE to_char(r.period_month, 'YYYY-MM') = :periode
), journal AS (
  SELECT a.employee_id,
         COALESCE(sum(rp.amount), 0) AS retenu_selon_journal,
         COALESCE(sum(rp.amount) FILTER (WHERE rp.payroll_item_id IS NULL), 0) AS dont_orphelin
    FROM salary_advance_repayments rp
    JOIN salary_advances a ON a.id = rp.advance_id
    JOIN salary_advance_installments i ON i.id = rp.installment_id
   WHERE rp.origin = 'RETENUE_PAIE' AND i.period_code = :periode
   GROUP BY a.employee_id
)
SELECT p.employee_name AS salarie, p.statut_paie,
       p.monthly_salary AS salaire_base, p.adjustments AS ajustements,
       p.absence_deduction AS retenue_absence,
       p.advance_deduction AS avance_affichee,
       COALESCE(j.retenu_selon_journal, 0) AS avance_selon_journal,
       COALESCE(j.dont_orphelin, 0) AS dont_orpheline,
       p.net_salary AS net_affiche,
       (p.monthly_salary - p.absence_deduction + p.adjustments - COALESCE(j.retenu_selon_journal,0)) AS net_si_journal_applique,
       CASE
         WHEN COALESCE(j.retenu_selon_journal,0) = COALESCE(p.advance_deduction,0) THEN 'cohérent'
         ELSE '⚠ ÉCART de ' || (COALESCE(j.retenu_selon_journal,0) - COALESCE(p.advance_deduction,0))::text
              || ' FCFA entre le journal et la paie'
       END AS verdict
  FROM paie p LEFT JOIN journal j ON j.employee_id = p.employee_id
 ORDER BY verdict DESC, p.employee_name;

\echo ''
\echo '════ 4. D''OÙ VIENT UN NET SUPÉRIEUR AU SALAIRE DE BASE ? (ajustements) ════'
SELECT e.full_name AS salarie, adj.work_date AS le, adj.amount AS montant,
       adj.reason AS motif, u.fullname AS saisi_par, adj.created_at::date AS enregistre_le
  FROM attendance_salary_adjustments_v2 adj
  JOIN attendance_employees e ON e.id = adj.employee_id
  LEFT JOIN users u ON u.id = adj.created_by
 WHERE to_char(adj.work_date, 'YYYY-MM') >= (:periode::text)
    OR adj.work_date >= (to_date(:periode || '-01','YYYY-MM-DD') - interval '1 month')::date
 ORDER BY e.full_name, adj.work_date;

\echo ''
\echo '════ 5. LA PROTECTION ANTI-DOUBLE-RETENUE COUVRE-T-ELLE TOUT ? ════'
\echo '     (l''index unique ne s''applique QUE si payroll_item_id IS NOT NULL)'
SELECT a.reference AS avance, e.full_name AS salarie, i.period_code AS periode,
       count(rp.id) AS nb_retenues_sur_cette_echeance,
       COALESCE(sum(rp.amount),0) AS total, i.amount_due AS du,
       CASE WHEN COALESCE(sum(rp.amount),0) > i.amount_due THEN '⚠ AU-DELÀ DU DÛ'
            WHEN count(rp.id) > 1 THEN '⚠ PLUSIEURS RETENUES sur la même échéance'
            ELSE 'cohérent' END AS verdict
  FROM salary_advance_installments i
  JOIN salary_advances a ON a.id = i.advance_id
  LEFT JOIN attendance_employees e ON e.id = a.employee_id
  LEFT JOIN salary_advance_repayments rp ON rp.installment_id = i.id AND rp.origin = 'RETENUE_PAIE'
 GROUP BY i.id, a.reference, e.full_name, i.period_code, i.amount_due
HAVING count(rp.id) > 1 OR COALESCE(sum(rp.amount),0) > i.amount_due
 ORDER BY e.full_name, i.period_code;

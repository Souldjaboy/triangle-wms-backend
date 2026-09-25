-- ═══════════════════════════════════════════════════════════════════════════
-- APERÇU AVANT DÉCISION : LES RETENUES HISTORIQUES SONT-ELLES BIEN DATÉES ?
--
-- LECTURE SEULE. Aucune écriture. Aucun script de réparation n'est fourni ici :
-- il n'y a rien à réparer tant que cette question n'est pas tranchée par vous.
--
--   psql "$DATABASE_URL" -f scripts/apercu-retenues-historiques.sql
--
-- Le correctif de code fait que la paie AFFICHE désormais les retenues déjà
-- enregistrées pour la période. Conséquence concrète : le net d'un salarié
-- concerné baisse du montant de sa retenue.
--
-- Cela n'est juste QUE SI le `period_code` de l'échéance correspond bien au
-- mois où l'argent a réellement été retenu sur le salaire. Si l'import a daté
-- 2026-09 une retenue effectuée en juillet, le net de septembre baisserait à
-- tort — et il faudrait corriger la DATE de l'échéance, jamais la paie.
--
-- Cette requête montre, pour chaque retenue non rattachée à une paie, ce que
-- le correctif va produire, afin que vous validiez avant déploiement.
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
\pset pager off

\echo ''
\echo '════ CE QUE LE CORRECTIF VA AFFICHER, PAIE PAR PAIE ════'
WITH orphelines AS (
  SELECT a.company_id, a.employee_id, a.reference, i.period_code,
         rp.id AS remboursement, rp.amount, rp.created_at::date AS enregistre_le,
         rp.performed_by_name AS par
    FROM salary_advance_repayments rp
    JOIN salary_advances a ON a.id = rp.advance_id
    JOIN salary_advance_installments i ON i.id = rp.installment_id
   WHERE rp.origin = 'RETENUE_PAIE' AND rp.payroll_item_id IS NULL
)
SELECT o.company_id AS societe, e.full_name AS salarie, o.reference AS avance,
       o.period_code AS periode_de_l_echeance, o.amount AS montant,
       o.enregistre_le, o.par,
       r.status AS statut_de_la_paie,
       it.monthly_salary AS salaire_base,
       it.advance_deduction AS avance_affichee_aujourdhui,
       it.net_salary AS net_affiche_aujourdhui,
       (it.net_salary - o.amount) AS net_apres_correctif,
       CASE
         WHEN it.id IS NULL THEN 'aucune paie préparée pour cette période — rien ne changera'
         WHEN r.status <> 'DRAFT' THEN '⚠ paie « ' || r.status || ' » : NON recalculée, aucun changement'
         ELSE 'paie DRAFT : le net passera de ' || it.net_salary || ' à ' || (it.net_salary - o.amount)
       END AS effet_du_correctif
  FROM orphelines o
  LEFT JOIN attendance_employees e ON e.id = o.employee_id
  LEFT JOIN attendance_payroll_runs_v2 r
         ON r.company_id = o.company_id AND to_char(r.period_month,'YYYY-MM') = o.period_code
  LEFT JOIN attendance_payroll_items_v2 it
         ON it.payroll_run_id = r.id AND it.employee_id = o.employee_id
 ORDER BY o.company_id, e.full_name, o.period_code;

\echo ''
\echo '════ COMBIEN DE LIGNES SONT CONCERNÉES ════'
SELECT count(*) AS retenues_non_rattachees,
       count(DISTINCT a.employee_id) AS salaries_concernes,
       count(DISTINCT a.company_id) AS societes_concernees,
       COALESCE(sum(rp.amount),0) AS montant_total
  FROM salary_advance_repayments rp
  JOIN salary_advances a ON a.id = rp.advance_id
 WHERE rp.origin = 'RETENUE_PAIE' AND rp.payroll_item_id IS NULL;

\echo ''
\echo '════ AUCUNE PAIE DÉJÀ PAYÉE NE SERA TOUCHÉE — VÉRIFICATION ════'
SELECT r.status AS statut, count(*) AS nb_lignes,
       CASE WHEN r.status = 'DRAFT' THEN 'recalculable' ELSE 'protégée : la préparation la refuse' END AS effet
  FROM attendance_payroll_runs_v2 r
  JOIN attendance_payroll_items_v2 it ON it.payroll_run_id = r.id
 GROUP BY r.status ORDER BY r.status;

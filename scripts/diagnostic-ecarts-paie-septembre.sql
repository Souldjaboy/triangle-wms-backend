-- ═══════════════════════════════════════════════════════════════════════════
-- D'OÙ VIENNENT LES ÉCARTS DE NET DE SEPTEMBRE 2026 ?
--
-- LECTURE SEULE. Aucun INSERT, UPDATE, DELETE, DROP, TRUNCATE ni ALTER.
-- Ne déclenche aucun paiement. Sans effet sur les données.
--
--   psql "$DATABASE_URL" -v societe=1 -v periode="'2026-09'" \
--        -f scripts/diagnostic-ecarts-paie-septembre.sql | tee diagnostic-$(date +%F).txt
--
-- ⚠ SAUVEGARDEZ CETTE SORTIE (le « tee » ci-dessus le fait).
--
-- `payroll_item_adjustments.payroll_item_id` est en ON DELETE CASCADE. Recalculer
-- la paie supprime ses lignes — et donc, en cascade, TOUTE la trace des
-- ajustements manuels : motif, auteur, ancien montant. Une fois la paie
-- recalculée, plus rien ne dira pourquoi un net avait été corrigé à la main.
--
-- La section 1 est la plus importante : c'est la seule voie du système qui
-- écrit `net_salary` directement, sans passer par le calcul.
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
\if :{?societe} \else \set societe 1 \endif
\if :{?periode} \else \set periode '''2026-09''' \endif
\pset pager off

\echo ''
\echo '════ 1. CORRECTIONS MANUELLES DU NET  (POST /paie/lignes/:id/ajuster) ════'
\echo '     La seule voie qui réécrit net_salary sans recalcul. À lire en premier.'
SELECT adj.id, it.employee_name AS salarie, adj.field AS champ,
       adj.old_value AS avant, adj.new_value AS apres,
       (COALESCE(NULLIF(adj.new_value,'')::numeric,0)
        - COALESCE(NULLIF(adj.old_value,'')::numeric,0)) AS ecart,
       adj.reason AS motif, adj.performed_by_name AS auteur, adj.created_at AS le
  FROM payroll_item_adjustments adj
  JOIN attendance_payroll_items_v2 it ON it.id = adj.payroll_item_id
  JOIN attendance_payroll_runs_v2 r ON r.id = it.payroll_run_id
 WHERE adj.company_id = :societe AND to_char(r.period_month,'YYYY-MM') = :periode
 ORDER BY adj.created_at, adj.id;

\echo ''
\echo '════ 2. LE NET STOCKÉ vs LE NET RECALCULABLE  (l''écart et son explication) ════'
WITH lignes AS (
  SELECT it.*, r.status AS statut_paie
    FROM attendance_payroll_items_v2 it
    JOIN attendance_payroll_runs_v2 r ON r.id = it.payroll_run_id
   WHERE r.company_id = :societe AND to_char(r.period_month,'YYYY-MM') = :periode
), corrections AS (
  SELECT payroll_item_id,
         count(*) AS nb_corrections,
         sum(COALESCE(NULLIF(new_value,'')::numeric,0) - COALESCE(NULLIF(old_value,'')::numeric,0)) AS effet,
         string_agg(reason || ' [' || performed_by_name || ']', ' | ' ORDER BY created_at) AS motifs
    FROM payroll_item_adjustments WHERE field = 'net_salary'
   GROUP BY payroll_item_id
)
SELECT l.employee_name AS salarie,
       l.monthly_salary AS salaire_configure,
       l.absence_days AS absences, l.late_minutes AS retard_min,
       l.absence_deduction AS retenue_absence,
       l.advance_deduction AS avance_retenue,
       l.adjustments AS ajustements_pointage,
       l.net_salary AS net_stocke,
       (COALESCE(l.monthly_salary,0) - COALESCE(l.absence_deduction,0)
        + COALESCE(l.adjustments,0) - COALESCE(l.advance_deduction,0)) AS net_recalculable,
       (l.net_salary - (COALESCE(l.monthly_salary,0) - COALESCE(l.absence_deduction,0)
        + COALESCE(l.adjustments,0) - COALESCE(l.advance_deduction,0))) AS ecart,
       COALESCE(c.nb_corrections,0) AS nb_corrections_manuelles,
       c.effet AS effet_des_corrections,
       c.motifs AS motifs_des_corrections,
       CASE
         WHEN l.net_salary IS NULL THEN '⚠ NET NUL — salaire non calculable (ligne BLOCKED)'
         WHEN l.monthly_salary IS NULL THEN '⚠ AUCUN SALAIRE MENSUEL configuré'
         WHEN COALESCE(l.monthly_salary,0) = 0 THEN '⚠ SALAIRE CONFIGURÉ À ZÉRO (accepté par le calcul, contrairement à NULL)'
         WHEN l.net_salary = (COALESCE(l.monthly_salary,0) - COALESCE(l.absence_deduction,0)
              + COALESCE(l.adjustments,0) - COALESCE(l.advance_deduction,0)) THEN 'OK — net conforme au calcul'
         WHEN c.nb_corrections > 0 THEN 'ANOMALIE EXPLIQUÉE — correction manuelle du net (voir motifs)'
         ELSE '⚠ ÉCART SANS CORRECTION TRACÉE — origine à chercher hors des tables de paie'
       END AS verdict
  FROM lignes l LEFT JOIN corrections c ON c.payroll_item_id = l.id
 ORDER BY (l.net_salary IS DISTINCT FROM (COALESCE(l.monthly_salary,0) - COALESCE(l.absence_deduction,0)
           + COALESCE(l.adjustments,0) - COALESCE(l.advance_deduction,0))) DESC,
          l.employee_name;

\echo ''
\echo '════ 3. HISTORIQUE SALARIAL COMPLET de chaque salarié de la paie ════'
SELECT e.employee_number AS matricule, e.full_name AS salarie, e.user_id,
       v.effective_from AS a_partir_du, v.effective_to AS jusqu_au,
       v.monthly_salary AS mensuel, v.daily_rate AS journalier, v.basis_days AS base_jours,
       u.fullname AS pose_par, v.created_at AS enregistre_le
  FROM attendance_employees e
  LEFT JOIN attendance_salary_settings_v2 v ON v.employee_id = e.id
  LEFT JOIN users u ON u.id = v.set_by
 WHERE e.company_id = :societe
 ORDER BY e.employee_number, v.effective_from NULLS FIRST;

\echo ''
\echo '════ 4. SALARIÉS SANS AUCUN SALAIRE, OU À ZÉRO ════'
SELECT e.id AS employee_id, e.employee_number AS matricule, e.full_name AS salarie,
       e.user_id, e.active, e.job_title AS poste, e.effective_from AS entre_le,
       (SELECT count(*) FROM attendance_salary_settings_v2 v WHERE v.employee_id = e.id) AS nb_lignes_salaire,
       (SELECT max(v.effective_from) FROM attendance_salary_settings_v2 v WHERE v.employee_id = e.id) AS derniere_date,
       s.monthly_salary AS mensuel_en_vigueur, s.daily_rate AS journalier_en_vigueur,
       CASE
         WHEN (SELECT count(*) FROM attendance_salary_settings_v2 v WHERE v.employee_id = e.id) = 0
           THEN 'AUCUNE ligne de salaire n''a jamais existé'
         WHEN s.monthly_salary IS NULL AND s.daily_rate IS NULL
           THEN 'ligne(s) de salaire présente(s) mais AUCUNE en vigueur à cette date'
         WHEN COALESCE(s.monthly_salary,0) = 0 AND COALESCE(s.daily_rate,0) = 0
           THEN 'salaire en vigueur À ZÉRO'
         WHEN s.monthly_salary IS NULL THEN 'mensuel absent (journalier seul)'
         WHEN s.daily_rate IS NULL THEN 'journalier absent (mensuel seul)'
         ELSE 'salaire complet'
       END AS diagnostic
  FROM attendance_employees e
  CROSS JOIN (SELECT date_fin FROM attendance_periods WHERE company_id = :societe AND code = :periode) p
  LEFT JOIN LATERAL (
    SELECT monthly_salary, daily_rate FROM attendance_salary_settings_v2 v
     WHERE v.employee_id = e.id AND v.effective_from <= p.date_fin
     ORDER BY v.effective_from DESC LIMIT 1) s ON true
 WHERE e.company_id = :societe
   AND (s.monthly_salary IS NULL OR s.daily_rate IS NULL
        OR COALESCE(s.monthly_salary,0) = 0 OR COALESCE(s.daily_rate,0) = 0)
 ORDER BY e.employee_number;

\echo ''
\echo '════ 5. AUTRES SOURCES DE SALAIRE : LES CHAMPS LEGACY ════'
\echo '     (le calcul de paie ne les lit PAS — on vérifie seulement s''ils portent une valeur)'
SELECT e.employee_number AS matricule, e.full_name AS salarie,
       u.payment_type AS type_paiement_legacy, u.hourly_rate AS horaire_legacy,
       u.daily_rate AS journalier_legacy,
       a.salary_type AS type_attendance_settings, a.hourly_rate AS horaire_settings,
       a.daily_salary AS journalier_settings, a.monthly_salary AS mensuel_settings,
       CASE WHEN COALESCE(a.monthly_salary,0) > 0 OR COALESCE(u.daily_rate,0) > 0
                 OR COALESCE(a.daily_salary,0) > 0
            THEN 'valeur legacy présente — NON utilisée par le calcul de paie'
            ELSE 'aucune valeur legacy' END AS remarque
  FROM attendance_employees e
  LEFT JOIN users u ON u.id = e.user_id
  LEFT JOIN attendance_settings a ON a.user_id = e.user_id
 WHERE e.company_id = :societe
 ORDER BY e.employee_number;

\echo ''
\echo '════ 6. AJUSTEMENTS DE POINTAGE (attendance_salary_adjustments_v2) ════'
SELECT e.full_name AS salarie, adj.id, adj.work_date AS date_effet, adj.amount AS montant,
       adj.reason AS motif, u.fullname AS saisi_par, adj.created_at AS enregistre_le
  FROM attendance_salary_adjustments_v2 adj
  JOIN attendance_employees e ON e.id = adj.employee_id
  LEFT JOIN users u ON u.id = adj.created_by
 WHERE adj.company_id = :societe
 ORDER BY e.full_name, adj.work_date;

\echo ''
\echo '════ 7. AVANCES : CE QUI EST RÉELLEMENT DÛ EN SEPTEMBRE ════'
SELECT e.full_name AS salarie, a.reference AS avance, a.status AS statut,
       a.amount_paid AS verse, a.balance AS solde_du, a.installment_amount AS mensualite,
       i.period_code AS echeance, i.status AS statut_echeance, i.amount_due AS du,
       i.amount_taken AS deja_pris, rp.id AS remboursement, rp.amount AS montant,
       rp.payroll_item_id AS rattache_a_la_ligne, rp.performed_by_name AS par,
       CASE
         WHEN rp.id IS NULL THEN 'aucun remboursement sur cette échéance'
         WHEN rp.payroll_item_id IS NULL
           THEN 'RETENUE DÉJÀ ENREGISTRÉE, sans lien vers une paie — sera AFFICHÉE, jamais recréée'
         ELSE 'retenue produite par la paie' END AS verdict
  FROM salary_advances a
  JOIN attendance_employees e ON e.id = a.employee_id
  LEFT JOIN salary_advance_installments i ON i.advance_id = a.id
  LEFT JOIN salary_advance_repayments rp ON rp.installment_id = i.id AND rp.origin = 'RETENUE_PAIE'
 WHERE a.company_id = :societe
 ORDER BY e.full_name, a.reference, i.rank;

\echo ''
\echo '════ 8. TABLES DE PAIE LEGACY : portent-elles quelque chose ? ════'
SELECT 'payroll_runs (023)' AS source, count(*) AS lignes,
       COALESCE(sum(net_amount),0) AS total FROM payroll_runs WHERE company_id = :societe
UNION ALL
SELECT 'payroll_items (023)', count(*), COALESCE(sum(net_salary),0)
  FROM payroll_items WHERE company_id = :societe
UNION ALL
SELECT 'payroll_vouchers', count(*), 0 FROM payroll_vouchers WHERE company_id = :societe
UNION ALL
SELECT 'attendance_payroll_items_v2 (en service)', count(*), COALESCE(sum(net_salary),0)
  FROM attendance_payroll_items_v2 WHERE company_id = :societe;

\echo ''
\echo '════ 9. JOURNAL D''ACTIVITÉ autour de la paie ════'
SELECT id, created_at AS le, user_name AS qui, user_role AS role, action, module, details
  FROM user_activities
 WHERE module ILIKE '%paie%' OR action ILIKE '%paie%' OR action ILIKE '%salaire%'
    OR details ILIKE '%paie%' OR details ILIKE '%avance%'
 ORDER BY created_at DESC LIMIT 60;

\echo ''
\echo '════ 10. TABLEAU FINAL — LES 27 SALARIÉS, AVEC ORIGINE ET VERDICT ════'
WITH lignes AS (
  SELECT it.*, r.status AS statut_paie
    FROM attendance_payroll_items_v2 it
    JOIN attendance_payroll_runs_v2 r ON r.id = it.payroll_run_id
   WHERE r.company_id = :societe AND to_char(r.period_month,'YYYY-MM') = :periode
), corr AS (
  SELECT payroll_item_id, count(*) AS n,
         sum(COALESCE(NULLIF(new_value,'')::numeric,0) - COALESCE(NULLIF(old_value,'')::numeric,0)) AS effet,
         string_agg(reason || ' [' || performed_by_name || ']', ' | ' ORDER BY created_at) AS motifs
    FROM payroll_item_adjustments WHERE field = 'net_salary' GROUP BY payroll_item_id
), av AS (
  SELECT a.employee_id, COALESCE(sum(rp.amount),0) AS retenue_reelle,
         count(*) FILTER (WHERE rp.payroll_item_id IS NULL) AS dont_hors_paie
    FROM salary_advance_repayments rp
    JOIN salary_advances a ON a.id = rp.advance_id
    JOIN salary_advance_installments i ON i.id = rp.installment_id
   WHERE rp.origin = 'RETENUE_PAIE' AND i.period_code = :periode
   GROUP BY a.employee_id
)
SELECT l.employee_name AS nom,
       l.monthly_salary AS salaire_configure,
       l.net_salary AS net_stocke,
       l.absence_days AS absence, l.late_minutes AS retard,
       COALESCE(av.retenue_reelle, 0) AS avance_reellement_due,
       COALESCE(c.effet, 0) + COALESCE(l.adjustments, 0) AS ajustement_identifie,
       CASE
         WHEN c.n > 0 AND COALESCE(l.adjustments,0) <> 0
           THEN 'correction manuelle du net + ajustement de pointage : ' || c.motifs
         WHEN c.n > 0 THEN 'correction manuelle du net : ' || c.motifs
         WHEN COALESCE(l.adjustments,0) <> 0 THEN 'ajustement de pointage (attendance_salary_adjustments_v2)'
         ELSE 'aucune — net issu du calcul'
       END AS origine_exacte,
       /* Net attendu après les correctifs déjà livrés : absences non retenues
          pour cette période, avance réellement due affichée. Les corrections
          manuelles NE SURVIVENT PAS à un recalcul : elles ne sont donc pas
          incluses ici. */
       GREATEST(0, COALESCE(l.monthly_salary,0) + COALESCE(l.adjustments,0)
                   - COALESCE(av.retenue_reelle,0)) AS net_attendu_apres_correctifs,
       CASE
         WHEN l.net_salary IS NULL OR l.monthly_salary IS NULL
           THEN 'DÉCISION MÉTIER REQUISE — aucun salaire configuré'
         WHEN COALESCE(l.monthly_salary,0) = 0
           THEN 'DÉCISION MÉTIER REQUISE — salaire à zéro'
         WHEN c.n > 0
           THEN 'DÉCISION MÉTIER REQUISE — correction manuelle, perdue au recalcul'
         WHEN COALESCE(av.dont_hors_paie,0) > 0
           THEN 'ANOMALIE EXPLIQUÉE — retenue d''avance enregistrée hors paie'
         WHEN l.net_salary = (COALESCE(l.monthly_salary,0) - COALESCE(l.absence_deduction,0)
              + COALESCE(l.adjustments,0) - COALESCE(l.advance_deduction,0)) THEN 'OK'
         ELSE 'DÉCISION MÉTIER REQUISE — écart sans trace'
       END AS verdict
  FROM lignes l
  LEFT JOIN corr c ON c.payroll_item_id = l.id
  LEFT JOIN av ON av.employee_id = l.employee_id
 ORDER BY (CASE WHEN c.n > 0 OR l.monthly_salary IS NULL OR COALESCE(l.monthly_salary,0)=0 THEN 0 ELSE 1 END),
          l.employee_name;

\echo ''
\echo '════ 11. AUCUNE AUTRE SOCIÉTÉ N''EST LUE ICI ════'
SELECT it.company_id AS societe, count(*) AS lignes_de_paie_2026_09
  FROM attendance_payroll_items_v2 it
  JOIN attendance_payroll_runs_v2 r ON r.id = it.payroll_run_id
 WHERE to_char(r.period_month,'YYYY-MM') = :periode
 GROUP BY it.company_id ORDER BY it.company_id;

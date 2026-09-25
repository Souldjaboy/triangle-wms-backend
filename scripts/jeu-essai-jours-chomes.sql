-- Jeu d'essai — CALENDRIER ADMINISTRATIF (jours fériés / chômés).
--
-- S'applique APRÈS jeu-essai-avances-paie.sql, et n'y touche pas : les salariés
-- existants gardent leurs pointages, leurs absences et leurs avances, pour que
-- les autres suites continuent de mesurer ce qu'elles mesuraient.
--
-- Ce qu'il ajoute :
--   • un ENTREPÔT Triangle, pour éprouver qu'une fermeture de bureau ne chôme
--     pas l'entrepôt ;
--   • deux salariés, un par site, avec service et catégorie renseignés ;
--   • une présence complète du 25/08 au 24/09 SAUF deux journées pour celui de
--     l'entrepôt — ce sont ces deux trous que les tests déclarent chômés, l'un
--     payé, l'autre non.
--   • celui du bureau a POINTÉ le 08/09 : c'est lui qui aura travaillé un jour
--     déclaré chômé.

BEGIN;

INSERT INTO attendance_work_sites(id, company_id, code, name, site_type) VALUES
 (3, 1, 'TRI-ENT', 'Entrepot Triangle', 'WAREHOUSE')
ON CONFLICT (id) DO NOTHING;

INSERT INTO attendance_employees
 (id, company_id, employee_number, full_name, site_id, schedule_id, active, effective_from, service, categorie) VALUES
 (810, 1, 10, 'Fanta Keita',    3, 1, true, '2026-01-01', 'Entrepot',    'Ouvrier'),
 (811, 1, 11, 'Bakary Traore',  1, 1, true, '2026-01-01', 'Comptabilite', 'Cadre')
ON CONFLICT (id) DO UPDATE
  SET site_id = EXCLUDED.site_id, service = EXCLUDED.service, categorie = EXCLUDED.categorie;

INSERT INTO attendance_salary_settings_v2
 (company_id, employee_id, monthly_salary, daily_rate, basis_days, effective_from) VALUES
 (1, 810, 100000, 4000, 25, '2026-01-01'),
 (1, 811, 100000, 4000, 25, '2026-01-01')
ON CONFLICT DO NOTHING;

-- Présence complète en semaine, SAUF le 08/09 et le 09/09 pour Fanta Keita.
INSERT INTO attendance_day_records_v2(company_id, employee_id, work_date, check_in, check_out, worked_minutes, status)
SELECT 1, 810, d::date, (d::date + time '08:00'), (d::date + time '17:00'), 480, 'COMPLETED'
  FROM generate_series('2026-08-25'::date, '2026-09-24'::date, interval '1 day') d
 WHERE extract(isodow FROM d) BETWEEN 1 AND 5
   AND d::date NOT IN ('2026-09-08', '2026-09-09')
ON CONFLICT DO NOTHING;

-- Bakary Traore : présent TOUS les jours ouvrés, y compris le 08/09. C'est lui
-- qui aura travaillé un jour déclaré chômé, et son pointage doit être conservé
-- tel quel — pas reclassé, pas effacé.
INSERT INTO attendance_day_records_v2(company_id, employee_id, work_date, check_in, check_out, worked_minutes, status)
SELECT 1, 811, d::date, (d::date + time '08:00'), (d::date + time '17:00'), 480, 'COMPLETED'
  FROM generate_series('2026-08-25'::date, '2026-09-24'::date, interval '1 day') d
 WHERE extract(isodow FROM d) BETWEEN 1 AND 5
ON CONFLICT DO NOTHING;

COMMIT;

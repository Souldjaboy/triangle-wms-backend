-- Jeu d'essai reproduisant la situation de production :
--   • DIALLO  : avance historique, remboursements SANS lien vers une paie
--   • MALAMINE: avance normale, retenue produite par l'application
--   • ZERBO   : échéance À VENIR, jamais retenue
--   • SANS    : aucune avance
--   • FAT&MAT : un salarié avec avance, pour l'isolation
BEGIN;

INSERT INTO companies(id,name,tenant_id) VALUES (1,'Triangle','triangle'),(2,'FAT & MAT','triangle')
  ON CONFLICT (id) DO UPDATE SET tenant_id='triangle';
SELECT setval(pg_get_serial_sequence('companies','id'), 10, true);

INSERT INTO attendance_company_configuration(company_id,official_start_at,timezone,saturday_mode)
VALUES (1,'2026-01-01 00:00:00','Africa/Bamako','NORMAL'),(2,'2026-01-01 00:00:00','Africa/Bamako','NORMAL')
ON CONFLICT (company_id) DO NOTHING;

INSERT INTO users(id,fullname,email,password,role,company_id,is_super_admin,is_active) VALUES
 (900,'Super Triangle','sup.tri@t.local','x','super_admin',1,true,true),
 (901,'Super Fatemat','sup.fat@t.local','x','super_admin',2,true,true),
 (903,'Comptable Triangle','compta.tri@t.local','x','comptable',1,false,true)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('users','id'), 2000, true);

INSERT INTO attendance_work_sites(id,company_id,code,name,site_type) VALUES
 (1,1,'TRI','Siege Triangle','OFFICE'),(2,2,'FAT','Siege Fatemat','OFFICE')
ON CONFLICT (id) DO NOTHING;
INSERT INTO attendance_work_schedules(id,company_id,code,name) VALUES
 (1,1,'STD','Standard T'),(2,2,'STD','Standard F') ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('attendance_work_sites','id'), 10, true);
SELECT setval(pg_get_serial_sequence('attendance_work_schedules','id'), 10, true);
INSERT INTO attendance_schedule_days(schedule_id,iso_weekday,is_working_day,start_time,end_time)
SELECT s.id, d.j, true, '08:00','17:00' FROM attendance_work_schedules s, generate_series(1,5) d(j)
ON CONFLICT DO NOTHING;

-- période du 25/08 au 24/09, pointage validé
INSERT INTO attendance_periods(id,company_id,code,date_debut,date_fin,status) VALUES
 (1,1,'2026-09','2026-08-25','2026-09-24','POINTAGE_VALIDE'),
 (2,2,'2026-09','2026-08-25','2026-09-24','POINTAGE_VALIDE')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('attendance_periods','id'), 10, true);

INSERT INTO attendance_employees(id,company_id,employee_number,full_name,site_id,schedule_id,active,effective_from) VALUES
 (801,1,1,'Souleymane Diallo',1,1,true,'2026-01-01'),
 (802,1,2,'Malamine NDiaye',1,1,true,'2026-01-01'),
 (803,1,3,'Amary Zerbo',1,1,true,'2026-01-01'),
 (804,1,4,'Sans Avance',1,1,true,'2026-01-01'),
 (805,2,1,'Salarie Fatemat',2,2,true,'2026-01-01'),
 (806,1,5,'Hawa Diarra',1,1,true,'2026-01-01')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('attendance_employees','id'), 900, true);

INSERT INTO attendance_salary_settings_v2(company_id,employee_id,monthly_salary,daily_rate,basis_days,effective_from) VALUES
 (1,801,150000,5000,30,'2026-01-01'),(1,802,120000,4000,30,'2026-01-01'),
 (1,803,100000,3333,30,'2026-01-01'),(1,804,90000,3000,30,'2026-01-01'),
 (2,805,130000,4333,30,'2026-01-01'),
 (1,806,75000,2500,30,'2026-01-01')
ON CONFLICT DO NOTHING;

-- ── DIALLO : avance historique. Échéances 08 et 09 déjà RETENUE, remboursements ORPHELINS.
INSERT INTO salary_advances(id,company_id,employee_id,reference,amount_requested,amount_authorized,
       amount_paid,balance,status,installment_amount,first_period_code)
VALUES (801,1,801,'AVA-HIST-2026-SD',245000,245000,245000,165000,'EN_REMBOURSEMENT',40000,'2026-08')
ON CONFLICT (id) DO NOTHING;
INSERT INTO salary_advance_installments(id,company_id,advance_id,rank,period_code,amount_due,amount_taken,status) VALUES
 (801,1,801,1,'2026-08',40000,40000,'RETENUE'),
 (802,1,801,2,'2026-09',40000,40000,'RETENUE'),
 (803,1,801,3,'2026-10',40000,0,'A_VENIR') ON CONFLICT (id) DO NOTHING;
INSERT INTO salary_advance_repayments(id,company_id,advance_id,installment_id,payroll_item_id,amount,origin,
       balance_before,balance_after,performed_by_name) VALUES
 (9001,1,801,801,NULL,40000,'RETENUE_PAIE',245000,205000,'Import historique'),
 (9002,1,801,802,NULL,40000,'RETENUE_PAIE',205000,165000,'Import historique')
ON CONFLICT (id) DO NOTHING;

-- ── MALAMINE : avance normale, échéance septembre À VENIR (la paie doit la prendre)
INSERT INTO salary_advances(id,company_id,employee_id,reference,amount_requested,amount_authorized,
       amount_paid,balance,status,installment_amount,first_period_code)
VALUES (802,1,802,'AV-2026-MN',45000,45000,45000,45000,'VERSEE',15000,'2026-09')
ON CONFLICT (id) DO NOTHING;
INSERT INTO salary_advance_installments(id,company_id,advance_id,rank,period_code,amount_due,amount_taken,status) VALUES
 (811,1,802,1,'2026-09',15000,0,'A_VENIR'),
 (812,1,802,2,'2026-10',15000,0,'A_VENIR'),
 (813,1,802,3,'2026-11',15000,0,'A_VENIR') ON CONFLICT (id) DO NOTHING;

-- ── ZERBO : échéance uniquement en octobre, rien à retenir en septembre
INSERT INTO salary_advances(id,company_id,employee_id,reference,amount_requested,amount_authorized,
       amount_paid,balance,status,installment_amount,first_period_code)
VALUES (803,1,803,'AV-2026-AZ',25000,25000,25000,25000,'VERSEE',25000,'2026-10')
ON CONFLICT (id) DO NOTHING;
INSERT INTO salary_advance_installments(id,company_id,advance_id,rank,period_code,amount_due,amount_taken,status)
VALUES (821,1,803,1,'2026-10',25000,0,'A_VENIR') ON CONFLICT (id) DO NOTHING;

-- ── FAT & MAT : avance avec remboursement orphelin, pour vérifier l'isolation
INSERT INTO salary_advances(id,company_id,employee_id,reference,amount_requested,amount_authorized,
       amount_paid,balance,status,installment_amount,first_period_code)
VALUES (805,2,805,'AVA-HIST-2026-FM',60000,60000,60000,30000,'EN_REMBOURSEMENT',30000,'2026-09')
ON CONFLICT (id) DO NOTHING;
INSERT INTO salary_advance_installments(id,company_id,advance_id,rank,period_code,amount_due,amount_taken,status)
VALUES (851,2,805,1,'2026-09',30000,30000,'RETENUE') ON CONFLICT (id) DO NOTHING;
INSERT INTO salary_advance_repayments(id,company_id,advance_id,installment_id,payroll_item_id,amount,origin,
       balance_before,balance_after,performed_by_name)
VALUES (9003,2,805,851,NULL,30000,'RETENUE_PAIE',60000,30000,'Import historique')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('salary_advance_repayments','id'), 10000, true);

-- ── HAWA DIARRA : avance historique + ajustement positif de 25 000
INSERT INTO salary_advances(id,company_id,employee_id,reference,amount_requested,amount_authorized,
       amount_paid,balance,status,installment_amount,first_period_code)
VALUES (806,1,806,'AVA-HIST-2026-HD',200000,200000,200000,120000,'EN_REMBOURSEMENT',40000,'2026-08')
ON CONFLICT (id) DO NOTHING;
INSERT INTO salary_advance_installments(id,company_id,advance_id,rank,period_code,amount_due,amount_taken,status) VALUES
 (861,1,806,1,'2026-08',40000,40000,'RETENUE'),
 (862,1,806,2,'2026-09',40000,40000,'RETENUE'),
 (863,1,806,3,'2026-10',40000,0,'A_VENIR') ON CONFLICT (id) DO NOTHING;
INSERT INTO salary_advance_repayments(id,company_id,advance_id,installment_id,payroll_item_id,amount,origin,
       balance_before,balance_after,performed_by_name) VALUES
 (9011,1,806,861,NULL,40000,'RETENUE_PAIE',200000,160000,'Import historique'),
 (9012,1,806,862,NULL,40000,'RETENUE_PAIE',160000,120000,'Import historique')
ON CONFLICT (id) DO NOTHING;
-- l'ajustement positif qui explique « 75 000 de base, 100 000 de net »
INSERT INTO attendance_salary_adjustments_v2(id,company_id,employee_id,work_date,amount,reason,created_by)
VALUES (9001,1,806,'2026-09-10',25000,'Prime exceptionnelle de rendement — decision direction',900)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('attendance_salary_adjustments_v2','id'), 10000, true);

-- présence complète pour tout le monde, pour que le net ne dépende pas des absences
INSERT INTO attendance_day_records_v2(company_id,employee_id,work_date,check_in)
SELECT e.company_id, e.id, d::date, (d::date + time '08:00')
  FROM attendance_employees e,
       generate_series('2026-08-25'::date, '2026-09-24'::date, interval '1 day') d
 WHERE e.id BETWEEN 801 AND 806 AND extract(isodow FROM d) BETWEEN 1 AND 5
   /* Diallo, Malamine et Hawa n'ont pas pu pointer les six premiers jours
      ouvrés : c'est l'incident de pointage que l'exception vient couvrir. */
   AND NOT (e.id IN (801, 802, 806) AND d::date < '2026-09-02')
ON CONFLICT DO NOTHING;

-- Droits : les migrations de peuplement tournent AVANT la création de ces
-- sociétés de test, donc role_permissions est vide. On accorde explicitement
-- « entrepot.view » au magasinier pour que le test de périmètre soit réel :
-- sans droit du tout, le garde RBAC masque le module (404) et l'on ne
-- testerait plus rien du périmètre lui-même.
-- Le comptable reçoit les droits paie : sans eux, le garde RBAC masque la route
-- (404) et l'on ne testerait plus la règle de séparation elle-même.
INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, 'comptable', 'paie', a.action, true
  FROM companies c CROSS JOIN (VALUES ('visible'),('view'),('prepare'),('submit'),('validate')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, 'super_admin', 'paie', a.action, true
  FROM companies c CROSS JOIN (VALUES ('visible'),('view'),('prepare'),('submit'),('validate'),('pay')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, 'magasinier', 'entrepot', a.action, true
  FROM companies c CROSS JOIN (VALUES ('visible'), ('view')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

COMMIT;

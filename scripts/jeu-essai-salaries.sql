-- Jeu d'essai pour les tests d'ajout et de retrait de salariés.
-- Deux sociétés, chacune avec son site, son horaire et ses comptes.
-- Le salarié Triangle nº1 porte un historique COMPLET : c'est lui qui prouve
-- qu'un retrait ne perd rien.
BEGIN;

INSERT INTO companies(id,name,tenant_id) VALUES (1,'Triangle','triangle'),(2,'FAT & MAT','triangle')
  ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, tenant_id='triangle';
SELECT setval(pg_get_serial_sequence('companies','id'), 10, true);

INSERT INTO attendance_company_configuration(company_id,official_start_at,timezone)
VALUES (1,'2026-01-01 00:00:00','Africa/Bamako'),(2,'2026-01-01 00:00:00','Africa/Bamako')
ON CONFLICT (company_id) DO NOTHING;

-- mot de passe bcrypt de « Triangle2026 » n'est pas nécessaire : les tests
-- forgent directement un jeton. Le champ reste rempli car il est NOT NULL.
INSERT INTO users(id,fullname,email,password,role,company_id,is_super_admin,is_active) VALUES
 (900,'Super Triangle','super.tri@test.local','x','super_admin',1,true,true),
 (901,'Super Fatemat','super.fat@test.local','x','super_admin',2,true,true),
 (902,'Compte A Rattacher','arattacher@test.local','x','magasinier',1,false,true),
 (903,'Admin Simple','admin.simple@test.local','x','admin',1,false,true),
 (904,'Compte Fatemat Libre','libre.fat@test.local','x','magasinier',2,false,true)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('users','id'), 2000, true);

INSERT INTO attendance_work_sites(id,company_id,code,name,site_type) VALUES
 (1,1,'TRI-SIEGE','Siege Triangle','OFFICE'),
 (2,2,'FAT-SIEGE','Siege FAT & MAT','OFFICE')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('attendance_work_sites','id'), 10, true);

INSERT INTO attendance_work_schedules(id,company_id,code,name) VALUES
 (1,1,'STD','Standard Triangle'),(2,2,'STD','Standard FAT & MAT')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('attendance_work_schedules','id'), 10, true);

INSERT INTO attendance_schedule_days(schedule_id,iso_weekday,is_working_day,start_time,end_time)
SELECT s.id, d.j, true, '08:00', '17:00' FROM attendance_work_schedules s, generate_series(1,5) d(j)
ON CONFLICT DO NOTHING;

-- Le salarié Triangle à l'historique complet
INSERT INTO attendance_employees(id,company_id,employee_number,full_name,user_id,site_id,schedule_id,job_title,active,effective_from)
VALUES (1,1,1,'Salarie Historique Triangle',902,1,1,'Magasinier',true,'2026-01-01')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('attendance_employees','id'), 50, true);

INSERT INTO attendance_salary_settings_v2(company_id,employee_id,monthly_salary,daily_rate,basis_days,effective_from)
VALUES (1,1,150000,5000,30,'2026-01-01') ON CONFLICT DO NOTHING;

INSERT INTO attendance_day_records_v2(company_id,employee_id,work_date) VALUES
 (1,1,'2026-08-03'),(1,1,'2026-08-04'),(1,1,'2026-08-05') ON CONFLICT DO NOTHING;

INSERT INTO attendance_badges(company_id,employee_id,badge_code,qr_token) VALUES
 (1,1,'TRI-B-001','tok-historique-aaaaaaaaaaaaaaaa') ON CONFLICT DO NOTHING;

INSERT INTO attendance_payroll_runs_v2(id,company_id,period_month,status,net_amount)
VALUES (1,1,'2026-08-01','PAID',150000) ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('attendance_payroll_runs_v2','id'), 10, true);

INSERT INTO attendance_payroll_items_v2(id,company_id,payroll_run_id,employee_id,employee_name,net_salary,status)
VALUES (1,1,1,1,'Salarie Historique Triangle',150000,'PAID') ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('attendance_payroll_items_v2','id'), 10, true);

INSERT INTO salary_advances(id,company_id,employee_id,reference,amount_requested,amount_authorized,amount_paid,balance,status)
VALUES (1,1,1,'AV-2026-001',60000,60000,60000,40000,'EN_REMBOURSEMENT') ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('salary_advances','id'), 10, true);

INSERT INTO salary_advance_installments(id,company_id,advance_id,rank,period_code,amount_due,amount_taken,status)
VALUES (1,1,1,1,'2026-08',20000,20000,'RETENUE'),
       (2,1,1,2,'2026-09',20000,0,'A_VENIR'),
       (3,1,1,3,'2026-10',20000,0,'A_VENIR') ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('salary_advance_installments','id'), 10, true);

INSERT INTO salary_advance_repayments(company_id,advance_id,installment_id,payroll_item_id,amount,origin,balance_before,balance_after)
VALUES (1,1,1,1,20000,'RETENUE_PAIE',60000,40000);

COMMIT;

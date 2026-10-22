-- Jeu d'essai des documents du personnel.
--
-- Deux salariés chez Triangle, un chez FAT & MAT. Aucun taux de cotisation
-- n'est inséré : c'est précisément ce que les tests doivent constater.
BEGIN;

INSERT INTO companies(id,name,tenant_id) VALUES (1,'Triangle','triangle'),(2,'FAT & MAT','triangle')
  ON CONFLICT (id) DO UPDATE SET tenant_id='triangle';
SELECT setval(pg_get_serial_sequence('companies','id'), 10, true);

INSERT INTO company_settings(company_id, company_name, address, phone, email) VALUES
 (1,'TRIANGLE LOGISTICS SARL','Sotuba ACI, Bamako, Mali','+223 20 00 00 00','contact@trianglewmspro.com'),
 (2,'FAT & MAT SARL','Magnambougou, Bamako, Mali','+223 20 11 11 11','contact@fatmat.ml')
ON CONFLICT DO NOTHING;

INSERT INTO users(id,fullname,email,password,role,company_id,is_super_admin,is_active) VALUES
 (900,'Super Triangle','sup.tri@t.local','x','super_admin',1,true,true),
 (901,'Super Fatemat','sup.fat@t.local','x','super_admin',2,true,true),
 (903,'Comptable Triangle','compta.tri@t.local','x','comptable',1,false,true),
 (904,'Direction Triangle','dir.tri@t.local','x','direction',1,false,true),
 (906,'Zerbo Magasinier','zerbo@t.local','x','magasinier',1,false,true),
 (908,'Assistante RH','rh@t.local','x','assistant_rh',1,false,true)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('users','id'), 2000, true);

INSERT INTO attendance_work_sites(id,company_id,code,name,site_type) VALUES
 (1,1,'TRI','Siège Triangle','OFFICE'),(2,2,'FAT','Siège FAT & MAT','OFFICE')
ON CONFLICT (id) DO NOTHING;

-- `employee_number` est un ENTIER dans ce schéma, pas une référence
-- alphanumérique. Les documents l'affichent tel quel plutôt que d'inventer
-- un format « TRI-0042 » qui n'existe nulle part ailleurs.
INSERT INTO attendance_employees(id,company_id,employee_number,full_name,site_id,job_title,active) VALUES
 (801,1,42,'Aminata Coulibaly',1,'Responsable d''entrepôt',true),
 (802,1,43,'Boubacar Traoré',1,'Magasinier',true),
 (809,2,1,'Salif Keita',2,'Chauffeur',true)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('attendance_employees','id'), 900, true);

-- Droits.
INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, r.role, 'rh.document', a.action, true
  FROM companies c
  CROSS JOIN (VALUES ('super_admin'),('direction'),('comptable')) AS r(role)
  CROSS JOIN (VALUES ('visible'),('view'),('create'),('update'),('print'),('voir_remuneration')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

/* L'assistante RH édite des attestations de travail — qui ne révèlent aucun
   salaire — mais ne voit PAS les rémunérations. C'est le témoin qui prouve
   que les deux droits sont bien séparés. */
INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, 'assistant_rh', 'rh.document', a.action, true
  FROM companies c CROSS JOIN (VALUES ('visible'),('view'),('create'),('print')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, 'assistant_rh', 'rh.document', 'voir_remuneration', false
  FROM companies c WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = false;

/* Réimprimer et annuler : deux droits que l'assistante RH n'a PAS, et que la
   direction a. Une seconde sortie d'une pièce déjà remise circule, et une
   annulation retire sa valeur à un document que le salarié détient peut-être
   déjà : ce sont des décisions, pas des gestes de saisie. */
INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, r.role, 'rh.document', a.action, r.droit
  FROM companies c
  CROSS JOIN (VALUES ('direction',true),('super_admin',true),
                     ('comptable',false),('assistant_rh',false)) AS r(role,droit)
  CROSS JOIN (VALUES ('reprint'),('delete')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = EXCLUDED.allowed;

COMMIT;

DO $$
DECLARE taux INTEGER;
BEGIN
  SELECT count(*) INTO taux FROM tax_rules;
  RAISE NOTICE 'Jeu d''essai RH : % salariés, % taux de cotisation en base.',
    (SELECT count(*) FROM attendance_employees), taux;
END $$;

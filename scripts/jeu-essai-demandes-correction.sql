-- Jeu d'essai de la correction des demandes de stock.
--
-- Quatre demandes, une par état qui compte :
--   DE-001  EN_ATTENTE   — se modifie librement
--   DE-002  VALIDEE      — se dévalide : rien n'a bougé
--   DE-003  RECUE        — a déplacé du stock : se contre-passe
--   DE-004  ANNULEE avec des mouvements qui subsistent — l'incohérence que la
--           vue doit recenser SANS la corriger
--   IN-005  inventaire RECUE — ne se contre-passe pas, et doit le dire
BEGIN;

INSERT INTO companies(id,name,tenant_id) VALUES (1,'Triangle','triangle'),(2,'FAT & MAT','triangle')
  ON CONFLICT (id) DO UPDATE SET tenant_id='triangle';
SELECT setval(pg_get_serial_sequence('companies','id'), 10, true);

INSERT INTO users(id,fullname,email,password,role,company_id,is_super_admin,is_active) VALUES
 (900,'Super Triangle','sup.tri@t.local','x','super_admin',1,true,true),
 (901,'Super Fatemat','sup.fat@t.local','x','super_admin',2,true,true),
 (904,'Direction Triangle','dir.tri@t.local','x','direction',1,false,true),
 (906,'Zerbo Magasinier','zerbo@t.local','x','magasinier',1,false,true)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('users','id'), 2000, true);

INSERT INTO warehouses(id,company_id,code,name,status) VALUES
 (1,1,'W-TRI','Entrepôt Triangle','active'),
 (9,2,'W-FAT','Entrepôt FAT & MAT','active')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('warehouses','id'), 50, true);

INSERT INTO products(id,company_id,name,reference,stock) VALUES
 (1,1,'Tôle TRX600','TRX600',500),
 (2,1,'Ciment CPJ 42.5','CPJ425',300),
 (9,2,'Sable fin','SBL-F',100)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('products','id'), 50, true);

INSERT INTO stock_requests
 (id,company_id,reference,request_type,status,source_warehouse,target_warehouse,
  motif,requested_by,requested_at,validated_by,validated_at,received_by,received_at) VALUES
 (1,1,'DE-001','entree','EN_ATTENTE',NULL,'W-TRI','Réapprovisionnement',906,'2026-10-10',NULL,NULL,NULL,NULL),
 (2,1,'DE-002','entree','VALIDEE',NULL,'W-TRI','Commande fournisseur',906,'2026-10-11',904,'2026-10-12',NULL,NULL),
 (3,1,'DE-003','entree','RECUE',NULL,'W-TRI','Livraison conteneur',906,'2026-10-12',904,'2026-10-13',906,'2026-10-14'),
 (4,1,'DE-004','sortie','ANNULEE','W-TRI',NULL,'Sortie annulée à tort',906,'2026-10-09',904,'2026-10-09',906,'2026-10-09'),
 (5,1,'IN-005','inventaire','RECUE','W-TRI','W-TRI','Inventaire trimestriel',906,'2026-10-15',904,'2026-10-15',906,'2026-10-15'),
 (10,2,'DE-F01','entree','VALIDEE',NULL,'W-FAT','Demande FAT & MAT',901,'2026-10-11',901,'2026-10-12',NULL,NULL)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('stock_requests','id'), 100, true);

-- Les mouvements réellement produits par les réceptions.
INSERT INTO stock_movements
 (id,type,product_reference,product_name,quantity,destination_warehouse,reason,status,
  approval_status,company_id,created_by,validated_by,validated_at,product_id) VALUES
 (1,'Entrée','TRX600','Tôle TRX600',120,'W-TRI','Demande DE-003','Validé','Validé',1,906,906,'2026-10-14',1),
 (2,'Entrée','CPJ425','Ciment CPJ 42.5',80,'W-TRI','Demande DE-003','Validé','Validé',1,906,906,'2026-10-14',2),
 (3,'Sortie','TRX600','Tôle TRX600',50,'W-TRI','Demande DE-004','Validé','Validé',1,906,906,'2026-10-09',1),
 (4,'Inventaire','CPJ425','Ciment CPJ 42.5',300,'W-TRI','Demande IN-005','Validé','Validé',1,906,906,'2026-10-15',2)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('stock_movements','id'), 100, true);

INSERT INTO stock_request_lines
 (id,company_id,request_id,line_no,product_id,product_reference,product_name,unit,
  quantity_requested,quantity_received,warehouse,movement_id) VALUES
 (1,1,1,1,1,'TRX600','Tôle TRX600','u',  60,  0,'W-TRI',NULL),
 (2,1,1,2,2,'CPJ425','Ciment CPJ 42.5','sac', 40, 0,'W-TRI',NULL),
 (3,1,2,1,1,'TRX600','Tôle TRX600','u', 100,  0,'W-TRI',NULL),
 (4,1,3,1,1,'TRX600','Tôle TRX600','u', 120,120,'W-TRI',1),
 (5,1,3,2,2,'CPJ425','Ciment CPJ 42.5','sac', 80, 80,'W-TRI',2),
 (6,1,4,1,1,'TRX600','Tôle TRX600','u',  50, 50,'W-TRI',3),
 (7,1,5,1,2,'CPJ425','Ciment CPJ 42.5','sac',300,300,'W-TRI',4),
 (10,2,10,1,9,'SBL-F','Sable fin','m3', 25, 0,'W-FAT',NULL)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('stock_request_lines','id'), 100, true);

-- Droits.
INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, r.role, m.module_key, a.action, true
  FROM companies c
  CROSS JOIN (VALUES ('super_admin'),('direction')) AS r(role)
  CROSS JOIN (VALUES ('stock'),('demande')) AS m(module_key)
  CROSS JOIN (VALUES ('visible'),('view'),('create'),('update'),('validate'),('delete')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, r.role, 'demande', 'contrepasser', true
  FROM companies c CROSS JOIN (VALUES ('super_admin'),('direction')) AS r(role)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

/* Le magasinier crée, soumet, réceptionne. Il ne défait pas seul ce que le
   magasin a rangé : c'est tout l'objet du droit distinct. */
INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, 'magasinier', m.module_key, a.action, true
  FROM companies c
  CROSS JOIN (VALUES ('stock'),('demande')) AS m(module_key)
  CROSS JOIN (VALUES ('visible'),('view'),('create'),('update'),('validate')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, 'magasinier', 'demande', 'contrepasser', false
  FROM companies c WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = false;

COMMIT;

DO $$
BEGIN
  RAISE NOTICE 'Jeu d''essai demandes : % demandes pour Triangle, % incohérente(s).',
    (SELECT count(*) FROM stock_requests WHERE company_id=1),
    (SELECT count(*) FROM v_demandes_incoherentes WHERE company_id=1);
END $$;

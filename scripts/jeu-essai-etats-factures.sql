-- Jeu d'essai des états de factures.
--
-- Deux sociétés, deux produits, et des factures dans des situations
-- différentes : payées, partiellement payées, impayées, annulées, brouillon.
-- Un état doit porter les premières et refuser les deux dernières.
--
-- FAT & MAT reçoit ses propres factures, avec des NUMÉROS IDENTIQUES à ceux
-- de Triangle. C'est volontaire : la contrainte d'unicité des états est posée
-- sur (company_id, product, numéro), et un essai où les numéros diffèrent ne
-- prouverait pas que les deux sociétés sont séparées.
BEGIN;

INSERT INTO companies(id,name,tenant_id) VALUES (1,'Triangle','triangle'),(2,'FAT & MAT','triangle')
  ON CONFLICT (id) DO UPDATE SET tenant_id='triangle';
SELECT setval(pg_get_serial_sequence('companies','id'), 10, true);

INSERT INTO users(id,fullname,email,password,role,company_id,is_super_admin,is_active) VALUES
 (900,'Super Triangle','sup.tri@t.local','x','super_admin',1,true,true),
 (901,'Super Fatemat','sup.fat@t.local','x','super_admin',2,true,true),
 (903,'Comptable Triangle','compta.tri@t.local','x','comptable',1,false,true),
 (904,'Direction Triangle','dir.tri@t.local','x','direction',1,false,true),
 (905,'Magasinier Triangle','mag.tri@t.local','x','magasinier',1,false,true),
 (906,'Comptable Fatemat','compta.fat@t.local','x','comptable',2,false,true)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('users','id'), 2000, true);

-- ── Les clients ───────────────────────────────────────────────────────────
INSERT INTO sand_customers(id,company_id,name) VALUES
 (501,1,'SOCOBAT'),(502,1,'Entreprise Keita'),(503,2,'Chantier FAT')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('sand_customers','id'), 900, true);

INSERT INTO cement_customers(id,company_id,name) VALUES
 (601,1,'Briqueterie du Fleuve'),(602,2,'FAT Construction')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('cement_customers','id'), 900, true);

-- ── Les ventes, dont les factures dépendent ───────────────────────────────
INSERT INTO sand_sales(id,company_id,sale_number,customer_id) VALUES
 (701,1,'VS-0001',501),(702,1,'VS-0002',501),(703,1,'VS-0003',502),
 (704,1,'VS-0004',502),(705,1,'VS-0005',501),(706,2,'VS-0001',503)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('sand_sales','id'), 900, true);

-- unit_price > 0 est exigé par cement_sales_unit_price_positive_chk : une
-- vente de ciment à prix nul n'existe pas.
INSERT INTO cement_sales(id,company_id,sale_number,customer_name,customer_id,tonnage,unit_price) VALUES
 (801,1,'VC-0001','Briqueterie du Fleuve',601,12,100000),
 (802,1,'VC-0002','Briqueterie du Fleuve',601, 9,100000),
 (803,2,'VC-0001','FAT Construction',602,      7,100000)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('cement_sales','id'), 900, true);

-- ── Les factures sable de Triangle ────────────────────────────────────────
--   FS-0001  impayée        450 000
--   FS-0002  partielle      600 000 dont 200 000 payés
--   FS-0003  payée          300 000
--   FS-0004  ANNULÉE        100 000  → ne doit jamais entrer dans un état
--   FS-0005  REMPLACÉE      250 000  → non plus (sand_invoices n'a pas de BROUILLON)
INSERT INTO sand_invoices
 (id,company_id,sale_id,customer_id,invoice_number,invoice_date,destination,
  total_amount,paid_amount,remaining_amount,status) VALUES
 (1001,1,701,501,'FS-0001','2026-09-02','Sotuba',  450000,      0, 450000,'IMPAYEE'),
 (1002,1,702,501,'FS-0002','2026-09-08','Sotuba',  600000, 200000, 400000,'PARTIELLEMENT_PAYEE'),
 (1003,1,703,502,'FS-0003','2026-09-14','Kalaban', 300000, 300000,      0,'PAYEE'),
 (1004,1,704,502,'FS-0004','2026-09-20','Kalaban', 100000,      0, 100000,'ANNULEE'),
 (1005,1,705,501,'FS-0005','2026-09-25','Sotuba',  250000,      0, 250000,'REMPLACEE')
ON CONFLICT (id) DO NOTHING;

-- ── FAT & MAT : MÊMES NUMÉROS, autre société ──────────────────────────────
INSERT INTO sand_invoices
 (id,company_id,sale_id,customer_id,invoice_number,invoice_date,destination,
  total_amount,paid_amount,remaining_amount,status) VALUES
 (1101,2,706,503,'FS-0001','2026-09-03','Ségou', 800000, 0, 800000,'IMPAYEE')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('sand_invoices','id'), 5000, true);

-- ── Les factures ciment ───────────────────────────────────────────────────
INSERT INTO cement_invoices
 (id,company_id,sale_id,customer_id,invoice_number,invoice_date,destination,
  total_amount,paid_amount,remaining_amount,status) VALUES
 (2001,1,801,601,'FC-0001','2026-09-05','Markala', 1200000,       0,1200000,'IMPAYEE'),
 (2002,1,802,601,'FC-0002','2026-09-18','Markala',  900000,  900000,      0,'PAYEE'),
 (2003,2,803,602,'FC-0001','2026-09-06','Ségou',    700000,       0, 700000,'IMPAYEE')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('cement_invoices','id'), 5000, true);

-- ── Les droits
-- Les semis des migrations bouclent sur les sociétés EXISTANTES au moment où
-- elles tournent. Ici les sociétés sont créées après : on pose donc les
-- droits explicitement, sinon tout répondrait 404 et les tests mesureraient
-- l'absence de semis, pas le comportement des états.
INSERT INTO role_permissions (company_id, role, module_key, action, allowed)
SELECT c.id, r.role, 'etat_facture', a.action, r.droit
  FROM (VALUES (1),(2)) AS c(id),
       (VALUES ('direction',true),('admin',true)) AS r(role,droit),
       (VALUES ('visible'),('view'),('create'),('validate'),('print'),
               ('reprint'),('cancel'),('correct'),('export'),('archive')) AS a(action)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = EXCLUDED.allowed;

-- Le comptable : prépare, valide, imprime — mais n'annule ni ne corrige.
INSERT INTO role_permissions (company_id, role, module_key, action, allowed) VALUES
 (1,'comptable','etat_facture','visible',true),(1,'comptable','etat_facture','view',true),
 (1,'comptable','etat_facture','create',true),(1,'comptable','etat_facture','validate',true),
 (1,'comptable','etat_facture','print',true),(1,'comptable','etat_facture','export',true),
 (1,'comptable','etat_facture','cancel',false),(1,'comptable','etat_facture','correct',false),
 (1,'comptable','etat_facture','archive',false),
 /* Volontairement SANS « reprint » : la réimpression se teste par son refus. */
 (2,'comptable','etat_facture','visible',true),(2,'comptable','etat_facture','view',true),
 (2,'comptable','etat_facture','create',true),(2,'comptable','etat_facture','validate',true),
 (2,'comptable','etat_facture','print',true),
 (1,'magasinier','etat_facture','visible',false)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = EXCLUDED.allowed;

-- Les produits : le comptable de Triangle voit le sable ET le ciment ; la
-- direction aussi. Un rôle d'essai « comptable » de FAT & MAT ne voit que le
-- sable, pour éprouver le second verrou.
INSERT INTO role_permissions (company_id, role, module_key, action, allowed)
SELECT c.id, r.role, m.module, a.action, true
  FROM (VALUES (1),(2)) AS c(id),
       (VALUES ('direction'),('admin'),('comptable')) AS r(role),
       (VALUES ('sable'),('ciment')) AS m(module),
       (VALUES ('visible'),('view')) AS a(action)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = EXCLUDED.allowed;

UPDATE role_permissions SET allowed = false
 WHERE company_id = 2 AND role = 'comptable' AND module_key = 'ciment';

COMMIT;

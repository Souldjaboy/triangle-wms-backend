-- Jeu d'essai de la contrepassation des encaissements ciment.
--
-- Une facture de 3 000 000 FCFA réglée en deux fois : 1 200 000 à la BDM et
-- 800 000 en espèces. Il reste 1 000 000 dû. Contrepasser le premier doit
-- ramener le dû à 2 200 000 et faire ressortir l'argent de la BDM — sans
-- toucher au second paiement.
--
-- Une seconde facture entièrement soldée, pour éprouver qu'une facture
-- « PAYEE » redevient « PARTIELLEMENT_PAYEE » et non « IMPAYEE ».
BEGIN;

INSERT INTO companies(id,name,tenant_id) VALUES (1,'Triangle','triangle'),(2,'FAT & MAT','triangle')
  ON CONFLICT (id) DO UPDATE SET tenant_id='triangle';
SELECT setval(pg_get_serial_sequence('companies','id'), 10, true);

INSERT INTO users(id,fullname,email,password,role,company_id,is_super_admin,is_active) VALUES
 (900,'Super Triangle','sup.tri@t.local','x','super_admin',1,true,true),
 (901,'Super Fatemat','sup.fat@t.local','x','super_admin',2,true,true),
 (903,'Comptable Triangle','compta.tri@t.local','x','comptable',1,false,true),
 (904,'Direction Triangle','dir.tri@t.local','x','direction',1,false,true),
 (905,'Magasinier Triangle','mag.tri@t.local','x','magasinier',1,false,true)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('users','id'), 2000, true);

-- Le module ciment doit être activé : sans cela le garde renvoie 403 et l'on
-- ne testerait plus la contrepassation, seulement l'activation.
INSERT INTO company_modules(company_id, module_key, is_enabled) VALUES
 (1,'cement',true),(2,'cement',true)
ON CONFLICT DO NOTHING;

INSERT INTO accounting_banks(id,company_id,bank_name,account_number,currency,
                             initial_balance,current_balance,is_active) VALUES
 (1,1,'BDM','ML-BDM-0001','FCFA',20000000,20000000,true),
 (10,2,'BDM FAT & MAT','ML-BDM-F001','FCFA',8000000,8000000,true)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('accounting_banks','id'), 50, true);

INSERT INTO caisses(id,company_id,nom_caisse,code_caisse,statut,
                    solde_initial,solde_actuel,actif) VALUES
 (1,1,'Caisse principale','CP','ouverte',2000000,2000000,true)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('caisses','id'), 50, true);

/* Une seule trésorerie par société : la contrainte est sur company_id, pas
   sur l'identifiant. */
INSERT INTO treasury_accounts(company_id,currency,initial_balance,current_balance) VALUES
 (1,'FCFA',0,0),(2,'FCFA',0,0)
ON CONFLICT (company_id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('treasury_accounts','id'), 50, true);

INSERT INTO cement_customers(id,company_id,customer_code,name,phone,status,created_by) VALUES
 (1,1,'CLI-001','Entreprise Sidibé','70000001','ACTIF',903),
 (10,2,'CLI-F01','Client FAT & MAT','70000010','ACTIF',901)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('cement_customers','id'), 50, true);

INSERT INTO cement_sales
 (id,company_id,sale_number,customer_id,customer_name,destination,
  cement_type,strength,tonnage,unit_price,total_amount,paid_amount,remaining_amount,
  status,sale_date,created_by) VALUES
 (1,1,'VC-000001',1,'Entreprise Sidibé','Chantier Kati','CPJ','42.5',30,100000,
  3000000,2000000,1000000,'PARTIELLEMENT_PAYEE','2026-10-05',903),
 (2,1,'VC-000002',1,'Entreprise Sidibé','Chantier Sotuba','CPJ','32.5',10,100000,
  1000000,1000000,0,'PAYEE','2026-10-08',903),
 (10,2,'VC-F00001',10,'Client FAT & MAT','Chantier FAT','CPJ','42.5',5,100000,
  500000,500000,0,'PAYEE','2026-10-08',901)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('cement_sales','id'), 50, true);

INSERT INTO cement_invoices
 (id,company_id,sale_id,customer_id,invoice_number,operation_reference,invoice_date,
  destination,total_amount,paid_amount,remaining_amount,status,created_by) VALUES
 (1,1,1,1,'FC-000001','OP-001','2026-10-05','Chantier Kati',
  3000000,2000000,1000000,'PARTIELLEMENT_PAYEE',903),
 (2,1,2,1,'FC-000002','OP-002','2026-10-08','Chantier Sotuba',
  1000000,1000000,0,'PAYEE',903),
 (10,2,10,10,'FC-F00001','OP-F01','2026-10-08','Chantier FAT',
  500000,500000,0,'PAYEE',901)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('cement_invoices','id'), 50, true);

-- Les encaissements, avec leur transaction comptable, comme la route les écrit.
INSERT INTO cement_payments
 (id,company_id,invoice_id,payment_number,payment_date,amount,payment_method,
  reference,created_by,bank_id) VALUES
 (1,1,1,'PAY-CIM-001','2026-10-06',1200000,'banque','VIR-4471',903,1),
 (2,1,1,'PAY-CIM-002','2026-10-07', 800000,'especes',NULL,   903,NULL),
 (3,1,2,'PAY-CIM-003','2026-10-08',1000000,'banque','VIR-4480',903,1),
 (10,2,10,'PAY-CIM-F01','2026-10-08',500000,'banque','VIR-F01',901,10)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('cement_payments','id'), 50, true);

-- Les soldes reflètent déjà ces encaissements.
--
-- ATTENTION : dans les modules Sable et Ciment, un encaissement « espèces »
-- crédite la TRÉSORERIE GÉNÉRALE (treasury_accounts), jamais une caisse
-- physique — routes/sales-payment-accounting.js ne touche `caisses` à aucun
-- moment. Le jeu d'essai doit refléter cela, sinon la contrepassation
-- partirait d'un état que l'application n'aurait jamais pu produire.
UPDATE accounting_banks SET current_balance = 20000000 + 2200000 WHERE id = 1;
UPDATE treasury_accounts SET current_balance = 800000 WHERE company_id = 1;
UPDATE accounting_banks SET current_balance = 8000000 + 500000 WHERE id = 10;

INSERT INTO accounting_transactions
 (id,company_id,transaction_number,transaction_type,source_type,source_id,bank_id,caisse_id,
  amount,currency,direction,category,description,status,operation_date,created_by) VALUES
 (1,1,'ENC-CIM-001','encaissement_client','cement_payment',1,1,NULL,
  1200000,'FCFA','entrée','Ventes ciment','Encaissement FC-000001','validé','2026-10-06',903),
 (2,1,'ENC-CIM-002','encaissement_client','cement_payment',2,NULL,1,
  800000,'FCFA','entrée','Ventes ciment','Encaissement FC-000001','validé','2026-10-07',903),
 (3,1,'ENC-CIM-003','encaissement_client','cement_payment',3,1,NULL,
  1000000,'FCFA','entrée','Ventes ciment','Encaissement FC-000002','validé','2026-10-08',903),
 (10,2,'ENC-CIM-F01','encaissement_client','cement_payment',10,10,NULL,
  500000,'FCFA','entrée','Ventes ciment','Encaissement FC-F00001','validé','2026-10-08',901)
ON CONFLICT (id) DO NOTHING;
UPDATE cement_payments SET accounting_transaction_id = id WHERE id IN (1,2,3,10);
SELECT setval(pg_get_serial_sequence('accounting_transactions','id'), 100, true);

-- Droits : les migrations de peuplement tournent avant la création de ces
-- sociétés de test. On reproduit ce que la 105 accorde en production.
INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, r.role, 'ciment', a.action, true
  FROM companies c
  CROSS JOIN (VALUES ('super_admin'),('direction'),('comptable')) AS r(role)
  CROSS JOIN (VALUES ('visible'),('view'),('create'),('update'),('validate'),('print')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, r.role, 'ciment', a.action, true
  FROM companies c
  CROSS JOIN (VALUES ('super_admin'),('direction'),('comptable')) AS r(role)
  CROSS JOIN (VALUES ('paiement_contrepasser'),('remboursement_constater')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

-- Le magasinier voit le ciment sans pouvoir défaire un encaissement : sans
-- aucun droit, le garde masquerait le module et l'on ne testerait plus rien.
INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, 'magasinier', 'ciment', a.action, true
  FROM companies c CROSS JOIN (VALUES ('visible'),('view')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, 'magasinier', 'ciment', 'paiement_contrepasser', false
  FROM companies c WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = false;

COMMIT;

DO $$
BEGIN
  RAISE NOTICE 'Jeu d''essai ciment : FC-000001 doit 1 000 000 sur 3 000 000, BDM = % FCFA.',
    (SELECT current_balance FROM accounting_banks WHERE id = 1);
END $$;

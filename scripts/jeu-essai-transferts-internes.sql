-- Jeu d'essai des transferts internes de fonds.
--
-- Il reprend l'exemple exact du cahier des charges : la BDM porte 20 000 000
-- FCFA, et l'on en déplace 5 000 000 vers la trésorerie. Après le transfert,
-- le total des fonds doit être identique au franc près, et ni les recettes ni
-- les dépenses ne doivent avoir bougé.
--
-- FAT & MAT reçoit ses propres comptes : un transfert ne doit jamais pouvoir
-- déplacer l'argent d'une société vers l'autre, ni même le voir.
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

-- ── Les comptes de Triangle ────────────────────────────────────────────────
INSERT INTO accounting_banks(id,company_id,bank_name,account_number,currency,
                             initial_balance,current_balance,is_active) VALUES
 (1,1,'BDM','ML-BDM-0001','FCFA',20000000,20000000,true),
 (2,1,'BNDA','ML-BNDA-0002','FCFA', 3000000, 3000000,true),
 (3,1,'Banque fermée','ML-X-0003','FCFA', 1000000, 1000000,false)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('accounting_banks','id'), 50, true);

INSERT INTO caisses(id,company_id,nom_caisse,code_caisse,statut,
                    solde_initial,solde_actuel,actif) VALUES
 (1,1,'Caisse principale','CP','ouverte',500000,500000,true),
 (2,1,'Caisse fermée','CF','fermee',200000,200000,false)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('caisses','id'), 50, true);

INSERT INTO treasury_accounts(id,company_id,currency,initial_balance,current_balance) VALUES
 (1,1,'FCFA',0,0)
ON CONFLICT (id) DO NOTHING;

-- ── Les comptes de FAT & MAT, pour éprouver l'isolation ────────────────────
INSERT INTO accounting_banks(id,company_id,bank_name,account_number,currency,
                             initial_balance,current_balance,is_active) VALUES
 (10,2,'BDM FAT & MAT','ML-BDM-F001','FCFA',8000000,8000000,true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO caisses(id,company_id,nom_caisse,code_caisse,statut,
                    solde_initial,solde_actuel,actif) VALUES
 (10,2,'Caisse FAT & MAT','CF-F','ouverte',100000,100000,true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO treasury_accounts(id,company_id,currency,initial_balance,current_balance) VALUES
 (10,2,'FCFA',0,0)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('treasury_accounts','id'), 50, true);

-- ── De vraies recettes et de vraies dépenses, pour que les totaux d'avant
--    ne soient pas nuls : un transfert qui ne bouge rien est plus facile à
--    constater quand il y a déjà quelque chose à ne pas bouger. ────────────
INSERT INTO accounting_transactions
  (company_id,transaction_number,transaction_type,source_type,source_id,bank_id,
   amount,currency,direction,category,description,status,operation_date,created_by) VALUES
 (1,'ENC-REEL-1','encaissement_client','invoice_payment',1,1,
  4000000,'FCFA','entrée','Ventes','Encaissement facture client','validé','2026-10-01',903),
 (1,'DEC-REEL-1','paiement_fournisseur','purchase_payment',1,1,
  1500000,'FCFA','sortie','Achats','Règlement fournisseur','validé','2026-10-02',903)
ON CONFLICT DO NOTHING;

-- ── Un ancien mouvement qui ressemble à un transfert, enregistré AVANT que
--    le type n'existe. Il doit apparaître dans v_transferts_internes_candidats
--    et n'être touché par rien d'automatique. ──────────────────────────────
INSERT INTO accounting_transactions
  (company_id,transaction_number,transaction_type,source_type,bank_id,
   amount,currency,direction,category,description,status,operation_date,created_by) VALUES
 (1,'ANC-TRF-1','depot_caisse_banque','manual',1,
  750000,'FCFA','entrée','Trésorerie','Dépôt de la caisse à la BDM','validé','2026-09-15',903)
ON CONFLICT DO NOTHING;

SELECT setval(pg_get_serial_sequence('accounting_transactions','id'),
              GREATEST((SELECT COALESCE(MAX(id),0) FROM accounting_transactions), 100), true);

-- ── Droits ────────────────────────────────────────────────────────────────
-- Les migrations de peuplement tournent AVANT la création de ces sociétés de
-- test, donc role_permissions est vide ici. On reproduit EXACTEMENT ce que la
-- migration 103 accorde en production : la Direction déplace et annule, le
-- comptable déplace mais n'annule pas. Sans ces lignes, le garde RBAC masque
-- le module (404) et le test des droits ne testerait plus la règle elle-même.
INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, 'direction', 'comptabilite.transfert_interne', a.action, true
  FROM companies c CROSS JOIN (VALUES ('visible'),('view'),('create'),('delete'),('print'),('export')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, 'comptable', 'comptabilite.transfert_interne', a.action, true
  FROM companies c CROSS JOIN (VALUES ('visible'),('view'),('create'),('print'),('export')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

-- Explicitement refusé, pas simplement absent : c'est la différence entre
-- « on ne vous l'a pas encore donné » et « ce geste ne vous appartient pas ».
INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, 'comptable', 'comptabilite.transfert_interne', 'delete', false
  FROM companies c WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = false;

-- Le magasinier voit la comptabilité sans pouvoir y déplacer d'argent : sans
-- aucun droit, le garde masquerait le module et l'on ne testerait plus rien.
INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, 'magasinier', 'comptabilite.transfert_interne', a.action, true
  FROM companies c CROSS JOIN (VALUES ('visible'),('view')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

-- Les écrans comptables lus par les tests (états financiers, tableau de bord).
INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, r.role, 'comptabilite', a.action, true
  FROM companies c
  CROSS JOIN (VALUES ('super_admin'),('direction'),('comptable')) AS r(role)
  CROSS JOIN (VALUES ('visible'),('view'),('export'),('print')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

COMMIT;

DO $$
DECLARE total NUMERIC;
BEGIN
  SELECT COALESCE((SELECT SUM(current_balance) FROM accounting_banks WHERE company_id=1),0)
       + COALESCE((SELECT SUM(solde_actuel)    FROM caisses         WHERE company_id=1),0)
       + COALESCE((SELECT SUM(current_balance) FROM treasury_accounts WHERE company_id=1),0)
    INTO total;
  RAISE NOTICE 'Jeu d''essai transferts : fonds Triangle = % FCFA (BDM 20 000 000 incluse).', total;
END $$;

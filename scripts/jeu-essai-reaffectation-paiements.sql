-- Jeu d'essai de la réaffectation des paiements.
--
-- Il met en place exactement les situations que la réaffectation doit savoir
-- traiter : un paiement unique, des paiements MULTIPLES sur une même facture,
-- un paiement PARTIEL, une facture déjà soldée, une facture annulée, et un
-- paiement déjà CONTREPASSÉ qui ne doit plus pouvoir bouger.
--
-- FAT & MAT reçoit les siens, pour éprouver qu'un paiement ne traverse jamais
-- la frontière entre les deux sociétés.
BEGIN;

INSERT INTO companies(id,name,tenant_id) VALUES (1,'Triangle','triangle'),(2,'FAT & MAT','triangle')
  ON CONFLICT (id) DO UPDATE SET tenant_id='triangle';
SELECT setval(pg_get_serial_sequence('companies','id'), 10, true);

INSERT INTO users(id,fullname,email,password,role,company_id,is_super_admin,is_active) VALUES
 (900,'Super Triangle','sup.tri@t.local','x','super_admin',1,true,true),
 (903,'Comptable Triangle','compta.tri@t.local','x','comptable',1,false,true),
 (904,'Direction Triangle','dir.tri@t.local','x','direction',1,false,true),
 (905,'Magasinier Triangle','mag.tri@t.local','x','magasinier',1,false,true),
 (906,'Comptable Fatemat','compta.fat@t.local','x','comptable',2,false,true)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('users','id'), 2000, true);

INSERT INTO sand_customers(id,company_id,name) VALUES
 (501,1,'SOCOBAT'),(502,1,'Entreprise Keita'),(503,2,'Chantier FAT')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('sand_customers','id'), 900, true);
INSERT INTO cement_customers(id,company_id,name) VALUES
 (601,1,'Briqueterie du Fleuve'),(602,2,'FAT Construction')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('cement_customers','id'), 900, true);

INSERT INTO sand_sales(id,company_id,sale_number,customer_id,total_amount,paid_amount,remaining_amount,status) VALUES
 (701,1,'VS-0001',501,1000000,     0,1000000,'VALIDEE'),
 (702,1,'VS-0002',501, 500000,     0, 500000,'VALIDEE'),
 (703,1,'VS-0003',502, 900000,     0, 900000,'VALIDEE'),
 (704,1,'VS-0004',502, 300000,     0, 300000,'VALIDEE'),
 (705,1,'VS-0005',501, 200000,     0, 200000,'ANNULEE'),
 (706,2,'VS-0001',503, 900000,     0, 900000,'VALIDEE')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('sand_sales','id'), 900, true);

INSERT INTO cement_sales(id,company_id,sale_number,customer_name,customer_id,tonnage,unit_price,total_amount,paid_amount,remaining_amount,status) VALUES
 (801,1,'VC-0001','Briqueterie du Fleuve',601,12,100000,1200000,0,1200000,'FACTUREE'),
 (802,1,'VC-0002','Briqueterie du Fleuve',601, 6,100000, 600000,0, 600000,'FACTUREE'),
 (803,2,'VC-0001','FAT Construction',602,      7,100000, 700000,0, 700000,'FACTUREE')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('cement_sales','id'), 900, true);

-- ── Les factures sable de Triangle ────────────────────────────────────────
--  FS-0001  1 000 000  → recevra le paiement à déplacer (600 000, partiel)
--  FS-0002    500 000  → cible possible ; un déplacement de 600 000 la met
--                        en trop-perçu de 100 000
--  FS-0003    900 000  → deux paiements (300+500), pour le cas « multiples » ;
--                        après contrepassation de l'un, elle a juste la place
--                        d'absorber le déplacement de 600 000
--  FS-0004    300 000  → soldée d'un coup
--  FS-0005    200 000  → ANNULÉE : aucun paiement ne doit s'y poser
INSERT INTO sand_invoices
 (id,company_id,sale_id,customer_id,invoice_number,invoice_date,
  total_amount,paid_amount,remaining_amount,status) VALUES
 (1001,1,701,501,'FS-0001','2026-09-02',1000000,      0,1000000,'IMPAYEE'),
 (1002,1,702,501,'FS-0002','2026-09-05', 500000,      0, 500000,'IMPAYEE'),
 (1003,1,703,502,'FS-0003','2026-09-09', 900000,      0, 900000,'IMPAYEE'),
 (1004,1,704,502,'FS-0004','2026-09-12', 300000,      0, 300000,'IMPAYEE'),
 (1005,1,705,501,'FS-0005','2026-09-15', 200000,      0, 200000,'ANNULEE'),
 (1101,2,706,503,'FS-0001','2026-09-03', 900000,      0, 900000,'IMPAYEE')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('sand_invoices','id'), 5000, true);

INSERT INTO cement_invoices
 (id,company_id,sale_id,customer_id,invoice_number,invoice_date,
  total_amount,paid_amount,remaining_amount,status) VALUES
 (2001,1,801,601,'FC-0001','2026-09-05',1200000,0,1200000,'IMPAYEE'),
 (2002,1,802,601,'FC-0002','2026-09-18', 600000,0, 600000,'IMPAYEE'),
 (2003,2,803,602,'FC-0001','2026-09-06', 700000,0, 700000,'IMPAYEE')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('cement_invoices','id'), 5000, true);

-- ── Les encaissements ─────────────────────────────────────────────────────
-- P1  600 000 sur FS-0001  → le paiement mal imputé, partiel
-- P2  300 000 sur FS-0003  ┐ deux paiements sur la même facture
-- P3  500 000 sur FS-0003  ┘ (total 800 000 : elle est soldée)
-- P4  300 000 sur FS-0004  → solde la facture d'un coup
-- P5  200 000 sur FS-0001  → sera contrepassé : il ne doit plus bouger
INSERT INTO sand_payments(id,company_id,invoice_id,payment_number,payment_date,amount,payment_method) VALUES
 (3001,1,1001,'PS-0001','2026-09-03',600000,'VIREMENT'),
 (3002,1,1003,'PS-0002','2026-09-10',300000,'ESPECES'),
 (3003,1,1003,'PS-0003','2026-09-11',500000,'CHEQUE'),
 (3004,1,1004,'PS-0004','2026-09-13',300000,'ESPECES'),
 (3005,1,1001,'PS-0005','2026-09-14',200000,'ESPECES'),
 (3101,2,1101,'PS-0001','2026-09-04',400000,'VIREMENT')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('sand_payments','id'), 9000, true);

INSERT INTO cement_payments(id,company_id,invoice_id,payment_number,payment_date,amount,payment_method) VALUES
 (4001,1,2001,'PC-0001','2026-09-07',400000,'VIREMENT'),
 (4101,2,2003,'PC-0001','2026-09-08',300000,'ESPECES')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('cement_payments','id'), 9000, true);

-- PS-0005 est contrepassé : l'argent est ressorti, il n'y a plus rien à
-- déplacer. La réaffectation doit le refuser, en disant pourquoi.
INSERT INTO sand_payment_reversals
 (company_id, original_payment_id, invoice_id, amount, reason, created_by, created_by_name)
VALUES (1, 3005, 1001, 200000, 'chèque sans provision', 904, 'Direction Triangle')
ON CONFLICT DO NOTHING;

-- Les soldes, reconstruits depuis les paiements réels : le jeu d'essai ne
-- doit pas poser des montants à la main qui contrediraient le calcul.
UPDATE sand_invoices i SET paid_amount = t.s,
       remaining_amount = GREATEST(i.total_amount - t.s, 0),
       status = CASE WHEN i.status='ANNULEE' THEN 'ANNULEE'
                     WHEN t.s >= i.total_amount AND i.total_amount>0 THEN 'PAYEE'
                     WHEN t.s > 0 THEN 'PARTIELLEMENT_PAYEE' ELSE 'IMPAYEE' END
  FROM (SELECT inv.id, COALESCE(SUM(p.amount) FILTER (
                WHERE NOT EXISTS (SELECT 1 FROM sand_payment_reversals r
                                   WHERE r.company_id=p.company_id AND r.original_payment_id=p.id)),0) s
          FROM sand_invoices inv LEFT JOIN sand_payments p ON p.invoice_id=inv.id AND p.company_id=inv.company_id
         GROUP BY inv.id) t
 WHERE i.id = t.id;

UPDATE cement_invoices i SET paid_amount = t.s,
       remaining_amount = GREATEST(i.total_amount - t.s, 0),
       status = CASE WHEN t.s >= i.total_amount AND i.total_amount>0 THEN 'PAYEE'
                     WHEN t.s > 0 THEN 'PARTIELLEMENT_PAYEE' ELSE 'IMPAYEE' END
  FROM (SELECT inv.id, COALESCE(SUM(p.amount),0) s
          FROM cement_invoices inv LEFT JOIN cement_payments p ON p.invoice_id=inv.id AND p.company_id=inv.company_id
         GROUP BY inv.id) t
 WHERE i.id = t.id;

-- ── Les droits
-- Les semis des migrations bouclent sur les sociétés existantes au moment où
-- elles tournent ; les sociétés sont créées ici après. On pose donc tout
-- explicitement, sinon les tests mesureraient l'absence de semis.
INSERT INTO role_permissions (company_id, role, module_key, action, allowed)
SELECT c.id, r.role, m.module, a.action, true
  FROM (VALUES (1),(2)) AS c(id),
       (VALUES ('direction'),('admin'),('comptable')) AS r(role),
       (VALUES ('sable'),('ciment')) AS m(module),
       (VALUES ('visible'),('view'),('paiement_reaffecter')) AS a(action)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = EXCLUDED.allowed;

-- Le magasinier voit le sable mais ne réaffecte rien : c'est la distinction
-- entre « voir » et « déplacer de l'argent » qui doit être éprouvée.
INSERT INTO role_permissions (company_id, role, module_key, action, allowed) VALUES
 (1,'magasinier','sable','visible',true),
 (1,'magasinier','sable','view',true),
 (1,'magasinier','sable','paiement_reaffecter',false),
 (1,'magasinier','ciment','visible',false)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = EXCLUDED.allowed;

-- Le comptable de FAT & MAT n'a pas le ciment : un droit de réaffectation ne
-- doit pas lui ouvrir une porte sur un module fermé.
UPDATE role_permissions SET allowed = false
 WHERE company_id = 2 AND role = 'comptable' AND module_key = 'ciment';

-- Les modules souscrits par la société. « sand » et « cement » sont opt-in :
-- sans ces lignes, le serveur répond « module non activé » et les écrans
-- restent vides — ce que l'essai mesurerait comme un défaut d'interface.
INSERT INTO company_modules (company_id, module_key, is_enabled)
SELECT c.id, m.k, TRUE
  FROM (VALUES (1),(2)) AS c(id), (VALUES ('sand'),('cement')) AS m(k)
ON CONFLICT (company_id, module_key) DO UPDATE SET is_enabled = TRUE;

COMMIT;

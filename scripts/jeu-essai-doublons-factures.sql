-- Jeu d'essai des doublons de factures.
--
-- Il construit exactement les quatre situations que le module doit savoir
-- distinguer, et que le cahier des charges nomme :
--
--  1. UN DOUBLON TECHNIQUE  — deux factures pour LA MÊME VENTE, le même jour.
--  2. UN RENOUVELLEMENT     — quatre factures mensuelles du même client, même
--                             montant : une location, pas une erreur.
--  3. DES FACTURES DISTINCTES — même client, même montant, mais deux ventes
--                             et deux livraisons différentes.
--  4. UN CAS À EXAMINER     — deux factures CIMENT sans vente rattachée, à
--                             dix jours : aucun signal ne tranche. Le ciment
--                             le permet, le sable non — sand_invoices exige
--                             une vente, et l'on ne fabrique pas un cas
--                             impossible pour faire passer un test.
--
-- Et un cinquième, le plus dangereux : un doublon dont LES DEUX factures ont
-- été encaissées. Le client a payé deux fois ; la neutralisation ne doit pas
-- le dissimuler.
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

INSERT INTO company_modules (company_id, module_key, is_enabled)
SELECT c.id, m.k, TRUE FROM (VALUES (1),(2)) AS c(id), (VALUES ('sand'),('cement')) AS m(k)
ON CONFLICT (company_id, module_key) DO UPDATE SET is_enabled = TRUE;

INSERT INTO sand_customers(id,company_id,name) VALUES
 (501,1,'SOCOBAT'),(502,1,'Entreprise Keita'),(503,1,'Location Diarra'),(504,2,'Chantier FAT')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('sand_customers','id'), 900, true);

-- ── Les ventes ────────────────────────────────────────────────────────────
INSERT INTO sand_sales(id,company_id,sale_number,customer_id,total_amount,status) VALUES
 (701,1,'VS-0001',501,400000,'VALIDEE'),   -- doublon technique : UNE vente
 (702,1,'VS-0002',502,250000,'VALIDEE'),   -- factures distinctes : vente 1
 (703,1,'VS-0003',502,250000,'VALIDEE'),   -- factures distinctes : vente 2
 (704,1,'VS-0004',503,150000,'VALIDEE'),   -- renouvellement, mois 1
 (705,1,'VS-0005',503,150000,'VALIDEE'),   -- mois 2
 (706,1,'VS-0006',503,150000,'VALIDEE'),   -- mois 3
 (707,1,'VS-0007',503,150000,'VALIDEE'),   -- mois 4
 (708,1,'VS-0008',501,900000,'VALIDEE'),   -- à examiner : vente 1
 (709,1,'VS-0009',501,900000,'VALIDEE'),   -- à examiner : vente 2
 (710,1,'VS-0010',501,700000,'VALIDEE'),   -- payé des deux côtés : UNE vente
 (711,2,'VS-0001',504,300000,'VALIDEE')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('sand_sales','id'), 900, true);

-- ── 1. LE DOUBLON TECHNIQUE : même vente, même jour ───────────────────────
INSERT INTO sand_invoices
 (id,company_id,sale_id,customer_id,invoice_number,invoice_date,operation_reference,
  total_amount,paid_amount,remaining_amount,status) VALUES
 (1001,1,701,501,'FS-1001','2026-09-02','OP-701',400000,0,400000,'IMPAYEE'),
 (1002,1,701,501,'FS-1002','2026-09-02','OP-701',400000,0,400000,'IMPAYEE'),

-- ── 2. LE RENOUVELLEMENT : quatre mois, même client, même montant ─────────
 (1010,1,704,503,'FS-1010','2026-06-05',NULL,150000,0,150000,'IMPAYEE'),
 (1011,1,705,503,'FS-1011','2026-07-05',NULL,150000,0,150000,'IMPAYEE'),
 (1012,1,706,503,'FS-1012','2026-08-05',NULL,150000,0,150000,'IMPAYEE'),
 (1013,1,707,503,'FS-1013','2026-09-05',NULL,150000,0,150000,'IMPAYEE'),

-- ── 3. FACTURES DISTINCTES : deux ventes, deux livraisons ─────────────────
 (1020,1,702,502,'FS-1020','2026-09-10','OP-702',250000,0,250000,'IMPAYEE'),
 (1021,1,703,502,'FS-1021','2026-09-24','OP-703',250000,0,250000,'IMPAYEE'),

-- ── 4bis. Même client, même montant, deux semaines : distinctes aussi ─────
 (1030,1,708,501,'FS-1030','2026-09-03',NULL,900000,0,900000,'IMPAYEE'),
 (1031,1,709,501,'FS-1031','2026-09-13',NULL,900000,0,900000,'IMPAYEE'),

-- ── 5. LE CAS DANGEREUX : doublon dont les deux ont été réglées ───────────
 (1040,1,710,501,'FS-1040','2026-09-15','OP-710',700000,0,700000,'IMPAYEE'),
 (1041,1,710,501,'FS-1041','2026-09-15','OP-710',700000,0,700000,'IMPAYEE'),

-- ── FAT & MAT : la frontière ──────────────────────────────────────────────
 (1101,2,711,504,'FS-1101','2026-09-04',NULL,300000,0,300000,'IMPAYEE'),
 (1102,2,711,504,'FS-1102','2026-09-04',NULL,300000,0,300000,'IMPAYEE')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('sand_invoices','id'), 5000, true);

-- Les encaissements.
-- FS-1002 (le doublon technique) a reçu 400 000 : ils devront SUIVRE vers
-- FS-1001 quand on neutralisera, sans qu'aucune écriture ne soit créée.
INSERT INTO sand_payments(id,company_id,invoice_id,payment_number,payment_date,amount,payment_method) VALUES
 (3001,1,1002,'PS-3001','2026-09-04',400000,'VIREMENT'),
 -- Les deux factures du cas 5, chacune réglée : le client a payé deux fois.
 (3010,1,1040,'PS-3010','2026-09-16',700000,'VIREMENT'),
 (3011,1,1041,'PS-3011','2026-09-20',700000,'ESPECES')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('sand_payments','id'), 9000, true);

UPDATE sand_invoices i SET paid_amount = t.s,
       remaining_amount = GREATEST(i.total_amount - t.s, 0),
       status = CASE WHEN i.status='ANNULEE' THEN 'ANNULEE'
                     WHEN t.s >= i.total_amount AND i.total_amount>0 THEN 'PAYEE'
                     WHEN t.s > 0 THEN 'PARTIELLEMENT_PAYEE' ELSE 'IMPAYEE' END
  FROM (SELECT inv.id, COALESCE(SUM(p.amount),0) s
          FROM sand_invoices inv
          LEFT JOIN sand_payments p ON p.invoice_id=inv.id AND p.company_id=inv.company_id
         GROUP BY inv.id) t
 WHERE i.id = t.id;

-- ── 4. LE CAS VRAIMENT AMBIGU : deux factures CIMENT sans vente ──────────
-- cement_invoices accepte sale_id NULL, sand_invoices non : c'est donc au
-- ciment qu'un cas sans aucun signal peut exister.
INSERT INTO cement_customers(id,company_id,name) VALUES (601,1,'Briqueterie du Fleuve')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('cement_customers','id'), 900, true);

INSERT INTO cement_invoices
 (id,company_id,sale_id,customer_id,invoice_number,invoice_date,
  total_amount,paid_amount,remaining_amount,status) VALUES
 (2001,1,NULL,601,'FC-2001','2026-09-03',550000,0,550000,'IMPAYEE'),
 (2002,1,NULL,601,'FC-2002','2026-09-13',550000,0,550000,'IMPAYEE')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('cement_invoices','id'), 5000, true);

-- ── Les droits
INSERT INTO role_permissions (company_id, role, module_key, action, allowed)
SELECT c.id, r.role, m.module, a.action, true
  FROM (VALUES (1),(2)) AS c(id),
       (VALUES ('direction'),('admin')) AS r(role),
       (VALUES ('sable'),('ciment')) AS m(module),
       (VALUES ('visible'),('view'),('validate'),('delete'),('paiement_reaffecter')) AS a(action)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = EXCLUDED.allowed;

/* Le comptable tranche mais ne neutralise pas : c'est la séparation que ces
   essais doivent éprouver. */
INSERT INTO role_permissions (company_id, role, module_key, action, allowed) VALUES
 (1,'comptable','sable','visible',true),(1,'comptable','sable','view',true),
 (1,'comptable','sable','validate',true),(1,'comptable','sable','delete',false),
 (1,'comptable','sable','paiement_reaffecter',true),
 /* Le comptable suit les deux produits : il voit et tranche aussi le ciment,
    mais n'y neutralise pas davantage. */
 (1,'comptable','ciment','visible',true),(1,'comptable','ciment','view',true),
 (1,'comptable','ciment','validate',true),(1,'comptable','ciment','delete',false),
 (1,'magasinier','sable','visible',true),(1,'magasinier','sable','view',true),
 (1,'magasinier','sable','validate',false),(1,'magasinier','sable','delete',false),
 (2,'comptable','sable','visible',true),(2,'comptable','sable','view',true),
 (2,'comptable','sable','validate',true),(2,'comptable','sable','delete',true),
 (2,'comptable','sable','paiement_reaffecter',true)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = EXCLUDED.allowed;

COMMIT;

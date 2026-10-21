-- Jeu d'essai de la réconciliation FAT & MAT.
--
-- Il reproduit la forme des trois relevés — 14 réglées, 11 impayées, 9
-- impayées de fin de période — puis y glisse les anomalies qu'on rencontre
-- réellement : doublons, facture marquée payée sans le moindre encaissement,
-- saisie tardive, montants qui ne s'additionnent pas, facture annulée dont
-- l'encaissement subsiste.
--
-- Les montants sont construits pour que, UNE FOIS LES ANOMALIES ÉCARTÉES,
-- chaque relevé retombe sur son total annoncé. C'est ce qui rend le rapport
-- vérifiable plutôt que simplement plausible.
BEGIN;

INSERT INTO companies(id,name,tenant_id) VALUES (1,'Triangle','triangle'),(2,'FAT & MAT','triangle')
  ON CONFLICT (id) DO UPDATE SET tenant_id='triangle';
SELECT setval(pg_get_serial_sequence('companies','id'), 10, true);

INSERT INTO users(id,fullname,email,password,role,company_id,is_super_admin,is_active) VALUES
 (901,'Super Fatemat','sup.fat@t.local','x','super_admin',2,true,true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO sand_customers(id,company_id,name,phone,created_by) VALUES
 (1,2,'Entreprise Coulibaly','70000001',901),
 (2,2,'Chantier Kati','70000002',901),
 (3,2,'SARL Diarra','70000003',901),
 (4,2,'Bâtiment Sanogo','70000004',901)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('sand_customers','id'), 50, true);

-- Chaque facture s'appuie sur une vente : sand_invoices.sale_id est NOT NULL
-- et référencé. « Facture sans vente » est donc structurellement impossible —
-- ce qui existe, en revanche, c'est une facture dont la VENTE a été annulée.
INSERT INTO sand_sales
 (id,company_id,sale_number,customer_id,customer_name,destination,
  quantity_m3,unit_price,sand_subtotal,transport_price,transport_total,
  discount,tax_amount,total_amount,paid_amount,remaining_amount,status,sale_date,created_by)
SELECT n, 2, 'VS-'||LPAD(n::text,4,'0'), 1, 'Client', 'Site',
       10, 100000, 1000000, 0, 0, 0, 0, 1000000, 0, 1000000, 'VALIDEE', '2026-09-01', 901
  FROM generate_series(1, 70) AS n
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('sand_sales','id'), 200, true);

-- La vente 64 est annulée : sa facture devient « vente annulée ».
UPDATE sand_sales SET status = 'ANNULEE', cancelled_at = '2026-09-28', cancelled_by = 901
 WHERE id = 64 AND company_id = 2;

-- ── RELEVÉ 1 : 14 factures réglées au 09/09/2026, 20 239 000 FCFA ────────
-- 13 factures saines + 1 doublon à écarter, dont les montants retombent juste.
INSERT INTO sand_invoices
 (id,company_id,sale_id,customer_id,invoice_number,operation_reference,invoice_date,
  destination,total_amount,paid_amount,remaining_amount,status,created_by,created_at,
  print_count,printed_at) VALUES
 (1 ,2,1 ,1,'FS-0001','OP-001','2026-09-01','Kati'      ,1500000,1500000,0,'PAYEE',901,'2026-09-01',1,'2026-09-01'),
 (2 ,2,2 ,1,'FS-0002','OP-002','2026-09-02','Kati'      ,1450000,1450000,0,'PAYEE',901,'2026-09-02',1,'2026-09-02'),
 (3 ,2,3 ,2,'FS-0003','OP-003','2026-09-02','Sotuba'    ,1600000,1600000,0,'PAYEE',901,'2026-09-02',1,'2026-09-02'),
 (4 ,2,4 ,2,'FS-0004','OP-004','2026-09-03','Sotuba'    ,1380000,1380000,0,'PAYEE',901,'2026-09-03',1,'2026-09-03'),
 (5 ,2,5 ,3,'FS-0005','OP-005','2026-09-03','Magnambougou',1720000,1720000,0,'PAYEE',901,'2026-09-03',1,'2026-09-03'),
 (6 ,2,6 ,3,'FS-0006','OP-006','2026-09-04','Magnambougou',1290000,1290000,0,'PAYEE',901,'2026-09-04',1,'2026-09-04'),
 (7 ,2,7 ,4,'FS-0007','OP-007','2026-09-04','Badalabougou',1540000,1540000,0,'PAYEE',901,'2026-09-04',1,'2026-09-04'),
 (8 ,2,8 ,4,'FS-0008','OP-008','2026-09-05','Badalabougou',1310000,1310000,0,'PAYEE',901,'2026-09-05',1,'2026-09-05'),
 (9 ,2,9 ,1,'FS-0009','OP-009','2026-09-05','Kati'      ,1475000,1475000,0,'PAYEE',901,'2026-09-05',1,'2026-09-05'),
 (10,2,10,2,'FS-0010','OP-010','2026-09-08','Sotuba'    ,1620000,1620000,0,'PAYEE',901,'2026-09-08',1,'2026-09-08'),
 (11,2,11,3,'FS-0011','OP-011','2026-09-08','Magnambougou',1395000,1395000,0,'PAYEE',901,'2026-09-08',1,'2026-09-08'),
 (12,2,12,4,'FS-0012','OP-012','2026-09-09','Badalabougou',1530000,1530000,0,'PAYEE',901,'2026-09-09',1,'2026-09-09'),
 (13,2,13,1,'FS-0013','OP-013','2026-09-09','Kati'      ,1429000,1429000,0,'PAYEE',901,'2026-09-09',1,'2026-09-09'),
 -- ANOMALIE : marquée payée, aucun encaissement en base. On ne l'invente pas.
 -- Le montant la fait tomber JUSTE dans le relevé : 19 239 000 + 1 000 000
 -- = 20 239 000. Le total concorde, le nombre concorde, et pourtant cette
 -- facture est fausse. C'est exactement le cas qu'un contrôle par totaux ne
 -- voit jamais.
 (14,2,14,2,'FS-0014','OP-014','2026-09-09','Sotuba'    ,1000000,1000000,0,'PAYEE',901,'2026-09-09',0,NULL),

 -- ── RELEVÉ 2 : 11 impayées au 23/09/2026, 10 286 000 FCFA ──────────────
 (21,2,21,1,'FS-0021','OP-021','2026-09-12','Kati'      , 950000,0, 950000,'IMPAYEE',901,'2026-09-12',0,NULL),
 (22,2,22,1,'FS-0022','OP-022','2026-09-13','Kati'      , 880000,0, 880000,'IMPAYEE',901,'2026-09-13',0,NULL),
 (23,2,23,2,'FS-0023','OP-023','2026-09-15','Sotuba'    ,1020000,0,1020000,'IMPAYEE',901,'2026-09-15',0,NULL),
 (24,2,24,2,'FS-0024','OP-024','2026-09-16','Sotuba'    , 940000,0, 940000,'IMPAYEE',901,'2026-09-16',0,NULL),
 (25,2,25,3,'FS-0025','OP-025','2026-09-17','Magnambougou', 1010000,0,1010000,'IMPAYEE',901,'2026-09-17',0,NULL),
 (26,2,26,3,'FS-0026','OP-026','2026-09-18','Magnambougou',  870000,0, 870000,'IMPAYEE',901,'2026-09-18',0,NULL),
 (27,2,27,4,'FS-0027','OP-027','2026-09-19','Badalabougou', 1060000,0,1060000,'IMPAYEE',901,'2026-09-19',0,NULL),
 (28,2,28,4,'FS-0028','OP-028','2026-09-20','Badalabougou',  920000,0, 920000,'IMPAYEE',901,'2026-09-20',0,NULL),
 (29,2,29,1,'FS-0029','OP-029','2026-09-21','Kati'      , 990000,0, 990000,'IMPAYEE',901,'2026-09-21',0,NULL),
 (30,2,30,2,'FS-0030','OP-030','2026-09-22','Sotuba'    , 836000,0, 836000,'IMPAYEE',901,'2026-09-22',0,NULL),
 -- ANOMALIE : saisie 20 jours après sa date de facture.
 (31,2,31,3,'FS-0031','OP-031','2026-09-23','Magnambougou', 810000,0, 810000,'IMPAYEE',901,'2026-10-13',0,NULL),

 -- ── RELEVÉ 3 : 9 impayées du 30/09 au 05/10/2026, 7 956 000 FCFA ───────
 (41,2,41,1,'FS-0041','OP-041','2026-09-30','Kati'      , 920000,0, 920000,'IMPAYEE',901,'2026-09-30',0,NULL),
 (42,2,42,1,'FS-0042','OP-042','2026-10-01','Kati'      , 865000,0, 865000,'IMPAYEE',901,'2026-10-01',0,NULL),
 (43,2,43,2,'FS-0043','OP-043','2026-10-01','Sotuba'    , 940000,0, 940000,'IMPAYEE',901,'2026-10-01',0,NULL),
 (44,2,44,2,'FS-0044','OP-044','2026-10-02','Sotuba'    , 880000,0, 880000,'IMPAYEE',901,'2026-10-02',0,NULL),
 (45,2,45,3,'FS-0045','OP-045','2026-10-02','Magnambougou', 905000,0, 905000,'IMPAYEE',901,'2026-10-02',0,NULL),
 (46,2,46,3,'FS-0046','OP-046','2026-10-03','Magnambougou', 848000,0, 848000,'IMPAYEE',901,'2026-10-03',0,NULL),
 (47,2,47,4,'FS-0047','OP-047','2026-10-03','Badalabougou', 918000,0, 918000,'IMPAYEE',901,'2026-10-03',0,NULL),
 (48,2,48,4,'FS-0048','OP-048','2026-10-04','Badalabougou', 795000,0, 795000,'IMPAYEE',901,'2026-10-04',0,NULL),
 (49,2,49,1,'FS-0049','OP-049','2026-10-05','Kati'      , 885000,0, 885000,'IMPAYEE',901,'2026-10-05',0,NULL),

 -- ── LES ANOMALIES À DÉTECTER ───────────────────────────────────────────
 -- Doublon EXACT de FS-0021 : même client, même date, même montant. Jamais
 -- imprimée, jamais encaissée : c'est la candidate type.
 (60,2,60,1,'FS-0060','OP-021','2026-09-12','Kati'    , 950000,0, 950000,'IMPAYEE',901,'2026-09-12',0,NULL),
 -- Doublon PROBABLE de FS-0023 : même client, même montant, trois jours plus
 -- tard. Mais IMPRIMÉE : on ne l'annule pas, on l'examine.
 (61,2,61,2,'FS-0061','OP-023B','2026-09-18','Sotuba' ,1020000,0,1020000,'IMPAYEE',901,'2026-09-18',1,'2026-09-18'),
 -- Montants qui ne s'additionnent pas : 500 000 payés + 400 000 dus ≠ 1 000 000.
 (62,2,62,3,'FS-0062','OP-062','2026-09-25','Magnambougou',1000000,500000,400000,'PARTIELLEMENT_PAYEE',901,'2026-09-25',0,NULL),
 -- Annulée, mais son encaissement subsiste.
 (63,2,63,4,'FS-0063','OP-063','2026-09-26','Badalabougou', 700000,700000,0,'ANNULEE',901,'2026-09-26',0,NULL),
 -- Vente ANNULÉE, et aucun client rattaché.
 (64,2,64,NULL,'FS-0064','OP-064','2026-09-27','Inconnu', 450000,0, 450000,'IMPAYEE',901,'2026-09-27',0,NULL),
 -- Statut incohérent : dit IMPAYEE alors que tout est réglé.
 (65,2,65,1,'FS-0065','OP-065','2026-09-28','Kati'      , 600000,600000,0,'IMPAYEE',901,'2026-09-28',0,NULL)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('sand_invoices','id'), 200, true);

UPDATE sand_invoices SET cancelled_at = '2026-09-27', cancelled_by = 901,
       cancellation_reason = 'Erreur de client' WHERE id = 63;

-- Les encaissements RÉELS. FS-0014 n'en a aucun : c'est le but.
INSERT INTO sand_payments(id,company_id,invoice_id,payment_number,amount,payment_date,payment_method,created_by)
SELECT 100 + i.id, 2, i.id, 'PS-'||LPAD((100 + i.id)::text,4,'0'),
       i.total_amount, i.invoice_date, 'especes', 901
  FROM sand_invoices i
 WHERE i.company_id = 2 AND i.id BETWEEN 1 AND 13
ON CONFLICT (id) DO NOTHING;

INSERT INTO sand_payments(id,company_id,invoice_id,payment_number,amount,payment_date,payment_method,created_by) VALUES
 (200,2,62,'PS-0200',500000,'2026-09-25','especes',901),
 (201,2,63,'PS-0201',700000,'2026-09-26','especes',901),
 (202,2,65,'PS-0202',600000,'2026-09-28','especes',901)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('sand_payments','id'), 500, true);

COMMIT;

DO $$
DECLARE n INTEGER; t NUMERIC;
BEGIN
  SELECT count(*), COALESCE(SUM(total_amount),0) INTO n, t
    FROM sand_invoices WHERE company_id = 2 AND cancelled_at IS NULL;
  RAISE NOTICE 'Jeu d''essai FAT & MAT : % factures actives, % FCFA.', n, t;
END $$;

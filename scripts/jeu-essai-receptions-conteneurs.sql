-- Jeu d'essai — IMPORT DES RÉCEPTIONS DE CONTENEURS.
--
-- Il reproduit les quatre situations que le classeur réel rencontre face à la
-- base, pour qu'aucune ne soit éprouvée « en théorie » :
--
--   • BEAU 466863/3  déjà présente et IDENTIQUE          → ne rien faire
--   • DRYU 923752/6  présente mais INCOMPLÈTE (2 l. / 4) → compléter
--   • TGHU 632434/4  présente, DÉJÀ RANGÉE, et divergente → ne rien écrire
--   • CAIU 967336/5  présente à une AUTRE date            → ambiguë
--
-- Les cinq entrepôts EM2S existent ; « WAREHOUSE-E » et « WAREHOUSE-C » NON —
-- c'est tout l'objet du test.

BEGIN;
INSERT INTO companies(id,name) VALUES (1,'Triangle'),(2,'FAT & MAT') ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('companies','id'), 10, true);

INSERT INTO warehouses(id,code,name,location,status,company_id) VALUES
 (1,'W-EM2S-A','Entrepot EM2S A','Sotuba','Actif',1),
 (2,'W-EM2S-B','Entrepot EM2S B','Sotuba','Actif',1),
 (3,'W-EM2S-C','Entrepot EM2S C','Magnambougou','Actif',1),
 (4,'W-EM2S-D','Entrepot EM2S D','Sotuba','Actif',1),
 (5,'W-EM2S-E','Entrepot EM2S E','Sotuba','Actif',1),
 (6,'W-FAT-A','Entrepot FAT A','Bamako','Actif',2)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('warehouses','id'), 20, true);

/* Quelques produits : des correspondances exactes, une variante d'orthographe
   au catalogue, un FAUX PLAFOND unique, deux homonymes. */
INSERT INTO products(id,company_id,name,reference,unit,stock,warehouse) VALUES
 (101,1,'1800 LEDGER','LEDG-1800','EACH',0,'W-EM2S-E'),
 (102,1,'1000 LEDGER','LEDG-1000','EACH',0,'W-EM2S-E'),
 (103,1,'SWIVEL COUPLER','SWVL-CPL','EACH',0,'W-EM2S-E'),
 (104,1,'3000 STANDART POST','STDP-3000','EACH',0,'W-EM2S-E'),
 (105,1,'FAUX PLAFOND','FXPL-STD','EACH',0,'W-EM2S-C'),
 (106,1,'SCAFFOLD TUBE','SCAF-TUBE','EACH',0,'W-EM2S-E'),
 (107,1,'SCAFFOLD TUBE','SCAF-TUBE-2','EACH',0,'W-EM2S-A'),
 (108,1,'1200 LEDGER','LEDG-1200','EACH',0,'W-EM2S-E')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('products','id'), 500, true);

INSERT INTO stock_receptions(id,company_id,warehouse_id,warehouse_code,reception_number,
  container_number,reception_date,source,source_file,status) VALUES
 (1,1,3,'W-EM2S-C','REC-000001','BEAU 466863/3','2026-09-25','EXCEL_IMPORT','ancien.xlsx','RECEIVED_PENDING_PUTAWAY'),
 (2,1,5,'W-EM2S-E','REC-000002','DRYU 923752/6','2026-09-08','MANUAL',NULL,'RECEIVED_PENDING_PUTAWAY'),
 (3,1,5,'W-EM2S-E','REC-000003','TGHU 632434/4','2026-09-11','MANUAL',NULL,'PUTAWAY_DONE'),
 (4,1,5,'W-EM2S-E','REC-000004','CAIU 967336/5','2026-09-12','MANUAL',NULL,'RECEIVED_PENDING_PUTAWAY')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('stock_receptions','id'), 100, true);

INSERT INTO stock_reception_lines(company_id,reception_id,line_no,received_label,
  received_label_norm,unit,quantity_received,quantity_putaway,warehouse_code,
  product_id,match_status) VALUES
 (1,1,1,'FAUX PLAFOND GRAND','FAUX PLAFOND GRAND','EACH',1016,0,'W-EM2S-C',NULL,'TO_REVIEW'),
 (1,2,1,'3000 STANDARD POST','3000 STANDARD POST','EACH',1522,0,'W-EM2S-E',NULL,'TO_REVIEW'),
 (1,2,2,'SWIVEL COUPLER','SWIVEL COUPLER','EACH',1284,0,'W-EM2S-E',103,'MATCHED'),
 (1,4,1,'FAUX PLAFOND GRAND','FAUX PLAFOND GRAND','EACH',1016,0,'W-EM2S-E',NULL,'TO_REVIEW');
/* Celle-ci est RANGÉE : son stock a bougé, et sa quantité diffère du document. */
INSERT INTO stock_reception_lines(id,company_id,reception_id,line_no,received_label,
  received_label_norm,unit,quantity_received,quantity_putaway,warehouse_code,
  product_id,match_status) VALUES
 (900,1,3,1,'FAUX PLAFOND','FAUX PLAFOND','EACH',900,900,'W-EM2S-E',105,'MATCHED');
SELECT setval(pg_get_serial_sequence('stock_reception_lines','id'), 2000, true);

INSERT INTO stock_movements(id,company_id,product_id,type,quantity,reason,source_reference,
  reception_id,stock_before,stock_after)
VALUES (9001,1,105,'Entrée',900,'Mise en stock réception REC-000003','REC-000003',3,0,900)
ON CONFLICT (id) DO NOTHING;
INSERT INTO stock_putaways(company_id,reception_id,reception_line_id,product_id,movement_id,
  quantity,stock_before,stock_after,warehouse_code)
VALUES (1,3,900,105,9001,900,0,900,'W-EM2S-E');
UPDATE products SET stock=900 WHERE id=105;
COMMIT;

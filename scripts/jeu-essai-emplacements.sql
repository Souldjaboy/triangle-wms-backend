-- Jeu d'essai des emplacements : cinq entrepôts, des rayons précis et des
-- rayons hérités (FULLBIN, plage, bin absent, rebut). Reproduit la situation
-- constatée en production sur W-EM2S-C et W-EM2S-A.
BEGIN;

INSERT INTO warehouses(id,code,name,status,company_id) VALUES
 (1,'W-EM2S-A','Entrepot A','active',1),
 (2,'W-EM2S-B','Entrepot B','active',1),
 (3,'W-EM2S-C','Entrepot C','active',1),
 (4,'W-EM2S-D','Entrepot D','active',1),
 /* « actif » et non « active » : le backend accepte les deux, et c'est
    précisément l'entrepôt que la liste figée du frontend masquait. */
 (5,'W-EM2S-E','Entrepot E','actif',1),
 (6,'W-FAT-A','Entrepot FAT & MAT','active',2)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('warehouses','id'), 20, true);

INSERT INTO products(id,name,company_id) VALUES (1,'Ciment 50kg',1)
ON CONFLICT (id) DO NOTHING;

-- W-EM2S-C : rayons A..E hérités en FULLBIN, F..H avec un bac précis
INSERT INTO locations(company_id,warehouse_id,warehouse_code,rayon_code,case_code,level_code,bin_code,emplacement_code,is_active)
SELECT 1,3,'W-EM2S-C',v.r,'01','N1','FULLBIN','W-EM2S-C-'||v.r||'-01-N1-FULLBIN',true
  FROM (VALUES ('A'),('B'),('C'),('D'),('E')) v(r) ON CONFLICT DO NOTHING;
INSERT INTO locations(company_id,warehouse_id,warehouse_code,rayon_code,case_code,level_code,bin_code,emplacement_code,is_active)
SELECT 1,3,'W-EM2S-C',v.r,'01','N1','BIN1','W-EM2S-C-'||v.r||'-01-N1-BIN1',true
  FROM (VALUES ('F'),('G'),('H')) v(r) ON CONFLICT DO NOTHING;

-- W-EM2S-A : les autres familles d'invisibilité signalées en production
INSERT INTO locations(company_id,warehouse_id,warehouse_code,rayon_code,case_code,level_code,bin_code,emplacement_code,is_active) VALUES
 (1,1,'W-EM2S-A','PICKING AREA','01','N1','','W-EM2S-A-PICKING-01-N1',true),
 (1,1,'W-EM2S-A','WRITE OFF','01','N1','BIN1','W-EM2S-A-WRITEOFF-01-N1-BIN1',true),
 (1,1,'W-EM2S-A','S','01','N1','BIN1-2','W-EM2S-A-S-01-N1-BIN1-2',true),
 (1,1,'W-EM2S-A','T','01','N1','BIN1','W-EM2S-A-T-01-N1-BIN1',true)
ON CONFLICT DO NOTHING;

-- du stock immobilisé sur des emplacements écartés : c'est le vrai enjeu
INSERT INTO stock_location_balances(company_id,location_id,product_id,quantity)
SELECT 1,l.id,1,240 FROM locations l WHERE l.emplacement_code='W-EM2S-C-A-01-N1-FULLBIN'
ON CONFLICT DO NOTHING;
INSERT INTO stock_location_balances(company_id,location_id,product_id,quantity)
SELECT 1,l.id,1,55 FROM locations l WHERE l.emplacement_code='W-EM2S-A-PICKING-01-N1'
ON CONFLICT DO NOTHING;

COMMIT;

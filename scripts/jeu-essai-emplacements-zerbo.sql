-- Jeu d'essai reproduisant EXACTEMENT ce que Zerbo constate.
--
-- Entrepôt W-TRI, rayon D :
--   • D1 — tous ses bacs sont des FULLBIN hérités : le niveau DISPARAÎT du
--     sélecteur alors que du stock y dort. C'est le « D1 manquant alors que
--     D2 et D3 sont visibles ».
--   • D2 — bacs réels, visible.
--   • D3 — bacs réels dont un TOP, visible.
--
-- Rayon E : une étagère dont TOUS les niveaux sont des plages « BIN1-2 ».
-- Rayon F : un seul niveau réel ; les autres ont des bacs non précisés.
--
-- Zones réelles du terrain, avec leurs pièges : WRITE OFF n'est pas un
-- emplacement, NOUVEAU est une valeur générée, PICKING AREA est bien un lieu.
--
-- Zerbo : magasinier de Triangle, droits de stock, un seul entrepôt autorisé.
BEGIN;

INSERT INTO companies(id,name,tenant_id) VALUES (1,'Triangle','triangle'),(2,'FAT & MAT','triangle')
  ON CONFLICT (id) DO UPDATE SET tenant_id='triangle';
SELECT setval(pg_get_serial_sequence('companies','id'), 10, true);

INSERT INTO users(id,fullname,email,password,role,company_id,is_super_admin,is_active) VALUES
 (900,'Super Triangle','sup.tri@t.local','x','super_admin',1,true,true),
 (901,'Super Fatemat','sup.fat@t.local','x','super_admin',2,true,true),
 (906,'Zerbo Magasinier','zerbo@t.local','x','magasinier',1,false,true),
 (908,'Keita Consultation','keita@t.local','x','consultation',1,false,true),
 (907,'Zerbo Fatemat','zerbo.fat@t.local','x','magasinier',2,false,true)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('users','id'), 2000, true);

INSERT INTO warehouses(id,company_id,code,name,status) VALUES
 (1,1,'W-TRI','Entrepôt Triangle Sotuba','active'),
 (2,1,'W-TRI-2','Entrepôt Triangle Magnambougou','active'),
 (9,2,'W-FAT','Entrepôt FAT & MAT','active')
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('warehouses','id'), 50, true);

INSERT INTO products(id,company_id,name,reference,stock) VALUES
 (1,1,'Tôle TRX600','TRX600',0),
 (2,1,'Ciment CPJ 42.5','CPJ425',0),
 (9,2,'Sable fin','SBL-F',0)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('products','id'), 50, true);

-- ── Rayon D : le cas Zerbo ────────────────────────────────────────────────
INSERT INTO locations
 (id, company_id, warehouse_id, warehouse_code, rayon_code, case_code, level_code,
  bin_code, level_rank, bin_rank, full_code, emplacement_code, is_active) VALUES
 -- D1 : rien de sélectionnable. Le niveau disparaissait entièrement.
 (101,1,1,'W-TRI','D','D-ET1','D1','FULLBIN',1,1,'W-TRI/D/D-ET1/D1/FULLBIN','W-TRI/D/D-ET1/D1/FULLBIN',true),
 (102,1,1,'W-TRI','D','D-ET1','D1','FULLBIN',1,2,'W-TRI/D/D-ET1/D1/FULLBIN-2','W-TRI/D/D-ET1/D1/FULLBIN-2',true),
 -- D2 : bacs réels.
 (103,1,1,'W-TRI','D','D-ET1','D2','B01',2,1,'W-TRI/D/D-ET1/D2/B01','W-TRI/D/D-ET1/D2/B01',true),
 (104,1,1,'W-TRI','D','D-ET1','D2','B02',2,2,'W-TRI/D/D-ET1/D2/B02','W-TRI/D/D-ET1/D2/B02',true),
 -- D3 : bacs réels, dont le sommet.
 (105,1,1,'W-TRI','D','D-ET1','D3','B01',3,1,'W-TRI/D/D-ET1/D3/B01','W-TRI/D/D-ET1/D3/B01',true),
 (106,1,1,'W-TRI','D','D-ET1','TOP','B01',9000,1,'W-TRI/D/D-ET1/TOP/B01','W-TRI/D/D-ET1/TOP/B01',true),

 -- ── Rayon E : une étagère entièrement en plages ─────────────────────────
 (110,1,1,'W-TRI','E','E-ET1','E1','BIN1-2',1,1,'W-TRI/E/E-ET1/E1/BIN1-2','W-TRI/E/E-ET1/E1/BIN1-2',true),
 (111,1,1,'W-TRI','E','E-ET1','E2','BIN3-4',2,1,'W-TRI/E/E-ET1/E2/BIN3-4','W-TRI/E/E-ET1/E2/BIN3-4',true),
 -- une seconde étagère, celle-là exploitable : le rayon E n'est donc pas
 -- « entièrement indisponible » et passait sous le radar de l'ancien rapport.
 (112,1,1,'W-TRI','E','E-ET2','E1','B01',1,1,'W-TRI/E/E-ET2/E1/B01','W-TRI/E/E-ET2/E1/B01',true),

 -- ── Rayon F : bacs non précisés ─────────────────────────────────────────
 (120,1,1,'W-TRI','F','F-ET1','F1','NON PRECISE',1,1,'W-TRI/F/F-ET1/F1/NP','W-TRI/F/F-ET1/F1/NP',true),
 (121,1,1,'W-TRI','F','F-ET1','F2','B01',2,1,'W-TRI/F/F-ET1/F2/B01','W-TRI/F/F-ET1/F2/B01',true),

 -- ── Rayon G : entièrement indisponible (bac absent) ─────────────────────
 (130,1,1,'W-TRI','G','G-ET1','G1','',1,1,'W-TRI/G/G-ET1/G1','W-TRI/G/G-ET1/G1',true),

 -- ── Les zones réelles du terrain ────────────────────────────────────────
 (140,1,1,'W-TRI','PICKING AREA','PA-ET1','P1','B01',1,1,'W-TRI/PICKING AREA/PA-ET1/P1/B01','W-TRI/PICKING AREA/PA-ET1/P1/B01',true),
 (141,1,1,'W-TRI','RECEPTION AREA','RA-ET1','R1','B01',1,1,'W-TRI/RECEPTION AREA/RA-ET1/R1/B01','W-TRI/RECEPTION AREA/RA-ET1/R1/B01',true),
 (142,1,1,'W-TRI','ALLE 3M','A3-ET1','A1','B01',1,1,'W-TRI/ALLE 3M/A3-ET1/A1/B01','W-TRI/ALLE 3M/A3-ET1/A1/B01',true),
 (143,1,1,'W-TRI','R&I','RI-ET1','RI1','B01',1,1,'W-TRI/R&I/RI-ET1/RI1/B01','W-TRI/R&I/RI-ET1/RI1/B01',true),
 (144,1,1,'W-TRI','S','S-ET1','S1','B01',1,1,'W-TRI/S/S-ET1/S1/B01','W-TRI/S/S-ET1/S1/B01',true),
 (145,1,1,'W-TRI','T','T-ET1','T1','B01',1,1,'W-TRI/T/T-ET1/T1/B01','W-TRI/T/T-ET1/T1/B01',true),
 (146,1,1,'W-TRI','U','U-ET1','U1','B01',1,1,'W-TRI/U/U-ET1/U1/B01','W-TRI/U/U-ET1/U1/B01',true),
 (147,1,1,'W-TRI','V','V-ET1','V1','B01',1,1,'W-TRI/V/V-ET1/V1/B01','W-TRI/V/V-ET1/V1/B01',true),
 (148,1,1,'W-TRI','X','X-ET1','X1','B01',1,1,'W-TRI/X/X-ET1/X1/B01','W-TRI/X/X-ET1/X1/B01',true),
 -- NOUVEAU : une valeur générée, pas un lieu. Jamais une destination.
 (149,1,1,'W-TRI','NOUVEAU','N-ET1','N1','B01',1,1,'W-TRI/NOUVEAU/N-ET1/N1/B01','W-TRI/NOUVEAU/N-ET1/N1/B01',true),
 -- WRITE OFF : un état du produit, pas un emplacement.
 (150,1,1,'W-TRI','WRITE OFF','WO-ET1','W1','B01',1,1,'W-TRI/WRITE OFF/WO-ET1/W1/B01','W-TRI/WRITE OFF/WO-ET1/W1/B01',true),

 -- ── Un bac archivé : il ne doit plus être une destination ───────────────
 (160,1,1,'W-TRI','D','D-ET1','D2','B99',2,99,'W-TRI/D/D-ET1/D2/B99','W-TRI/D/D-ET1/D2/B99',true),

 -- ── Second entrepôt de Triangle ─────────────────────────────────────────
 (170,1,2,'W-TRI-2','A','A-ET1','A1','B01',1,1,'W-TRI-2/A/A-ET1/A1/B01','W-TRI-2/A/A-ET1/A1/B01',true),

 -- ── FAT & MAT : rien de tout cela ne doit être visible depuis Triangle ──
 (190,2,9,'W-FAT','Z','Z-ET1','Z1','B01',1,1,'W-FAT/Z/Z-ET1/Z1/B01','W-FAT/Z/Z-ET1/Z1/B01',true)
ON CONFLICT (id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('locations','id'), 500, true);

UPDATE locations SET archived_at = now(), archived_by = 900 WHERE id = 160;

-- Du stock, pour que « indisponible » ne veuille pas dire « vide ».
INSERT INTO stock_location_balances(company_id,product_id,warehouse_id,location_id,quantity,reserved_quantity) VALUES
 (1,1,1,101,  40,0),   -- D1, prisonnier d'un FULLBIN
 (1,1,1,102,  25,0),
 (1,1,1,103, 100,10),  -- D2
 (1,1,1,104,  60,0),
 (1,2,1,105,  80,0),   -- D3
 (1,2,1,106,  15,0),   -- TOP
 (1,1,1,110,  30,0),   -- E1, plage
 (1,1,1,111,  20,0),
 (1,1,1,112,  50,0),
 (1,1,1,120,  12,0),   -- F1, non précisé
 (1,1,1,121,  70,0),
 (1,1,1,130,   8,0),   -- G1, bac absent
 (1,1,1,140, 200,0),   -- PICKING AREA
 (1,1,1,150,   5,0),   -- WRITE OFF
 (1,1,2,170,  90,0),
 (2,9,9,190, 300,0)
ON CONFLICT DO NOTHING;

-- Zerbo est rattaché à UN entrepôt : tout ce qu'il tente ailleurs doit être
-- refusé, et c'est le serveur qui le tient, pas l'écran.
UPDATE users SET warehouse_id = 1 WHERE id = 906;
UPDATE users SET warehouse_id = 9 WHERE id = 907;

-- ── Les droits de Zerbo ──────────────────────────────────────────────────
INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, 'magasinier', m.module_key, a.action, true
  FROM companies c
  CROSS JOIN (VALUES ('stock'),('stock.emplacement'),('stock.entree'),('stock.sortie'),
                     ('stock.transfert'),('stock.inventaire'),('entrepot'),('produit')) AS m(module_key)
  CROSS JOIN (VALUES ('visible'),('view')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, 'magasinier', m.module_key, a.action, true
  FROM companies c
  CROSS JOIN (VALUES ('stock.entree'),('stock.sortie'),('stock.transfert'),('stock.inventaire')) AS m(module_key)
  CROSS JOIN (VALUES ('create')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

/* APPLIQUER un mouvement, c'est `stock|validate` : les routes d'entrée, de
   sortie et de transfert passent toutes par `canApply`. Un magasinier qui
   range des réceptions et déplace des palettes l'a nécessairement ; sans ce
   droit il voit ses emplacements et ne peut rien y faire. */
INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, 'magasinier', 'stock', a.action, true
  FROM companies c CROSS JOIN (VALUES ('create'),('validate')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

/* Un rôle de consultation voit tout et ne touche à rien : c'est le témoin qui
   prouve que le droit d'appliquer est bien exigé, et pas seulement supposé. */
INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, 'consultation', m.module_key, a.action, true
  FROM companies c
  CROSS JOIN (VALUES ('stock'),('stock.emplacement'),('entrepot'),('produit')) AS m(module_key)
  CROSS JOIN (VALUES ('visible'),('view')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, 'consultation', 'stock', a.action, false
  FROM companies c CROSS JOIN (VALUES ('create'),('validate'),('update'),('delete')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = false;

/* Zerbo ne crée pas d'emplacement : il en utilise. La régularisation d'un
   emplacement ambigu lui est en revanche ouverte, sans quoi il resterait
   bloqué devant un stock qu'il voit et ne peut pas déplacer. */
INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, 'magasinier', 'stock.emplacement', 'create', false
  FROM companies c WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = false;

INSERT INTO role_permissions(company_id, role, module_key, action, allowed)
SELECT c.id, r.role, m.module_key, a.action, true
  FROM companies c
  CROSS JOIN (VALUES ('super_admin')) AS r(role)
  CROSS JOIN (VALUES ('stock'),('stock.emplacement'),('stock.entree'),('stock.sortie'),
                     ('stock.transfert'),('stock.inventaire'),('entrepot'),('produit')) AS m(module_key)
  CROSS JOIN (VALUES ('visible'),('view'),('create'),('update'),('delete')) AS a(action)
 WHERE c.id IN (1,2)
ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true;

COMMIT;

DO $$
BEGIN
  RAISE NOTICE 'Jeu d''essai emplacements : % bacs pour Triangle, dont % non sélectionnables.',
    (SELECT count(*) FROM locations WHERE company_id=1 AND archived_at IS NULL),
    (SELECT count(*) FROM locations WHERE company_id=1 AND archived_at IS NULL
       AND (COALESCE(TRIM(bin_code),'')='' OR TRIM(bin_code) ~* '^FULL[[:space:]_-]*BIN$'
            OR TRIM(bin_code) ~* '^(BIN[[:space:]]*)?[0-9]+[[:space:]]*[-/][[:space:]]*[0-9]+$'
            OR bin_code ~* 'NON[[:space:]_-]*PRECISE'
            OR COALESCE(warehouse_code,'') ~* 'WRITE[[:space:]_-]*OFF'
            OR UPPER(TRIM(COALESCE(rayon_code,''))) ~ '^(NOUVEAU|AUTO|DEFAUT|DEFAULT|TEST|TEMP|X+|-+|0+)$'));
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- POURQUOI DES RAYONS ET DES ENTREPÔTS N'APPARAISSENT-ILS PAS DANS LES ÉCRANS ?
--
-- LECTURE SEULE. Aucun INSERT, UPDATE, DELETE, DROP ni TRUNCATE.
-- Sans effet sur les données. Peut être lancé en production sans risque.
--
--   psql "$DATABASE_URL" -f scripts/diagnostic-emplacements-entrepots.sql
--
-- Le sélecteur d'emplacement (GET /stock/locations/tree) ne retient que les
-- « vrais bacs ». Le classement ci-dessous reproduit EXACTEMENT le filtre
-- `BAC_REEL` de routes/stock-locations.js, lui-même dérivé de
-- services/location-rules.js. Un rayon dont TOUS les bacs sont écartés
-- disparaît entièrement de la liste, sans aucun message : c'est ce que ce
-- diagnostic rend visible.
-- ═══════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on
\pset pager off

\echo ''
\echo '════ 1. TOUS LES ENTREPÔTS, ET CE QUE LES ÉCRANS EN FONT ════'
SELECT w.company_id AS societe, w.id, w.code, w.name,
       COALESCE(w.status, 'active') AS statut,
       (LOWER(BTRIM(COALESCE(w.status,'active'))) IN ('active','actif')) AS vu_comme_actif,
       (SELECT count(*) FROM locations l WHERE l.warehouse_id = w.id) AS nb_emplacements,
       (SELECT count(*) FROM locations l WHERE l.warehouse_id = w.id
          AND COALESCE(l.is_active,TRUE) AND l.merged_into_location_id IS NULL) AS nb_vivants,
       CASE WHEN w.code IN ('W-EM2S-A','W-EM2S-B','W-EM2S-C')
            THEN 'visible en réception (liste figée)'
            ELSE '⚠ ABSENT du sélecteur de réception : liste figée WAREHOUSE_CODES'
       END AS reception
  FROM warehouses w ORDER BY w.company_id, w.code;

\echo ''
\echo '════ 2. RAYONS PAR ENTREPÔT : BACS RETENUS vs BACS ÉCARTÉS ════'
\echo '     (retenus = 0  =>  le rayon NE PARAÎT PAS dans le sélecteur)'
WITH base AS (
  SELECT l.company_id, l.warehouse_code,
         COALESCE(NULLIF(l.rayon_code,''), l.zone)    AS rayon,
         COALESCE(NULLIF(l.case_code,''),  l.rayon)   AS loc,
         l.bin_code, l.emplacement_code, l.id,
         (COALESCE(l.is_active,TRUE) AND l.merged_into_location_id IS NULL) AS vivant,
         CASE
           WHEN l.bin_code ~* '(WRITE[[:space:]_-]*OFF|\mREBUT\M|\mCASSE\M)'
             OR COALESCE(l.warehouse_code,'')   ~* '(WRITE[[:space:]_-]*OFF|\mREBUT\M|\mCASSE\M)'
             OR COALESCE(l.emplacement_code,'') ~* '(WRITE[[:space:]_-]*OFF|\mREBUT\M|\mCASSE\M)'
             THEN 'REBUT'
           WHEN COALESCE(BTRIM(l.bin_code),'') = '' THEN 'BIN VIDE'
           WHEN l.bin_code ~* '(NON[[:space:]_-]*PRECISE|NON[[:space:]_-]*PRÉCIS|\mINCONNU\M|\mDIVERS\M)'
             THEN 'BIN NON PRÉCISÉ'
           WHEN BTRIM(l.bin_code) ~* '^(BIN[[:space:]]*)?[0-9]+[[:space:]]*[-/][[:space:]]*[0-9]+$'
             THEN 'BIN EN PLAGE'
           WHEN BTRIM(l.bin_code) ~* '^FULL[[:space:]_-]*BIN$' THEN 'FULLBIN HÉRITÉ'
           WHEN UPPER(BTRIM(COALESCE(NULLIF(l.rayon_code,''), l.zone, ''))) ~ '^(NOUVEAU|AUTO|DEFAUT|DEFAULT|TEST|TEMP|X+|-+|0+)$'
             OR UPPER(BTRIM(COALESCE(NULLIF(l.case_code,''), l.rayon, ''))) ~ '^(NOUVEAU|AUTO|DEFAUT|DEFAULT|TEST|TEMP|X+|-+|0+)$'
             THEN 'COMPOSANTE GÉNÉRÉE'
           ELSE 'RETENU'
         END AS classement
    FROM locations l
)
SELECT company_id AS societe, warehouse_code AS entrepot, rayon,
       count(*) AS bacs_total,
       count(*) FILTER (WHERE vivant AND classement='RETENU')              AS retenus,
       count(*) FILTER (WHERE NOT vivant)                                  AS inactifs_ou_fusionnes,
       count(*) FILTER (WHERE vivant AND classement='FULLBIN HÉRITÉ')      AS fullbin,
       count(*) FILTER (WHERE vivant AND classement IN ('BIN VIDE','BIN NON PRÉCISÉ')) AS non_precise,
       count(*) FILTER (WHERE vivant AND classement='BIN EN PLAGE')        AS en_plage,
       count(*) FILTER (WHERE vivant AND classement='REBUT')               AS rebut,
       count(*) FILTER (WHERE vivant AND classement='COMPOSANTE GÉNÉRÉE')  AS generee,
       CASE WHEN count(*) FILTER (WHERE vivant AND classement='RETENU') = 0
            THEN '⚠ RAYON INVISIBLE — tous ses bacs sont écartés'
            ELSE 'visible' END AS verdict
  FROM base GROUP BY company_id, warehouse_code, rayon
 ORDER BY company_id, warehouse_code, rayon;

\echo ''
\echo '════ 3. LES BACS ÉCARTÉS QUI PORTENT ENCORE DU STOCK ════'
\echo '     (le stock existe ; son emplacement exact n''est pas connu du système)'
WITH base AS (
  SELECT l.id, l.company_id, l.warehouse_code,
         COALESCE(NULLIF(l.rayon_code,''), l.zone) AS rayon,
         l.bin_code, l.emplacement_code,
         CASE
           WHEN COALESCE(BTRIM(l.bin_code),'') = '' THEN 'BIN VIDE'
           WHEN BTRIM(l.bin_code) ~* '^FULL[[:space:]_-]*BIN$' THEN 'FULLBIN HÉRITÉ'
           WHEN BTRIM(l.bin_code) ~* '^(BIN[[:space:]]*)?[0-9]+[[:space:]]*[-/][[:space:]]*[0-9]+$' THEN 'BIN EN PLAGE'
           WHEN l.bin_code ~* '(NON[[:space:]_-]*PRECISE|NON[[:space:]_-]*PRÉCIS)' THEN 'BIN NON PRÉCISÉ'
           ELSE 'RETENU'
         END AS motif
    FROM locations l
   WHERE COALESCE(l.is_active,TRUE) AND l.merged_into_location_id IS NULL
)
SELECT b.company_id AS societe, b.warehouse_code AS entrepot, b.rayon,
       b.emplacement_code, b.bin_code, b.motif,
       COALESCE(sum(s.quantity),0) AS quantite_immobilisee
  FROM base b
  LEFT JOIN stock_location_balances s ON s.location_id = b.id AND s.company_id = b.company_id
 WHERE b.motif <> 'RETENU'
 GROUP BY b.company_id, b.warehouse_code, b.rayon, b.emplacement_code, b.bin_code, b.motif
HAVING COALESCE(sum(s.quantity),0) > 0
 ORDER BY quantite_immobilisee DESC LIMIT 50;

\echo ''
\echo '════ 4. UNE SEULE SOURCE DE VÉRITÉ ? codes d''entrepôt absents de warehouses ════'
SELECT DISTINCT l.company_id AS societe, l.warehouse_code AS code_dans_locations
  FROM locations l
 WHERE l.warehouse_code IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM warehouses w
                    WHERE w.company_id = l.company_id AND w.code = l.warehouse_code)
 ORDER BY 1, 2;

\echo ''
\echo '════ 5. RÉCAPITULATIF : RAYONS RÉELS vs RAYONS VISIBLES, PAR ENTREPÔT ════'
WITH base AS (
  SELECT l.company_id, l.warehouse_code,
         COALESCE(NULLIF(l.rayon_code,''), l.zone) AS rayon,
         (COALESCE(l.is_active,TRUE) AND l.merged_into_location_id IS NULL
          AND COALESCE(BTRIM(l.bin_code),'') <> ''
          AND BTRIM(l.bin_code) !~* '^FULL[[:space:]_-]*BIN$'
          AND BTRIM(l.bin_code) !~* '^(BIN[[:space:]]*)?[0-9]+[[:space:]]*[-/][[:space:]]*[0-9]+$'
          AND l.bin_code !~* '(NON[[:space:]_-]*PRECISE|NON[[:space:]_-]*PRÉCIS|\mINCONNU\M|\mDIVERS\M)'
          AND l.bin_code !~* '(WRITE[[:space:]_-]*OFF|\mREBUT\M|\mCASSE\M)'
         ) AS retenu
    FROM locations l
), parRayon AS (
  SELECT company_id, warehouse_code, rayon, bool_or(retenu) AS a_un_bac_retenu
    FROM base GROUP BY company_id, warehouse_code, rayon
)
SELECT company_id AS societe, warehouse_code AS entrepot,
       count(*) AS rayons_en_base,
       count(*) FILTER (WHERE a_un_bac_retenu) AS rayons_visibles,
       string_agg(rayon, ', ' ORDER BY rayon) FILTER (WHERE a_un_bac_retenu)     AS liste_visibles,
       string_agg(rayon, ', ' ORDER BY rayon) FILTER (WHERE NOT a_un_bac_retenu) AS liste_invisibles
  FROM parRayon GROUP BY company_id, warehouse_code
 ORDER BY company_id, warehouse_code;

-- 060b — LE SCHÉMA DU STOCK PAR EMPLACEMENT
--
-- Ces tables, colonnes et index étaient créés à l'intérieur de `061`, une
-- migration qui cible UNE entreprise et attend des nombres relevés dans un
-- preview de production. Sans ces paramètres elle ne s'exécute pas — et sur une
-- base neuve `stock_location_balances` n'existait alors jamais, alors que tout
-- le moteur de stock s'appuie dessus.
--
-- Créer une table est additif, sans condition et rejouable ; reprendre du stock
-- existant est une opération ponctuelle qui demande des paramètres. Les deux
-- sont donc séparées : la structure ici, la reprise de données dans 061.
--
-- Le calcul de `full_code` reste ici avec elle : il ne dépend d'aucun
-- paramètre, et l'index d'unicité qui le suit n'a de sens qu'une fois la
-- colonne remplie. Sur une base vide il ne touche aucune ligne.
--
-- Le contenu est repris à l'identique de 061, qui le conserve : tous ces ordres
-- portent `IF NOT EXISTS` ou une clause `WHERE` qui les rend rejouables. Une
-- base déjà migrée ne voit donc rien changer.
--
-- Strictement additive et idempotente.

BEGIN;

CREATE TABLE IF NOT EXISTS stock_location_balances (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL,
  product_id        INTEGER NOT NULL REFERENCES products(id)   ON DELETE CASCADE,
  warehouse_id      INTEGER          REFERENCES warehouses(id) ON DELETE SET NULL,
  location_id       INTEGER NOT NULL REFERENCES locations(id)  ON DELETE RESTRICT,
  quantity          NUMERIC NOT NULL DEFAULT 0,
  reserved_quantity NUMERIC NOT NULL DEFAULT 0,
  created_at        TIMESTAMP DEFAULT NOW(),
  updated_at        TIMESTAMP DEFAULT NOW(),

  /* Un stock négatif dans un bin n'a aucun sens physique : la base le refuse,
     en plus du contrôle applicatif. */
  CONSTRAINT slb_quantity_positive  CHECK (quantity >= 0),
  CONSTRAINT slb_reserved_positive  CHECK (reserved_quantity >= 0),
  /* On ne peut jamais réserver plus que ce qui est physiquement présent. */
  CONSTRAINT slb_reserved_le_qty    CHECK (reserved_quantity <= quantity)
);

/* UNE seule balance par (entreprise, produit, entrepôt, emplacement).
   location_id désigne déjà l'entrepôt, mais warehouse_id est conservé pour
   agréger par entrepôt sans jointure ; il fait donc partie de la clé. */
CREATE UNIQUE INDEX IF NOT EXISTS slb_unique_idx
    ON stock_location_balances (company_id, product_id, warehouse_id, location_id);

CREATE INDEX IF NOT EXISTS slb_product_idx  ON stock_location_balances (company_id, product_id);
CREATE INDEX IF NOT EXISTS slb_location_idx ON stock_location_balances (company_id, location_id);
/* Recherche d'un bin vide réutilisable (A24) sans parcourir toute la table. */
CREATE INDEX IF NOT EXISTS slb_empty_idx
    ON stock_location_balances (company_id, warehouse_id)
 WHERE quantity = 0;

-- ------------------------------------------------- emplacement des mouvements
/* Un transfert a DEUX extrémités. `stock_movements` n'a qu'un location_id :
   il ne peut donc pas dire d'où vient et où va la marchandise. On ajoute la
   paire source/destination sans toucher la colonne existante, qui reste
   l'emplacement principal du mouvement. */
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS source_location_id       INTEGER,
  ADD COLUMN IF NOT EXISTS destination_location_id  INTEGER,
  ADD COLUMN IF NOT EXISTS source_warehouse_id      INTEGER,
  ADD COLUMN IF NOT EXISTS destination_warehouse_id INTEGER,
  /* Stock AVANT/APRÈS au niveau de l'emplacement — distinct du global déjà
     présent (stock_before / stock_after), qui reste celui du produit. */
  ADD COLUMN IF NOT EXISTS location_stock_before        NUMERIC,
  ADD COLUMN IF NOT EXISTS location_stock_after         NUMERIC,
  ADD COLUMN IF NOT EXISTS destination_stock_before     NUMERIC,
  ADD COLUMN IF NOT EXISTS destination_stock_after      NUMERIC;

CREATE INDEX IF NOT EXISTS stock_movements_src_loc_idx
    ON stock_movements (company_id, source_location_id) WHERE source_location_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_movements_dst_loc_idx
    ON stock_movements (company_id, destination_location_id) WHERE destination_location_id IS NOT NULL;

-- ------------------------------------------------------------- emplacements
/* `emplacement_code` est aujourd'hui construit sans le bin :
   `${warehouse}-${zone}-${rayon}-${etagere}`. Deux bins d'un même niveau
   partagent donc le MÊME code. On ajoute un code complet, sans toucher au code
   existant qui reste affiché tel quel. */
ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS full_code TEXT,
  /* Un emplacement vidé reste en base et redevient immédiatement disponible :
     ces colonnes tracent le passage à vide sans JAMAIS supprimer la ligne.
     occupancy_status : EMPTY | OCCUPIED | INACTIVE. Aucune capacité n'est
     inventée — le système n'en possède pas — donc pas de PARTIELLEMENT_OCCUPE. */
  ADD COLUMN IF NOT EXISTS emptied_at        TIMESTAMP,
  ADD COLUMN IF NOT EXISTS is_active         BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS occupancy_status  TEXT DEFAULT 'EMPTY';

/* Un produit n'est soumis à l'invariant « stock = somme des balances » qu'une
   fois SA répartition entièrement établie. Tant que ce drapeau est faux, le
   produit vit sur products.stock seul, sans contrainte de balances : c'est ce
   qui permet de migrer produit par produit sans jamais bloquer les autres. */
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS location_managed BOOLEAN DEFAULT FALSE;

/* full_code n'est attribué qu'aux VRAIS BACS.
   Règle identique à services/location-rules.js. Sont exclus :
     - bin absent ;
     - rebut (WRITE OFF) : un état du produit, pas un contenant ;
     - bin non précisé (BIN-NON-PRECISE) : ne localise rien ;
     - plage « BIN1-2 » / « BIN2-3 » : un bac ou deux ? indécidable ;
     - composantes générées « NOUVEAU / AUTO » : emplacement non prouvé.
   Sans full_code, ces lignes sortent de l'index unique ci-dessous — c'est ce
   qui permet à 061 de passer alors que ces groupes restent en doublon. */
UPDATE locations l
   SET full_code = NULLIF(ARRAY_TO_STRING(ARRAY[
         NULLIF(TRIM(COALESCE(l.warehouse_code, '')), ''),
         NULLIF(TRIM(COALESCE(NULLIF(l.rayon_code, ''), l.zone)),    ''),
         NULLIF(TRIM(COALESCE(NULLIF(l.case_code, ''),  l.rayon)),   ''),
         NULLIF(TRIM(COALESCE(NULLIF(l.level_code, ''), l.etagere)), ''),
         TRIM(l.bin_code)
       ], '-'), '')
 WHERE l.full_code IS NULL
   AND COALESCE(TRIM(l.bin_code), '') <> ''
   AND l.bin_code                          !~* '(WRITE[[:space:]_-]*OFF|\mREBUT\M|\mCASSE\M)'
   AND l.bin_code                          !~* '(NON[[:space:]_-]*PRECISE|NON[[:space:]_-]*PRÉCIS|\mINCONNU\M|\mDIVERS\M)'
   AND TRIM(l.bin_code)                    !~* '^(BIN[[:space:]]*)?[0-9]+[[:space:]]*[-/][[:space:]]*[0-9]+$'
   AND COALESCE(l.warehouse_code,'')       !~* '(WRITE[[:space:]_-]*OFF|\mREBUT\M)'
   AND COALESCE(l.emplacement_code,'')     !~* '(WRITE[[:space:]_-]*OFF|\mREBUT\M)'
   AND UPPER(TRIM(COALESCE(NULLIF(l.rayon_code,''), l.zone,  ''))) !~ '^(NOUVEAU|AUTO|DEFAUT|DEFAULT|TEST|TEMP|X+|-+|0+)$'
   AND UPPER(TRIM(COALESCE(NULLIF(l.case_code,''),  l.rayon, ''))) !~ '^(NOUVEAU|AUTO|DEFAUT|DEFAULT|TEST|TEMP|X+|-+|0+)$'
   AND COALESCE(l.merged_into_location_id, 0) = 0;

/* Unicité du bin physique. Index PARTIEL : seules les lignes ayant reçu un
   full_code ci-dessus y entrent. Les plages, rebuts, bins non précisés et
   placeholders en sont donc absents et ne peuvent pas le faire échouer,
   même s'ils restent en doublon entre eux. */
CREATE UNIQUE INDEX IF NOT EXISTS locations_full_code_uidx
    ON locations (company_id, full_code)
 WHERE full_code IS NOT NULL AND full_code <> '';

-- -------------------------------------------------------- inventaires par bin
/* `inventory_history` ne connaît que `location_code` en texte libre : on ne
   peut pas inventorier un bin précis ni rattacher l'écart à une balance. */
ALTER TABLE inventory_history
  ADD COLUMN IF NOT EXISTS location_id  INTEGER,
  ADD COLUMN IF NOT EXISTS warehouse_id INTEGER,
  ADD COLUMN IF NOT EXISTS product_id   INTEGER,
  ADD COLUMN IF NOT EXISTS session_id   INTEGER,
  ADD COLUMN IF NOT EXISTS movement_id  INTEGER;

/* Une session d'inventaire regroupe les comptages d'un périmètre (entrepôt,
   rayon, location, level ou bin) et porte le document imprimable/envoyé. */
CREATE TABLE IF NOT EXISTS inventory_sessions (
  id              SERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL,
  session_number  TEXT    NOT NULL,
  scope_type      TEXT    NOT NULL,      -- WAREHOUSE | ROW | LOCATION | LEVEL | BIN
  warehouse_id    INTEGER,
  location_id     INTEGER,
  rayon_code      TEXT,
  case_code       TEXT,
  level_code      TEXT,
  bin_code        TEXT,
  status          TEXT    NOT NULL DEFAULT 'DRAFT',  -- DRAFT|COUNTED|APPLIED|CANCELLED
  counted_by      INTEGER,
  applied_by      INTEGER,
  applied_at      TIMESTAMP,
  notes           TEXT,
  created_by      INTEGER,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS inventory_sessions_number_uidx
    ON inventory_sessions (company_id, session_number);

/* Traçabilité d'envoi (A22). Aucune deuxième configuration SMTP : ces colonnes
   n'enregistrent QUE le résultat de l'envoi fait par le transport existant. */
CREATE TABLE IF NOT EXISTS inventory_session_emails (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL,
  session_id   INTEGER NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  sent_to      TEXT    NOT NULL,
  subject      TEXT,
  message      TEXT,
  status       TEXT    NOT NULL,        -- SENT | EMAIL_NOT_CONFIGURED | FAILED
  error        TEXT,
  sent_by      INTEGER,
  sent_at      TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS inventory_session_emails_idx
    ON inventory_session_emails (company_id, session_id);

-- ------------------------------------------------------------- réservations
/* Préparer une sortie ne déduit RIEN : la quantité est portée en réservation
   sur la balance, et seule la validation la convertit en sortie réelle.
   Disponible réel = quantity - reserved_quantity. */
CREATE TABLE IF NOT EXISTS stock_reservations (
  id            SERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL,
  balance_id    INTEGER NOT NULL REFERENCES stock_location_balances(id) ON DELETE CASCADE,
  movement_id   INTEGER,                -- mouvement « En attente » qui la porte
  product_id    INTEGER NOT NULL,
  location_id   INTEGER NOT NULL,
  quantity      NUMERIC NOT NULL CHECK (quantity > 0),
  status        TEXT    NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE|RELEASED|CONSUMED
  created_by    INTEGER,
  created_at    TIMESTAMP DEFAULT NOW(),
  released_at   TIMESTAMP
);

CREATE INDEX IF NOT EXISTS stock_reservations_active_idx
    ON stock_reservations (company_id, balance_id) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS stock_reservations_movement_idx
    ON stock_reservations (company_id, movement_id) WHERE movement_id IS NOT NULL;

COMMIT;

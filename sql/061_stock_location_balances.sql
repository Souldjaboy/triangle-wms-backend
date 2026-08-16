-- 061 — Stock par emplacement physique exact.  *** PROPOSITION — NON EXÉCUTÉE ***
--
-- CE QUI EXISTE DÉJÀ, et qu'on ne refait pas :
--   `locations` porte déjà warehouse_id, rayon_code (ROW), case_code (LOCATION),
--   level_code (LEVEL), bin_code (BIN), emplacement_code, qr_code, status.
--   La structure physique est donc là. Aucune table d'emplacement n'est créée.
--
-- CE QUI MANQUE, et que cette migration ajoute :
--   la QUANTITÉ par (produit, emplacement). Aujourd'hui `products.stock` est un
--   entier global et `products.location_id` désigne UN emplacement : le système
--   ne peut pas dire combien d'un produit se trouve dans quel bin, ni répartir
--   un produit sur plusieurs bins.
--
-- MIGRATION ADDITIVE ET IDEMPOTENTE : aucune table existante n'est supprimée ni
-- renommée, aucune donnée n'est déplacée. Le remplissage des balances fait
-- l'objet d'une migration de données SÉPARÉE, après validation du preview.

/* Essai à blanc : tout est exécuté et contrôlé, puis ANNULÉ.
     -v dry_run=true    voir sans écrire
     -v company_id=<ID> -v expected_balances=<N>   depuis le preview */
\if :{?dry_run}
\else
  \set dry_run false
\endif

BEGIN;

/* Les variables psql ne s'interpolent pas dans un bloc DO $$ … $$. */
CREATE TEMP TABLE _p061 ON COMMIT DROP AS
SELECT (:company_id)::int AS company_id, (:expected_balances)::int AS expected_balances;

CREATE TEMP TABLE _avant061 ON COMMIT DROP AS
SELECT COUNT(*)::int AS produits, COALESCE(SUM(stock),0)::numeric AS stock,
       COUNT(*) FILTER (WHERE stock < 0)::int AS negatifs
  FROM products WHERE company_id = (:company_id)::int AND COALESCE(is_active,TRUE) = TRUE;

-- ---------------------------------------------------------------- balances
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

-- ═════════════════════════════════════════════════════════════════════════
-- BALANCES INITIALES — UNIQUEMENT LES PRODUITS AUTO_MATCH.
--
-- Un produit ne reçoit une balance automatique que si sa localisation est
-- CERTAINE : un seul emplacement candidat, et cet emplacement est un vrai bac.
-- Les TO_REVIEW_LOCATION et NO_LOCATION n'en reçoivent AUCUNE : leur stock
-- reste sur products.stock, sans emplacement, jusqu'à répartition manuelle.
--
-- Les candidats viennent des mêmes quatre sources que le preview :
-- products.location_id, locations.product_id, products.location_code et
-- l'historique des mouvements.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _candidats ON COMMIT DROP AS
WITH vivants AS (
  SELECT l.* FROM locations l
   WHERE l.company_id = (SELECT company_id FROM _p061)
     AND COALESCE(l.merged_into_location_id, 0) = 0
), prod AS (
  SELECT p.id, p.stock::numeric AS stock, p.location_id, p.location_code
    FROM products p
   WHERE p.company_id = (SELECT company_id FROM _p061)
     AND COALESCE(p.is_active, TRUE) = TRUE
     AND COALESCE(p.location_managed, FALSE) = FALSE
     AND p.stock > 0
), liens AS (
  SELECT p.id AS product_id, l.id AS location_id
    FROM prod p JOIN vivants l ON l.id = p.location_id
  UNION
  SELECT p.id, l.id FROM prod p JOIN vivants l ON l.product_id = p.id
  UNION
  SELECT p.id, l.id FROM prod p JOIN vivants l
    ON COALESCE(p.location_code,'') <> ''
   AND UPPER(TRIM(COALESCE(l.emplacement_code,''))) = UPPER(TRIM(p.location_code))
  UNION
  SELECT p.id, m.location_id
    FROM prod p JOIN stock_movements m
      ON m.product_id = p.id AND m.company_id = (SELECT company_id FROM _p061)
     AND m.location_id IS NOT NULL
   WHERE EXISTS (SELECT 1 FROM vivants v WHERE v.id = m.location_id)
)
SELECT product_id, COUNT(*)::int AS n, MIN(location_id) AS location_id
  FROM liens GROUP BY product_id;

CREATE TEMP TABLE _auto ON COMMIT DROP AS
SELECT p.id AS product_id, p.stock::numeric AS stock, c.location_id, l.warehouse_id
  FROM products p
  JOIN _candidats c ON c.product_id = p.id AND c.n = 1
  JOIN locations  l ON l.id = c.location_id
 WHERE p.company_id = (SELECT company_id FROM _p061)
   /* un seul candidat ET c'est un vrai bac : full_code a justement été
      attribué plus haut aux seuls vrais bacs, il sert donc de test. */
   AND COALESCE(l.full_code, '') <> '';

DO $$
DECLARE trouve INT; attendu INT; unites NUMERIC;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(stock),0) INTO trouve, unites FROM _auto;
  SELECT expected_balances INTO attendu FROM _p061;
  RAISE NOTICE '061 : % produit(s) AUTO_MATCH, % unité(s) placées en balance.', trouve, unites;
  IF attendu IS NOT NULL AND trouve <> attendu THEN
    RAISE EXCEPTION
      'Désaccord avec le preview : % balance(s) AUTO_MATCH trouvée(s), % attendue(s). Aucune écriture.',
      trouve, attendu;
  END IF;
END $$;

INSERT INTO stock_location_balances
  (company_id, product_id, warehouse_id, location_id, quantity, reserved_quantity)
SELECT (SELECT company_id FROM _p061), a.product_id, a.warehouse_id, a.location_id, a.stock, 0
  FROM _auto a
ON CONFLICT (company_id, product_id, warehouse_id, location_id) DO NOTHING;

UPDATE products p SET location_managed = TRUE, updated_at = NOW()
  FROM _auto a WHERE p.id = a.product_id AND p.company_id = (SELECT company_id FROM _p061);

UPDATE locations l SET occupancy_status = 'OCCUPIED', updated_at = NOW()
  FROM _auto a WHERE l.id = a.location_id AND l.company_id = (SELECT company_id FROM _p061);

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLES FINAUX. Toute anomalie annule TOUT.
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE av RECORD; ap RECORD; cid INT; mauvais INT; ecarts INT;
BEGIN
  SELECT company_id INTO cid FROM _p061;
  SELECT * INTO av FROM _avant061;
  SELECT COUNT(*)::int AS produits, COALESCE(SUM(stock),0)::numeric AS stock,
         COUNT(*) FILTER (WHERE stock < 0)::int AS negatifs
    INTO ap
    FROM products WHERE company_id = cid AND COALESCE(is_active,TRUE) = TRUE;

  IF av.stock <> ap.stock THEN
    RAISE EXCEPTION 'Stock modifié : % avant, % après. Annulation.', av.stock, ap.stock;
  END IF;
  IF av.produits <> ap.produits THEN
    RAISE EXCEPTION 'Nombre de produits modifié : % -> %. Annulation.', av.produits, ap.produits;
  END IF;
  IF ap.negatifs > 0 THEN
    RAISE EXCEPTION 'Stock négatif apparu : %. Annulation.', ap.negatifs;
  END IF;

  /* Aucune balance ne doit pointer vers un emplacement non physique. */
  SELECT COUNT(*)::int INTO mauvais
    FROM stock_location_balances b JOIN locations l ON l.id = b.location_id
   WHERE b.company_id = cid AND COALESCE(l.full_code,'') = '';
  IF mauvais > 0 THEN
    RAISE EXCEPTION '% balance(s) sur un emplacement non exploitable. Annulation.', mauvais;
  END IF;

  /* Pour tout produit désormais géré, stock = somme de ses balances. */
  SELECT COUNT(*)::int INTO ecarts FROM (
    SELECT p.id FROM products p
      LEFT JOIN stock_location_balances b ON b.product_id = p.id AND b.company_id = p.company_id
     WHERE p.company_id = cid AND COALESCE(p.location_managed, FALSE) = TRUE
     GROUP BY p.id, p.stock
    HAVING p.stock::numeric <> COALESCE(SUM(b.quantity), 0)::numeric) t;
  IF ecarts > 0 THEN
    RAISE EXCEPTION '% produit(s) avec stock <> somme des balances. Annulation.', ecarts;
  END IF;

  RAISE NOTICE '061 : contrôles passés — produits %, stock %, négatifs %.',
    ap.produits, ap.stock, ap.negatifs;
END $$;

\if :dry_run
  \echo ''
  \echo '*** ESSAI À BLANC — tout est annulé, la base est inchangée. ***'
  ROLLBACK;
\else
  COMMIT;
\endif

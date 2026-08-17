-- RECTIFICATION ADMINISTRATIVE DE SIX BONS — TRIANGLE, company_id = 1
--
-- Ces six mouvements ont DÉJÀ été appliqués au stock. On corrige donc les
-- enregistrements historiques en place ; on ne rejoue aucune entrée ni sortie,
-- sans quoi les quantités seraient comptées une seconde fois.
--
-- Tout se joue dans UNE transaction. La moindre incohérence — document
-- introuvable, mouvement qui ne correspond pas au bon, plusieurs produits pour
-- une référence, balance qui deviendrait négative — lève une exception et
-- ANNULE l'ensemble. Il n'y a pas de correction partielle possible.
--
-- Les identifiants historiques sont conservés : mêmes id de mouvement, mêmes
-- numéros de document. Le bon papier détenu par le magasinier reste le même
-- document que celui de la base.
--
-- À lancer avec : psql -v ON_ERROR_STOP=1 -f ce_fichier.sql

\set ON_ERROR_STOP on
\timing off

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- Ce qui doit être vrai après correction. Une ligne par bon.
--   type_mouvement : « Entrée » ou « Sortie »
--   type_document  : libellé exact employé par le moteur
-- ─────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE rectifications (
  numero_document   text PRIMARY KEY,
  reference_produit text NOT NULL,
  nom_produit       text NOT NULL,
  mouvement_attendu integer,          -- NULL = on prend celui du document
  type_mouvement    text NOT NULL,
  type_document     text NOT NULL,
  quantite          numeric NOT NULL,
  stock_avant       numeric NOT NULL,
  stock_apres       numeric NOT NULL
) ON COMMIT DROP;

INSERT INTO rectifications VALUES
 ('BR-260814-057','IMP-CHAISE-DE-VESTIAIRE',            'CHAISE DE VESTIAIRE',              NULL,'Entrée','Bon de réception',   5,   5,  10),
 ('BR-260814-035','IMP-CONTROLEUR-VOLUME-DE-VENTILO',   'CONTROLEUR VOLUME DE VENTILO',      411,'Entrée','Bon de réception', 120, 100, 220),
 ('BR-260803-001','IMP-ACCESSOIRE-D-ECRAN',             'ACCESSOIRE D''ECRAN',               285,'Sortie','Bon de sortie',      2,   2,   0),
 ('BR-260814-059','IMP-UNDERCOUNTER-BASIN-BC-8322',     'UNDERCOUNTER BASIN/BC-8322',        392,'Entrée','Bon de réception', 312,   0, 312),
 ('BR-260803-002','IMP-ACCESOIRE-POUR-CONTROLEUR-VOLUME','ACCESSOIRE POUR CONTROLEUR VOLUME',287,'Entrée','Bon de réception', 200,   0, 200),
 ('BR-260814-049','IMP-TOURNIQUET-D-ENTREE',            'TOURNIQUET D''ENTREE',              400,'Entrée','Bon de réception',  33,  84, 117);

-- Photographie de l'état de départ, pour le rapport et pour comparaison.
CREATE TEMP TABLE etat_avant AS
SELECT r.numero_document,
       d.id            AS document_id,
       d.document_type AS type_document_avant,
       m.id            AS mouvement_id,
       m.type          AS type_mouvement_avant,
       m.quantity      AS quantite_avant,
       m.stock_before  AS stock_before_avant,
       m.stock_after   AS stock_after_avant,
       p.id            AS produit_id,
       p.stock         AS stock_produit_avant,
       COALESCE(p.location_managed, false) AS gere_par_emplacement
  FROM rectifications r
  JOIN documents d       ON d.document_number = r.numero_document AND d.company_id = 1
  JOIN stock_movements m ON m.id = d.stock_movement_id
  JOIN products p        ON p.company_id = 1 AND upper(trim(p.reference)) = upper(trim(r.reference_produit));

CREATE TEMP TABLE stock_global_avant AS
SELECT COALESCE(sum(stock), 0) AS total FROM products WHERE company_id = 1;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. VÉRIFICATIONS D'IDENTITÉ — avant toute écriture
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  r        record;
  doc      record;
  mvt      record;
  prod     record;
  n        integer;
BEGIN
  FOR r IN SELECT * FROM rectifications LOOP

    -- ── Le document existe et une seule fois ──
    SELECT count(*) INTO n FROM documents
     WHERE document_number = r.numero_document AND company_id = 1;
    IF n <> 1 THEN
      RAISE EXCEPTION 'Document % : % occurrence(s) au lieu d''une. Rectification annulée.',
        r.numero_document, n;
    END IF;

    SELECT * INTO doc FROM documents
     WHERE document_number = r.numero_document AND company_id = 1;

    -- ── Le produit existe et une seule fois ──
    SELECT count(*) INTO n FROM products
     WHERE company_id = 1 AND upper(trim(reference)) = upper(trim(r.reference_produit));
    IF n <> 1 THEN
      RAISE EXCEPTION 'Référence % : % produit(s) correspondants au lieu d''un. Rectification annulée.',
        r.reference_produit, n;
    END IF;

    SELECT * INTO prod FROM products
     WHERE company_id = 1 AND upper(trim(reference)) = upper(trim(r.reference_produit));

    -- ── Le document porte bien un mouvement ──
    IF doc.stock_movement_id IS NULL THEN
      RAISE EXCEPTION 'Document % : aucun mouvement rattaché. Rectification annulée.',
        r.numero_document;
    END IF;

    SELECT * INTO mvt FROM stock_movements WHERE id = doc.stock_movement_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Document % : mouvement % introuvable. Rectification annulée.',
        r.numero_document, doc.stock_movement_id;
    END IF;

    -- ── Le mouvement est bien celui désigné par la mission ──
    -- C'est le garde-fou qui protège BR-260814-037 : si le bon 035 ne porte
    -- pas le mouvement 411, c'est que la lecture de la photo ne correspond
    -- pas à la base, et l'on refuse de deviner.
    IF r.mouvement_attendu IS NOT NULL AND mvt.id <> r.mouvement_attendu THEN
      RAISE EXCEPTION
        'Document % : porte le mouvement % alors que la mission désigne le %. Ambiguïté — rectification annulée.',
        r.numero_document, mvt.id, r.mouvement_attendu;
    END IF;

    -- ── Le mouvement concerne bien ce produit ──
    IF upper(trim(COALESCE(mvt.product_reference, ''))) <> upper(trim(r.reference_produit))
       AND upper(trim(COALESCE(mvt.product_name, ''))) <> upper(trim(r.nom_produit)) THEN
      RAISE EXCEPTION
        'Mouvement % : porte « % / % » et non « % / % ». Ambiguïté — rectification annulée.',
        mvt.id, mvt.product_reference, mvt.product_name, r.reference_produit, r.nom_produit;
    END IF;

    IF mvt.company_id <> 1 THEN
      RAISE EXCEPTION 'Mouvement % appartient à la société % et non à Triangle (1).', mvt.id, mvt.company_id;
    END IF;

    -- ── Une seule ligne d'article, sinon on ne sait pas laquelle corriger ──
    SELECT count(*) INTO n FROM document_items WHERE document_id = doc.id;
    IF n > 1 THEN
      RAISE EXCEPTION
        'Document % : % lignes d''articles. La correction en viserait une sans savoir laquelle. Rectification annulée.',
        r.numero_document, n;
    END IF;

    -- ── Cohérence arithmétique de la consigne ──
    IF r.type_mouvement = 'Entrée' AND r.stock_avant + r.quantite <> r.stock_apres THEN
      RAISE EXCEPTION 'Document % : % + % ne fait pas %.',
        r.numero_document, r.stock_avant, r.quantite, r.stock_apres;
    END IF;
    IF r.type_mouvement = 'Sortie' AND r.stock_avant - r.quantite <> r.stock_apres THEN
      RAISE EXCEPTION 'Document % : % − % ne fait pas %.',
        r.numero_document, r.stock_avant, r.quantite, r.stock_apres;
    END IF;

    RAISE NOTICE 'OK  %  doc=%  mvt=%  produit=%  stock % → %',
      r.numero_document, doc.id, mvt.id, prod.id, prod.stock, r.stock_apres;
  END LOOP;

  RAISE NOTICE 'Les six correspondances sont établies sans ambiguïté.';
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. RECTIFICATION DES MOUVEMENTS
-- ═════════════════════════════════════════════════════════════════════════
UPDATE stock_movements m
   SET type         = r.type_mouvement,
       quantity     = r.quantite,
       stock_before = r.stock_avant,
       stock_after  = r.stock_apres,
       updated_at   = NOW()
  FROM rectifications r
  JOIN documents d ON d.document_number = r.numero_document AND d.company_id = 1
 WHERE m.id = d.stock_movement_id;

-- Un mouvement devenu sortie doit porter son emplacement du bon côté :
-- ce qui était la destination d'une entrée devient la source d'une sortie.
UPDATE stock_movements m
   SET source_location_id       = COALESCE(m.source_location_id, m.destination_location_id),
       source_warehouse_id      = COALESCE(m.source_warehouse_id, m.destination_warehouse_id),
       destination_location_id  = NULL,
       destination_warehouse_id = NULL
  FROM rectifications r
  JOIN documents d ON d.document_number = r.numero_document AND d.company_id = 1
 WHERE m.id = d.stock_movement_id
   AND r.type_mouvement = 'Sortie';

-- ═════════════════════════════════════════════════════════════════════════
-- 3. RECTIFICATION DES DOCUMENTS ET DE LEURS LIGNES
-- ═════════════════════════════════════════════════════════════════════════

-- Le numéro n'est PAS modifié, même pour le bon devenu sortie : il figure sur
-- le papier détenu au magasin et dans l'historique. Changer le numéro
-- rendrait le document introuvable à qui tient l'original en main.
UPDATE documents d
   SET document_type = r.type_document
  FROM rectifications r
 WHERE d.document_number = r.numero_document AND d.company_id = 1;

UPDATE document_items di
   SET quantity    = r.quantite,
       total_price = ROUND(r.quantite * COALESCE(di.unit_price, 0), 2)
  FROM rectifications r
  JOIN documents d ON d.document_number = r.numero_document AND d.company_id = 1
 WHERE di.document_id = d.id;

-- Le total du bon suit ses lignes, sinon le document s'affiche incohérent.
UPDATE documents d
   SET total_amount = COALESCE((SELECT sum(total_price) FROM document_items WHERE document_id = d.id),
                               d.total_amount)
  FROM rectifications r
 WHERE d.document_number = r.numero_document AND d.company_id = 1
   AND EXISTS (SELECT 1 FROM document_items WHERE document_id = d.id);

-- ═════════════════════════════════════════════════════════════════════════
-- 4. STOCK PRODUIT ET BALANCES D'EMPLACEMENT
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  r            record;
  prod         record;
  mvt          record;
  doc_id       integer;
  emplacement  integer;
  par_balance  integer;
  par_code     integer;
  n_corresp    integer;
  base_balances numeric;
  ecart        numeric;
  qte_avant    numeric;
  qte_apres    numeric;
  total_bal    numeric;
BEGIN
  FOR r IN SELECT * FROM rectifications LOOP
    emplacement := NULL; par_balance := NULL; par_code := NULL;
    SELECT d.id INTO doc_id FROM documents d
     WHERE d.document_number = r.numero_document AND d.company_id = 1;
    SELECT * INTO mvt  FROM stock_movements WHERE id = (SELECT stock_movement_id FROM documents WHERE id = doc_id);
    SELECT * INTO prod FROM products
     WHERE company_id = 1 AND upper(trim(reference)) = upper(trim(r.reference_produit));

    -- ── Produit géré par emplacement : la balance fait foi ──
    IF COALESCE(prod.location_managed, false) THEN

      -- L'écart se mesure depuis la SOMME DES BALANCES, et non depuis
      -- products.stock. C'est la somme des balances qui doit valoir le stock
      -- final ; partir du stock produit laisserait subsister une dérive
      -- antérieure entre les deux.
      SELECT COALESCE(sum(quantity), 0) INTO base_balances
        FROM stock_location_balances WHERE company_id = 1 AND product_id = prod.id;
      ecart := r.stock_apres - base_balances;

      -- ── Résolution de l'emplacement, du plus sûr au plus interprétatif ──
      -- 1. l'emplacement porté par le mouvement
      emplacement := COALESCE(mvt.source_location_id, mvt.destination_location_id);

      -- 2. la balance existante du produit, si elle est unique : un produit
      --    qui n'occupe qu'un seul bac désigne ce bac sans ambiguïté.
      IF emplacement IS NULL THEN
        SELECT count(*) INTO n_corresp FROM stock_location_balances
         WHERE company_id = 1 AND product_id = prod.id;
        IF n_corresp = 1 THEN
          SELECT location_id INTO par_balance FROM stock_location_balances
           WHERE company_id = 1 AND product_id = prod.id;
        ELSIF n_corresp > 1 THEN
          RAISE NOTICE '    produit % : % balances existantes, aucune ne s''impose', prod.id, n_corresp;
        END IF;
      END IF;

      -- 3. le code historique du mouvement, séparateurs normalisés.
      --    « W/EM2S-A-M-M3-L2-BIN1 » et « W-EM2S-A-M-M3-L2-BIN1 » désignent le
      --    même bac : full_code assemble warehouse-rayon-case-level-bin avec
      --    des tirets, mais les saisies anciennes emploient aussi « / ». On
      --    compare donc sur les seuls caractères alphanumériques. Deux bacs
      --    réellement distincts (BIN1 et BIN2) restent distincts.
      IF emplacement IS NULL
         AND NULLIF(trim(COALESCE(mvt.location_code, '')), '') IS NOT NULL THEN
        SELECT count(*) INTO n_corresp FROM locations
         WHERE company_id = 1
           AND COALESCE(merged_into_location_id, 0) = 0
           AND regexp_replace(upper(COALESCE(full_code, '')),        '[^A-Z0-9]', '', 'g')
             = regexp_replace(upper(mvt.location_code),              '[^A-Z0-9]', '', 'g')
           AND regexp_replace(upper(COALESCE(full_code, '')),        '[^A-Z0-9]', '', 'g') <> '';

        IF n_corresp > 1 THEN
          RAISE EXCEPTION
            'Mouvement % : le code « % » correspond à % emplacements après normalisation. Ambiguïté — rectification annulée.',
            mvt.id, mvt.location_code, n_corresp;
        ELSIF n_corresp = 1 THEN
          SELECT id INTO par_code FROM locations
           WHERE company_id = 1
             AND COALESCE(merged_into_location_id, 0) = 0
             AND regexp_replace(upper(COALESCE(full_code, '')), '[^A-Z0-9]', '', 'g')
               = regexp_replace(upper(mvt.location_code),       '[^A-Z0-9]', '', 'g');
        ELSE
          -- Dernier recours : le code historique conservé sur l'emplacement.
          SELECT count(*) INTO n_corresp FROM locations
           WHERE company_id = 1
             AND COALESCE(merged_into_location_id, 0) = 0
             AND regexp_replace(upper(COALESCE(emplacement_code, '')), '[^A-Z0-9]', '', 'g')
               = regexp_replace(upper(mvt.location_code),              '[^A-Z0-9]', '', 'g')
             AND regexp_replace(upper(COALESCE(emplacement_code, '')), '[^A-Z0-9]', '', 'g') <> '';
          IF n_corresp > 1 THEN
            RAISE EXCEPTION
              'Mouvement % : le code « % » correspond à % emplacements par emplacement_code. Ambiguïté — rectification annulée.',
              mvt.id, mvt.location_code, n_corresp;
          ELSIF n_corresp = 1 THEN
            SELECT id INTO par_code FROM locations
             WHERE company_id = 1
               AND COALESCE(merged_into_location_id, 0) = 0
               AND regexp_replace(upper(COALESCE(emplacement_code, '')), '[^A-Z0-9]', '', 'g')
                 = regexp_replace(upper(mvt.location_code),              '[^A-Z0-9]', '', 'g');
          END IF;
        END IF;
      END IF;

      -- Deux pistes qui se contredisent valent une absence de piste.
      IF par_balance IS NOT NULL AND par_code IS NOT NULL AND par_balance <> par_code THEN
        RAISE EXCEPTION
          'Produit % : la balance existante désigne l''emplacement % et le code « % » l''emplacement %. Contradiction — rectification annulée.',
          prod.id, par_balance, mvt.location_code, par_code;
      END IF;
      IF emplacement IS NULL THEN emplacement := COALESCE(par_balance, par_code); END IF;

      -- Aucun emplacement inventé. Mais si la somme des balances vaut déjà le
      -- stock visé, il n'y a rien à déplacer : exiger un emplacement pour ne
      -- rien y écrire bloquerait la correction sans rien protéger.
      IF emplacement IS NULL AND ecart <> 0 THEN
        RAISE EXCEPTION
          'Produit % (%) est géré par emplacement et demande un écart de %, mais le mouvement % ne désigne aucun emplacement identifiable (code « % »). Rectification annulée.',
          prod.id, r.reference_produit, ecart, mvt.id, COALESCE(mvt.location_code, '—');
      END IF;

      IF emplacement IS NULL THEN
        RAISE NOTICE '    produit % : balances déjà à % — aucun mouvement de balance nécessaire',
          prod.id, base_balances;
      END IF;
    ELSE
      ecart := r.stock_apres - COALESCE(prod.stock, 0);
    END IF;

    IF COALESCE(prod.location_managed, false) AND emplacement IS NOT NULL THEN
      SELECT quantity INTO qte_avant FROM stock_location_balances
       WHERE company_id = 1 AND product_id = prod.id AND location_id = emplacement;

      IF NOT FOUND THEN
        -- La balance de CET emplacement manque : on la crée à zéro, on ne
        -- répartit rien ailleurs.
        INSERT INTO stock_location_balances (company_id, product_id, location_id, warehouse_id, quantity)
        VALUES (1, prod.id, emplacement,
                COALESCE(mvt.source_warehouse_id, mvt.destination_warehouse_id), 0);
        qte_avant := 0;
      END IF;

      qte_apres := qte_avant + ecart;
      IF qte_apres < 0 THEN
        RAISE EXCEPTION
          'Produit % : la balance de l''emplacement % passerait de % à % (écart %). Un stock négatif est impossible. Rectification annulée.',
          prod.id, emplacement, qte_avant, qte_apres, ecart;
      END IF;

      UPDATE stock_location_balances
         SET quantity = qte_apres, updated_at = NOW()
       WHERE company_id = 1 AND product_id = prod.id AND location_id = emplacement;

      -- Un emplacement vidé reste en base : il redevient simplement libre.
      UPDATE locations
         SET occupancy_status = CASE WHEN qte_apres > 0 THEN 'OCCUPIED' ELSE 'EMPTY' END,
             updated_at = NOW()
       WHERE id = emplacement AND company_id = 1;

      RAISE NOTICE '    emplacement % : % → %', emplacement, qte_avant, qte_apres;
    END IF;

    -- ── Stock du produit ──
    UPDATE products SET stock = r.stock_apres, updated_at = NOW() WHERE id = prod.id;

    -- ── L'invariant, vérifié produit par produit ──
    IF COALESCE(prod.location_managed, false) THEN
      SELECT COALESCE(sum(quantity), 0) INTO total_bal
        FROM stock_location_balances WHERE company_id = 1 AND product_id = prod.id;
      IF total_bal <> r.stock_apres THEN
        RAISE EXCEPTION
          'Produit % : somme des balances = % alors que le stock vaut %. Rectification annulée.',
          prod.id, total_bal, r.stock_apres;
      END IF;
    END IF;

    RAISE NOTICE 'CORRIGÉ %  stock % → %  (écart %)',
      r.numero_document, prod.stock, r.stock_apres, ecart;
  END LOOP;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 5. CONTRÔLES FINAUX — toute anomalie annule l'ensemble
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  n         integer;
  attendu   record;
  reel      numeric;
BEGIN
  -- Les six stocks visés, au chiffre près.
  FOR attendu IN SELECT * FROM rectifications LOOP
    SELECT stock INTO reel FROM products
     WHERE company_id = 1 AND upper(trim(reference)) = upper(trim(attendu.reference_produit));
    IF reel <> attendu.stock_apres THEN
      RAISE EXCEPTION 'Contrôle final — % : stock % au lieu de %.',
        attendu.numero_document, reel, attendu.stock_apres;
    END IF;
  END LOOP;

  -- Le bon 001 doit être devenu une sortie de 2.
  SELECT count(*) INTO n
    FROM documents d JOIN stock_movements m ON m.id = d.stock_movement_id
   WHERE d.document_number = 'BR-260803-001' AND d.company_id = 1
     AND d.document_type = 'Bon de sortie' AND m.type = 'Sortie' AND m.quantity = 2;
  IF n <> 1 THEN
    RAISE EXCEPTION 'Contrôle final — BR-260803-001 n''est pas une sortie de 2.';
  END IF;

  -- Aucun stock négatif dans toute la société.
  SELECT count(*) INTO n FROM products WHERE company_id = 1 AND stock < 0;
  IF n > 0 THEN RAISE EXCEPTION 'Contrôle final — % produit(s) à stock négatif.', n; END IF;

  SELECT count(*) INTO n FROM stock_location_balances WHERE company_id = 1 AND quantity < 0;
  IF n > 0 THEN RAISE EXCEPTION 'Contrôle final — % balance(s) négative(s).', n; END IF;

  -- L'invariant sur TOUS les produits gérés par emplacement, pas seulement les six.
  SELECT count(*) INTO n
    FROM products p
    LEFT JOIN (SELECT product_id, sum(quantity) AS total
                 FROM stock_location_balances WHERE company_id = 1 GROUP BY product_id) b
      ON b.product_id = p.id
   WHERE p.company_id = 1 AND COALESCE(p.location_managed, false)
     AND COALESCE(b.total, 0) <> COALESCE(p.stock, 0);
  IF n > 0 THEN
    RAISE EXCEPTION 'Contrôle final — % produit(s) géré(s) par emplacement en écart entre stock et balances.', n;
  END IF;

  -- Aucune réservation orpheline.
  -- Seules les réservations ACTIVE comptent : une réservation relâchée ou
  -- consommée est un fait historique, pas une anomalie.
  SELECT count(*) INTO n FROM stock_reservations sr
   WHERE sr.company_id = 1 AND sr.status = 'ACTIVE'
     AND NOT EXISTS (SELECT 1 FROM stock_location_balances b
                      WHERE b.company_id = 1 AND b.product_id = sr.product_id
                        AND b.location_id = sr.location_id);
  IF n > 0 THEN RAISE EXCEPTION 'Contrôle final — % réservation(s) orpheline(s).', n; END IF;

  RAISE NOTICE 'Tous les contrôles finaux passent.';
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 6. RAPPORT
-- ═════════════════════════════════════════════════════════════════════════
\echo ''
\echo '── AVANT → APRÈS, LIGNE PAR LIGNE ──'
SELECT a.numero_document                              AS bon,
       left(r.nom_produit, 30)                        AS produit,
       a.type_mouvement_avant || ' → ' || r.type_mouvement   AS mouvement,
       a.quantite_avant       || ' → ' || r.quantite         AS quantite,
       a.stock_produit_avant  || ' → ' || r.stock_apres      AS stock,
       (r.stock_apres - a.stock_produit_avant)        AS ecart,
       CASE WHEN a.gere_par_emplacement THEN 'oui' ELSE 'non' END AS par_emplacement
  FROM etat_avant a JOIN rectifications r USING (numero_document)
 ORDER BY a.numero_document;

\echo ''
\echo '── STOCK GLOBAL TRIANGLE ──'
SELECT (SELECT total FROM stock_global_avant)                              AS avant,
       (SELECT COALESCE(sum(stock),0) FROM products WHERE company_id = 1)  AS apres,
       (SELECT COALESCE(sum(stock),0) FROM products WHERE company_id = 1)
         - (SELECT total FROM stock_global_avant)                          AS variation,
       (SELECT sum(r.stock_apres - a.stock_produit_avant)
          FROM etat_avant a JOIN rectifications r USING (numero_document))  AS somme_des_six_ecarts;

-- Le contrôle « aucun autre produit modifié » ne se fait pas ici : une
-- comparaison fondée sur updated_at confondrait une modification légitime
-- faite par un magasinier au même moment. Le script appelant compare l'état
-- complet des stocks avant et après, hors transaction, et exige que six
-- produits exactement aient changé.

COMMIT;

\echo ''
\echo 'Rectification validée et enregistrée.'

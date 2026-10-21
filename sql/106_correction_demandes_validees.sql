-- ═════════════════════════════════════════════════════════════════════════
-- 106 — CORRIGER UNE DEMANDE DÉJÀ VALIDÉE
--
-- Une demande de stock suit : BROUILLON → EN_ATTENTE → VALIDEE → RECUE.
-- Seule la RÉCEPTION déplace du stock ; la validation, elle, n'en déplace
-- aucun (`stock_impacted: false` partout avant `confirm`).
--
-- LE DÉFAUT
--
-- Une demande RECUE ne pouvait plus rien devenir : l'annulation la refusait
-- explicitement. Une erreur de saisie découverte après coup — mauvais
-- produit, quantité doublée, mauvais entrepôt — restait donc inscrite pour
-- toujours, et la seule issue connue des utilisateurs était de créer une
-- demande inverse « à la main », sans lien avec l'originale et sans motif.
--
-- CE QUE CETTE MIGRATION PERMET
--
--   • DÉVALIDER une demande validée dont AUCUN stock n'a bougé : elle
--     retourne EN_ATTENTE, et c'est tout. Rien à contre-passer.
--   • CONTRE-PASSER une réception : chaque mouvement produit reçoit son
--     mouvement inverse, les quantités reçues reviennent à zéro, la demande
--     redevient VALIDEE. Les mouvements d'origine RESTENT, marqués annulés.
--
-- Ce qui n'est pas permis, et ne doit pas l'être : effacer une ligne de
-- mouvement, ou « remettre le stock comme avant » par un UPDATE direct. Le
-- stock d'aujourd'hui est la somme des mouvements ; le corriger sans écrire
-- de mouvement rend l'écart inexplicable dès le lendemain.
--
-- Idempotente. Aucune demande existante n'est modifiée.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE stock_requests
  ADD COLUMN IF NOT EXISTS cancel_reason        TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_by_name    TEXT,
  ADD COLUMN IF NOT EXISTS last_correction_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_correction_by   INTEGER,
  ADD COLUMN IF NOT EXISTS corrections_count    INTEGER NOT NULL DEFAULT 0;

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS cancelled_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by            INTEGER,
  ADD COLUMN IF NOT EXISTS cancel_reason           TEXT,
  /* Le mouvement que celui-ci défait. Un journal se lit alors sans avoir à
     deviner quelle ligne annule quelle autre. */
  ADD COLUMN IF NOT EXISTS reverses_movement_id    INTEGER;

CREATE INDEX IF NOT EXISTS stock_movements_annules_idx
  ON stock_movements (company_id, cancelled_at) WHERE cancelled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS stock_movements_contrepasse_idx
  ON stock_movements (reverses_movement_id) WHERE reverses_movement_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- LE JOURNAL DES CORRECTIONS
--
-- Une ligne par geste de correction, avec ce qu'il a défait et pourquoi.
-- Sans elle, « pourquoi cette demande a-t-elle été reçue deux fois puis
-- ramenée à zéro ? » n'a pas de réponse six mois plus tard.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_request_corrections (
  id              BIGSERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL,
  request_id      INTEGER NOT NULL REFERENCES stock_requests(id) ON DELETE CASCADE,
  action          TEXT    NOT NULL,
  reason          TEXT    NOT NULL,
  status_before   TEXT,
  status_after    TEXT,
  /* Le détail de ce qui a bougé : lignes touchées, quantités, mouvements
     d'origine et leurs inverses. */
  details         JSONB   NOT NULL DEFAULT '{}'::jsonb,
  lines_affected  INTEGER NOT NULL DEFAULT 0,
  quantity_reversed NUMERIC(18,3) NOT NULL DEFAULT 0,
  acted_by        INTEGER,
  acted_by_name   TEXT NOT NULL DEFAULT '',
  acted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_request_corrections_action_connue CHECK (
    action IN ('MODIFICATION','DEVALIDATION','CONTREPASSATION','ANNULATION')
  ),
  CONSTRAINT stock_request_corrections_motif CHECK (BTRIM(reason) <> '')
);

CREATE INDEX IF NOT EXISTS stock_request_corrections_demande_idx
  ON stock_request_corrections (request_id, acted_at DESC);
CREATE INDEX IF NOT EXISTS stock_request_corrections_societe_idx
  ON stock_request_corrections (company_id, acted_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- QUI PEUT DÉFAIRE
--
-- Modifier une demande non validée relève de `update` : c'est de la saisie.
-- Dévalider relève de `validate` : c'est reprendre sa propre décision.
-- CONTRE-PASSER une réception change le stock réel : action distincte, car
-- un magasinier qui réceptionne ne doit pas pouvoir défaire seul ce que le
-- magasin a déjà rangé.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO permission_actions (action_key, label, description, sort_order, is_write) VALUES
  ('contrepasser', 'Contre-passer',
   'Défaire une opération déjà appliquée, par des écritures inverses.', 170, TRUE)
ON CONFLICT (action_key) DO UPDATE
  SET label = EXCLUDED.label, description = EXCLUDED.description;

UPDATE permission_modules
   SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                    FROM unnest(actions || ARRAY['contrepasser']) AS a),
       updated_at = now()
 WHERE module_key = 'demande';

DO $$
DECLARE soc RECORD;
BEGIN
  FOR soc IN SELECT id FROM companies LOOP
    INSERT INTO role_permissions (company_id, role, module_key, action, allowed) VALUES
      (soc.id, 'direction',   'demande', 'contrepasser', true),
      (soc.id, 'admin',       'demande', 'contrepasser', true),
      /* Le magasinier réceptionne ; il ne défait pas seul ce qui est rangé. */
      (soc.id, 'magasinier',  'demande', 'contrepasser', false)
    ON CONFLICT (company_id, role, module_key, action)
    DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
     WHERE role_permissions.updated_by IS NULL;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- CE QUI EST DÉJÀ INCOHÉRENT : RECENSÉ, PAS CORRIGÉ
--
-- Une demande annulée dont des mouvements de stock subsistent. Les corriger
-- en masse changerait des stocks réels ; une personne doit décider cas par
-- cas, en allant voir ce qu'il y a dans l'entrepôt.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_demandes_incoherentes AS
SELECT r.id, r.company_id, r.reference, r.request_type, r.status,
       r.cancelled_at, r.received_at,
       count(m.id)::int AS mouvements_actifs,
       COALESCE(sum(m.quantity), 0)::numeric AS quantite_en_jeu,
       'demande annulée dont des mouvements de stock subsistent' AS anomalie
  FROM stock_requests r
  JOIN stock_request_lines l ON l.request_id = r.id
  JOIN stock_movements m ON m.id = l.movement_id AND m.company_id = r.company_id
 WHERE r.status = 'ANNULEE'
   AND m.cancelled_at IS NULL
 GROUP BY r.id, r.company_id, r.reference, r.request_type, r.status,
          r.cancelled_at, r.received_at;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE incoherentes INTEGER;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_name = 'stock_request_corrections') THEN
    RAISE EXCEPTION '106 : sans journal, une correction de demande serait intraçable.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'stock_movements' AND column_name = 'reverses_movement_id') THEN
    RAISE EXCEPTION '106 : sans ce lien, on ne saurait pas quel mouvement en défait un autre.';
  END IF;

  SELECT count(*) INTO incoherentes FROM v_demandes_incoherentes;
  IF incoherentes > 0 THEN
    RAISE NOTICE '106 : % demande(s) annulée(s) dont des mouvements de stock subsistent. Aucune corrigée : voir v_demandes_incoherentes.', incoherentes;
  ELSE
    RAISE NOTICE '106 : aucune demande annulée avec des mouvements encore actifs.';
  END IF;
  RAISE NOTICE 'Correction des demandes en place. Aucune demande modifiée, aucun stock touché.';
END $$;

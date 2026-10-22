-- ═════════════════════════════════════════════════════════════════════════
--  155 — ÉTATS DE FACTURES (sable et ciment, Triangle et FAT & MAT)
--
--  Un « état » est une liste de factures arrêtée à un moment, numérotée,
--  imprimée et conservée. Une fois validé, il devient une pièce : on le
--  consulte, on le réimprime, on ne le réécrit pas.
--
--  LA QUESTION QUI COMMANDE TOUT LE RESTE : une facture peut-elle figurer
--  dans deux états validés ? Non — elle serait réclamée deux fois. La règle
--  n'est donc pas confiée à l'application : elle est posée en contrainte, par
--  un index unique partiel, et tenue par un déclencheur. Deux personnes qui
--  génèrent un état au même instant ne peuvent pas y faire entrer la même
--  facture : la seconde reçoit une violation d'unicité, pas un doublon.
--
--  ADDITIVE. Ne touche à aucune table existante.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- L'EN-TÊTE DE L'ÉTAT
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_statements (
  id                BIGSERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  statement_number  TEXT    NOT NULL,
  product           TEXT    NOT NULL,
  title             TEXT    NOT NULL DEFAULT '',
  period_from       DATE,
  period_to         DATE,
  status            TEXT    NOT NULL DEFAULT 'BROUILLON',

  /* D'où vient cet état :
       APPLICATION — généré ici ;
       HISTORIQUE  — un état antérieur, repris pour que ses factures ne
                     soient pas réutilisées comme si elles étaient libres. */
  origin            TEXT    NOT NULL DEFAULT 'APPLICATION',
  historical_reference TEXT NOT NULL DEFAULT '',

  invoices_count    INTEGER NOT NULL DEFAULT 0,
  total_invoiced    NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_paid        NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_remaining   NUMERIC(18,2) NOT NULL DEFAULT 0,

  notes             TEXT    NOT NULL DEFAULT '',

  /* Une correction ne réécrit pas l'état fautif : elle en crée un nouveau qui
     le remplace, et l'ancien reste consultable, marqué REMPLACE. */
  replaces_statement_id BIGINT REFERENCES invoice_statements(id) ON DELETE SET NULL,
  replace_reason    TEXT    NOT NULL DEFAULT '',

  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name   TEXT    NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  validated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  validated_by_name TEXT    NOT NULL DEFAULT '',
  validated_at      TIMESTAMPTZ,
  cancelled_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancelled_by_name TEXT    NOT NULL DEFAULT '',
  cancelled_at      TIMESTAMPTZ,
  cancel_reason     TEXT    NOT NULL DEFAULT '',
  printed_count     INTEGER NOT NULL DEFAULT 0,
  last_printed_at   TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_statements_coherent') THEN
    ALTER TABLE invoice_statements ADD CONSTRAINT invoice_statements_coherent CHECK (
          product IN ('SABLE','CIMENT')
      AND status  IN ('BROUILLON','VALIDE','ANNULE','REMPLACE')
      AND origin  IN ('APPLICATION','HISTORIQUE')
      /* Un état validé porte qui l'a validé et quand. */
      AND (status <> 'VALIDE'  OR validated_at IS NOT NULL)
      /* Une annulation porte toujours son motif : sans quoi personne ne peut
         dire, six mois plus tard, pourquoi cet état a disparu des comptes. */
      AND (status <> 'ANNULE'  OR (cancelled_at IS NOT NULL AND btrim(cancel_reason) <> ''))
      /* Un état remplacé porte le motif du remplacement : « corrigé parce
         que la facture FS-0042 y figurait deux fois » se relit, « corrigé »
         ne se relit pas. */
      AND (status <> 'REMPLACE' OR btrim(replace_reason) <> '')
      /* Un état repris de l'historique dit de quel document il vient. */
      AND (origin <> 'HISTORIQUE' OR btrim(historical_reference) <> '')
      /* On ne se remplace pas soi-même. */
      AND (replaces_statement_id IS NULL OR replaces_statement_id <> id)
    );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS invoice_statements_numero_uidx
  ON invoice_statements (company_id, statement_number);
CREATE INDEX IF NOT EXISTS invoice_statements_societe_idx
  ON invoice_statements (company_id, product, status, period_from DESC);
CREATE INDEX IF NOT EXISTS invoice_statements_remplace_idx
  ON invoice_statements (replaces_statement_id) WHERE replaces_statement_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- LES LIGNES
--
-- Les montants sont RECOPIÉS, pas liés. Un état dit ce que la facture valait
-- le jour où il a été arrêté ; si un paiement arrive ensuite, l'état ne doit
-- pas changer tout seul — sinon un document remis à un client ne correspond
-- plus à ce qu'on lui a remis.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_statement_lines (
  id              BIGSERIAL PRIMARY KEY,
  statement_id    BIGINT  NOT NULL REFERENCES invoice_statements(id) ON DELETE CASCADE,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product         TEXT    NOT NULL,

  /* NULL quand l'état vient de l'historique et que le numéro n'a pas encore
     été rapproché d'une facture existante. Le numéro, lui, est toujours là. */
  invoice_id      BIGINT,
  invoice_number  TEXT    NOT NULL,
  reconciled      BOOLEAN NOT NULL DEFAULT TRUE,

  invoice_date    DATE,
  client_name     TEXT    NOT NULL DEFAULT '',
  site            TEXT    NOT NULL DEFAULT '',
  quantity        NUMERIC(18,3),
  total_amount    NUMERIC(18,2) NOT NULL DEFAULT 0,
  paid_amount     NUMERIC(18,2) NOT NULL DEFAULT 0,
  remaining_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  status_at_time  TEXT    NOT NULL DEFAULT '',

  /* Tenu par le déclencheur ci-dessous, à partir du statut de l'en-tête.
     C'est cette colonne, et non une requête de l'application, qui empêche
     une facture d'entrer dans deux états validés. */
  blocks_reuse    BOOLEAN NOT NULL DEFAULT FALSE,

  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_statement_lines_coherent') THEN
    ALTER TABLE invoice_statement_lines ADD CONSTRAINT invoice_statement_lines_coherent CHECK (
          product IN ('SABLE','CIMENT')
      AND btrim(invoice_number) <> ''
      /* Une ligne rapprochée désigne une facture ; une ligne non rapprochée
         n'en désigne aucune. L'un ou l'autre, jamais un entre-deux. */
      AND (reconciled = (invoice_id IS NOT NULL))
    );
  END IF;
END $$;

/* Une même facture ne peut pas figurer deux fois dans le MÊME état. */
CREATE UNIQUE INDEX IF NOT EXISTS invoice_statement_lines_une_fois_uidx
  ON invoice_statement_lines (statement_id, product, invoice_id)
  WHERE invoice_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invoice_statement_lines_une_fois_num_uidx
  ON invoice_statement_lines (statement_id, product, lower(btrim(invoice_number)));

/* LA CONTRAINTE CENTRALE : une facture dans au plus UN état qui bloque.
   Deux index : l'un par identifiant pour les factures rapprochées, l'autre
   par numéro pour les lignes d'un état historique qui ne l'a pas encore été.
   Sans le second, reprendre un vieil état ne protégerait rien. */
CREATE UNIQUE INDEX IF NOT EXISTS invoice_statement_lines_un_seul_etat_uidx
  ON invoice_statement_lines (company_id, product, invoice_id)
  WHERE blocks_reuse AND invoice_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS invoice_statement_lines_un_seul_etat_num_uidx
  ON invoice_statement_lines (company_id, product, lower(btrim(invoice_number)))
  WHERE blocks_reuse;

CREATE INDEX IF NOT EXISTS invoice_statement_lines_etat_idx
  ON invoice_statement_lines (statement_id, sort_order, id);
CREATE INDEX IF NOT EXISTS invoice_statement_lines_facture_idx
  ON invoice_statement_lines (company_id, product, invoice_id);

-- ─────────────────────────────────────────────────────────────────────────
-- LE DÉCLENCHEUR QUI TIENT blocks_reuse
--
-- SEUL un état VALIDE bloque ses factures. Un BROUILLON ne bloque rien — on
-- peut préparer plusieurs brouillons sur les mêmes factures, c'est la
-- validation qui tranche. Un état ANNULE libère les siennes.
--
-- Et un état REMPLACE libère aussi. C'était l'erreur de la première version
-- de cette migration : s'il bloquait encore, l'état correctif ne pouvait pas
-- reprendre les factures de l'état fautif — or corriger consiste exactement
-- à les reprendre. L'état remplacé reste consultable et imprimable, marqué
-- REMPLACE et pointant vers son successeur ; il ne réclame plus rien.
--
-- Autrement dit : à tout instant, une facture figure dans AU PLUS UN état
-- qui la réclame.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION invoice_statements_tenir_blocage() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    UPDATE invoice_statement_lines
       SET blocks_reuse = (NEW.status = 'VALIDE')
     WHERE statement_id = NEW.id
       AND blocks_reuse <> (NEW.status = 'VALIDE');
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS invoice_statements_blocage_trg ON invoice_statements;
CREATE TRIGGER invoice_statements_blocage_trg
  AFTER UPDATE OF status ON invoice_statements
  FOR EACH ROW EXECUTE FUNCTION invoice_statements_tenir_blocage();

/* À l'insertion d'une ligne, hériter du statut de l'en-tête : une ligne
   ajoutée à un état déjà validé (reprise d'historique) bloque aussitôt. */
CREATE OR REPLACE FUNCTION invoice_statement_lines_heriter_blocage() RETURNS TRIGGER AS $$
DECLARE s TEXT;
BEGIN
  SELECT status INTO s FROM invoice_statements WHERE id = NEW.statement_id;
  NEW.blocks_reuse := (s = 'VALIDE');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS invoice_statement_lines_blocage_trg ON invoice_statement_lines;
CREATE TRIGGER invoice_statement_lines_blocage_trg
  BEFORE INSERT ON invoice_statement_lines
  FOR EACH ROW EXECUTE FUNCTION invoice_statement_lines_heriter_blocage();

-- ─────────────────────────────────────────────────────────────────────────
-- LE JOURNAL
--
-- Qui a généré, validé, réimprimé, annulé, corrigé. Un état est une pièce :
-- son histoire se lit, elle ne se déduit pas.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_statement_history (
  id            BIGSERIAL PRIMARY KEY,
  statement_id  BIGINT  NOT NULL REFERENCES invoice_statements(id) ON DELETE CASCADE,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  action        TEXT    NOT NULL,
  reason        TEXT    NOT NULL DEFAULT '',
  details       JSONB   NOT NULL DEFAULT '{}'::jsonb,
  acted_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  acted_by_name TEXT    NOT NULL DEFAULT '',
  acted_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_statement_history_action_chk') THEN
    ALTER TABLE invoice_statement_history ADD CONSTRAINT invoice_statement_history_action_chk
      CHECK (action IN ('CREATION','AJOUT_LIGNE','RETRAIT_LIGNE','VALIDATION',
                        'IMPRESSION','REIMPRESSION','ANNULATION','REMPLACEMENT',
                        'REPRISE_HISTORIQUE','RAPPROCHEMENT'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS invoice_statement_history_etat_idx
  ON invoice_statement_history (statement_id, acted_at DESC);
CREATE INDEX IF NOT EXISTS invoice_statement_history_societe_idx
  ON invoice_statement_history (company_id, acted_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- CE QUE L'ON NE SAIT PAS ENCORE
--
-- Tant que les états antérieurs n'ont pas tous été repris, l'absence d'une
-- facture du registre ne prouve PAS qu'elle n'a jamais été portée sur un
-- état. L'écran doit le dire, au lieu de laisser croire le contraire.
--
-- Une ligne par société et par produit. Personne ne la coche à la place de
-- l'utilisateur : par défaut, l'historique est déclaré incomplet.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_statement_history_notice (
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product           TEXT    NOT NULL,
  declared_complete BOOLEAN NOT NULL DEFAULT FALSE,
  note              TEXT    NOT NULL DEFAULT '',
  declared_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  declared_by_name  TEXT    NOT NULL DEFAULT '',
  declared_at       TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, product)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_statement_history_notice_produit_chk') THEN
    ALTER TABLE invoice_statement_history_notice
      ADD CONSTRAINT invoice_statement_history_notice_produit_chk
      CHECK (product IN ('SABLE','CIMENT')
             AND (declared_complete = FALSE OR declared_at IS NOT NULL));
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- LES FACTURES DÉJÀ PORTÉES SUR UN ÉTAT
--
-- Une vue, pour que la question « cette facture est-elle déjà prise ? » ait
-- une seule réponse, la même pour l'écran de sélection, le PDF et les tests.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_factures_deja_sur_etat AS
SELECT l.company_id,
       l.product,
       l.invoice_id,
       lower(btrim(l.invoice_number)) AS invoice_key,
       l.invoice_number,
       s.id            AS statement_id,
       s.statement_number,
       s.status        AS statement_status,
       s.origin        AS statement_origin,
       s.validated_at,
       l.reconciled
  FROM invoice_statement_lines l
  JOIN invoice_statements s ON s.id = l.statement_id
 WHERE l.blocks_reuse;

-- ─────────────────────────────────────────────────────────────────────────
-- LES DROITS
--
-- Un seul module, « etat_facture ». La séparation Triangle / FAT & MAT reste
-- celle de company_id, et l'accès au produit reste celui des modules
-- « sable » et « ciment » : rien n'est contourné ici.
--
-- Toutes les actions utilisées existent déjà au catalogue (view, create,
-- validate, print, reprint, cancel, correct, export, archive). Aucune action
-- nouvelle n'est déclarée : permission_actions est une clé étrangère, et y
-- ajouter sans nécessité est un risque pour rien.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO permission_modules
  (module_key, parent_key, label, description, sort_order, is_active, is_system, actions) VALUES
  ('etat_facture', 'comptabilite', 'États de factures',
   'Listes de factures arrêtées, numérotées, imprimées et conservées.',
   215, TRUE, FALSE,
   ARRAY['visible','view','create','validate','print','reprint','cancel',
         'correct','export','archive'])
ON CONFLICT (module_key) DO UPDATE
  SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(permission_modules.actions || EXCLUDED.actions) AS a),
      updated_at = now();

DO $$
DECLARE soc RECORD;
BEGIN
  FOR soc IN SELECT id FROM companies LOOP
    INSERT INTO role_permissions (company_id, role, module_key, action, allowed) VALUES
      (soc.id, 'direction', 'etat_facture', 'visible',  true),
      (soc.id, 'direction', 'etat_facture', 'view',     true),
      (soc.id, 'direction', 'etat_facture', 'create',   true),
      (soc.id, 'direction', 'etat_facture', 'validate', true),
      (soc.id, 'direction', 'etat_facture', 'print',    true),
      (soc.id, 'direction', 'etat_facture', 'reprint',  true),
      (soc.id, 'direction', 'etat_facture', 'cancel',   true),
      (soc.id, 'direction', 'etat_facture', 'correct',  true),
      (soc.id, 'direction', 'etat_facture', 'export',   true),
      (soc.id, 'direction', 'etat_facture', 'archive',  true),

      (soc.id, 'admin',     'etat_facture', 'visible',  true),
      (soc.id, 'admin',     'etat_facture', 'view',     true),
      (soc.id, 'admin',     'etat_facture', 'create',   true),
      (soc.id, 'admin',     'etat_facture', 'validate', true),
      (soc.id, 'admin',     'etat_facture', 'print',    true),
      (soc.id, 'admin',     'etat_facture', 'reprint',  true),
      (soc.id, 'admin',     'etat_facture', 'cancel',   true),
      (soc.id, 'admin',     'etat_facture', 'correct',  true),
      (soc.id, 'admin',     'etat_facture', 'export',   true),
      (soc.id, 'admin',     'etat_facture', 'archive',  true),

      /* Le comptable prépare et imprime. Annuler un état validé et en
         corriger un sont des gestes de direction : ils déplacent ce qui est
         réclamé à un client. */
      (soc.id, 'comptable', 'etat_facture', 'visible',  true),
      (soc.id, 'comptable', 'etat_facture', 'view',     true),
      (soc.id, 'comptable', 'etat_facture', 'create',   true),
      (soc.id, 'comptable', 'etat_facture', 'validate', true),
      (soc.id, 'comptable', 'etat_facture', 'print',    true),
      (soc.id, 'comptable', 'etat_facture', 'reprint',  true),
      (soc.id, 'comptable', 'etat_facture', 'export',   true),
      (soc.id, 'comptable', 'etat_facture', 'cancel',   false),
      (soc.id, 'comptable', 'etat_facture', 'correct',  false),

      (soc.id, 'magasinier','etat_facture', 'visible',  false)
    ON CONFLICT (company_id, role, module_key, action)
    DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
     WHERE role_permissions.updated_by IS NULL;

    /* L'historique est déclaré INCOMPLET par défaut, pour les deux produits.
       Personne ne coche cette case à la place de l'utilisateur. */
    INSERT INTO invoice_statement_history_notice (company_id, product, note)
    VALUES (soc.id, 'SABLE',  'Aucun état antérieur repris pour l''instant.'),
           (soc.id, 'CIMENT', 'Aucun état antérieur repris pour l''instant.')
    ON CONFLICT (company_id, product) DO NOTHING;
  END LOOP;
END $$;

COMMIT;

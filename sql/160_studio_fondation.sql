-- ═════════════════════════════════════════════════════════════════════════
--  160 — TRIANGLE STUDIO PRO : LA FONDATION
--
--  Avant le scanner, l'éditeur PDF ou le studio graphique, il faut un endroit
--  où les documents vivent. Cette migration l'installe : des dossiers, des
--  documents, des VERSIONS, des partages, et un journal.
--
--  TROIS CHOIX QUI COMMANDENT TOUT LE RESTE.
--
--  1. LE FICHIER N'EST PAS DANS LA BASE, ET SON CHEMIN N'EST PAS DEVINABLE.
--     La base porte une CLÉ opaque ; le fichier vit sous `storage/studio/`,
--     hors du dossier servi en statique par express. Aucune URL ne peut donc
--     contourner les contrôles : il n'existe pas d'adresse publique vers ces
--     fichiers, contrairement à `uploads/`.
--
--  2. L'ORIGINAL NE CHANGE JAMAIS. Modifier un document crée une VERSION de
--     plus. La version 1 reste, avec son empreinte. C'est ce qui permet de
--     dire « voici ce qui a été remis » six mois plus tard, et de comparer.
--
--  3. UN DOCUMENT APPARTIENT À UNE SOCIÉTÉ, ET LA FRONTIÈRE EST DANS LA
--     TABLE. company_id est NOT NULL partout, et chaque lecture le vérifie.
--
--  ADDITIVE. Aucune table existante n'est modifiée.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- LES DOSSIERS
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS studio_folders (
  id           BIGSERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_id    BIGINT REFERENCES studio_folders(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  /* Le chemin complet, tenu par l'application à chaque déplacement. Il évite
     une requête récursive pour afficher « Comptabilité / 2026 / Factures ». */
  path         TEXT    NOT NULL DEFAULT '',
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  trashed_at   TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'studio_folders_nom_chk') THEN
    ALTER TABLE studio_folders ADD CONSTRAINT studio_folders_nom_chk CHECK (
          btrim(name) <> ''
      /* Un dossier ne peut pas être son propre parent. La boucle plus longue
         (A dans B dans A) est empêchée par l'application, qui refuse de
         déplacer un dossier dans sa propre descendance. */
      AND (parent_id IS NULL OR parent_id <> id)
    );
  END IF;
END $$;

/* Deux dossiers de même nom au même endroit prêteraient à confusion sans
   rien apporter. La corbeille ne compte pas : un dossier jeté libère son nom. */
CREATE UNIQUE INDEX IF NOT EXISTS studio_folders_unique_idx
  ON studio_folders (company_id, COALESCE(parent_id, 0), lower(btrim(name)))
  WHERE trashed_at IS NULL;
CREATE INDEX IF NOT EXISTS studio_folders_parent_idx
  ON studio_folders (company_id, parent_id) WHERE trashed_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- LES DOCUMENTS
--
-- La ligne porte ce qu'on cherche ; le fichier porte le contenu. `storage_key`
-- est l'identifiant opaque sous lequel la version courante est rangée.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS studio_documents (
  id            BIGSERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  folder_id     BIGINT REFERENCES studio_folders(id) ON DELETE SET NULL,
  name          TEXT    NOT NULL,
  /* Ce que le document EST, du point de vue du Studio : un scan, un PDF
     édité, une création graphique, une présentation, une image retouchée.
     Le type MIME dit le format ; `kind` dit l'intention. */
  kind          TEXT    NOT NULL DEFAULT 'FICHIER',
  mime          TEXT    NOT NULL DEFAULT 'application/octet-stream',
  size_bytes    BIGINT  NOT NULL DEFAULT 0,
  sha256        TEXT    NOT NULL DEFAULT '',
  storage_key   TEXT    NOT NULL,
  page_count    INTEGER,

  version       INTEGER NOT NULL DEFAULT 1,
  /* Le texte reconnu, pour la recherche. Rempli par l'OCR quand il tourne. */
  ocr_text      TEXT    NOT NULL DEFAULT '',
  ocr_language  TEXT    NOT NULL DEFAULT '',
  tags          TEXT[]  NOT NULL DEFAULT ARRAY[]::text[],
  description   TEXT    NOT NULL DEFAULT '',

  /* Qui le voit : son auteur seul, son équipe, ou toute la société. Les
     partages nominatifs vivent dans studio_shares. */
  visibility    TEXT    NOT NULL DEFAULT 'PRIVE',

  owner_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  owner_name    TEXT    NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_name TEXT  NOT NULL DEFAULT '',

  /* La corbeille : rien n'est supprimé d'un clic. */
  trashed_at    TIMESTAMPTZ,
  trashed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  trashed_by_name TEXT  NOT NULL DEFAULT '',

  /* Un document issu d'un autre — un PDF reconstruit depuis un scan, une
     image détourée — garde le lien vers sa source. */
  source_document_id BIGINT REFERENCES studio_documents(id) ON DELETE SET NULL,
  source_note   TEXT    NOT NULL DEFAULT ''
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'studio_documents_coherent') THEN
    ALTER TABLE studio_documents ADD CONSTRAINT studio_documents_coherent CHECK (
          btrim(name) <> ''
      AND btrim(storage_key) <> ''
      AND size_bytes >= 0
      AND version >= 1
      AND kind IN ('FICHIER','SCAN','PDF','IMAGE','CREATION','PRESENTATION','SIGNATURE','CACHET')
      AND visibility IN ('PRIVE','EQUIPE','SOCIETE')
      AND (trashed_at IS NULL OR trashed_by IS NOT NULL)
      AND (source_document_id IS NULL OR source_document_id <> id)
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS studio_documents_dossier_idx
  ON studio_documents (company_id, folder_id, updated_at DESC) WHERE trashed_at IS NULL;
CREATE INDEX IF NOT EXISTS studio_documents_proprietaire_idx
  ON studio_documents (company_id, owner_id, updated_at DESC) WHERE trashed_at IS NULL;
CREATE INDEX IF NOT EXISTS studio_documents_corbeille_idx
  ON studio_documents (company_id, trashed_at DESC) WHERE trashed_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS studio_documents_cle_uidx
  ON studio_documents (storage_key);
CREATE INDEX IF NOT EXISTS studio_documents_tags_idx
  ON studio_documents USING GIN (tags);

/* LA RECHERCHE PLEIN TEXTE, nom + description + texte reconnu par l'OCR.
   En français : « facture » et « factures » doivent se trouver l'un l'autre.
   L'index est posé sur une expression, donc recalculé à chaque écriture —
   acceptable pour des documents qu'on écrit rarement et qu'on cherche
   souvent. */
CREATE INDEX IF NOT EXISTS studio_documents_recherche_idx
  ON studio_documents USING GIN (
    to_tsvector('french', coalesce(name,'') || ' ' || coalesce(description,'') || ' ' || coalesce(ocr_text,''))
  ) WHERE trashed_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- LES VERSIONS
--
-- Chaque enregistrement produit une ligne. La version 1 est l'original, et
-- elle ne bouge plus jamais : c'est elle qu'on ressort pour dire « voilà ce
-- qui avait été remis ».
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS studio_document_versions (
  id           BIGSERIAL PRIMARY KEY,
  document_id  BIGINT  NOT NULL REFERENCES studio_documents(id) ON DELETE CASCADE,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  storage_key  TEXT    NOT NULL,
  mime         TEXT    NOT NULL DEFAULT 'application/octet-stream',
  size_bytes   BIGINT  NOT NULL DEFAULT 0,
  sha256       TEXT    NOT NULL DEFAULT '',
  page_count   INTEGER,
  /* Ce qui a changé, dit par la personne. « Correction du montant » se relit ;
     « modification » ne se relit pas. */
  change_note  TEXT    NOT NULL DEFAULT '',
  /* Un document modifié NE DOIT JAMAIS passer pour un original. Cette colonne
     le dit, et l'écran l'affiche. */
  is_original  BOOLEAN NOT NULL DEFAULT FALSE,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS studio_versions_uidx
  ON studio_document_versions (document_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS studio_versions_cle_uidx
  ON studio_document_versions (storage_key);
/* Un seul original par document : la version 1. */
CREATE UNIQUE INDEX IF NOT EXISTS studio_versions_original_uidx
  ON studio_document_versions (document_id) WHERE is_original;

-- ─────────────────────────────────────────────────────────────────────────
-- LES PARTAGES
--
-- Deux natures bien distinctes :
--   INTERNE — une personne nommée, avec un niveau d'accès.
--   LIEN    — une adresse signée, qui expire et se révoque.
--
-- Le jeton d'un lien n'est PAS stocké en clair : la base garde son empreinte.
-- Une fuite de la table ne donne donc aucun lien utilisable.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS studio_shares (
  id            BIGSERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_id   BIGINT  NOT NULL REFERENCES studio_documents(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL,

  /* Partage interne */
  grantee_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  access        TEXT    NOT NULL DEFAULT 'LECTURE',

  /* Lien signé */
  token_sha256  TEXT,
  expires_at    TIMESTAMPTZ,
  max_downloads INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  revoked_at    TIMESTAMPTZ,
  revoked_by_name TEXT   NOT NULL DEFAULT '',
  revoke_reason TEXT     NOT NULL DEFAULT '',

  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT   NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'studio_shares_coherent') THEN
    ALTER TABLE studio_shares ADD CONSTRAINT studio_shares_coherent CHECK (
          kind IN ('INTERNE','LIEN')
      AND access IN ('LECTURE','COMMENTAIRE','MODIFICATION','TELECHARGEMENT')
      /* Un partage interne vise quelqu'un ; un lien porte une empreinte et
         une date de fin. Un lien sans expiration n'en est pas un. */
      AND (kind <> 'INTERNE' OR grantee_user_id IS NOT NULL)
      AND (kind <> 'LIEN' OR (token_sha256 IS NOT NULL AND expires_at IS NOT NULL))
      AND (revoked_at IS NULL OR btrim(revoke_reason) <> '')
      AND download_count >= 0
    );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS studio_shares_interne_uidx
  ON studio_shares (document_id, grantee_user_id)
  WHERE kind = 'INTERNE';
CREATE UNIQUE INDEX IF NOT EXISTS studio_shares_jeton_uidx
  ON studio_shares (token_sha256) WHERE token_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS studio_shares_document_idx
  ON studio_shares (company_id, document_id);
CREATE INDEX IF NOT EXISTS studio_shares_actifs_idx
  ON studio_shares (company_id, expires_at)
  WHERE kind = 'LIEN' AND revoked_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- LE JOURNAL
--
-- Chaque lecture, écriture, partage, téléchargement et suppression. Un
-- document du Studio peut porter un bilan, un contrat, une fiche de paie :
-- savoir qui l'a ouvert fait partie du contrôle.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS studio_access_log (
  id           BIGSERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_id  BIGINT,
  share_id     BIGINT,
  action       TEXT    NOT NULL,
  detail       TEXT    NOT NULL DEFAULT '',
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name    TEXT    NOT NULL DEFAULT '',
  ip           TEXT    NOT NULL DEFAULT '',
  acted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'studio_access_log_action_chk') THEN
    ALTER TABLE studio_access_log ADD CONSTRAINT studio_access_log_action_chk
      CHECK (action IN ('DEPOT','LECTURE','TELECHARGEMENT','NOUVELLE_VERSION','RENOMMAGE',
                        'DEPLACEMENT','PARTAGE','REVOCATION','CORBEILLE','RESTAURATION',
                        'SUPPRESSION_DEFINITIVE','REFUS','LIEN_UTILISE','SIGNATURE'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS studio_access_log_document_idx
  ON studio_access_log (document_id, acted_at DESC);
CREATE INDEX IF NOT EXISTS studio_access_log_societe_idx
  ON studio_access_log (company_id, acted_at DESC);
CREATE INDEX IF NOT EXISTS studio_access_log_refus_idx
  ON studio_access_log (company_id, acted_at DESC) WHERE action = 'REFUS';

-- ─────────────────────────────────────────────────────────────────────────
-- LES DROITS
--
-- Un module « studio » et ses sous-modules. Le moteur de permissions résout
-- « studio.bibliotheque » en remontant à « studio » quand le premier ne dit
-- rien : un droit posé sur le parent suffit donc pour tout, et un droit posé
-- sur l'enfant l'emporte.
--
-- Aucune action nouvelle : visible, view, create, update, delete, export,
-- print, share, validate et archive existent déjà au catalogue.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO permission_modules
  (module_key, parent_key, label, description, sort_order, is_active, is_system, actions) VALUES
  ('studio', NULL, 'Triangle Studio Pro',
   'Scanner, documents, signatures, création graphique et bibliothèque.',
   300, TRUE, FALSE,
   ARRAY['visible','view','create','update','delete','export','print','share']),
  ('studio.bibliotheque', 'studio', 'Bibliothèque documentaire',
   'Dossiers, documents, versions, corbeille et partages.', 301, TRUE, FALSE,
   ARRAY['visible','view','create','update','delete','export','print','share','archive']),
  ('studio.scanner', 'studio', 'Scanner intelligent',
   'Capture, correction de perspective et reconnaissance de texte.', 302, TRUE, FALSE,
   ARRAY['visible','view','create']),
  ('studio.pdf', 'studio', 'Documents et PDF',
   'Lecture, annotation, assemblage et export des PDF.', 303, TRUE, FALSE,
   ARRAY['visible','view','create','update','export','print']),
  ('studio.signature', 'studio', 'Signatures et cachets',
   'Signatures personnelles, cachets d''entreprise et apposition.', 304, TRUE, FALSE,
   ARRAY['visible','view','create','update','delete','validate']),
  ('studio.design', 'studio', 'Studio graphique',
   'Modèles, mise en page et exports.', 305, TRUE, FALSE,
   ARRAY['visible','view','create','update','export']),
  ('studio.photo', 'studio', 'Photo',
   'Recadrage, réglages et détourage.', 306, TRUE, FALSE,
   ARRAY['visible','view','create','update','export']),
  ('studio.presentation', 'studio', 'Présentations',
   'Diapositives, mode présentateur et export.', 307, TRUE, FALSE,
   ARRAY['visible','view','create','update','export','print']),
  ('studio.detente', 'studio', 'Espace détente',
   'Jeux courts, désactivés par défaut.', 308, TRUE, FALSE,
   ARRAY['visible','view'])
ON CONFLICT (module_key) DO UPDATE
  SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(permission_modules.actions || EXCLUDED.actions) AS a),
      parent_key = EXCLUDED.parent_key,
      updated_at = now();

DO $$
DECLARE soc RECORD;
BEGIN
  FOR soc IN SELECT id FROM companies LOOP
    /* La direction et l'administrateur ont tout. Le comptable et l'assistante
       RH travaillent dans le Studio sans pouvoir supprimer définitivement.
       Le magasinier y accède en lecture : il a besoin de retrouver un bon de
       livraison scanné, pas d'éditer des documents. */
    INSERT INTO role_permissions (company_id, role, module_key, action, allowed)
    SELECT soc.id, r.role, m.module, a.action, r.niveau >= a.exigence
      FROM (VALUES ('direction',3),('admin',3),('super_admin',3),
                   ('comptable',2),('assistant_rh',2),('magasinier',1)) AS r(role,niveau),
           (VALUES ('studio'),('studio.bibliotheque'),('studio.scanner'),('studio.pdf'),
                   ('studio.signature'),('studio.design'),('studio.photo'),
                   ('studio.presentation'),('studio.detente')) AS m(module),
           (VALUES ('visible',1),('view',1),('create',2),('update',2),
                   ('export',2),('print',2),('share',2),
                   ('delete',3),('validate',3),('archive',3)) AS a(action,exigence)
     WHERE a.action = ANY (SELECT unnest(actions) FROM permission_modules WHERE module_key = m.module)
    ON CONFLICT (company_id, role, module_key, action)
    DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
     WHERE role_permissions.updated_by IS NULL;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- CE QU'UNE PERSONNE PEUT VOIR
--
-- Une vue, pour que la question « ai-je accès à ce document ? » reçoive la
-- même réponse de l'écran, de l'API et des tests. Elle ne remplace pas le
-- contrôle serveur : elle le rend lisible.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_studio_acces AS
SELECT d.id AS document_id, d.company_id, u.id AS user_id,
       CASE
         WHEN d.owner_id = u.id THEN 'PROPRIETAIRE'
         WHEN s.id IS NOT NULL  THEN 'PARTAGE'
         WHEN d.visibility = 'SOCIETE' THEN 'SOCIETE'
         ELSE NULL
       END AS motif,
       COALESCE(s.access, CASE WHEN d.owner_id = u.id THEN 'TELECHARGEMENT' ELSE 'LECTURE' END) AS niveau
  FROM studio_documents d
  JOIN users u ON u.company_id = d.company_id
  LEFT JOIN studio_shares s
    ON s.document_id = d.id AND s.kind = 'INTERNE' AND s.grantee_user_id = u.id
 WHERE d.trashed_at IS NULL
   AND (d.owner_id = u.id OR s.id IS NOT NULL OR d.visibility = 'SOCIETE');

COMMIT;

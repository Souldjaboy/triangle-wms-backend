-- ═════════════════════════════════════════════════════════════════════════
--  157 — DOCUMENTS DU PERSONNEL : APERÇU, VERSIONS, ARCHIVAGE RÉEL
--
--  CE QUI MANQUAIT, ET POURQUOI C'EST GÊNANT.
--
--  1. LE PDF N'ÉTAIT PAS CONSERVÉ. Seules son empreinte SHA-256 et les
--     données ayant servi à l'écrire étaient gardées. Réimprimer revenait à
--     RÉGÉNÉRER : au moindre changement du générateur — une marge, une
--     mention légale, un logo — le document reproduit ne serait plus celui
--     qui a été remis au salarié, et l'empreinte ne correspondrait plus.
--     Une attestation signée se conserve, elle ne se recalcule pas.
--
--  2. RIEN NE RELIAIT LES VERSIONS. Rééditer un bulletin après correction
--     créait une seconde pièce, sans lien avec la première. Deux documents du
--     même mois circulaient, et rien ne disait lequel faisait foi.
--
--  3. IL N'Y AVAIT PAS D'APERÇU. On émettait pour voir. Un document émis par
--     erreur se range dans le registre et demande une annulation motivée.
--
--  ADDITIVE. Les documents déjà émis gardent leur empreinte et leurs données ;
--  ils sont simplement déclarés « version 1 » et « émis ».
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE hr_documents
  /* Les octets du PDF tel qu'il a été remis. C'est l'archive ; le reste est
     de la documentation. Un bulletin pèse une quinzaine de kilo-octets :
     mille documents tiennent dans une quinzaine de méga-octets. */
  ADD COLUMN IF NOT EXISTS pdf_content   BYTEA,
  ADD COLUMN IF NOT EXISTS pdf_bytes     INTEGER NOT NULL DEFAULT 0,

  ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'EMIS',
  ADD COLUMN IF NOT EXISTS version       INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS supersedes_document_id    BIGINT,
  ADD COLUMN IF NOT EXISTS superseded_by_document_id BIGINT,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS version_reason TEXT NOT NULL DEFAULT '',

  /* Combien de fois la pièce est sortie, et quand pour la dernière fois.
     La première remise et la cinquième ne sont pas le même événement entre
     les mains d'un salarié. */
  ADD COLUMN IF NOT EXISTS printed_count   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_printed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by_name TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_documents_version_coherente') THEN
    ALTER TABLE hr_documents ADD CONSTRAINT hr_documents_version_coherente CHECK (
          status IN ('EMIS','ANNULE','REMPLACE')
      AND version >= 1
      AND (status <> 'ANNULE'   OR cancelled_at IS NOT NULL)
      AND (status <> 'REMPLACE' OR superseded_at IS NOT NULL)
      /* Une version supérieure à 1 désigne celle qu'elle remplace, et dit
         pourquoi. « Version 3 » sans motif ne se relit pas. */
      AND (version = 1 OR (supersedes_document_id IS NOT NULL AND btrim(version_reason) <> ''))
      AND (supersedes_document_id IS NULL OR supersedes_document_id <> id)
    );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_documents_remplace_fkey') THEN
    ALTER TABLE hr_documents
      ADD CONSTRAINT hr_documents_remplace_fkey
      FOREIGN KEY (supersedes_document_id) REFERENCES hr_documents(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_documents_remplace_par_fkey') THEN
    ALTER TABLE hr_documents
      ADD CONSTRAINT hr_documents_remplace_par_fkey
      FOREIGN KEY (superseded_by_document_id) REFERENCES hr_documents(id) ON DELETE SET NULL;
  END IF;
END $$;

/* Les documents déjà en base sont des versions 1, émises. La valeur par
   défaut s'en est chargée ; on remet cancelled_by_name pour ceux qui étaient
   déjà annulés, afin que le registre ne montre pas une annulation anonyme. */
UPDATE hr_documents SET status = 'ANNULE'
 WHERE cancelled_at IS NOT NULL AND status <> 'ANNULE';

CREATE INDEX IF NOT EXISTS hr_documents_versions_idx
  ON hr_documents (company_id, employee_id, doc_type, period_code, version DESC);
CREATE INDEX IF NOT EXISTS hr_documents_courants_idx
  ON hr_documents (company_id, doc_type, issued_on DESC) WHERE status = 'EMIS';
CREATE INDEX IF NOT EXISTS hr_documents_remplacement_idx
  ON hr_documents (supersedes_document_id) WHERE supersedes_document_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- LE JOURNAL DES PIÈCES
--
-- Émise, prévisualisée, réimprimée, remplacée, annulée. Un aperçu n'entre
-- PAS au registre des pièces — il n'a été remis à personne — mais le fait
-- qu'on ait regardé avant d'émettre se note : c'est la preuve que le
-- document a été relu.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_document_history (
  id            BIGSERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_id   BIGINT REFERENCES hr_documents(id) ON DELETE CASCADE,
  employee_id   INTEGER,
  doc_type      TEXT    NOT NULL,
  action        TEXT    NOT NULL,
  reason        TEXT    NOT NULL DEFAULT '',
  details       JSONB   NOT NULL DEFAULT '{}'::jsonb,
  acted_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  acted_by_name TEXT    NOT NULL DEFAULT '',
  acted_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hr_document_history_action_chk') THEN
    ALTER TABLE hr_document_history ADD CONSTRAINT hr_document_history_action_chk
      CHECK (action IN ('APERCU','EMISSION','REIMPRESSION','NOUVELLE_VERSION',
                        'REMPLACEMENT','ANNULATION'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS hr_document_history_piece_idx
  ON hr_document_history (document_id, acted_at DESC);
CREATE INDEX IF NOT EXISTS hr_document_history_societe_idx
  ON hr_document_history (company_id, acted_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- LA PIÈCE QUI FAIT FOI
--
-- Pour un salarié, un type et une période, c'est la dernière version émise.
-- Une vue, pour que l'écran, le PDF et les tests répondent la même chose.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_documents_rh_courants AS
SELECT DISTINCT ON (d.company_id, d.employee_id, d.doc_type, COALESCE(d.period_code, ''))
       d.id, d.company_id, d.employee_id, d.doc_type, d.period_code,
       d.reference, d.title, d.issued_on, d.version, d.status,
       d.issued_by_name, d.pdf_sha256, d.pdf_bytes, d.printed_count
  FROM hr_documents d
 WHERE d.status = 'EMIS'
 ORDER BY d.company_id, d.employee_id, d.doc_type, COALESCE(d.period_code, ''),
          d.version DESC, d.id DESC;

-- ─────────────────────────────────────────────────────────────────────────
-- LES DROITS
--
-- Aucune action nouvelle : « print » couvre l'aperçu et l'émission,
-- « reprint » la seconde sortie d'une pièce déjà remise, « update » la
-- nouvelle version. Toutes existent au catalogue, et les droits déjà
-- configurés sur rh.document ne sont pas touchés.
--
-- La migration 154 sème rh.document pour la direction et le comptable, et
-- PAS pour l'administrateur : ces pièces portent les rémunérations, et
-- `voir_remuneration` n'est pas un droit à accorder par défaut à un rôle
-- technique. Ce choix est conservé ici.
-- ─────────────────────────────────────────────────────────────────────────
UPDATE permission_modules
   SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                    FROM unnest(actions || ARRAY['reprint','archive']) AS a),
       updated_at = now()
 WHERE module_key = 'rh.document';

DO $$
DECLARE soc RECORD;
BEGIN
  FOR soc IN SELECT id FROM companies LOOP
    INSERT INTO role_permissions (company_id, role, module_key, action, allowed) VALUES
      (soc.id, 'direction', 'rh.document', 'reprint', true),
      (soc.id, 'direction', 'rh.document', 'archive', true),
      /* Le comptable édite et imprime ; réimprimer une pièce déjà remise
         relève de la direction, car c'est elle qui répond de ce qui circule
         en double. */
      (soc.id, 'comptable', 'rh.document', 'reprint', false),
      (soc.id, 'comptable', 'rh.document', 'archive', false)
    ON CONFLICT (company_id, role, module_key, action)
    DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
     WHERE role_permissions.updated_by IS NULL;
  END LOOP;
END $$;

COMMIT;

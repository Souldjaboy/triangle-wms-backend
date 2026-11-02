-- ═════════════════════════════════════════════════════════════════════════
--  162 — SIGNATURES ET CACHETS
--
--  UNE SIGNATURE N'EST PAS UN DOCUMENT COMME UN AUTRE.
--
--  Un contrat déposé à la bibliothèque peut être ouvert à toute la société.
--  Une signature, jamais : c'est la marque d'une personne, et quiconque
--  l'obtient peut signer à sa place. Elle a donc sa propre table, avec sa
--  propre règle d'accès — plus stricte que celle des documents, et qui ne
--  dépend d'aucun réglage de visibilité.
--
--  TROIS RÈGLES, TENUES PAR LA BASE.
--
--  1. UNE SIGNATURE APPARTIENT À UNE PERSONNE. Pas à son rôle, pas à la
--     société : à elle. La direction n'accède pas à la signature du
--     comptable. Le cahier des charges l'exige, et c'est la seule règle qui
--     rende la signature électronique crédible.
--
--  2. UN CACHET APPARTIENT À LA SOCIÉTÉ. C'est l'autre nature : le tampon de
--     Triangle n'est à personne en particulier, mais il ne doit jamais
--     traverser la frontière vers FAT & MAT. La contrainte l'écrit : une
--     signature a un propriétaire, un cachet n'en a pas.
--
--  3. CHAQUE APPOSITION LAISSE UNE TRACE. Qui a signé quoi, quand, avec
--     quelle signature, sur quelle page, et quelle version du document en
--     est sortie. Cette trace survit au document : si quelqu'un le supprime,
--     la ligne reste pour expliquer le vide. C'est elle qu'on relira le jour
--     où une signature est contestée.
--
--  ADDITIVE. Aucune table existante n'est modifiée.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS studio_signatures (
  id           BIGSERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL,
  /* NULL pour un cachet d'entreprise, obligatoire pour une signature. */
  owner_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  owner_name   TEXT    NOT NULL DEFAULT '',
  label        TEXT    NOT NULL DEFAULT '',

  /* L'image vit dans le même dépôt privé que les documents : hors du
     dossier servi en statique, sous une clé opaque. */
  storage_key  TEXT    NOT NULL UNIQUE,
  mime         TEXT    NOT NULL,
  size_bytes   BIGINT  NOT NULL,
  sha256       TEXT    NOT NULL,
  width_px     INTEGER,
  height_px    INTEGER,
  /* Le rapport largeur/hauteur, figé à l'enregistrement : il sert à proposer
     une taille d'apposition qui ne déforme pas le tracé. */
  ratio        NUMERIC(8,4),

  is_default   BOOLEAN NOT NULL DEFAULT FALSE,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  /* On ne supprime pas une signature : on la révoque. Les documents déjà
     signés avec elle restent signés, et la trace garde son sens. */
  revoked_at   TIMESTAMPTZ,
  revoked_by_name TEXT NOT NULL DEFAULT '',
  revoke_reason   TEXT NOT NULL DEFAULT '',

  CONSTRAINT studio_signatures_nature_chk CHECK (kind IN ('SIGNATURE','CACHET')),
  /* LA RÈGLE 1 ET LA RÈGLE 2, ÉCRITES DANS LA TABLE. Une signature sans
     propriétaire serait à tout le monde ; un cachet avec propriétaire serait
     une signature déguisée. Ni l'un ni l'autre n'est acceptable, et le
     vérifier dans le code seulement laisserait passer un import mal fait. */
  CONSTRAINT studio_signatures_appartenance_chk CHECK (
    (kind = 'SIGNATURE' AND owner_id IS NOT NULL) OR
    (kind = 'CACHET'    AND owner_id IS NULL)
  ),
  CONSTRAINT studio_signatures_revocation_chk CHECK (
    (revoked_at IS NULL) OR (revoke_reason <> '')
  )
);

/* Une seule signature par défaut par personne, un seul cachet par défaut par
   société. Partiel : les révoquées ne comptent pas, sinon on ne pourrait
   plus en désigner une nouvelle. */
CREATE UNIQUE INDEX IF NOT EXISTS studio_signatures_defaut_personne_uidx
  ON studio_signatures (company_id, owner_id)
  WHERE kind = 'SIGNATURE' AND is_default AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS studio_signatures_defaut_societe_uidx
  ON studio_signatures (company_id)
  WHERE kind = 'CACHET' AND is_default AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS studio_signatures_personne_idx
  ON studio_signatures (company_id, owner_id, kind)
  WHERE revoked_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- LA TRACE DES APPOSITIONS
--
-- Ce qu'on relira le jour où une signature est contestée. Elle ne disparaît
-- pas avec le document : les clés étrangères sont volontairement en
-- SET NULL, pas en CASCADE.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS studio_signature_uses (
  id            BIGSERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  signature_id  BIGINT  REFERENCES studio_signatures(id) ON DELETE SET NULL,
  /* Recopiés : si la signature est révoquée puis effacée, on doit encore
     pouvoir dire ce qui a été apposé. */
  signature_kind  TEXT NOT NULL DEFAULT '',
  signature_label TEXT NOT NULL DEFAULT '',
  signature_sha256 TEXT NOT NULL DEFAULT '',

  document_id   BIGINT  REFERENCES studio_documents(id) ON DELETE SET NULL,
  document_name TEXT    NOT NULL DEFAULT '',
  /* La version PRODUITE par l'apposition, et celle d'où l'on partait. */
  version_before INTEGER,
  version_after  INTEGER,

  page_number   INTEGER NOT NULL,
  /* La position, en points PDF, telle qu'elle a été appliquée. */
  pos_x         NUMERIC(10,2) NOT NULL,
  pos_y         NUMERIC(10,2) NOT NULL,
  width_pt      NUMERIC(10,2) NOT NULL,
  height_pt     NUMERIC(10,2) NOT NULL,

  /* L'empreinte du document AVANT et APRÈS : c'est ce qui permet de dire
     « voici exactement ce qui a été signé », sans dépendre du fichier. */
  sha256_before TEXT NOT NULL DEFAULT '',
  sha256_after  TEXT NOT NULL DEFAULT '',

  acted_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  acted_by_name TEXT    NOT NULL DEFAULT '',
  acted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip            TEXT    NOT NULL DEFAULT '',
  note          TEXT    NOT NULL DEFAULT '',

  CONSTRAINT studio_signature_uses_page_chk CHECK (page_number >= 1)
);

CREATE INDEX IF NOT EXISTS studio_signature_uses_document_idx
  ON studio_signature_uses (document_id, acted_at DESC);
CREATE INDEX IF NOT EXISTS studio_signature_uses_signature_idx
  ON studio_signature_uses (signature_id, acted_at DESC);
CREATE INDEX IF NOT EXISTS studio_signature_uses_societe_idx
  ON studio_signature_uses (company_id, acted_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- CE QU'UN DOCUMENT PORTE COMME SIGNATURES
--
-- Une vue plutôt qu'une colonne : le compte se déduit de la trace, et deux
-- endroits qui prétendent dire la même chose finissent toujours par
-- diverger.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_studio_documents_signes AS
SELECT d.id AS document_id, d.company_id, d.name,
       count(u.id)::int                                      AS appositions,
       count(DISTINCT u.signature_id)::int                    AS signatures_distinctes,
       min(u.acted_at)                                        AS premiere,
       max(u.acted_at)                                        AS derniere,
       array_agg(DISTINCT u.acted_by_name ORDER BY u.acted_by_name)
         FILTER (WHERE u.acted_by_name <> '')                 AS signataires
  FROM studio_documents d
  JOIN studio_signature_uses u ON u.document_id = d.id
 GROUP BY d.id, d.company_id, d.name;

COMMIT;

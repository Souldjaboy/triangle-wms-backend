-- ═════════════════════════════════════════════════════════════════════════
--  161 — LE SCANNER : DES PAGES QUI SURVIVENT AU TÉLÉPHONE
--
--  Scanner dix pages d'un contrat prend plusieurs minutes. Pendant ce
--  temps : un appel entre, l'écran se verrouille, le navigateur recharge
--  l'onglet pour récupérer de la mémoire, la batterie meurt. Si les pages
--  ne vivent que dans la page web, tout est à refaire — et la deuxième fois
--  on ne scanne plus, on photographie mal.
--
--  Chaque page est donc rangée DÈS SA CAPTURE, dans le même dépôt privé que
--  les documents de la bibliothèque, rattachée à une séance qu'on retrouve
--  et qu'on reprend.
--
--  DEUX CHOIX.
--
--  1. UNE PAGE N'EST PAS UN DOCUMENT. Tant que la séance n'est pas
--     assemblée, ces images ne sont pas dans la bibliothèque : elles ne se
--     cherchent pas, ne se partagent pas, et personne d'autre ne les voit.
--     C'est un brouillon, et un brouillon ne se diffuse pas.
--
--  2. L'ASSEMBLAGE PRODUIT UN DOCUMENT ORDINAIRE. Le PDF final entre dans
--     `studio_documents` comme n'importe quel dépôt, avec sa version 1
--     marquée « original » et son empreinte. Rien de particulier ne
--     distingue ensuite un scan d'un fichier reçu par courriel — sinon sa
--     nature, qui reste écrite.
--
--  ADDITIVE. Aucune table existante n'est modifiée.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- LA SÉANCE DE NUMÉRISATION
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS studio_scan_sessions (
  id           BIGSERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  owner_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  owner_name   TEXT    NOT NULL DEFAULT '',
  title        TEXT    NOT NULL DEFAULT '',
  /* Où le document ira, choisi avant de scanner : c'est au moment où l'on a
     le papier en main qu'on sait de quoi il s'agit. */
  folder_id    BIGINT  REFERENCES studio_folders(id) ON DELETE SET NULL,
  visibility   TEXT    NOT NULL DEFAULT 'PRIVE',
  /* Le format de sortie. « AUTO » suit l'orientation de chaque page : un
     bon de livraison à l'italienne ne doit pas être couché de force sur un
     A4 debout. */
  page_format  TEXT    NOT NULL DEFAULT 'AUTO',
  ocr_language TEXT    NOT NULL DEFAULT '',

  status       TEXT    NOT NULL DEFAULT 'EN_COURS',
  document_id  BIGINT  REFERENCES studio_documents(id) ON DELETE SET NULL,
  assembled_at TIMESTAMPTZ,
  abandoned_at TIMESTAMPTZ,
  abandon_reason TEXT  NOT NULL DEFAULT '',

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT studio_scan_sessions_statut_chk
    CHECK (status IN ('EN_COURS','ASSEMBLEE','ABANDONNEE')),
  CONSTRAINT studio_scan_sessions_visibilite_chk
    CHECK (visibility IN ('PRIVE','EQUIPE','SOCIETE')),
  CONSTRAINT studio_scan_sessions_format_chk
    CHECK (page_format IN ('AUTO','A4_PORTRAIT','A4_PAYSAGE')),
  /* Une séance assemblée A un document ; une séance en cours n'en a pas.
     Sans cette règle, un brouillon pourrait prétendre avoir produit un PDF
     qui n'existe pas, et l'écran de reprise proposerait de rouvrir un
     document introuvable. */
  CONSTRAINT studio_scan_sessions_coherence_chk CHECK (
    (status = 'ASSEMBLEE'  AND document_id IS NOT NULL AND assembled_at IS NOT NULL) OR
    (status = 'ABANDONNEE' AND abandoned_at IS NOT NULL) OR
    (status = 'EN_COURS'   AND document_id IS NULL AND assembled_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS studio_scan_sessions_reprise_idx
  ON studio_scan_sessions (company_id, owner_id, updated_at DESC)
  WHERE status = 'EN_COURS';

-- ─────────────────────────────────────────────────────────────────────────
-- LES PAGES
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS studio_scan_pages (
  id           BIGSERIAL PRIMARY KEY,
  session_id   BIGINT  NOT NULL REFERENCES studio_scan_sessions(id) ON DELETE CASCADE,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  /* Le rang, et non l'ordre d'arrivée : on insère une page oubliée au
     milieu sans tout recommencer. */
  position     INTEGER NOT NULL,
  storage_key  TEXT    NOT NULL UNIQUE,
  mime         TEXT    NOT NULL,
  size_bytes   BIGINT  NOT NULL,
  sha256       TEXT    NOT NULL,
  width_px     INTEGER,
  height_px    INTEGER,
  /* Les quatre coins retenus, en pixels de l'image d'origine. Conservés
     pour qu'on puisse dire comment la page a été redressée — et refaire le
     redressement autrement si le résultat déçoit. */
  corners      JSONB   NOT NULL DEFAULT '[]'::jsonb,
  /* Vrai si la perspective a été corrigée. Une page simplement photographiée
     et une page redressée ne se valent pas, et l'écran doit pouvoir le dire. */
  corrected    BOOLEAN NOT NULL DEFAULT FALSE,
  ocr_text     TEXT    NOT NULL DEFAULT '',
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT studio_scan_pages_rang_chk CHECK (position >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS studio_scan_pages_rang_uidx
  ON studio_scan_pages (session_id, position);
CREATE INDEX IF NOT EXISTS studio_scan_pages_session_idx
  ON studio_scan_pages (session_id, position);

-- ─────────────────────────────────────────────────────────────────────────
-- LA NATURE « SCAN » EXISTE DÉJÀ au catalogue des documents (migration 160) :
-- rien à ajouter. Les droits non plus : « studio.scanner » y est déclaré
-- avec visible, view et create.
--
-- On ajoute seulement de quoi dire, sur un document, DE QUELLE SÉANCE il
-- vient. Utile pour remonter aux pages d'origine quand le PDF assemblé
-- déçoit, plutôt que de tout rescanner.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE studio_documents
  ADD COLUMN IF NOT EXISTS scan_session_id BIGINT
    REFERENCES studio_scan_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS studio_documents_scan_idx
  ON studio_documents (scan_session_id) WHERE scan_session_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- CE QU'ON REPREND
--
-- Les séances en cours d'une personne, avec le compte de pages déjà prises.
-- C'est tout ce qu'il faut pour proposer « vous avez 7 pages en attente ».
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_studio_scans_a_reprendre AS
SELECT s.id, s.company_id, s.owner_id, s.owner_name, s.title,
       s.folder_id, s.visibility, s.page_format, s.created_at, s.updated_at,
       count(p.id)::int                      AS pages,
       coalesce(sum(p.size_bytes), 0)::bigint AS octets,
       count(p.id) FILTER (WHERE p.corrected)::int AS pages_redressees,
       max(p.captured_at)                    AS derniere_page
  FROM studio_scan_sessions s
  LEFT JOIN studio_scan_pages p ON p.session_id = s.id
 WHERE s.status = 'EN_COURS'
 GROUP BY s.id;

COMMIT;

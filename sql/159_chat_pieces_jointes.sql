-- ═════════════════════════════════════════════════════════════════════════
--  159 — LE CHAT : LES COLONNES QUI MANQUAIENT, ET L'ACCÈS AUX PIÈCES JOINTES
--
--  CE QUE L'AUDIT A TROUVÉ. `routes/chat-v2.js` lit et écrit neuf colonnes
--  qu'AUCUNE migration ne crée :
--
--      conversation_participants.role
--      conversations.description
--      messages.file_url, file_name, file_size, file_mime,
--               document_url, document_title, metadata
--
--  Sur une base reconstruite à partir des migrations, l'envoi d'un fichier
--  dans le chat échoue donc avant même d'atteindre la question du 404 :
--  « column file_url does not exist ». En production, ces colonnes ont dû
--  être ajoutées à la main, hors de Git — comme les tables RH de la V16.
--  Cette migration les inscrit enfin, de façon idempotente : si elles sont
--  déjà là, rien ne bouge.
--
--  CE QU'ELLE PRÉPARE AUSSI. Le téléchargement d'une pièce jointe n'était
--  soumis à aucun contrôle : `app.use("/uploads", express.static(...))` sert
--  le dossier à qui connaît un nom de fichier. L'index ci-dessous permet au
--  nouveau point d'accès authentifié de retrouver, pour un fichier donné, le
--  message et la conversation dont il dépend — et donc de vérifier que le
--  demandeur y participe.
--
--  ADDITIVE. Aucune donnée n'est réécrite.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE conversation_participants
  /* 'admin' pour qui a créé la conversation, 'member' pour les autres :
     ce sont les deux seules valeurs que le code écrit. Le défaut est
     'member', le moins puissant — une colonne ajoutée ne doit pas promouvoir
     tout le monde. */
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS file_url       TEXT,
  ADD COLUMN IF NOT EXISTS file_name      TEXT,
  ADD COLUMN IF NOT EXISTS file_size      BIGINT,
  ADD COLUMN IF NOT EXISTS file_mime      TEXT,
  ADD COLUMN IF NOT EXISTS document_url   TEXT,
  ADD COLUMN IF NOT EXISTS document_title TEXT,
  ADD COLUMN IF NOT EXISTS metadata       JSONB NOT NULL DEFAULT '{}'::jsonb;

/* Le créateur d'une conversation en est l'administrateur. On ne le devine
   que là où `conversations.created_by` le dit, et on ne touche pas aux
   lignes déjà réglées. */
UPDATE conversation_participants cp
   SET role = 'admin'
  FROM conversations c
 WHERE c.id = cp.conversation_id
   AND c.created_by = cp.user_id
   AND cp.role = 'member';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'conversation_participants_role_chk') THEN
    ALTER TABLE conversation_participants
      ADD CONSTRAINT conversation_participants_role_chk CHECK (role IN ('admin','member'));
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- RETROUVER UNE PIÈCE JOINTE À PARTIR DE SON NOM DE FICHIER
--
-- Le point d'accès authentifié reçoit un nom de fichier et doit répondre à
-- une question : « quel message porte ce fichier, et le demandeur
-- participe-t-il à sa conversation ? » Sans cet index, chaque téléchargement
-- parcourrait toute la table des messages.
--
-- L'index porte sur la FIN de l'URL, car `file_url` vaut « /uploads/chat/<nom> »
-- et c'est le nom seul qui circule dans l'adresse.
-- ─────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS messages_fichier_idx
  ON messages (company_id, file_url)
  WHERE file_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS messages_conversation_fichier_idx
  ON messages (conversation_id)
  WHERE file_url IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- LE JOURNAL DES ACCÈS AUX PIÈCES JOINTES
--
-- Qui a téléchargé quoi, et quand. Une pièce jointe de chat peut contenir un
-- bilan, une fiche de paie, un contrat : savoir qui l'a ouverte fait partie
-- du contrôle, pas du confort.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS chat_attachment_access (
  id            BIGSERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  message_id    INTEGER,
  conversation_id INTEGER,
  file_name     TEXT    NOT NULL,
  outcome       TEXT    NOT NULL,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name     TEXT    NOT NULL DEFAULT '',
  ip            TEXT    NOT NULL DEFAULT '',
  accessed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_attachment_access_outcome_chk') THEN
    ALTER TABLE chat_attachment_access ADD CONSTRAINT chat_attachment_access_outcome_chk
      CHECK (outcome IN ('SERVI','REFUSE_HORS_CONVERSATION','REFUSE_AUTRE_SOCIETE','INTROUVABLE'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS chat_attachment_access_societe_idx
  ON chat_attachment_access (company_id, accessed_at DESC);
CREATE INDEX IF NOT EXISTS chat_attachment_access_refus_idx
  ON chat_attachment_access (company_id, outcome, accessed_at DESC)
  WHERE outcome <> 'SERVI';

COMMIT;

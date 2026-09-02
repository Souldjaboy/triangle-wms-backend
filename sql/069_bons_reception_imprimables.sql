-- 069 — LE BON DE RÉCEPTION S'IMPRIME
--
-- Une réception se constate sur le quai, souvent des jours avant d'être
-- saisie. Le bon doit donc porter la date RÉELLE de l'arrivée, pas celle de
-- la frappe : c'est la première qui fait foi devant un transporteur ou un
-- douanier.
--
-- Les mêmes quatre dates que pour les documents de mouvement, avec le même
-- sens exactement :
--
--   created_at              quand la ligne est née dans la base, immuable ;
--   operation_effective_at  quand la marchandise est réellement arrivée ;
--   document_datetime       ce que le bon affiche ;
--   printed_at              quand on l'a imprimé pour la dernière fois.
--
-- Additive et idempotente. Aucune réception existante n'est modifiée dans son
-- sens : les colonnes nouvelles reprennent la date de réception déjà connue.

BEGIN;

ALTER TABLE stock_receptions
  ADD COLUMN IF NOT EXISTS operation_effective_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS document_datetime      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS printed_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS print_count            INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS document_revision      INTEGER NOT NULL DEFAULT 0;

/* Les réceptions déjà enregistrées prennent leur date de réception comme date
   métier : c'est la seule que le fichier ait jamais portée. `created_at`
   n'est pas touché — il dit quand la saisie a eu lieu, et c'est utile. */
/* `reception_date::timestamptz` interpréterait le jour dans le fuseau du
   SERVEUR : une réception du 22 juin devient le 21 à 22 h dès que la machine
   est à l'est de Bamako, et le bon imprime la veille. On convertit donc
   explicitement depuis Africa/Bamako, le fuseau du métier. */
UPDATE stock_receptions
   SET operation_effective_at = COALESCE(operation_effective_at,
                                         reception_date::timestamp AT TIME ZONE 'Africa/Bamako'),
       document_datetime      = COALESCE(document_datetime,
                                         reception_date::timestamp AT TIME ZONE 'Africa/Bamako')
 WHERE reception_date IS NOT NULL
   AND (operation_effective_at IS NULL OR document_datetime IS NULL);

/* Historique des corrections de date : l'ancienne valeur ne disparaît jamais.
   Après une première impression, corriger exige un motif — le bon est déjà
   parti quelque part, et il faut pouvoir expliquer l'écart. */
CREATE TABLE IF NOT EXISTS stock_reception_date_revisions (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL,
  reception_id   INTEGER NOT NULL REFERENCES stock_receptions(id) ON DELETE CASCADE,
  revision       INTEGER NOT NULL,
  field          TEXT    NOT NULL,
  old_value      TIMESTAMPTZ,
  new_value      TIMESTAMPTZ,
  reason         TEXT,
  after_print    BOOLEAN NOT NULL DEFAULT FALSE,
  changed_by     INTEGER,
  changed_by_name TEXT,
  changed_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stock_reception_date_revisions_idx
  ON stock_reception_date_revisions (company_id, reception_id, revision);

INSERT INTO permission_actions (action_key, label, description, sort_order, is_write) VALUES
  ('reprint',      'Réimprimer',            'Imprimer à nouveau un bon déjà sorti.', 178, true),
  ('edit_date_after_print', 'Corriger une date après impression',
   'Modifier la date métier d''un document déjà imprimé, avec motif obligatoire.', 180, true)
ON CONFLICT (action_key) DO NOTHING;

UPDATE permission_modules m
   SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                    FROM unnest(m.actions || ARRAY['print','reprint','edit_date_after_print','audit']) AS a),
       updated_at = now()
 WHERE m.module_key = 'reception'
   AND NOT (m.actions @> ARRAY['print','reprint','edit_date_after_print']);

COMMIT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'stock_receptions' AND column_name = 'document_datetime') THEN
    RAISE EXCEPTION 'Le bon de réception ne porte pas sa date métier : il afficherait la date de saisie.';
  END IF;
  RAISE NOTICE 'Bons de réception imprimables : schéma conforme.';
END $$;

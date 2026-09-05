-- 087 — DES NOTIFICATIONS QUI NE SE RÉPÈTENT PAS
--
-- `notifications` n'a aucune contrainte d'unicité. Chaque passage d'un
-- déclencheur — période à contrôler, paie soumise, échéance fiscale
-- approchant — recrée donc la même ligne. Au bout d'une semaine, la cloche
-- affiche quarante fois « la période de septembre est à contrôler », et
-- personne ne la regarde plus. Une notification répétée ne prévient pas
-- davantage : elle prévient moins.
--
-- On ajoute une clé d'événement : ce qui identifie l'ÉVÉNEMENT, pas le
-- message. « paie 12 soumise » n'a de sens qu'une fois, quel que soit le
-- nombre de fois où le code repasse dessus.
--
-- Additive : la colonne est nullable, et l'unicité ne porte que sur les
-- lignes qui en ont une. Les notifications existantes ne sont pas touchées.

BEGIN;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS event_key TEXT;

/* Index partiel : deux notifications sans clé restent permises — ce sont les
   messages libres, qui peuvent légitimement se répéter. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_event_key
  ON notifications (company_id, COALESCE(user_id, 0), event_key)
  WHERE event_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_destinataire
  ON notifications (company_id, user_id, is_read, created_at DESC);

COMMIT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_notifications_event_key') THEN
    RAISE EXCEPTION '087 : sans clé d''événement, la même alerte se répéterait à chaque passage.';
  END IF;
  RAISE NOTICE 'Notifications : clé d''événement posée, les alertes ne se dupliquent plus.';
END $$;

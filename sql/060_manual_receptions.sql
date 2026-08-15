-- 060 — Saisie manuelle des réceptions.
--
-- Toutes les réceptions ne viennent pas d'un fichier Excel. La saisie manuelle
-- alimente EXACTEMENT le même modèle : mêmes tables, même service, même bon de
-- réception. Seule la colonne `source` distingue MANUAL de EXCEL_IMPORT — la
-- provenance ne change jamais le workflow.
--
-- Cette migration n'ajoute que les champs d'en-tête que l'import Excel ne
-- fournissait pas (fournisseur, BL, transporteur) et la traçabilité des
-- corrections apportées avant la mise en stock.
--
-- Migration ADDITIVE et idempotente : aucune donnée existante n'est touchée,
-- aucune colonne n'est supprimée ni renommée.

BEGIN;

ALTER TABLE stock_receptions
  ADD COLUMN IF NOT EXISTS supplier_name      TEXT,
  ADD COLUMN IF NOT EXISTS supplier_reference TEXT,   -- BL / bordereau fournisseur
  ADD COLUMN IF NOT EXISTS carrier            TEXT,
  ADD COLUMN IF NOT EXISTS updated_by         INTEGER,
  ADD COLUMN IF NOT EXISTS cancelled_at       TIMESTAMP,
  ADD COLUMN IF NOT EXISTS cancelled_by       INTEGER,
  ADD COLUMN IF NOT EXISTS cancel_reason      TEXT;

/* Une correction de ligne avant rangement doit rester traçable : qui a changé
   quoi, et quand. Le CHECK de 058 continue d'interdire de ranger plus que reçu. */
ALTER TABLE stock_reception_lines
  ADD COLUMN IF NOT EXISTS updated_by INTEGER;

/* Les réceptions déjà enregistrées viennent toutes de l'import : on nomme leur
   provenance explicitement plutôt que de laisser un champ libre ambigu. */
UPDATE stock_receptions
   SET source = 'EXCEL_IMPORT'
 WHERE source IS NULL OR source = 'Import Excel';

COMMIT;

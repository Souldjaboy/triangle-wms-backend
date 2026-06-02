-- Triangle WMS Pro - Organisation paramètres POS
-- Ajoute les champs généraux manquants sans toucher aux clés paiement.

ALTER TABLE pos_settings ADD COLUMN IF NOT EXISTS decimal_count INTEGER DEFAULT 0;

UPDATE pos_settings
SET decimal_count=0
WHERE decimal_count IS NULL;

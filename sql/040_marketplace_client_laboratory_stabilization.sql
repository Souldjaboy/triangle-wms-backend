-- Triangle WMS Pro - Stabilisation Marketplace client + vérification
-- À exécuter après le déploiement backend.

ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP;

ALTER TABLE marketplace_carts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_marketplace_carts_status ON marketplace_carts(status);
CREATE INDEX IF NOT EXISTS idx_verification_codes_active_user
  ON verification_codes(user_id, target_type, target_value)
  WHERE used_at IS NULL;

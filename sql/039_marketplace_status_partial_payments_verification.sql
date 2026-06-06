-- Triangle WMS Pro - Marketplace statuts FR, paiements partiels, verification et champs metiers.
-- Migration additive uniquement. Ne supprime aucune donnee.

ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_status VARCHAR(80) DEFAULT 'pending';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS verification_status VARCHAR(80) DEFAULT 'pending';

ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(14,2) DEFAULT 0;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS amount_due NUMERIC(14,2) DEFAULT 0;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS reservation_start_date DATE;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS reservation_end_date DATE;
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS pickup_location TEXT DEFAULT '';
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS return_location TEXT DEFAULT '';
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS identity_document_url TEXT DEFAULT '';
ALTER TABLE marketplace_orders ADD COLUMN IF NOT EXISTS driving_license_url TEXT DEFAULT '';

ALTER TABLE marketplace_payments ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';
ALTER TABLE marketplace_payments ADD COLUMN IF NOT EXISTS created_by INTEGER;
ALTER TABLE marketplace_payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS boite_vitesse TEXT DEFAULT '';
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS nombre_places INTEGER DEFAULT 0;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS etat_vehicule TEXT DEFAULT '';
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS prix_location_semaine NUMERIC(14,2) DEFAULT 0;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS disponibilite VARCHAR(80) DEFAULT 'disponible';
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS is_sellable BOOLEAN DEFAULT true;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS is_rentable BOOLEAN DEFAULT false;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS publish_on_marketplace BOOLEAN DEFAULT false;

ALTER TABLE properties ADD COLUMN IF NOT EXISTS neighborhood TEXT DEFAULT '';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS beds_count INTEGER DEFAULT 0;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS guests_count INTEGER DEFAULT 0;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS price_night NUMERIC(14,2) DEFAULT 0;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS is_sellable BOOLEAN DEFAULT true;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS is_rentable BOOLEAN DEFAULT false;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS is_bookable BOOLEAN DEFAULT false;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS publish_on_marketplace BOOLEAN DEFAULT false;

ALTER TABLE restaurant_menu_items ADD COLUMN IF NOT EXISTS publish_on_marketplace BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_marketplace_orders_vendor_status
  ON marketplace_orders(vendor_company_id, status, payment_status);

CREATE INDEX IF NOT EXISTS idx_marketplace_payments_order_status
  ON marketplace_payments(order_id, status);

UPDATE users
SET verification_status='verified'
WHERE email_verified=true OR phone_verified=true OR account_status='active';

UPDATE companies
SET verification_status='verified'
WHERE email_verified=true OR phone_verified=true OR account_status='active';

UPDATE marketplace_orders
SET amount_paid = COALESCE(amount_paid, 0),
    amount_due = GREATEST(COALESCE(total_amount,0) - COALESCE(amount_paid,0), 0)
WHERE amount_due IS NULL OR amount_due = 0;

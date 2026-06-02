-- Triangle WMS Pro - Réparation POS caisses, ventes, reçus et paiements
-- Non destructif : aucune suppression de données.

CREATE TABLE IF NOT EXISTS caisses (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  nom_caisse VARCHAR(255) NOT NULL DEFAULT 'Caisse principale',
  code_caisse VARCHAR(120) DEFAULT '',
  statut VARCHAR(80) DEFAULT 'fermée',
  solde_initial NUMERIC(14,2) DEFAULT 0,
  solde_actuel NUMERIC(14,2) DEFAULT 0,
  opened_by INTEGER,
  opened_at TIMESTAMP,
  closed_by INTEGER,
  closed_at TIMESTAMP,
  actif BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE caisses ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE caisses ADD COLUMN IF NOT EXISTS nom_caisse VARCHAR(255) DEFAULT 'Caisse principale';
ALTER TABLE caisses ADD COLUMN IF NOT EXISTS code_caisse VARCHAR(120) DEFAULT '';
ALTER TABLE caisses ADD COLUMN IF NOT EXISTS statut VARCHAR(80) DEFAULT 'fermée';
ALTER TABLE caisses ADD COLUMN IF NOT EXISTS solde_initial NUMERIC(14,2) DEFAULT 0;
ALTER TABLE caisses ADD COLUMN IF NOT EXISTS solde_actuel NUMERIC(14,2) DEFAULT 0;
ALTER TABLE caisses ADD COLUMN IF NOT EXISTS opened_by INTEGER;
ALTER TABLE caisses ADD COLUMN IF NOT EXISTS opened_at TIMESTAMP;
ALTER TABLE caisses ADD COLUMN IF NOT EXISTS closed_by INTEGER;
ALTER TABLE caisses ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP;
ALTER TABLE caisses ADD COLUMN IF NOT EXISTS actif BOOLEAN DEFAULT true;
ALTER TABLE caisses ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE caisses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE users ADD COLUMN IF NOT EXISTS caisse_id INTEGER;

ALTER TABLE sales ADD COLUMN IF NOT EXISTS caisse_id INTEGER;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS nom_caisse VARCHAR(255) DEFAULT '';
ALTER TABLE sales ADD COLUMN IF NOT EXISTS cash_register_id INTEGER;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS client_id INTEGER;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS total_profit NUMERIC(14,2) DEFAULT 0;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(14,2) DEFAULT 0;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS remaining_amount NUMERIC(14,2) DEFAULT 0;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS amount_due NUMERIC(14,2) DEFAULT 0;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS change_due NUMERIC(14,2) DEFAULT 0;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(255) DEFAULT '';
ALTER TABLE sales ADD COLUMN IF NOT EXISTS provider VARCHAR(100) DEFAULT '';
ALTER TABLE sales ADD COLUMN IF NOT EXISTS transaction_id INTEGER;

ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS purchase_price NUMERIC(14,2) DEFAULT 0;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS sale_price NUMERIC(14,2) DEFAULT 0;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS profit NUMERIC(14,2) DEFAULT 0;

CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  sale_id INTEGER,
  provider VARCHAR(100),
  method VARCHAR(100),
  amount NUMERIC(14,2) DEFAULT 0,
  currency VARCHAR(10) DEFAULT 'FCFA',
  status VARCHAR(50) DEFAULT 'pending',
  phone_number VARCHAR(50),
  transaction_reference VARCHAR(255),
  provider_response TEXT,
  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE payments ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS sale_id INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS receipt_id INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS caisse_id INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider VARCHAR(100);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS method VARCHAR(100);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_method VARCHAR(100) DEFAULT '';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount NUMERIC(14,2) DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency VARCHAR(20) DEFAULT 'FCFA';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_status VARCHAR(80) DEFAULT 'pending';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS phone_number VARCHAR(50);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS transaction_reference VARCHAR(255);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(255) DEFAULT '';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS provider_response TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_by INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS caisse_id INTEGER;
ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS caisse_id INTEGER;

UPDATE sales
SET remaining_amount=COALESCE(NULLIF(remaining_amount,0), amount_due, 0)
WHERE remaining_amount IS NULL OR remaining_amount=0;

UPDATE sale_items
SET sale_price=COALESCE(NULLIF(sale_price,0), unit_price, 0),
    profit=COALESCE(NULLIF(profit,0), (COALESCE(unit_price,0) - COALESCE(purchase_price,0)) * COALESCE(quantity,0))
WHERE sale_price IS NULL OR sale_price=0 OR profit IS NULL;

UPDATE sales s
SET total_profit=COALESCE(items.profit_total,0)
FROM (
  SELECT sale_id, SUM(COALESCE(profit,0)) AS profit_total
  FROM sale_items
  GROUP BY sale_id
) items
WHERE s.id=items.sale_id;

CREATE INDEX IF NOT EXISTS idx_caisses_company_id ON caisses(company_id);
CREATE INDEX IF NOT EXISTS idx_caisses_code ON caisses(code_caisse);
CREATE INDEX IF NOT EXISTS idx_users_caisse_id ON users(caisse_id);
CREATE INDEX IF NOT EXISTS idx_sales_caisse_id ON sales(caisse_id);
CREATE INDEX IF NOT EXISTS idx_sales_cash_register_id ON sales(cash_register_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_profit ON sale_items(sale_id, profit);
CREATE INDEX IF NOT EXISTS idx_payments_sale_id ON payments(sale_id);
CREATE INDEX IF NOT EXISTS idx_payments_caisse_id ON payments(caisse_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_caisse_id ON payment_transactions(caisse_id);
CREATE INDEX IF NOT EXISTS idx_sale_payments_caisse_id ON sale_payments(caisse_id);

-- Triangle WMS Pro - Gestion professionnelle multi-caisses POS
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
ALTER TABLE sales ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(14,2) DEFAULT 0;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS amount_due NUMERIC(14,2) DEFAULT 0;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS change_due NUMERIC(14,2) DEFAULT 0;

ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS caisse_id INTEGER;
ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS caisse_id INTEGER;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS caisse_id INTEGER;

ALTER TABLE cash_registers ADD COLUMN IF NOT EXISTS nom_caisse VARCHAR(255);
ALTER TABLE cash_registers ADD COLUMN IF NOT EXISTS code_caisse VARCHAR(120) DEFAULT '';
ALTER TABLE cash_registers ADD COLUMN IF NOT EXISTS statut VARCHAR(80) DEFAULT 'fermée';
ALTER TABLE cash_registers ADD COLUMN IF NOT EXISTS solde_initial NUMERIC(14,2) DEFAULT 0;
ALTER TABLE cash_registers ADD COLUMN IF NOT EXISTS solde_actuel NUMERIC(14,2) DEFAULT 0;

UPDATE cash_registers
SET nom_caisse=COALESCE(nom_caisse, name, 'Caisse principale')
WHERE nom_caisse IS NULL OR nom_caisse='';

INSERT INTO caisses (company_id, nom_caisse, code_caisse, statut, solde_initial, solde_actuel)
SELECT DISTINCT
  company_id,
  COALESCE(nom_caisse, name, 'Caisse principale'),
  COALESCE(NULLIF(code_caisse,''), 'CAISSE-' || id),
  CASE
    WHEN lower(COALESCE(statut, status, 'fermée')) IN ('ouverte','open','active') THEN 'ouverte'
    ELSE 'fermée'
  END,
  COALESCE(solde_initial, 0),
  COALESCE(solde_actuel, 0)
FROM cash_registers
WHERE NOT EXISTS (
  SELECT 1 FROM caisses c
  WHERE c.company_id IS NOT DISTINCT FROM cash_registers.company_id
    AND lower(c.code_caisse)=lower(COALESCE(NULLIF(cash_registers.code_caisse,''), 'CAISSE-' || cash_registers.id))
);

CREATE INDEX IF NOT EXISTS idx_caisses_company_id ON caisses(company_id);
CREATE INDEX IF NOT EXISTS idx_caisses_code ON caisses(code_caisse);
CREATE INDEX IF NOT EXISTS idx_users_caisse_id ON users(caisse_id);
CREATE INDEX IF NOT EXISTS idx_sales_caisse_id ON sales(caisse_id);
CREATE INDEX IF NOT EXISTS idx_sales_cash_register_id ON sales(cash_register_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_caisse_id ON payment_transactions(caisse_id);
CREATE INDEX IF NOT EXISTS idx_sale_payments_caisse_id ON sale_payments(caisse_id);

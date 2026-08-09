BEGIN;

CREATE TABLE IF NOT EXISTS cement_products (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(180) NOT NULL,
    cement_type VARCHAR(50) NOT NULL,
    strength VARCHAR(50) NOT NULL,
    unit VARCHAR(30) NOT NULL DEFAULT 'tonne',
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIF',
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT cement_products_status_chk CHECK (status IN ('ACTIF','INACTIF')),
    UNIQUE(company_id, cement_type, strength)
);

CREATE TABLE IF NOT EXISTS cement_prices (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    cement_product_id BIGINT NOT NULL REFERENCES cement_products(id) ON DELETE CASCADE,
    destination VARCHAR(180) NOT NULL,
    cement_price NUMERIC(18,2) NOT NULL CHECK (cement_price >= 0),
    transport_price NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (transport_price >= 0),
    transport_mode VARCHAR(20) NOT NULL DEFAULT 'PAR_TONNE',
    effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
    effective_to DATE,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIF',
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT cement_prices_transport_mode_chk CHECK (transport_mode IN ('PAR_TONNE','FORFAIT')),
    CONSTRAINT cement_prices_status_chk CHECK (status IN ('ACTIF','INACTIF')),
    UNIQUE(company_id, cement_product_id, destination, effective_from)
);

CREATE TABLE IF NOT EXISTS cement_price_history (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    cement_price_id BIGINT NOT NULL REFERENCES cement_prices(id) ON DELETE CASCADE,
    old_cement_price NUMERIC(18,2),
    new_cement_price NUMERIC(18,2),
    old_transport_price NUMERIC(18,2),
    new_transport_price NUMERIC(18,2),
    old_transport_mode VARCHAR(20),
    new_transport_mode VARCHAR(20),
    changed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    changed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cement_customers (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    customer_code VARCHAR(50),
    name VARCHAR(220) NOT NULL,
    phone VARCHAR(100),
    email VARCHAR(180),
    address TEXT,
    nif VARCHAR(120),
    rccm VARCHAR(120),
    contact_name VARCHAR(180),
    payment_terms_days INTEGER NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIF',
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT cement_customers_status_chk CHECK (status IN ('ACTIF','INACTIF')),
    UNIQUE(company_id, customer_code)
);

CREATE TABLE IF NOT EXISTS cement_counters (
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    counter_key VARCHAR(100) NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY(company_id, counter_key)
);

CREATE TABLE IF NOT EXISTS cement_sales (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    sale_number VARCHAR(60) NOT NULL,
    customer_id BIGINT REFERENCES cement_customers(id) ON DELETE SET NULL,
    customer_name VARCHAR(220) NOT NULL,
    customer_phone VARCHAR(100),
    customer_address TEXT,
    customer_nif VARCHAR(120),
    customer_rccm VARCHAR(120),
    destination VARCHAR(180),
    loading_place VARCHAR(180),
    delivery_place VARCHAR(180),
    cement_product_id BIGINT REFERENCES cement_products(id) ON DELETE SET NULL,
    cement_type VARCHAR(50),
    strength VARCHAR(50),
    tonnage NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (tonnage >= 0),
    unit_price NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
    transport_price NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (transport_price >= 0),
    transport_mode VARCHAR(20) NOT NULL DEFAULT 'PAR_TONNE',
    cement_subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
    transport_total NUMERIC(18,2) NOT NULL DEFAULT 0,
    discount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
    tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
    total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    paid_amount NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
    remaining_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    payment_method VARCHAR(80),
    tonnage_voucher_number VARCHAR(120),
    tonnage_voucher_url TEXT,
    truck VARCHAR(120),
    driver_name VARCHAR(180),
    status VARCHAR(40) NOT NULL DEFAULT 'BROUILLON',
    sale_date DATE NOT NULL DEFAULT CURRENT_DATE,
    notes TEXT,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    validated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    validated_at TIMESTAMP,
    cancelled_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    cancelled_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT cement_sales_transport_mode_chk CHECK (transport_mode IN ('PAR_TONNE','FORFAIT')),
    CONSTRAINT cement_sales_status_chk CHECK (
        status IN ('BROUILLON','VALIDEE','LIVRAISON_PARTIELLE','LIVREE','FACTUREE','PARTIELLEMENT_PAYEE','PAYEE','ANNULEE')
    ),
    UNIQUE(company_id, sale_number)
);

CREATE TABLE IF NOT EXISTS cement_sale_lines (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    sale_id BIGINT NOT NULL REFERENCES cement_sales(id) ON DELETE CASCADE,
    line_type VARCHAR(40) NOT NULL DEFAULT 'CIMENT',
    description VARCHAR(300) NOT NULL,
    quantity NUMERIC(18,3) NOT NULL DEFAULT 1 CHECK (quantity >= 0),
    unit VARCHAR(40) NOT NULL DEFAULT 'tonne',
    unit_price NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
    line_total NUMERIC(18,2) NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cement_deliveries (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    sale_id BIGINT NOT NULL REFERENCES cement_sales(id) ON DELETE CASCADE,
    delivery_number VARCHAR(60) NOT NULL,
    tonnage_delivered NUMERIC(18,3) NOT NULL CHECK (tonnage_delivered > 0),
    delivery_date DATE NOT NULL DEFAULT CURRENT_DATE,
    destination VARCHAR(180),
    truck VARCHAR(120),
    driver_name VARCHAR(180),
    tonnage_voucher_number VARCHAR(120),
    tonnage_voucher_url TEXT,
    received_by_name VARCHAR(180),
    delivered_by_name VARCHAR(180),
    notes TEXT,
    status VARCHAR(30) NOT NULL DEFAULT 'VALIDEE',
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    validated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    validated_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(company_id, delivery_number)
);

CREATE TABLE IF NOT EXISTS cement_invoices (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    sale_id BIGINT REFERENCES cement_sales(id) ON DELETE SET NULL,
    customer_id BIGINT REFERENCES cement_customers(id) ON DELETE SET NULL,
    invoice_number VARCHAR(60) NOT NULL,
    operation_reference VARCHAR(60),
    invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE,
    destination VARCHAR(180),
    total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    paid_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    remaining_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    status VARCHAR(30) NOT NULL DEFAULT 'IMPAYEE',
    notes TEXT,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    validated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    validated_at TIMESTAMP,
    cancelled_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    cancelled_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT cement_invoice_status_chk CHECK (
        status IN ('BROUILLON','IMPAYEE','PARTIELLEMENT_PAYEE','PAYEE','ANNULEE')
    ),
    UNIQUE(company_id, invoice_number)
);

CREATE TABLE IF NOT EXISTS cement_invoice_lines (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    invoice_id BIGINT NOT NULL REFERENCES cement_invoices(id) ON DELETE CASCADE,
    description VARCHAR(300) NOT NULL,
    quantity NUMERIC(18,3) NOT NULL DEFAULT 1 CHECK (quantity >= 0),
    unit VARCHAR(40) NOT NULL DEFAULT 'unité',
    unit_price NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
    line_total NUMERIC(18,2) NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cement_payments (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    invoice_id BIGINT NOT NULL REFERENCES cement_invoices(id) ON DELETE CASCADE,
    payment_number VARCHAR(60) NOT NULL,
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),
    payment_method VARCHAR(80),
    reference VARCHAR(160),
    notes TEXT,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(company_id, payment_number)
);

CREATE TABLE IF NOT EXISTS cement_proformas (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    customer_id BIGINT REFERENCES cement_customers(id) ON DELETE SET NULL,
    proforma_number VARCHAR(60) NOT NULL,
    proforma_date DATE NOT NULL DEFAULT CURRENT_DATE,
    valid_until DATE,
    customer_name VARCHAR(220) NOT NULL,
    customer_phone VARCHAR(100),
    customer_address TEXT,
    destination VARCHAR(180),
    subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
    discount NUMERIC(18,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
    status VARCHAR(30) NOT NULL DEFAULT 'BROUILLON',
    notes TEXT,
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    validated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    validated_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT cement_proforma_status_chk CHECK (status IN ('BROUILLON','VALIDEE','ACCEPTEE','REFUSEE','ANNULEE')),
    UNIQUE(company_id, proforma_number)
);

CREATE TABLE IF NOT EXISTS cement_proforma_lines (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    proforma_id BIGINT NOT NULL REFERENCES cement_proformas(id) ON DELETE CASCADE,
    line_type VARCHAR(40) NOT NULL DEFAULT 'AUTRE',
    description VARCHAR(300) NOT NULL,
    quantity NUMERIC(18,3) NOT NULL DEFAULT 1 CHECK (quantity >= 0),
    unit VARCHAR(40) NOT NULL DEFAULT 'unité',
    unit_price NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
    line_total NUMERIC(18,2) NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cement_attachments (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    entity_type VARCHAR(40) NOT NULL,
    entity_id BIGINT NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_url TEXT NOT NULL,
    mime_type VARCHAR(120),
    uploaded_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cement_audit_logs (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(80) NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id BIGINT,
    reference VARCHAR(100),
    old_value JSONB,
    new_value JSONB,
    ip_address VARCHAR(80),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cement_print_logs (
    id BIGSERIAL PRIMARY KEY,
    company_id BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    document_type VARCHAR(50) NOT NULL,
    document_id BIGINT,
    reference VARCHAR(100),
    customer_id BIGINT REFERENCES cement_customers(id) ON DELETE SET NULL,
    printed_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    printed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cement_products_company ON cement_products(company_id, status);
CREATE INDEX IF NOT EXISTS idx_cement_prices_company_destination ON cement_prices(company_id, destination, status);
CREATE INDEX IF NOT EXISTS idx_cement_customers_company_name ON cement_customers(company_id, name);
CREATE INDEX IF NOT EXISTS idx_cement_customers_company_phone ON cement_customers(company_id, phone);
CREATE INDEX IF NOT EXISTS idx_cement_sales_company_date ON cement_sales(company_id, sale_date DESC);
CREATE INDEX IF NOT EXISTS idx_cement_sales_company_customer ON cement_sales(company_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_cement_sales_company_status ON cement_sales(company_id, status);
CREATE INDEX IF NOT EXISTS idx_cement_invoices_company_status ON cement_invoices(company_id, status);
CREATE INDEX IF NOT EXISTS idx_cement_invoices_company_customer ON cement_invoices(company_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_cement_invoices_company_remaining
    ON cement_invoices(company_id, remaining_amount)
    WHERE remaining_amount > 0 AND status <> 'ANNULEE';
CREATE INDEX IF NOT EXISTS idx_cement_payments_invoice ON cement_payments(company_id, invoice_id, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_cement_proformas_company_date ON cement_proformas(company_id, proforma_date DESC);

INSERT INTO cement_products (
    company_id, name, cement_type, strength, unit, status
)
SELECT
    1, 'Ciment CPJ 32,5 R', 'CPJ', '32,5 R', 'tonne', 'ACTIF'
WHERE EXISTS (SELECT 1 FROM companies WHERE id = 1)
ON CONFLICT (company_id, cement_type, strength) DO NOTHING;

WITH cpj AS (
    SELECT id
    FROM cement_products
    WHERE company_id = 1
      AND cement_type = 'CPJ'
      AND strength = '32,5 R'
    LIMIT 1
)
INSERT INTO cement_prices (
    company_id, cement_product_id, destination, cement_price, transport_price, transport_mode, status
)
SELECT
    1, cpj.id, t.destination, t.cement_price, t.transport_price, 'PAR_TONNE', 'ACTIF'
FROM cpj
CROSS JOIN (
    VALUES
        ('Bamako',      120000::numeric,      0::numeric),
        ('Sévaré',      180000::numeric,      0::numeric),
        ('Koutiala',    150000::numeric,  15000::numeric),
        ('Bougouni',    135000::numeric,  10000::numeric),
        ('Dioïla',      135500::numeric,  10000::numeric),
        ('Kankanba',    135500::numeric,      0::numeric),
        ('Masala',      135500::numeric,      0::numeric),
        ('Sanankoroba', 135500::numeric,      0::numeric)
) AS t(destination, cement_price, transport_price)
ON CONFLICT (company_id, cement_product_id, destination, effective_from)
DO NOTHING;

COMMIT;

BEGIN;

-- ============================================================
-- FAT & MAT - VENTE DE SABLE
-- Module indépendant du stock et du ciment
-- ============================================================

CREATE TABLE IF NOT EXISTS sand_products (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    unit VARCHAR(50) NOT NULL DEFAULT 'm3',
    status VARCHAR(30) NOT NULL DEFAULT 'ACTIF',
    created_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sand_prices (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    sand_product_id INTEGER NOT NULL REFERENCES sand_products(id) ON DELETE CASCADE,
    destination VARCHAR(255) NOT NULL,
    quantity_reference NUMERIC(12,3) NOT NULL DEFAULT 10,
    price NUMERIC(16,2) NOT NULL DEFAULT 0,
    transport_price NUMERIC(16,2) NOT NULL DEFAULT 0,
    status VARCHAR(30) NOT NULL DEFAULT 'ACTIF',
    created_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sand_customers (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    customer_code VARCHAR(100),
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(100),
    email VARCHAR(255),
    address TEXT,
    nif VARCHAR(120),
    rccm VARCHAR(120),
    status VARCHAR(30) NOT NULL DEFAULT 'ACTIF',
    created_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sand_counters (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    counter_key VARCHAR(100) NOT NULL,
    counter_date DATE NOT NULL DEFAULT CURRENT_DATE,
    current_value INTEGER NOT NULL DEFAULT 0,
    UNIQUE(company_id, counter_key, counter_date)
);

CREATE TABLE IF NOT EXISTS sand_sales (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    sale_number VARCHAR(100) NOT NULL,
    customer_id INTEGER REFERENCES sand_customers(id) ON DELETE SET NULL,
    customer_name VARCHAR(255),
    customer_phone VARCHAR(100),
    customer_address TEXT,
    sand_product_id INTEGER REFERENCES sand_products(id) ON DELETE SET NULL,
    product_name VARCHAR(255),
    destination VARCHAR(255),
    delivery_place VARCHAR(255),

    quantity_m3 NUMERIC(12,3) NOT NULL DEFAULT 0,
    unit_price NUMERIC(16,2) NOT NULL DEFAULT 0,
    sand_subtotal NUMERIC(16,2) NOT NULL DEFAULT 0,

    transport_price NUMERIC(16,2) NOT NULL DEFAULT 0,
    transport_total NUMERIC(16,2) NOT NULL DEFAULT 0,

    discount NUMERIC(16,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(16,2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(16,2) NOT NULL DEFAULT 0,
    paid_amount NUMERIC(16,2) NOT NULL DEFAULT 0,
    remaining_amount NUMERIC(16,2) NOT NULL DEFAULT 0,

    truck VARCHAR(150),
    driver_name VARCHAR(255),
    voucher_number VARCHAR(150),
    notes TEXT,

    status VARCHAR(50) NOT NULL DEFAULT 'BROUILLON',
    sale_date DATE NOT NULL DEFAULT CURRENT_DATE,

    created_by INTEGER,
    validated_by INTEGER,
    validated_at TIMESTAMP,
    cancelled_by INTEGER,
    cancelled_at TIMESTAMP,

    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(company_id, sale_number)
);

CREATE TABLE IF NOT EXISTS sand_deliveries (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    sale_id INTEGER NOT NULL REFERENCES sand_sales(id) ON DELETE CASCADE,
    delivery_number VARCHAR(100) NOT NULL,
    delivery_date DATE NOT NULL DEFAULT CURRENT_DATE,
    destination VARCHAR(255),
    quantity_m3 NUMERIC(12,3) NOT NULL DEFAULT 0,
    truck VARCHAR(150),
    driver_name VARCHAR(255),
    voucher_number VARCHAR(150),
    received_by VARCHAR(255),
    delivered_by VARCHAR(255),
    notes TEXT,
    created_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, delivery_number)
);

CREATE TABLE IF NOT EXISTS sand_invoices (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    sale_id INTEGER NOT NULL REFERENCES sand_sales(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES sand_customers(id) ON DELETE SET NULL,
    invoice_number VARCHAR(100) NOT NULL,
    operation_reference VARCHAR(100),
    invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE,
    destination VARCHAR(255),
    total_amount NUMERIC(16,2) NOT NULL DEFAULT 0,
    paid_amount NUMERIC(16,2) NOT NULL DEFAULT 0,
    remaining_amount NUMERIC(16,2) NOT NULL DEFAULT 0,
    status VARCHAR(50) NOT NULL DEFAULT 'IMPAYEE',
    notes TEXT,
    created_by INTEGER,
    validated_by INTEGER,
    validated_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, invoice_number)
);

CREATE TABLE IF NOT EXISTS sand_payments (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    invoice_id INTEGER NOT NULL REFERENCES sand_invoices(id) ON DELETE CASCADE,
    payment_number VARCHAR(100) NOT NULL,
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    amount NUMERIC(16,2) NOT NULL,
    payment_method VARCHAR(100),
    reference VARCHAR(150),
    notes TEXT,
    created_by INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sand_proformas (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES sand_customers(id) ON DELETE SET NULL,
    proforma_number VARCHAR(100) NOT NULL,
    proforma_date DATE NOT NULL DEFAULT CURRENT_DATE,
    valid_until DATE,
    customer_name VARCHAR(255),
    customer_phone VARCHAR(100),
    customer_address TEXT,
    destination VARCHAR(255),
    subtotal NUMERIC(16,2) NOT NULL DEFAULT 0,
    discount NUMERIC(16,2) NOT NULL DEFAULT 0,
    tax_amount NUMERIC(16,2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(16,2) NOT NULL DEFAULT 0,
    status VARCHAR(50) NOT NULL DEFAULT 'BROUILLON',
    notes TEXT,
    created_by INTEGER,
    validated_by INTEGER,
    validated_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(company_id, proforma_number)
);

CREATE TABLE IF NOT EXISTS sand_proforma_lines (
    id SERIAL PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    proforma_id INTEGER NOT NULL REFERENCES sand_proformas(id) ON DELETE CASCADE,
    line_type VARCHAR(100) NOT NULL DEFAULT 'SABLE',
    description VARCHAR(255) NOT NULL,
    quantity NUMERIC(12,3) NOT NULL DEFAULT 1,
    unit VARCHAR(50) NOT NULL DEFAULT 'm3',
    unit_price NUMERIC(16,2) NOT NULL DEFAULT 0,
    line_total NUMERIC(16,2) NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_sand_sales_company
ON sand_sales(company_id);

CREATE INDEX IF NOT EXISTS idx_sand_sales_customer
ON sand_sales(company_id, customer_id);

CREATE INDEX IF NOT EXISTS idx_sand_invoices_remaining
ON sand_invoices(company_id, remaining_amount);

CREATE INDEX IF NOT EXISTS idx_sand_prices_destination
ON sand_prices(company_id, destination);

-- ============================================================
-- MODULE FAT & MAT
-- ============================================================

INSERT INTO company_modules
(company_id, module_key, is_enabled, updated_by)
VALUES
(5, 'sand', TRUE, 1)
ON CONFLICT (company_id, module_key)
DO UPDATE SET
    is_enabled=TRUE,
    updated_by=1,
    updated_at=CURRENT_TIMESTAMP;

-- Super Admin : tous les droits
INSERT INTO user_permissions
(user_id,module_key,can_view,can_create,can_edit,can_delete,can_validate,updated_by)
VALUES
(1,'sand',TRUE,TRUE,TRUE,TRUE,TRUE,1)
ON CONFLICT (user_id,module_key)
DO UPDATE SET
    can_view=TRUE,
    can_create=TRUE,
    can_edit=TRUE,
    can_delete=TRUE,
    can_validate=TRUE,
    updated_by=1,
    updated_at=CURRENT_TIMESTAMP;

-- ============================================================
-- PRODUIT INITIAL FAT & MAT
-- ============================================================

INSERT INTO sand_products
(company_id,name,unit,status,created_by)
SELECT
    5,
    'Sable',
    'm3',
    'ACTIF',
    1
WHERE NOT EXISTS (
    SELECT 1
    FROM sand_products
    WHERE company_id=5
      AND LOWER(name)='sable'
);

-- ============================================================
-- TARIF INITIAL
-- 10 m3 = 170 000 FCFA
-- soit 17 000 FCFA / m3
-- ============================================================

INSERT INTO sand_prices (
    company_id,
    sand_product_id,
    destination,
    quantity_reference,
    price,
    transport_price,
    status,
    created_by
)
SELECT
    5,
    sp.id,
    'Bamako',
    10,
    170000,
    0,
    'ACTIF',
    1
FROM sand_products sp
WHERE sp.company_id=5
  AND LOWER(sp.name)='sable'
  AND NOT EXISTS (
      SELECT 1
      FROM sand_prices p
      WHERE p.company_id=5
        AND p.sand_product_id=sp.id
        AND LOWER(p.destination)='bamako'
  );

COMMIT;

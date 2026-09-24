CREATE TABLE IF NOT EXISTS pos_commercial_documents (
  id SERIAL PRIMARY KEY,
  company_id INTEGER,
  document_type VARCHAR(30) NOT NULL DEFAULT 'proforma',
  document_number VARCHAR(80) UNIQUE NOT NULL,
  customer_name VARCHAR(255) DEFAULT '',
  customer_phone VARCHAR(80) DEFAULT '',
  customer_email VARCHAR(255) DEFAULT '',
  customer_address TEXT DEFAULT '',
  subtotal NUMERIC(14,2) DEFAULT 0,
  discount_amount NUMERIC(14,2) DEFAULT 0,
  tax_amount NUMERIC(14,2) DEFAULT 0,
  total_amount NUMERIC(14,2) DEFAULT 0,
  status VARCHAR(50) DEFAULT 'brouillon',
  source_document_id INTEGER,
  sale_id INTEGER,
  notes TEXT DEFAULT '',
  created_by INTEGER,
  created_by_name VARCHAR(255) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pos_commercial_document_items (
  id SERIAL PRIMARY KEY,
  document_id INTEGER REFERENCES pos_commercial_documents(id) ON DELETE CASCADE,
  company_id INTEGER,
  product_id INTEGER,
  product_reference VARCHAR(255),
  product_name VARCHAR(255),
  quantity NUMERIC(14,2) DEFAULT 0,
  unit_price NUMERIC(14,2) DEFAULT 0,
  discount_amount NUMERIC(14,2) DEFAULT 0,
  tax_rate NUMERIC(8,2) DEFAULT 0,
  total_price NUMERIC(14,2) DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pos_docs_company_type ON pos_commercial_documents(company_id, document_type);
CREATE INDEX IF NOT EXISTS idx_pos_docs_source ON pos_commercial_documents(source_document_id);
CREATE INDEX IF NOT EXISTS idx_pos_doc_items_doc ON pos_commercial_document_items(document_id);

CREATE TABLE IF NOT EXISTS pos_document_settings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER UNIQUE,
  company_name VARCHAR(255) DEFAULT 'Triangle Logistics Transport & Intérim SARL',
  logo_url TEXT DEFAULT '/brands/triangle-official.jpeg',
  phone VARCHAR(100) DEFAULT '70044404',
  email VARCHAR(255) DEFAULT 'info@triangle.com',
  address TEXT DEFAULT 'Bamako, Mali',
  nif VARCHAR(100) DEFAULT '081137831N',
  nina VARCHAR(100) DEFAULT '4200919889109C',
  rccm VARCHAR(150) DEFAULT 'MA-BKA.2020.b-12488',
  bank_1 TEXT DEFAULT 'Orabank ML17',
  bank_2 TEXT DEFAULT 'BDM-SA 020401496674-56',
  footer_text TEXT DEFAULT 'Merci pour votre confiance.',
  proforma_formula TEXT DEFAULT 'Arrêtée la présente proforma à la somme de :',
  invoice_formula TEXT DEFAULT 'Arrêtée la présente facture à la somme de :',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

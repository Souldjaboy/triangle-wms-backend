BEGIN;

CREATE TABLE IF NOT EXISTS document_number_counters (
  company_key INTEGER NOT NULL DEFAULT 0,
  prefix VARCHAR(10) NOT NULL,
  document_date DATE NOT NULL,
  last_value INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (company_key, prefix, document_date)
);

CREATE OR REPLACE FUNCTION next_short_document_number(
  p_company_id INTEGER,
  p_prefix TEXT,
  p_document_date DATE DEFAULT CURRENT_DATE
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_company_key INTEGER := COALESCE(p_company_id, 0);
  v_prefix TEXT := UPPER(TRIM(COALESCE(p_prefix, 'DOC')));
  v_date DATE := COALESCE(p_document_date, CURRENT_DATE);
  v_next INTEGER;
BEGIN
  INSERT INTO document_number_counters (
    company_key,
    prefix,
    document_date,
    last_value,
    updated_at
  )
  VALUES (
    v_company_key,
    v_prefix,
    v_date,
    1,
    CURRENT_TIMESTAMP
  )
  ON CONFLICT (company_key, prefix, document_date)
  DO UPDATE SET
    last_value = document_number_counters.last_value + 1,
    updated_at = CURRENT_TIMESTAMP
  RETURNING last_value INTO v_next;

  RETURN v_prefix
    || '-'
    || TO_CHAR(v_date, 'YYMMDD')
    || '-'
    || LPAD(v_next::TEXT, 3, '0');
END;
$$;

CREATE OR REPLACE FUNCTION assign_short_document_number()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_prefix TEXT;
  v_date DATE;
BEGIN
  v_prefix := CASE LOWER(TRIM(COALESCE(NEW.document_type, '')))
    WHEN 'bon de réception' THEN 'BR'
    WHEN 'bon de reception' THEN 'BR'
    WHEN 'bon de sortie' THEN 'BS'
    WHEN 'bon de livraison' THEN 'BL'
    WHEN 'bon de transfert' THEN 'BT'
    WHEN 'fiche inventaire' THEN 'INV'
    WHEN 'bon d''inventaire' THEN 'INV'
    WHEN 'bon de décaissement' THEN 'BD'
    WHEN 'bon de decaissement' THEN 'BD'
    WHEN 'demande de décaissement' THEN 'DD'
    WHEN 'demande de decaissement' THEN 'DD'
    ELSE NULL
  END;

  IF v_prefix IS NULL THEN
    RETURN NEW;
  END IF;

  v_date := COALESCE(NEW.created_at::DATE, CURRENT_DATE);

  NEW.document_number :=
    next_short_document_number(
      NEW.company_id,
      v_prefix,
      v_date
    );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_documents_short_number
ON documents;

CREATE TRIGGER trg_documents_short_number
BEFORE INSERT ON documents
FOR EACH ROW
EXECUTE FUNCTION assign_short_document_number();

CREATE UNIQUE INDEX IF NOT EXISTS uq_documents_short_number
ON documents (
  COALESCE(company_id, 0),
  document_number
)
WHERE document_number ~
'^[A-Z]{2,4}-[0-9]{6}-[0-9]{3,}$';

COMMIT;

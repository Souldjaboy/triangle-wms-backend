-- 091 — Numéro de demande unique PAR SOCIÉTÉ
--
-- Le compteur des demandes est déjà séparé par company_id.
-- L'ancienne contrainte UNIQUE(request_number) était donc incompatible
-- avec le fonctionnement multi-sociétés :
--
-- Triangle : DD-260907-001
-- FAT & MAT: DD-260907-001
--
-- Les deux références sont valides car elles appartiennent à des sociétés
-- différentes.
--
-- Cette migration ne modifie aucune demande existante.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.disbursement_requests') IS NULL THEN
    RAISE EXCEPTION 'Table disbursement_requests absente';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM disbursement_requests
    WHERE company_id IS NOT NULL
      AND request_number IS NOT NULL
    GROUP BY company_id, request_number
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Doublons de request_number déjà présents dans une même société';
  END IF;
END
$$;

-- Ancienne unicité globale créée par :
-- request_number TEXT UNIQUE
ALTER TABLE disbursement_requests
  DROP CONSTRAINT IF EXISTS disbursement_requests_request_number_key;

-- Nouvelle règle correcte :
-- un numéro ne peut apparaître qu'une fois DANS une société.
CREATE UNIQUE INDEX IF NOT EXISTS
  disbursement_requests_company_request_number_uidx
ON disbursement_requests (company_id, request_number)
WHERE company_id IS NOT NULL
  AND request_number IS NOT NULL;

COMMIT;

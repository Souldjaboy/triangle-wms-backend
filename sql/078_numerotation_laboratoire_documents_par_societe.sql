-- 078 — NUMÉROS LABORATOIRE ET DOCUMENTS UNIQUES PAR SOCIÉTÉ
--
-- Deux incohérences de numérotation multi-sociétés restent après 077 :
--
-- 1) laboratory_cases.case_number est généré par nextAccountingNumber()
--    avec un compteur scoppé par company_id, mais porte depuis 035 une
--    contrainte UNIQUE GLOBALE. Deux sociétés peuvent donc générer le même
--    texte et la seconde insertion échoue.
--
-- 2) documents.document_number est lui aussi généré par un compteur par
--    société, mais ne porte AUCUNE contrainte d'unicité : un doublon interne
--    à une société pourrait donc être accepté silencieusement.
--
-- IMPORTANT : laboratory_cases.result_code reste volontairement UNIQUE
-- GLOBALEMENT. Il est généré aléatoirement et utilisé par la vérification
-- publique des résultats sans filtre de société ; l'élargir à
-- (company_id, result_code) créerait une ambiguïté inter-sociétés et une
-- régression de sécurité.
--
-- Migration additive et idempotente. Si des doublons existent déjà pour la
-- future clé (company_id, numéro), elle avertit avec détail et n'ajoute pas
-- la contrainte concernée. Aucun doublon existant n'est supprimé ni modifié.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────
-- laboratory_cases.case_number : global -> par société
-- ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  doublons INTEGER;
  d RECORD;
BEGIN
  SELECT count(*) INTO doublons
  FROM (
    SELECT company_id, case_number
      FROM laboratory_cases
     WHERE case_number IS NOT NULL
     GROUP BY company_id, case_number
    HAVING count(*) > 1
  ) x;

  IF doublons > 0 THEN
    RAISE WARNING 'laboratory_cases : % doublon(s) de (company_id, case_number) trouvé(s) — contrainte non resserrée.', doublons;
    FOR d IN
      SELECT company_id, case_number, count(*) AS occurrences
        FROM laboratory_cases
       WHERE case_number IS NOT NULL
       GROUP BY company_id, case_number
      HAVING count(*) > 1
       ORDER BY company_id NULLS FIRST, case_number
    LOOP
      RAISE WARNING 'laboratory_cases doublon : company_id=%, case_number=%, occurrences=%',
        d.company_id, d.case_number, d.occurrences;
    END LOOP;
  ELSE
    ALTER TABLE laboratory_cases
      DROP CONSTRAINT IF EXISTS laboratory_cases_case_number_key;

    IF NOT EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conrelid = 'laboratory_cases'::regclass
         AND conname = 'laboratory_cases_company_case_number_key'
         AND contype = 'u'
    ) THEN
      ALTER TABLE laboratory_cases
        ADD CONSTRAINT laboratory_cases_company_case_number_key
        UNIQUE (company_id, case_number);
    END IF;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────
-- documents.document_number : aucune protection -> unique par société
-- ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  doublons INTEGER;
  d RECORD;
BEGIN
  SELECT count(*) INTO doublons
  FROM (
    SELECT company_id, document_number
      FROM documents
     WHERE document_number IS NOT NULL
     GROUP BY company_id, document_number
    HAVING count(*) > 1
  ) x;

  IF doublons > 0 THEN
    RAISE WARNING 'documents : % doublon(s) de (company_id, document_number) trouvé(s) — contrainte non ajoutée.', doublons;
    FOR d IN
      SELECT company_id, document_number, count(*) AS occurrences
        FROM documents
       WHERE document_number IS NOT NULL
       GROUP BY company_id, document_number
      HAVING count(*) > 1
       ORDER BY company_id NULLS FIRST, document_number
    LOOP
      RAISE WARNING 'documents doublon : company_id=%, document_number=%, occurrences=%',
        d.company_id, d.document_number, d.occurrences;
    END LOOP;
  ELSE
    IF NOT EXISTS (
      SELECT 1
        FROM pg_constraint
       WHERE conrelid = 'documents'::regclass
         AND conname = 'documents_company_document_number_key'
         AND contype = 'u'
    ) THEN
      ALTER TABLE documents
        ADD CONSTRAINT documents_company_document_number_key
        UNIQUE (company_id, document_number);
    END IF;
  END IF;
END $$;

COMMIT;

-- ────────────────────────────────────────────────────────────────────────
-- CONTRÔLE INFORMATIF
-- ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  case_ok BOOLEAN;
  result_code_global_ok BOOLEAN;
  document_ok BOOLEAN;
BEGIN
  case_ok := EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'laboratory_cases'::regclass
       AND conname = 'laboratory_cases_company_case_number_key'
       AND contype = 'u'
  );

  result_code_global_ok := EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'laboratory_cases'::regclass
       AND conname = 'laboratory_cases_result_code_key'
       AND contype = 'u'
  );

  document_ok := EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'documents'::regclass
       AND conname = 'documents_company_document_number_key'
       AND contype = 'u'
  );

  RAISE NOTICE '078 case_number par société : %', CASE WHEN case_ok THEN 'OK' ELSE 'NON POSÉE' END;
  RAISE NOTICE '078 result_code reste global : %', CASE WHEN result_code_global_ok THEN 'OK' ELSE 'ATTENTION' END;
  RAISE NOTICE '078 document_number par société : %', CASE WHEN document_ok THEN 'OK' ELSE 'NON POSÉE' END;
END $$;

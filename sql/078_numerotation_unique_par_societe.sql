-- 078 — L'UNICITÉ DES NUMÉROS SUIT LE COMPTEUR QUI LES PRODUIT
--
-- Suite directe de 077. En auditant les appelants de `nextAccountingNumber()`
-- — qui compte PAR SOCIÉTÉ mais produit un texte qui ne contient jamais le
-- `company_id` — deux autres colonnes se sont révélées mal protégées.
--
--   1. `laboratory_cases.case_number` porte une contrainte unique GLOBALE
--      (`laboratory_cases_case_number_key`). Le numéro vient pourtant de
--      `nextAccountingNumber(client,'laboratory_cases','case_number','LABD',companyId)`
--      (server.js). Deux sociétés atteignant la même séquence la même année
--      produisent le même texte, et le second INSERT échoue sur une violation
--      de clé brute — pas sur une erreur métier lisible. Même défaut, même
--      correctif que 077 : l'unicité passe à (company_id, case_number).
--
--   2. `documents.document_number` n'a AUCUNE contrainte d'unicité, ni
--      globale ni par société. Le défaut est inverse et plus sournois : rien
--      n'échoue, deux documents peuvent porter le même numéro en silence,
--      y compris dans une même société. On pose donc la contrainte qui
--      manque, à la maille qui correspond aux compteurs qui l'alimentent
--      (`nextShortDocumentNumber` et `nextAccountingNumber` préfixe REC-LAB,
--      tous deux scopés par société).
--
-- ═════════════════════════════════════════════════════════════════════════
-- CE QUI N'EST VOLONTAIREMENT PAS TOUCHÉ : laboratory_cases.result_code
--
-- La demande initiale rangeait `result_code` avec `case_number`, comme deux
-- cas du même défaut. La lecture du code montre que ce n'en est pas un :
--
--   • `result_code` n'est PAS produit par `nextAccountingNumber`. Il vient de
--     `generateLaboratoryResultCode()` (server.js) : `LAB-<année>-<6 car.
--     aléatoires>`. Aucun compteur par société n'est en jeu, donc aucune
--     collision mécanique à réparer.
--
--   • Surtout, la route PUBLIQUE et NON AUTHENTIFIÉE
--     `POST /laboratory/public/results/verify` interroge la table sur le seul
--     `result_code`, sans `company_id` — c'est sa raison d'être : un patient
--     saisit son code sans savoir à quelle société le laboratoire appartient.
--     Resserrer l'unicité à (company_id, result_code) autoriserait deux
--     sociétés à tirer le même code aléatoire ; la recherche publique
--     renverrait alors le dossier d'une autre société. On transformerait une
--     contrainte protectrice en fuite de données inter-sociétés.
--
-- L'unicité GLOBALE de `result_code` est donc correcte et reste en place.
-- Cette omission est délibérée, pas un oubli.
-- ═════════════════════════════════════════════════════════════════════════
--
-- Additive, idempotente, rejouable. Aucune donnée n'est modifiée ni
-- supprimée : seule la règle d'unicité change. Le format des numéros ne
-- change pas, aucun affichage ni rapport existant n'est affecté.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. laboratory_cases.case_number — de globale à par société
--
-- Sous l'ancienne contrainte globale un doublon est structurellement
-- impossible ; on le vérifie quand même plutôt que de le supposer.
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE doublons INTEGER;
BEGIN
  SELECT count(*) INTO doublons FROM (
    SELECT company_id, case_number
      FROM laboratory_cases
     WHERE case_number IS NOT NULL
     GROUP BY 1, 2 HAVING count(*) > 1
  ) d;

  IF doublons > 0 THEN
    RAISE WARNING 'laboratory_cases : % doublon(s) de (company_id, case_number) — contrainte non resserrée. Corrigez-les puis rejouez 078.', doublons;
  ELSE
    ALTER TABLE laboratory_cases
      DROP CONSTRAINT IF EXISTS laboratory_cases_case_number_key;

    /* Vérification explicite plutôt qu'un bloc EXCEPTION : une contrainte
       UNIQUE crée un index du même nom, et sa réutilisation lève
       `duplicate_table` (42P07), pas `duplicate_object` (42710) — le piège
       rencontré en mettant au point 077. */
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'laboratory_cases_company_case_number_key') THEN
      ALTER TABLE laboratory_cases
        ADD CONSTRAINT laboratory_cases_company_case_number_key
        UNIQUE (company_id, case_number);
    END IF;
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. documents.document_number — la contrainte qui n'a jamais existé
--
-- Ici l'inverse : rien n'a jamais empêché les doublons, il peut donc y en
-- avoir. Si c'est le cas on n'impose rien et on liste les numéros fautifs :
-- choisir lequel renuméroter est une décision métier, pas une décision de
-- migration. Les documents validés ou imprimés ne se réécrivent pas tout
-- seuls.
--
-- Les numéros NULL restent permis : PostgreSQL ne les compare pas entre eux,
-- et de vieux documents importés n'en portent pas.
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  doublons INTEGER;
  details  TEXT;
BEGIN
  SELECT count(*), string_agg(format('société %s / %s (%s fois)', company_id, document_number, n), ', ')
    INTO doublons, details
    FROM (
      SELECT company_id, document_number, count(*) AS n
        FROM documents
       WHERE document_number IS NOT NULL
       GROUP BY 1, 2 HAVING count(*) > 1
       ORDER BY 1, 2
       LIMIT 20
    ) d;

  IF COALESCE(doublons, 0) > 0 THEN
    RAISE WARNING 'documents : % numéro(s) en doublon — contrainte non posée. Détail : %. Renumérotez côté métier puis rejouez 078.', doublons, details;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'documents_company_document_number_key') THEN
      ALTER TABLE documents
        ADD CONSTRAINT documents_company_document_number_key
        UNIQUE (company_id, document_number);
    END IF;
  END IF;
END $$;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLE
--
-- N'échoue jamais sur l'absence d'une contrainte : « des doublons existaient,
-- on a donc laissé la table tranquille » est le comportement voulu, pas une
-- migration cassée (même philosophie que 073 / 074 / 075 / 077).
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE labo BOOLEAN; docs BOOLEAN;
BEGIN
  labo := EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'laboratory_cases_company_case_number_key');
  docs := EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_company_document_number_key');

  IF labo THEN RAISE NOTICE 'laboratory_cases.case_number : unicité par société posée.';
          ELSE RAISE NOTICE 'laboratory_cases.case_number : contrainte non resserrée — voir l''avertissement ci-dessus.';
  END IF;

  IF docs THEN RAISE NOTICE 'documents.document_number : unicité par société posée (elle n''existait pas du tout).';
          ELSE RAISE NOTICE 'documents.document_number : contrainte non posée — des doublons existent, voir l''avertissement ci-dessus.';
  END IF;

  RAISE NOTICE 'laboratory_cases.result_code : unicité GLOBALE conservée volontairement (recherche publique sans société).';
END $$;

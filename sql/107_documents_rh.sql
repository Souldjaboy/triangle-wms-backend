-- ═════════════════════════════════════════════════════════════════════════
-- 107 — DOCUMENTS DE RESSOURCES HUMAINES
--
-- Contrats CDI et CDD, bulletins de salaire, attestations, certificats et
-- diplômes. Quatre principes gouvernent cette migration.
--
-- 1. AUCUN TAUX DE COTISATION N'EST ÉCRIT ICI.
--    Les cotisations maliennes — ITS, INPS, AMO, CFE, CGS, TFP, TEJ — ont
--    déjà leur catalogue (`tax_types`) et leur table de taux (`tax_rules`),
--    vide au départ et dotée d'une référence de texte officiel et d'un
--    statut de vérification. Le bulletin LIT ces taux ; il n'en invente
--    aucun. Sans taux validé, il affiche « non paramétré » et refuse de
--    calculer plutôt que de produire un chiffre faux d'allure crédible.
--
-- 2. AUCUNE DISPOSITION LÉGALE N'EST INVENTÉE.
--    Les clauses de contrat sont des données, pas du code. Chacune porte sa
--    référence au Code du travail malien quand elle en a une, et un drapeau
--    `requires_legal_validation` tant qu'un juriste ne l'a pas relue. Une
--    clause non validée s'imprime avec une mention visible.
--
-- 3. AUCUNE SANCTION NI RETENUE AUTOMATIQUE.
--    Rien dans ce schéma ne permet à un document de déclencher une retenue
--    sur salaire ou une sanction. Un contrat décrit des obligations ; il ne
--    les applique pas.
--
-- 4. LE SALAIRE EST UNE DONNÉE CONFIDENTIELLE.
--    Un module de permission distinct (`rh.document`) sépare « éditer une
--    attestation de travail » de « voir une rémunération ».
--
-- Idempotente. Additive. Aucune donnée existante n'est modifiée.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- LES CONTRATS
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_contracts (
  id              BIGSERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL,
  employee_id     INTEGER NOT NULL,
  reference       TEXT    NOT NULL,
  contract_type   TEXT    NOT NULL,
  job_title       TEXT    NOT NULL,
  site_label      TEXT,
  start_date      DATE    NOT NULL,
  /* Un CDD a une fin, un CDI n'en a pas : la contrainte le dit plutôt que
     de laisser un CDI traîner une date de fin oubliée. */
  end_date        DATE,
  trial_period_days INTEGER,
  weekly_hours    NUMERIC(5,2),
  gross_salary    NUMERIC(18,2),
  salary_currency TEXT NOT NULL DEFAULT 'FCFA',
  /* Le motif de recours au CDD : le droit malien l'exige, et aucun motif par
     défaut n'est proposé — c'est à l'employeur de le dire. */
  cdd_reason      TEXT,
  status          TEXT NOT NULL DEFAULT 'BROUILLON',
  signed_at       DATE,
  signed_place    TEXT,
  ended_at        DATE,
  end_reason      TEXT,
  notes           TEXT,
  created_by      INTEGER,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT hr_contracts_type_connu CHECK (contract_type IN ('CDI','CDD','STAGE','APPRENTISSAGE')),
  CONSTRAINT hr_contracts_statut_connu CHECK (status IN ('BROUILLON','ACTIF','SUSPENDU','TERMINE','ANNULE')),
  /* Un CDD sans date de fin n'est pas un CDD ; un CDI avec une date de fin
     n'est pas un CDI. La base refuse les deux. */
  CONSTRAINT hr_contracts_duree_coherente CHECK (
    (contract_type = 'CDI'  AND end_date IS NULL)
    OR (contract_type <> 'CDI' AND end_date IS NOT NULL AND end_date > start_date)
  ),
  /* Le recours au CDD doit être motivé : c'est une exigence du Code du
     travail, pas une préférence d'interface. */
  CONSTRAINT hr_contracts_cdd_motive CHECK (
    contract_type <> 'CDD' OR BTRIM(COALESCE(cdd_reason,'')) <> ''
  ),
  CONSTRAINT hr_contracts_salaire CHECK (gross_salary IS NULL OR gross_salary > 0),
  CONSTRAINT hr_contracts_essai CHECK (trial_period_days IS NULL OR trial_period_days >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS hr_contracts_ref_uidx
  ON hr_contracts (company_id, reference);
CREATE INDEX IF NOT EXISTS hr_contracts_salarie_idx
  ON hr_contracts (company_id, employee_id, start_date DESC);
/* Un salarié n'a qu'un contrat ACTIF à la fois : deux contrats actifs
   voudraient dire deux salaires, et personne ne saurait lequel payer. */
CREATE UNIQUE INDEX IF NOT EXISTS hr_contracts_un_actif_uidx
  ON hr_contracts (company_id, employee_id) WHERE status = 'ACTIF';

-- ─────────────────────────────────────────────────────────────────────────
-- LES CLAUSES — DES DONNÉES, PAS DU CODE
--
-- Le logiciel n'écrit aucune disposition légale en dur. Chaque clause porte
-- son texte, sa référence officielle quand elle en a une, et reste marquée
-- « à faire valider » tant qu'un juriste ne l'a pas relue.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_contract_clauses (
  id              BIGSERIAL PRIMARY KEY,
  company_id      INTEGER,
  clause_key      TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  applies_to      TEXT[]  NOT NULL DEFAULT ARRAY['CDI','CDD'],
  sort_order      INTEGER NOT NULL DEFAULT 100,
  legal_reference TEXT,
  requires_legal_validation BOOLEAN NOT NULL DEFAULT TRUE,
  validated_by    INTEGER,
  validated_at    TIMESTAMPTZ,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hr_contract_clauses_texte CHECK (BTRIM(body) <> ''),
  /* Une clause déclarée validée porte qui l'a validée et quand. */
  CONSTRAINT hr_contract_clauses_validation CHECK (
    requires_legal_validation = TRUE
    OR (validated_by IS NOT NULL AND validated_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS hr_contract_clauses_cle_uidx
  ON hr_contract_clauses (COALESCE(company_id, 0), clause_key);

-- ─────────────────────────────────────────────────────────────────────────
-- LE REGISTRE DES DOCUMENTS ÉMIS
--
-- Chaque pièce remise porte une référence unique. Réimprimer n'émet pas un
-- second document : on retrouve celui qui a été remis, avec ce qu'il disait
-- au moment où il a été remis.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hr_documents (
  id              BIGSERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL,
  employee_id     INTEGER,
  contract_id     BIGINT REFERENCES hr_contracts(id) ON DELETE SET NULL,
  doc_type        TEXT    NOT NULL,
  reference       TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  period_code     TEXT,
  issued_on       DATE    NOT NULL DEFAULT CURRENT_DATE,
  /* Ce que le document DISAIT quand il a été émis. Recalculer à la
     réimpression donnerait un autre chiffre si un paramètre a changé
     depuis — et deux exemplaires d'une même attestation divergeraient. */
  payload         JSONB   NOT NULL DEFAULT '{}'::jsonb,
  /* L'empreinte du PDF remis : deux exemplaires d'une même référence
     doivent être le même octet. */
  pdf_sha256      TEXT,
  issued_by       INTEGER,
  issued_by_name  TEXT NOT NULL DEFAULT '',
  cancelled_at    TIMESTAMPTZ,
  cancelled_by    INTEGER,
  cancel_reason   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hr_documents_type_connu CHECK (doc_type IN (
    'CONTRAT','BULLETIN','ATTESTATION_TRAVAIL','CERTIFICAT_TRAVAIL',
    'ATTESTATION_STAGE','ATTESTATION_FORMATION','DIPLOME'
  )),
  CONSTRAINT hr_documents_annulation CHECK (
    cancelled_at IS NULL OR BTRIM(COALESCE(cancel_reason,'')) <> ''
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS hr_documents_ref_uidx
  ON hr_documents (company_id, reference);
CREATE INDEX IF NOT EXISTS hr_documents_salarie_idx
  ON hr_documents (company_id, employee_id, issued_on DESC);
CREATE INDEX IF NOT EXISTS hr_documents_type_idx
  ON hr_documents (company_id, doc_type, issued_on DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- LES CLAUSES LIVRÉES
--
-- Elles décrivent des OBLIGATIONS, jamais des sanctions ni des retenues.
-- Toutes arrivent « à faire valider » : le logiciel ne se prononce pas sur
-- la conformité d'un texte juridique.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO hr_contract_clauses
  (company_id, clause_key, title, body, applies_to, sort_order, legal_reference, requires_legal_validation)
VALUES
  (NULL, 'OBJET', 'Objet du contrat',
   'Le présent contrat a pour objet de définir les conditions dans lesquelles le salarié exerce les fonctions qui lui sont confiées au sein de l''entreprise.',
   ARRAY['CDI','CDD'], 10, NULL, TRUE),
  (NULL, 'PERIODE_ESSAI', 'Période d''essai',
   'Le contrat devient définitif à l''issue de la période d''essai mentionnée aux conditions particulières. Durant cette période, chacune des parties peut y mettre fin dans les conditions prévues par la réglementation applicable.',
   ARRAY['CDI','CDD'], 20, 'Code du travail du Mali — à préciser par le conseil', TRUE),
  (NULL, 'FONCTIONS', 'Fonctions et lieu de travail',
   'Le salarié exerce les fonctions indiquées aux conditions particulières, sur le site qui y est mentionné. Toute évolution des fonctions ou du lieu de travail fait l''objet d''un avenant écrit.',
   ARRAY['CDI','CDD'], 30, NULL, TRUE),
  (NULL, 'HORAIRES', 'Durée du travail',
   'La durée hebdomadaire de travail est celle indiquée aux conditions particulières, dans le respect de la durée légale applicable.',
   ARRAY['CDI','CDD'], 40, 'Code du travail du Mali — à préciser par le conseil', TRUE),
  (NULL, 'REMUNERATION', 'Rémunération',
   'Le salarié perçoit la rémunération brute indiquée aux conditions particulières, payable selon la périodicité en vigueur dans l''entreprise. Les cotisations et retenues légales sont appliquées conformément à la réglementation.',
   ARRAY['CDI','CDD'], 50, NULL, TRUE),
  (NULL, 'OBLIGATIONS', 'Obligations du salarié',
   'Le salarié exécute son travail avec soin et diligence, respecte les instructions qui lui sont données et les règles d''hygiène et de sécurité en vigueur sur le site.',
   ARRAY['CDI','CDD'], 60, NULL, TRUE),
  (NULL, 'MATERIEL', 'Matériel et marchandises confiés',
   'Le matériel, l''outillage et les marchandises confiés au salarié restent la propriété de l''entreprise. Le salarié en prend soin et les restitue à la fin du contrat.',
   ARRAY['CDI','CDD'], 70, NULL, TRUE),
  (NULL, 'SECURITE', 'Hygiène et sécurité',
   'Le salarié respecte les consignes de sécurité, porte les équipements de protection mis à sa disposition et signale sans délai toute situation dangereuse.',
   ARRAY['CDI','CDD'], 80, NULL, TRUE),
  (NULL, 'INFORMATIQUE', 'Accès aux systèmes d''information',
   'Les accès informatiques sont strictement personnels. Le salarié ne communique pas ses identifiants et n''utilise les systèmes que dans le cadre de ses fonctions.',
   ARRAY['CDI','CDD'], 90, NULL, TRUE),
  (NULL, 'CONFIDENTIALITE', 'Confidentialité',
   'Le salarié observe la discrétion la plus stricte sur les informations dont il a connaissance dans l''exercice de ses fonctions, pendant la durée du contrat et après son terme.',
   ARRAY['CDI','CDD'], 100, NULL, TRUE),
  (NULL, 'CONGES', 'Congés',
   'Le salarié bénéficie des congés payés dans les conditions prévues par la réglementation applicable et les usages de l''entreprise.',
   ARRAY['CDI','CDD'], 110, 'Code du travail du Mali — à préciser par le conseil', TRUE),
  (NULL, 'RUPTURE_CDI', 'Rupture du contrat',
   'Le contrat peut prendre fin dans les conditions et selon les procédures prévues par la réglementation applicable. Chaque partie respecte le préavis en vigueur.',
   ARRAY['CDI'], 120, 'Code du travail du Mali — à préciser par le conseil', TRUE),
  (NULL, 'TERME_CDD', 'Terme du contrat',
   'Le contrat prend fin de plein droit au terme indiqué aux conditions particulières, sans qu''il soit nécessaire de le dénoncer. Son renouvellement éventuel fait l''objet d''un avenant écrit.',
   ARRAY['CDD'], 120, 'Code du travail du Mali — à préciser par le conseil', TRUE),
  (NULL, 'REGLEMENT_INTERIEUR', 'Règlement intérieur',
   'Le salarié déclare avoir pris connaissance du règlement intérieur de l''entreprise, lorsqu''il existe et lui a été communiqué.',
   ARRAY['CDI','CDD'], 130, NULL, TRUE)
ON CONFLICT (COALESCE(company_id, 0), clause_key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- QUI PEUT ÉDITER QUOI
--
-- Une attestation de travail ne révèle aucun salaire ; un bulletin et un
-- contrat, si. Les deux droits sont donc séparés.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO permission_actions (action_key, label, description, sort_order, is_write) VALUES
  ('voir_remuneration', 'Voir les rémunérations',
   'Accéder aux montants de salaire d''un document ou d''un contrat.', 175, FALSE)
ON CONFLICT (action_key) DO UPDATE
  SET label = EXCLUDED.label, description = EXCLUDED.description;

INSERT INTO permission_modules
  (module_key, parent_key, label, description, sort_order, is_active, is_system, actions) VALUES
  ('rh.document', 'rh', 'Documents du personnel',
   'Contrats, bulletins, attestations, certificats et diplômes.',
   520, TRUE, FALSE,
   ARRAY['visible','view','create','update','delete','print','export','voir_remuneration'])
ON CONFLICT (module_key) DO UPDATE
  SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(permission_modules.actions || EXCLUDED.actions) AS a),
      label = EXCLUDED.label, description = EXCLUDED.description, updated_at = now();

DO $$
DECLARE soc RECORD;
BEGIN
  FOR soc IN SELECT id FROM companies LOOP
    INSERT INTO role_permissions (company_id, role, module_key, action, allowed) VALUES
      (soc.id, 'direction', 'rh.document', 'visible',           true),
      (soc.id, 'direction', 'rh.document', 'view',              true),
      (soc.id, 'direction', 'rh.document', 'create',            true),
      (soc.id, 'direction', 'rh.document', 'update',            true),
      (soc.id, 'direction', 'rh.document', 'delete',            true),
      (soc.id, 'direction', 'rh.document', 'print',             true),
      (soc.id, 'direction', 'rh.document', 'voir_remuneration', true),
      /* Le comptable établit les bulletins : il voit les rémunérations. */
      (soc.id, 'comptable', 'rh.document', 'visible',           true),
      (soc.id, 'comptable', 'rh.document', 'view',              true),
      (soc.id, 'comptable', 'rh.document', 'create',            true),
      (soc.id, 'comptable', 'rh.document', 'print',             true),
      (soc.id, 'comptable', 'rh.document', 'voir_remuneration', true),
      (soc.id, 'comptable', 'rh.document', 'delete',            false)
    ON CONFLICT (company_id, role, module_key, action)
    DO UPDATE SET allowed = EXCLUDED.allowed, updated_at = now()
     WHERE role_permissions.updated_by IS NULL;
  END LOOP;
END $$;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE clauses INTEGER; taux INTEGER; aValider INTEGER;
BEGIN
  SELECT count(*) INTO clauses FROM hr_contract_clauses WHERE is_active;
  SELECT count(*) INTO aValider FROM hr_contract_clauses
   WHERE is_active AND requires_legal_validation;
  SELECT count(*) INTO taux FROM tax_rules
   WHERE verification_status = 'VERIFIE' OR verification_status = 'verified';

  RAISE NOTICE '107 : % clause(s) de contrat livrées, dont % à faire valider par un juriste.',
    clauses, aValider;
  /* Le point le plus important de cette migration : aucun taux n'est actif,
     et le bulletin le dira plutôt que d'inventer un chiffre. */
  IF taux = 0 THEN
    RAISE NOTICE '107 : AUCUN taux de cotisation vérifié. Les bulletins afficheront « non paramétré » et ne calculeront aucune retenue tant qu''un taux n''aura pas été saisi avec sa référence officielle.';
  ELSE
    RAISE NOTICE '107 : % taux de cotisation vérifié(s) disponible(s) pour les bulletins.', taux;
  END IF;
  RAISE NOTICE 'Documents RH en place. Aucun salaire modifié, aucune sanction automatisée.';
END $$;

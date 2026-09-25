-- ═════════════════════════════════════════════════════════════════════════
-- 100 — JOURS FÉRIÉS, JOURS CHÔMÉS, JOURNÉES EXCEPTIONNELLES
--
-- LE PROBLÈME
--
-- Le moteur ne connaissait qu'une seule idée de journée spéciale :
-- `attendance_holidays`, une date et un libellé. Un jour férié y était
-- simplement « non dû » — ni attendu, ni absent. C'était juste, mais muet :
-- rien ne disait si la journée était payée, si le pointage restait exigé, qui
-- l'avait décidée, ni ce qu'il advenait de celui qui avait quand même
-- travaillé. Toute journée administrativement chômée qui n'était pas dans
-- cette table devenait donc une absence injustifiée — et une retenue.
--
-- CE QUE CETTE MIGRATION N'INTERPRÈTE PAS
--
-- Elle ne décide nulle part ce qu'« un jour chômé » signifie en droit malien.
-- Une journée chômée peut être payée ou non, exiger un pointage ou non,
-- concerner l'entreprise entière ou le seul bureau de Sotuba ACI. Le moteur
-- lit ces faits ; il ne les devine pas. C'est pour cela que le traitement est
-- décomposé en champs distincts (`est_chome`, `est_paye`, `pointage_requis`,
-- `impact_absence`, `impact_salaire`) plutôt que déduit d'un type : deux
-- entreprises, ou deux décisions, peuvent traiter le même type autrement.
--
-- CE QUI EST CONSERVÉ
--
-- `attendance_holidays` n'est pas supprimée. Ses lignes sont RECOPIÉES dans le
-- nouveau calendrier comme jours fériés chômés et payés — ce qu'elles
-- signifiaient déjà — et le moteur continue de l'honorer. Aucun férié existant
-- ne change de comportement, et les scripts qui écrivent encore dedans
-- continuent de fonctionner.
--
-- Additive et idempotente.
-- ═════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────
-- 1. LE CATALOGUE DES TYPES — extensible par données, pas par déploiement
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance_special_day_types (
  type_key    TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  /* Ce que l'écran PROPOSE quand on choisit ce type. Des valeurs par défaut,
     jamais une contrainte : l'administration reste libre de les changer pour
     une journée donnée, parce que c'est la décision qui fait la règle. */
  defaut_est_chome        BOOLEAN NOT NULL DEFAULT TRUE,
  defaut_est_paye         BOOLEAN NOT NULL DEFAULT TRUE,
  defaut_pointage_requis  BOOLEAN NOT NULL DEFAULT FALSE,
  defaut_impact_absence   TEXT NOT NULL DEFAULT 'AUCUNE',
  defaut_impact_salaire   TEXT NOT NULL DEFAULT 'MAINTENU',
  /* Un motif est-il exigé ? Un 1er mai n'a rien à justifier ; une fermeture
     décidée un mardi matin, si. */
  motif_obligatoire       BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO attendance_special_day_types
  (type_key, label, description, defaut_est_chome, defaut_est_paye,
   defaut_pointage_requis, defaut_impact_absence, defaut_impact_salaire,
   motif_obligatoire, sort_order, is_system) VALUES
  ('JOUR_FERIE', 'Jour férié',
   'Jour férié légal ou coutumier. Chômé et payé sauf décision contraire.',
   TRUE, TRUE, FALSE, 'AUCUNE', 'MAINTENU', FALSE, 10, TRUE),
  ('JOUR_CHOME_EXCEPTIONNEL', 'Jour chômé exceptionnel',
   'Journée déclarée exceptionnellement chômée par l''autorité compétente.',
   TRUE, TRUE, FALSE, 'AUCUNE', 'MAINTENU', TRUE, 20, TRUE),
  ('JOUR_CHOME_DIRECTION', 'Jour chômé — décision de la Direction',
   'Journée chômée décidée par la Direction de l''entreprise.',
   TRUE, TRUE, FALSE, 'AUCUNE', 'MAINTENU', TRUE, 30, TRUE),
  ('FERMETURE_EXCEPTIONNELLE', 'Fermeture exceptionnelle',
   'Fermeture d''un site, d''un entrepôt ou de l''entreprise.',
   TRUE, TRUE, FALSE, 'AUCUNE', 'MAINTENU', TRUE, 40, TRUE),
  ('AUTRE', 'Autre journée particulière',
   'Journée au régime particulier, décrit dans le motif.',
   TRUE, TRUE, FALSE, 'AUCUNE', 'MAINTENU', TRUE, 90, TRUE)
ON CONFLICT (type_key) DO UPDATE
  SET label = EXCLUDED.label, description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order, is_system = TRUE, updated_at = now();

-- ─────────────────────────────────────────────────────────────────────────
-- 2. LE CALENDRIER ADMINISTRATIF
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance_special_days (
  id          BIGSERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  day_date    DATE NOT NULL,
  label       TEXT NOT NULL,
  type_key    TEXT NOT NULL REFERENCES attendance_special_day_types(type_key) ON DELETE RESTRICT,
  description TEXT NOT NULL DEFAULT '',
  /* La référence de la décision : arrêté, note de service, procès-verbal. Ce
     qui permet, des mois plus tard, de remonter à la source. */
  decision_reference TEXT NOT NULL DEFAULT '',

  /* LES CINQ FAITS QUI FONT LE TRAITEMENT. Séparés, parce qu'ils varient
     indépendamment : une journée peut être chômée ET exiger un pointage
     (service minimum), ou être chômée, non payée, et ne rien exiger. */
  est_chome       BOOLEAN NOT NULL DEFAULT TRUE,
  est_paye        BOOLEAN NOT NULL DEFAULT TRUE,
  pointage_requis BOOLEAN NOT NULL DEFAULT FALSE,
  /* AUCUNE : l'absence de pointage n'est pas une absence. C'est le cœur du
     9.2 — « pas de pointage + jour chômé payé ≠ absence ».
     NORMALE : la journée suit les règles ordinaires. */
  impact_absence  TEXT NOT NULL DEFAULT 'AUCUNE',
  /* MAINTENU     : le salaire de la journée est dû.
     RETENUE_JOUR : une retenue d'UN jour s'applique — comptée à part, jamais
                    présentée comme une absence (9.3).
     AUCUN_EFFET  : la journée ne pèse ni dans un sens ni dans l'autre. */
  impact_salaire  TEXT NOT NULL DEFAULT 'MAINTENU',

  /* PORTÉE — une fermeture de bureau ne chôme pas l'entrepôt (9.5). */
  portee      TEXT NOT NULL DEFAULT 'ENTREPRISE',

  /* CELUI QUI TRAVAILLE QUAND MÊME (9.4). Aucun taux n'est écrit dans le
     code : ni ici, ni dans le moteur. Ce qui s'applique est ce qui est saisi. */
  traitement_si_travaille TEXT NOT NULL DEFAULT 'AUCUN',
  compensation_montant NUMERIC(14,2),
  compensation_taux    NUMERIC(8,4),
  /* Quel élément de paie reçoit la compensation. Le catalogue des éléments
     reste la seule source des libellés et des signes. */
  compensation_type_key TEXT REFERENCES payroll_element_types(type_key) ON DELETE RESTRICT,
  compensation_note    TEXT NOT NULL DEFAULT '',

  status      TEXT NOT NULL DEFAULT 'ACTIF',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by_name TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_special_days_impacts_check') THEN
    ALTER TABLE attendance_special_days ADD CONSTRAINT attendance_special_days_impacts_check
      CHECK (impact_absence IN ('AUCUNE', 'NORMALE')
         AND impact_salaire IN ('MAINTENU', 'RETENUE_JOUR', 'AUCUN_EFFET')
         AND portee IN ('ENTREPRISE', 'SITE', 'ENTREPOT', 'SERVICE', 'CATEGORIE', 'SALARIES')
         AND status IN ('ACTIF', 'INACTIF')
         AND traitement_si_travaille IN ('AUCUN', 'PRIME_FIXE', 'MAJORATION',
                                         'HEURES_SUP', 'REPOS_COMPENSATEUR', 'AUTRE'));
  END IF;

  /* « Payée » et « retenue d'un jour » ne peuvent pas être vraies ensemble :
     la base refuse une journée dont le traitement se contredit, plutôt que de
     laisser le moteur trancher à sa façon. */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_special_days_paye_coherent') THEN
    ALTER TABLE attendance_special_days ADD CONSTRAINT attendance_special_days_paye_coherent
      CHECK ((est_paye AND impact_salaire IN ('MAINTENU', 'AUCUN_EFFET'))
          OR (NOT est_paye AND impact_salaire IN ('RETENUE_JOUR', 'AUCUN_EFFET')));
  END IF;

  /* Une compensation annoncée sans montant ni taux ne compense rien. */
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_special_days_compensation_check') THEN
    ALTER TABLE attendance_special_days ADD CONSTRAINT attendance_special_days_compensation_check
      CHECK (
        (traitement_si_travaille IN ('AUCUN', 'REPOS_COMPENSATEUR'))
        OR (traitement_si_travaille = 'PRIME_FIXE'  AND COALESCE(compensation_montant, 0) > 0)
        OR (traitement_si_travaille IN ('MAJORATION', 'HEURES_SUP')
            AND COALESCE(compensation_taux, 0) > 0)
        OR (traitement_si_travaille = 'AUTRE'
            AND (COALESCE(compensation_montant, 0) > 0 OR COALESCE(compensation_taux, 0) > 0))
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_special_days_label_check') THEN
    ALTER TABLE attendance_special_days ADD CONSTRAINT attendance_special_days_label_check
      CHECK (length(trim(label)) >= 3);
  END IF;
END $$;

/* Deux journées ENTREPRISE actives le même jour se contrediraient sans que
   personne puisse dire laquelle s'applique. Une seule est admise ; les portées
   plus fines cohabitent, et le moteur les résout de la plus précise à la plus
   large. */
CREATE UNIQUE INDEX IF NOT EXISTS uq_special_days_entreprise_par_date
  ON attendance_special_days (company_id, day_date)
  WHERE status = 'ACTIF' AND portee = 'ENTREPRISE';
CREATE INDEX IF NOT EXISTS idx_special_days_societe_date
  ON attendance_special_days (company_id, day_date) WHERE status = 'ACTIF';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. LES CIBLES D'UNE PORTÉE
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance_special_day_targets (
  id             BIGSERIAL PRIMARY KEY,
  special_day_id BIGINT NOT NULL REFERENCES attendance_special_days(id) ON DELETE CASCADE,
  /* Redondant avec la journée, et voulu : l'isolation des sociétés doit se
     vérifier sur CETTE ligne, sans jointure. */
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id        INTEGER REFERENCES attendance_work_sites(id) ON DELETE CASCADE,
  employee_id    INTEGER REFERENCES attendance_employees(id) ON DELETE CASCADE,
  service        TEXT,
  categorie      TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_special_day_targets_une_cible') THEN
    ALTER TABLE attendance_special_day_targets
      ADD CONSTRAINT attendance_special_day_targets_une_cible CHECK (
        (CASE WHEN site_id IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN employee_id IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN NULLIF(trim(COALESCE(service, '')), '') IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN NULLIF(trim(COALESCE(categorie, '')), '') IS NOT NULL THEN 1 ELSE 0 END)
      = 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_special_day_targets_journee
  ON attendance_special_day_targets (special_day_id);

-- ─────────────────────────────────────────────────────────────────────────
-- 4. L'AUDIT — avant, après, par qui, pourquoi
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance_special_day_audit (
  id             BIGSERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  /* SET NULL et non CASCADE : l'audit survit à la journée qu'il raconte. */
  special_day_id BIGINT REFERENCES attendance_special_days(id) ON DELETE SET NULL,
  day_date       DATE,
  action         TEXT NOT NULL,
  avant          JSONB,
  apres          JSONB,
  motif          TEXT NOT NULL DEFAULT '',
  portee         TEXT NOT NULL DEFAULT '',
  traitement_salarial TEXT NOT NULL DEFAULT '',
  /* L'état de la paie au moment du geste : ce qui distingue une correction
     anodine d'une correction rétroactive. */
  paie_concernee TEXT NOT NULL DEFAULT '',
  par            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  par_nom        TEXT NOT NULL DEFAULT '',
  le             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_special_day_audit_journee
  ON attendance_special_day_audit (company_id, special_day_id, le DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- 5. SERVICE ET CATÉGORIE DU SALARIÉ — pour que la portée ait des cibles
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE attendance_employees ADD COLUMN IF NOT EXISTS service   TEXT NOT NULL DEFAULT '';
ALTER TABLE attendance_employees ADD COLUMN IF NOT EXISTS categorie TEXT NOT NULL DEFAULT '';

-- ─────────────────────────────────────────────────────────────────────────
-- 6. LA COMPENSATION PASSE PAR LE MOTEUR DES ÉLÉMENTS DE PAIE
--
-- Elle n'est pas écrite dans le net, ni recalculée à part : elle devient un
-- élément de paie comme une prime saisie à la main, et survit donc au recalcul
-- par le même mécanisme. Ce qui la distingue, c'est son ORIGINE — et c'est
-- cette origine qui rend la duplication impossible : une clé d'unicité par
-- (journée spéciale, salarié, date). Un recalcul réécrit la même ligne ; il
-- n'en ajoute jamais une seconde.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE payroll_elements ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'MANUEL';
ALTER TABLE payroll_elements ADD COLUMN IF NOT EXISTS source_ref  TEXT NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_elements_origine
  ON payroll_elements (company_id, source_kind, source_ref)
  WHERE source_kind <> 'MANUEL' AND source_ref <> '';

INSERT INTO payroll_element_types
  (type_key, kind, label, sign, uses_quantity, requires_label, sort_order) VALUES
  ('TRAVAIL_JOUR_CHOME',    'PRIME', 'Travail un jour chômé',              1, TRUE, FALSE, 15),
  ('MAJORATION_JOUR_CHOME', 'PRIME', 'Majoration pour travail un jour chômé', 1, TRUE, FALSE, 16)
ON CONFLICT (type_key) DO UPDATE
  SET kind = EXCLUDED.kind, label = EXCLUDED.label, sign = EXCLUDED.sign,
      uses_quantity = EXCLUDED.uses_quantity, sort_order = EXCLUDED.sort_order,
      is_active = TRUE;

-- ─────────────────────────────────────────────────────────────────────────
-- 7. CE QUE LA LIGNE DE PAIE DOIT POUVOIR DIRE
--
-- Une retenue de jour chômé non payé n'est PAS une absence : elle a sa propre
-- colonne, et le bulletin l'explique séparément (9.3).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE attendance_payroll_items_v2
  ADD COLUMN IF NOT EXISTS jours_feries             INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS jours_chomes_payes       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS jours_chomes_non_payes   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retenue_jour_chome       NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS travail_jour_chome_jours INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS travail_jour_chome_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS repos_compensateur_jours INTEGER NOT NULL DEFAULT 0;

-- ─────────────────────────────────────────────────────────────────────────
-- 8. REPRISE DES FÉRIÉS EXISTANTS
--
-- Ce qu'ils signifiaient déjà, écrit explicitement : chômés, payés, pointage
-- non requis, portée entreprise. `attendance_holidays` reste en place et
-- continue d'être honorée par le moteur : aucun férié ne change de
-- comportement, et rien de ce qui écrit encore dedans ne casse.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO attendance_special_days
  (company_id, day_date, label, type_key, description, est_chome, est_paye,
   pointage_requis, impact_absence, impact_salaire, portee, created_by, created_at)
SELECT h.company_id, h.holiday_date, h.label, 'JOUR_FERIE',
       'Repris du calendrier des jours fériés (migration 100).',
       TRUE, TRUE, FALSE, 'AUCUNE', 'MAINTENU', 'ENTREPRISE', h.created_by, h.created_at
  FROM attendance_holidays h
 WHERE NOT EXISTS (
   SELECT 1 FROM attendance_special_days s
    WHERE s.company_id = h.company_id AND s.day_date = h.holiday_date
      AND s.portee = 'ENTREPRISE' AND s.status = 'ACTIF');

-- ─────────────────────────────────────────────────────────────────────────
-- 9. LES DROITS — un module à part, sous le pointage
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO permission_modules
  (module_key, parent_key, label, description, sort_order, is_active, is_system, actions) VALUES
  ('pointage.calendrier', 'pointage', 'Jours fériés et jours chômés',
   'Déclarer les jours fériés, les journées chômées et leur traitement en paie.',
   312, TRUE, FALSE,
   ARRAY['visible','view','create','update','delete','print','export'])
ON CONFLICT (module_key) DO UPDATE
  SET actions = (SELECT array_agg(DISTINCT a ORDER BY a)
                   FROM unnest(permission_modules.actions || EXCLUDED.actions) AS a),
      label = EXCLUDED.label, description = EXCLUDED.description, updated_at = now();

DO $$
DECLARE soc RECORD;
BEGIN
  FOR soc IN SELECT id FROM companies LOOP
    /* Le calendrier administratif décide de ce que la paie retient : il relève
       de la Direction et de l'administration, pas de la saisie courante. */
    INSERT INTO role_permissions (company_id, role, module_key, action, allowed) VALUES
      (soc.id, 'direction', 'pointage.calendrier', 'visible', true),
      (soc.id, 'direction', 'pointage.calendrier', 'view',    true),
      (soc.id, 'direction', 'pointage.calendrier', 'create',  true),
      (soc.id, 'direction', 'pointage.calendrier', 'update',  true),
      (soc.id, 'direction', 'pointage.calendrier', 'delete',  true),
      (soc.id, 'direction', 'pointage.calendrier', 'print',   true),
      (soc.id, 'comptable', 'pointage.calendrier', 'visible', true),
      (soc.id, 'comptable', 'pointage.calendrier', 'view',    true),
      (soc.id, 'comptable', 'pointage.calendrier', 'print',   true),
      (soc.id, 'comptable', 'pointage.calendrier', 'create',  false),
      (soc.id, 'comptable', 'pointage.calendrier', 'update',  false),
      (soc.id, 'comptable', 'pointage.calendrier', 'delete',  false)
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
DECLARE types INTEGER; reprises INTEGER; feries INTEGER;
BEGIN
  SELECT count(*) INTO types FROM attendance_special_day_types WHERE is_active;
  SELECT count(*) INTO feries FROM attendance_holidays;
  SELECT count(*) INTO reprises FROM attendance_special_days WHERE type_key = 'JOUR_FERIE';

  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_special_days_entreprise_par_date') THEN
    RAISE EXCEPTION '100 : sans unicité, deux journées entreprise pourraient se contredire le même jour.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_payroll_elements_origine') THEN
    RAISE EXCEPTION '100 : sans clé d''origine, un recalcul dupliquerait la compensation d''un jour chômé.';
  END IF;
  IF reprises < feries THEN
    RAISE EXCEPTION '100 : % férié(s) sur % n''ont pas été repris dans le calendrier.', feries - reprises, feries;
  END IF;
  RAISE NOTICE 'Calendrier administratif : % types, % férié(s) repris. Le moteur lit la décision, il ne l''interprète pas.',
    types, reprises;
END $$;

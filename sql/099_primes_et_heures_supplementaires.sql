-- 099 — PRIMES ET HEURES SUPPLÉMENTAIRES : UNE SOURCE MÉTIER QUI SURVIT AU RECALCUL
--
-- Le défaut à ne pas reproduire : `payroll_item_adjustments.payroll_item_id` est
-- en ON DELETE CASCADE. Recalculer une paie supprime ses lignes, et emporte donc
-- la trace des corrections — motif, auteur, ancien montant. Trois primes et un
-- vrai salaire ont ainsi vécu dans un endroit que le recalcul détruit.
--
-- La leçon est dans la clé : ces éléments sont rattachés à la PÉRIODE et au
-- SALARIÉ, jamais à une ligne de paie. Une ligne de paie est un CALCUL, et un
-- calcul se refait ; une prime est une DÉCISION, et une décision reste. Un
-- recalcul relit donc ces éléments et reconstruit le net, au lieu de les perdre.
--
-- Le lien vers la ligne de paie n'est pas stocké : il se déduit de
-- (company_id, employee_id, period_code). Rien à réparer après un recalcul.
--
-- `employee_id` est en ON DELETE RESTRICT : on ne supprime pas un salarié qui
-- porte des éléments de paie. Le retrait se fait par désactivation, comme
-- partout ailleurs.
--
-- Additive, idempotente, réversible : cesser de lire ces tables suffit à
-- revenir au comportement précédent. Aucune ligne existante n'est modifiée.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- LE CATALOGUE DES TYPES — extensible sans toucher au code
--
-- `sign` porte le sens : +1 ajoute au net, -1 en retire. Sans lui, une prime
-- saisie en négatif deviendrait une retenue déguisée, et une retenue en positif
-- une prime. Le montant reste donc toujours positif, et c'est le type qui dit
-- dans quel sens il va.
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payroll_element_types (
  type_key     TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  label        TEXT NOT NULL,
  sign         SMALLINT NOT NULL DEFAULT 1,
  /* Une quantité et un taux n'ont de sens que pour ce qui se compte : des
     heures. Une prime de mérite est un montant, pas un produit. */
  uses_quantity BOOLEAN NOT NULL DEFAULT FALSE,
  /* « Autre prime » n'est pas un type : c'est l'absence de type. On exige donc
     une description, sinon la ligne ne dit rien à qui la relit. */
  requires_label BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order   INTEGER NOT NULL DEFAULT 100,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE payroll_element_types ADD CONSTRAINT payroll_element_types_kind_check
    CHECK (kind IN ('PRIME', 'HEURES_SUP', 'RETENUE'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE payroll_element_types ADD CONSTRAINT payroll_element_types_sign_check
    CHECK (sign IN (-1, 1));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO payroll_element_types (type_key, kind, label, sign, uses_quantity, requires_label, sort_order) VALUES
  ('HEURES_SUP',        'HEURES_SUP', 'Heures supplémentaires',          1, TRUE,  FALSE, 10),
  ('PRIME_MERITE',      'PRIME',      'Prime de mérite / performance',   1, FALSE, FALSE, 20),
  ('PRIME_EXCEPTIONNELLE','PRIME',    'Prime exceptionnelle',            1, FALSE, FALSE, 30),
  ('PRIME_RESPONSABILITE','PRIME',    'Prime de responsabilité',         1, FALSE, FALSE, 40),
  ('PRIME_TRANSPORT',   'PRIME',      'Prime de transport / déplacement', 1, FALSE, FALSE, 50),
  ('PRIME_NUIT',        'PRIME',      'Prime de nuit',                   1, FALSE, FALSE, 60),
  ('PRIME_RISQUE',      'PRIME',      'Prime de risque',                 1, FALSE, FALSE, 70),
  ('PRIME_AUTRE',       'PRIME',      'Autre prime',                     1, FALSE, TRUE,  80),
  ('RETENUE_AUTRE',     'RETENUE',    'Autre retenue autorisée',        -1, FALSE, TRUE,  90)
ON CONFLICT (type_key) DO UPDATE
  SET kind = EXCLUDED.kind, label = EXCLUDED.label, sign = EXCLUDED.sign,
      uses_quantity = EXCLUDED.uses_quantity, requires_label = EXCLUDED.requires_label,
      sort_order = EXCLUDED.sort_order, is_active = TRUE;

-- ═════════════════════════════════════════════════════════════════════════
-- LES ÉLÉMENTS DE PAIE — la source métier
-- ═════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS payroll_elements (
  id            BIGSERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  /* RESTRICT, et non CASCADE : un salarié qui porte des éléments de paie ne se
     supprime pas. Il se désactive, comme partout ailleurs. */
  employee_id   INTEGER NOT NULL REFERENCES attendance_employees(id) ON DELETE RESTRICT,
  /* La PÉRIODE, pas la ligne de paie. C'est ce qui fait survivre l'élément. */
  period_code   TEXT NOT NULL,
  type_key      TEXT NOT NULL REFERENCES payroll_element_types(type_key) ON DELETE RESTRICT,

  quantity      NUMERIC(12,2),
  unit_amount   NUMERIC(14,2),
  amount        NUMERIC(14,2) NOT NULL,

  label         TEXT NOT NULL DEFAULT '',
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'ACTIF',

  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  validated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  validated_by_name TEXT NOT NULL DEFAULT '',
  validated_at  TIMESTAMPTZ,
  cancelled_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancelled_by_name TEXT NOT NULL DEFAULT '',
  cancelled_at  TIMESTAMPTZ,
  cancel_reason TEXT NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE payroll_elements ADD CONSTRAINT payroll_elements_status_check
    CHECK (status IN ('ACTIF', 'ANNULE'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

/* Un montant négatif ferait d'une prime une retenue sans le dire : le sens
   appartient au type, pas à la saisie. */
DO $$ BEGIN
  ALTER TABLE payroll_elements ADD CONSTRAINT payroll_elements_montant_positif
    CHECK (amount >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

/* Un motif vide ne se relit pas six mois plus tard. */
DO $$ BEGIN
  ALTER TABLE payroll_elements ADD CONSTRAINT payroll_elements_motif_obligatoire
    CHECK (BTRIM(reason) <> '');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

/* Une annulation sans motif ni auteur laisse deviner pourquoi un montant a
   disparu d'un bulletin. */
DO $$ BEGIN
  ALTER TABLE payroll_elements ADD CONSTRAINT payroll_elements_annulation_justifiee
    CHECK (status <> 'ANNULE' OR (cancelled_at IS NOT NULL AND BTRIM(cancel_reason) <> ''));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

/* Le format de période est le même que partout : AAAA-MM. Un « 2026-9 » ne
   serait jamais retrouvé par la comparaison de texte qui sert aux échéances. */
DO $$ BEGIN
  ALTER TABLE payroll_elements ADD CONSTRAINT payroll_elements_periode_forme
    CHECK (period_code ~ '^[0-9]{4}-[0-9]{2}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

/* La requête que fait chaque préparation, pour chaque salarié. */
CREATE INDEX IF NOT EXISTS idx_payroll_elements_periode
  ON payroll_elements (company_id, period_code, employee_id) WHERE status = 'ACTIF';
CREATE INDEX IF NOT EXISTS idx_payroll_elements_salarie
  ON payroll_elements (employee_id, period_code);

-- ═════════════════════════════════════════════════════════════════════════
-- NON RÉMUNÉRÉ VOLONTAIREMENT
--
-- Trois situations que le système confondait en une seule :
--   A) salaire non configuré      -> anomalie, ligne BLOCKED, soumission refusée
--   B) non rémunéré volontairement -> autorisé, 0 FCFA, soumission possible
--   C) salaire configuré > 0       -> normal
--
-- A et B produisaient le même écran : une ligne sans montant. On s'en sortait
-- en corrigeant le net à la main — ce qui faisait passer A pour B, en silence.
-- Le drapeau ci-dessous est POSÉ EXPLICITEMENT, jamais déduit : un salaire
-- oublié doit rester une anomalie visible.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE attendance_employees
  ADD COLUMN IF NOT EXISTS non_remunere BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS non_remunere_motif TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS non_remunere_par INTEGER,
  ADD COLUMN IF NOT EXISTS non_remunere_le TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE attendance_employees
    ADD CONSTRAINT attendance_employees_non_remunere_par_fkey
    FOREIGN KEY (non_remunere_par) REFERENCES users(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE attendance_employees
    ADD CONSTRAINT attendance_employees_non_remunere_justifie
    CHECK (NOT non_remunere OR (BTRIM(non_remunere_motif) <> '' AND non_remunere_le IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- LA LIGNE DE PAIE PORTE LE DÉTAIL
--
-- « Ne jamais afficher uniquement un net inexpliqué » : chaque composante est
-- enregistrée séparément, pour que le bulletin puisse la nommer.
-- ═════════════════════════════════════════════════════════════════════════
ALTER TABLE attendance_payroll_items_v2
  ADD COLUMN IF NOT EXISTS primes_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS heures_sup_total  NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS heures_sup_heures NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retenues_autres_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  /* Une correction manuelle du net reste possible, mais elle ne se cache plus :
     la ligne le dit, et le bulletin peut le montrer. */
  ADD COLUMN IF NOT EXISTS net_corrige_manuellement BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS non_remunere BOOLEAN NOT NULL DEFAULT FALSE;

DO $$ BEGIN
  ALTER TABLE attendance_payroll_items_v2
    ADD CONSTRAINT attendance_payroll_items_composantes_positives
    CHECK (primes_total >= 0 AND heures_sup_total >= 0 AND retenues_autres_total >= 0
           AND heures_sup_heures >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE types INTEGER; elements INTEGER;
BEGIN
  SELECT count(*) INTO types FROM payroll_element_types WHERE is_active;
  SELECT count(*) INTO elements FROM payroll_elements;
  IF types < 9 THEN
    RAISE EXCEPTION '099 : catalogue incomplet (% types actifs).', types;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'attendance_employees' AND column_name = 'non_remunere') THEN
    RAISE EXCEPTION '099 : la colonne non_remunere est absente.';
  END IF;
  RAISE NOTICE '099 : % types d''éléments de paie, % élément(s) enregistré(s). '
               'Les primes et heures supplémentaires vivent désormais hors des '
               'lignes de paie : un recalcul les relit au lieu de les perdre.', types, elements;
END $$;

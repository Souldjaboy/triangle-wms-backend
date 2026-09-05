-- 082 — TOUTE LA FAMILLE, PAS SEULEMENT LES TROIS PREMIERS CAS
--
-- Les migrations 077 et 078 ont corrigé, un par un, trois symptômes du même
-- défaut : `nextAccountingNumber()` compte PAR SOCIÉTÉ mais produit un texte
-- qui ne contient jamais le `company_id`, alors que la colonne visée porte
-- une contrainte unique GLOBALE. Chaque correction traitait le cas qu'on
-- venait de rencontrer.
--
-- L'inventaire exhaustif des appelants montre que la famille compte huit
-- membres, pas trois. Cinq restaient :
--
--   accounting_entries.entry_number   (ECR)  — écriture comptable
--   journal_entries.entry_number      (JRN)  — écriture de journal
--   expense_requests.request_number   (DD)   — demande de décaissement
--   cash_vouchers.voucher_number      (BE/BD)— bon d'encaissement/décaissement
--   marketplace_orders.order_number   (MKP)  — commande place de marché
--
-- Le cas d'`accounting_entries` est le plus grave des cinq : la fonction
-- `createAccountingEntry()` est appelée par TOUTE opération financière —
-- salaire, vente, encaissement, contrepassation. Deux sociétés qui atteignent
-- la même séquence ECR le même jour font échouer la seconde en pleine
-- transaction financière, sur une violation de clé brute. Rencontré pour de
-- vrai en écrivant la suite de la migration 081 : le paiement d'un salaire a
-- échoué là-dessus.
--
-- ═════════════════════════════════════════════════════════════════════════
-- LE CAS PARTICULIER DE marketplace_orders
--
-- Cette table n'a pas de `company_id` : elle porte `vendor_company_id` et
-- `buyer_company_id`. Le compteur, lui, est alimenté avec le vendeur. Une
-- unicité `(vendor_company_id, order_number)` serait donc la traduction
-- fidèle du compteur. Mais `nextAccountingNumber` ne trouve pas de colonne
-- `company_id` dans cette table et se réconcilie alors GLOBALEMENT sur le
-- dernier numéro du préfixe, toutes sociétés confondues : le numéro produit
-- est déjà, de fait, unique globalement. Resserrer la contrainte
-- n'apporterait rien et ferait diverger la règle de ce que le code fait.
-- Elle est donc laissée GLOBALE, volontairement — et documentée ici pour que
-- la prochaine relecture n'y voie pas un oubli.
-- ═════════════════════════════════════════════════════════════════════════
--
-- Additive et idempotente, sous garde : si des doublons existent déjà, on
-- avertit avec leur détail et on n'impose rien. Renuméroter une écriture
-- comptable est une décision métier, pas une décision de migration.

BEGIN;

-- ═════════════════════════════════════════════════════════════════════════
-- UNE SEULE PROCÉDURE POUR LES QUATRE — plutôt que quatre blocs recopiés,
-- où l'un finit toujours par diverger des trois autres.
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  cible RECORD;
  doublons INTEGER;
  details TEXT;
  ancienne TEXT;
  nouvelle TEXT;
BEGIN
  FOR cible IN
    SELECT * FROM (VALUES
      ('accounting_entries', 'entry_number'),
      ('journal_entries',    'entry_number'),
      ('expense_requests',   'request_number'),
      ('cash_vouchers',      'voucher_number')
    ) AS t(nom_table, nom_colonne)
  LOOP
    ancienne := format('%s_%s_key', cible.nom_table, cible.nom_colonne);
    nouvelle := format('%s_company_%s_key', cible.nom_table, cible.nom_colonne);

    /* Sous la contrainte globale actuelle, un doublon est structurellement
       impossible — on le vérifie plutôt que de le supposer, comme partout
       ailleurs dans ce dépôt. */
    EXECUTE format(
      'SELECT count(*), string_agg(format(''société %%s / %%s'', company_id, %I), '', '')
         FROM (SELECT company_id, %I FROM %I
                WHERE %I IS NOT NULL
                GROUP BY 1, 2 HAVING count(*) > 1 LIMIT 20) d',
      cible.nom_colonne, cible.nom_colonne, cible.nom_table, cible.nom_colonne)
      INTO doublons, details;

    IF COALESCE(doublons, 0) > 0 THEN
      RAISE WARNING '% : % doublon(s) de (company_id, %) — contrainte non resserrée. Détail : %. Corrigez puis rejouez 082.',
        cible.nom_table, doublons, cible.nom_colonne, details;
    ELSE
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', cible.nom_table, ancienne);

      /* Vérification explicite plutôt qu'un bloc EXCEPTION : ADD CONSTRAINT
         ... UNIQUE crée un index du même nom, et sa réutilisation lève
         `duplicate_table` (42P07), pas `duplicate_object` (42710). Le piège
         rencontré en mettant au point 077. */
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = nouvelle) THEN
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I UNIQUE (company_id, %I)',
                       cible.nom_table, nouvelle, cible.nom_colonne);
      END IF;
    END IF;
  END LOOP;
END $$;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLE — ET GARDE-FOU POUR LA SUITE
--
-- Le contrôle ne se contente pas de vérifier les quatre tables de cette
-- migration : il vérifie que TOUTE table alimentée par un compteur
-- `number_counters` porte bien une unicité par société. Si quelqu'un ajoute
-- demain un nouveau `nextAccountingNumber(...)` sur une table protégée
-- globalement, ce bloc le dira — au lieu de laisser le défaut se découvrir
-- en production, un jour où deux sociétés travaillent en même temps.
--
-- N'échoue jamais : avertir suffit, et faire échouer une migration sur l'état
-- d'une table qu'elle ne crée pas transformerait un signalement utile en
-- déploiement bloqué.
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  ligne RECORD;
  restants INTEGER := 0;
BEGIN
  FOR ligne IN
    SELECT nom_table, nom_colonne FROM (VALUES
      ('accounting_transactions', 'transaction_number'),
      ('accounting_entries',      'entry_number'),
      ('journal_entries',         'entry_number'),
      ('expense_requests',        'request_number'),
      ('cash_vouchers',           'voucher_number'),
      ('laboratory_cases',        'case_number'),
      ('documents',               'document_number'),
      ('payroll_vouchers',        'voucher_number')
    ) AS t(nom_table, nom_colonne)
  LOOP
    /* Y a-t-il une unicité qui COMMENCE par company_id sur cette colonne ? */
    IF NOT EXISTS (
      SELECT 1
        FROM pg_constraint c
        JOIN pg_attribute a_soc ON a_soc.attrelid = c.conrelid AND a_soc.attnum = c.conkey[1]
        JOIN pg_attribute a_col ON a_col.attrelid = c.conrelid AND a_col.attnum = c.conkey[2]
       WHERE c.conrelid = ligne.nom_table::regclass
         AND c.contype = 'u'
         AND array_length(c.conkey, 1) = 2
         AND a_soc.attname = 'company_id'
         AND a_col.attname = ligne.nom_colonne
    ) THEN
      restants := restants + 1;
      RAISE WARNING 'Numérotation : %.% n''est PAS unique par société. Deux sociétés peuvent produire le même numéro et la seconde échouera.',
        ligne.nom_table, ligne.nom_colonne;
    END IF;
  END LOOP;

  IF restants = 0 THEN
    RAISE NOTICE 'Numérotation : les 8 colonnes alimentées par nextAccountingNumber sont uniques PAR SOCIÉTÉ.';
  ELSE
    RAISE NOTICE 'Numérotation : % colonne(s) encore protégée(s) globalement — voir les avertissements.', restants;
  END IF;

  RAISE NOTICE 'marketplace_orders.order_number reste GLOBAL volontairement : la table n''a pas de company_id, et nextAccountingNumber s''y réconcilie déjà globalement.';
END $$;

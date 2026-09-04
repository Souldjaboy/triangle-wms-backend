-- 077 — LES NUMÉROS COMPTABLES REDEVIENNENT UNIQUES PAR SOCIÉTÉ
--
-- `accounting_transactions.transaction_number` porte, depuis sa création
-- (migration 023 : `transaction_number TEXT UNIQUE`), une contrainte unique
-- GLOBALE — alors que `nextAccountingNumber()` (server.js) scope son
-- compteur (`number_counters`) PAR SOCIÉTÉ. Deux sociétés qui atteignent
-- chacune leur premier paiement du même préfixe (ENC-SAB, ENC-CIM, REV-SAB,
-- DEC, REMB, SAL…) la même année génèrent donc littéralement le même texte
-- — « ENC-SAB-2026-000001 » pour l'une comme pour l'autre — et le second
-- INSERT échoue sur une violation de clé brute, pas sur une erreur métier.
--
-- Reproduit réellement le 2026-09-03 : deux sociétés de test, chacune avec
-- un paiement sable encaissé puis contrepassé le même jour — la seconde
-- contrepassation (préfixe REV-SAB) a heurté cette collision.
--
-- Aucune donnée existante n'est en danger : la contrainte GLOBALE actuelle
-- interdit structurellement qu'un doublon de `transaction_number` existe
-- déjà quelque part, dans quelque société que ce soit — il ne peut donc pas y
-- avoir de ligne qui violerait la nouvelle contrainte, plus étroite. Le
-- contrôle ci-dessous le vérifie plutôt que de le supposer.
--
-- Le format des numéros ne change PAS : seule la règle d'unicité passe de
-- « unique dans toute la base » à « unique par société » — exactement ce que
-- le compteur qui les produit fait déjà. Aucun rapport, aucun affichage
-- existant n'est affecté.

BEGIN;

DO $$
DECLARE doublons INTEGER;
BEGIN
  /* Sous l'ancienne contrainte globale, un doublon de transaction_number est
     structurellement impossible — mais on le vérifie plutôt que de le
     supposer, comme partout ailleurs dans ce dépôt. */
  SELECT count(*) INTO doublons FROM (
    SELECT company_id, transaction_number
      FROM accounting_transactions
     WHERE transaction_number IS NOT NULL
     GROUP BY 1, 2 HAVING count(*) > 1
  ) d;

  IF doublons > 0 THEN
    RAISE WARNING 'accounting_transactions : % doublon(s) de (company_id, transaction_number) trouvé(s) — contrainte non resserrée. Corrigez-les puis rejouez 077.', doublons;
  ELSE
    ALTER TABLE accounting_transactions
      DROP CONSTRAINT IF EXISTS accounting_transactions_transaction_number_key;

    /* Vérification explicite plutôt qu'un bloc EXCEPTION : une contrainte
       UNIQUE crée un index du même nom, et sa réutilisation lève
       `duplicate_table` (42P07), pas `duplicate_object` — un piège déjà
       rencontré une fois dans ce fichier, corrigé ici avant de le répéter
       ailleurs. */
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'accounting_transactions_company_transaction_number_key') THEN
      ALTER TABLE accounting_transactions
        ADD CONSTRAINT accounting_transactions_company_transaction_number_key
        UNIQUE (company_id, transaction_number);
    END IF;
  END IF;
END $$;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLE
--
-- Ne fait JAMAIS échouer la migration sur l'absence de la nouvelle
-- contrainte : si des doublons ont été trouvés ci-dessus, ne pas la poser
-- est le comportement VOULU (même philosophie que 073/074/075) — l'échec
-- reviendrait à transformer un avertissement légitime en migration cassée.
-- Ce bloc informe seulement de l'état réel obtenu.
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE resserree BOOLEAN;
BEGIN
  resserree := EXISTS (SELECT 1 FROM pg_constraint
                         WHERE conname = 'accounting_transactions_company_transaction_number_key');
  IF resserree THEN
    RAISE NOTICE 'Numéros comptables : unicité par société posée, schéma conforme.';
  ELSE
    RAISE NOTICE 'Numéros comptables : contrainte non resserrée (des doublons existaient) — voir l''avertissement ci-dessus, corrigez puis rejouez 077.';
  END IF;
END $$;

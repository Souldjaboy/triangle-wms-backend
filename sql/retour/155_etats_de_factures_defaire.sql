-- ═════════════════════════════════════════════════════════════════════════
--  DÉFAIRE 155_etats_de_factures.sql
--
--  Les états de factures validés disparaissent : les factures qu'ils
--  réclamaient redeviennent disponibles, et rien n'empêchera plus de les
--  porter sur un nouvel état. Si des états ont été remis à des clients, le
--  registre qui en gardait trace n'existera plus.
--
--  Les états repris de l'historique partent aussi, et avec eux la protection
--  des numéros de facture déjà portés sur un état papier.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

DROP VIEW  IF EXISTS v_factures_deja_sur_etat;

DROP TRIGGER IF EXISTS invoice_statement_lines_blocage_trg ON invoice_statement_lines;
DROP TRIGGER IF EXISTS invoice_statements_blocage_trg ON invoice_statements;
DROP FUNCTION IF EXISTS invoice_statement_lines_heriter_blocage();
DROP FUNCTION IF EXISTS invoice_statements_tenir_blocage();

DROP TABLE IF EXISTS invoice_statement_history CASCADE;
DROP TABLE IF EXISTS invoice_statement_lines CASCADE;
DROP TABLE IF EXISTS invoice_statement_history_notice CASCADE;
DROP TABLE IF EXISTS invoice_statements CASCADE;

DELETE FROM role_permissions   WHERE module_key = 'etat_facture' AND updated_by IS NULL;
DELETE FROM permission_modules
 WHERE module_key = 'etat_facture'
   AND NOT EXISTS (SELECT 1 FROM role_permissions WHERE module_key = 'etat_facture')
   AND NOT EXISTS (SELECT 1 FROM user_permission_overrides WHERE module_key = 'etat_facture');

COMMIT;

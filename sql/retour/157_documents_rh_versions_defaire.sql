-- ═════════════════════════════════════════════════════════════════════════
--  DÉFAIRE 157_documents_rh_versions.sql
--
--  CE QUI SE PERD ICI, ET QU'IL FAUT MESURER.
--
--  pdf_content porte les OCTETS des pièces remises aux salariés. Les
--  supprimer ne détruit pas les documents déjà imprimés, mais l'application
--  ne pourra plus les resservir à l'identique : elle retombera sur la
--  régénération, qui ne donne pas forcément le même fichier.
--
--  Les chaînes de versions disparaissent aussi : deux bulletins du même mois
--  redeviendront deux pièces sans lien, et rien ne dira laquelle fait foi.
--
--  « retour-base.sh » exporte les pièces et leurs octets avant d'appeler ce
--  fichier, et refuse s'il ne peut pas.
-- ═════════════════════════════════════════════════════════════════════════
BEGIN;

DROP VIEW  IF EXISTS v_documents_rh_courants;
DROP TABLE IF EXISTS hr_document_history CASCADE;

DROP INDEX IF EXISTS hr_documents_versions_idx;
DROP INDEX IF EXISTS hr_documents_courants_idx;
DROP INDEX IF EXISTS hr_documents_remplacement_idx;

ALTER TABLE hr_documents
  DROP CONSTRAINT IF EXISTS hr_documents_remplace_fkey,
  DROP CONSTRAINT IF EXISTS hr_documents_remplace_par_fkey,
  DROP CONSTRAINT IF EXISTS hr_documents_version_coherente;

ALTER TABLE hr_documents
  DROP COLUMN IF EXISTS pdf_content,
  DROP COLUMN IF EXISTS pdf_bytes,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS version,
  DROP COLUMN IF EXISTS supersedes_document_id,
  DROP COLUMN IF EXISTS superseded_by_document_id,
  DROP COLUMN IF EXISTS superseded_at,
  DROP COLUMN IF EXISTS version_reason,
  DROP COLUMN IF EXISTS printed_count,
  DROP COLUMN IF EXISTS last_printed_at,
  DROP COLUMN IF EXISTS cancelled_by_name;

DELETE FROM role_permissions
 WHERE module_key = 'rh.document' AND action IN ('reprint','archive')
   AND updated_by IS NULL;

UPDATE permission_modules
   SET actions = (SELECT COALESCE(array_agg(a ORDER BY a), ARRAY[]::text[])
                    FROM unnest(actions) AS a WHERE a NOT IN ('reprint','archive')),
       updated_at = now()
 WHERE module_key = 'rh.document';

COMMIT;

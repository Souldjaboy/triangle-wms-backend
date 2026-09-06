-- 089 — UN SEUL MOTEUR DÉCIDE DE LA PAIE
--
-- `canManagePayroll()` (services/attendance-payroll.js) accordait la paie à
-- quiconque porte le rôle « comptable », avant même de regarder les
-- permissions. Un administrateur pouvait donc poser DENY sur `paie|pay`, voir
-- le bouton disparaître de l'écran — et le comptable payait quand même en
-- appelant la route directement. Le refus n'existait qu'à l'écran.
--
-- Deux moteurs décidaient d'un même paiement : le moteur RBAC, et ce repli
-- par rôle. Le second gagnait, parce qu'il répondait le premier.
--
-- Le repli disparaît. Reste la question de ceux à qui la paie avait été
-- accordée par l'AUTRE chemin encore en place : la table
-- `attendance_payroll_authorizations` (`can_prepare` / `can_pay`). Supprimer
-- le repli sans rien faire leur retirerait en silence un droit que quelqu'un
-- leur avait explicitement donné.
--
-- Cette migration recopie donc ces autorisations en exceptions personnelles
-- du moteur moderne. Rien n'est perdu, et tout est désormais visible au même
-- endroit : l'écran des droits. Une autorisation devenue une exception se
-- retire comme n'importe quelle autre — ce qui n'était pas le cas avant.
--
-- Additive et idempotente. `attendance_payroll_authorizations` n'est pas
-- supprimée : elle reste lisible, comme trace de ce qui a été configuré.

BEGIN;

/* Un DENY déjà posé par un administrateur l'emporte : on ne réactive pas un
   droit que quelqu'un a explicitement retiré. D'où le DO NOTHING plutôt qu'un
   DO UPDATE — cette migration ne fait qu'ajouter ce qui manque. */
INSERT INTO user_permission_overrides (company_id, user_id, module_key, action, effect)
SELECT a.company_id, a.user_id, 'paie', v.action, 'ALLOW'
  FROM attendance_payroll_authorizations a
  CROSS JOIN LATERAL (VALUES ('visible'), ('view')) AS v(action)
 WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id)
ON CONFLICT (company_id, user_id, module_key, action) DO NOTHING;

INSERT INTO user_permission_overrides (company_id, user_id, module_key, action, effect)
SELECT a.company_id, a.user_id, 'paie', 'prepare', 'ALLOW'
  FROM attendance_payroll_authorizations a
 WHERE a.can_prepare = true
   AND EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id)
ON CONFLICT (company_id, user_id, module_key, action) DO NOTHING;

INSERT INTO user_permission_overrides (company_id, user_id, module_key, action, effect)
SELECT a.company_id, a.user_id, 'paie', 'pay', 'ALLOW'
  FROM attendance_payroll_authorizations a
 WHERE a.can_pay = true
   AND EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id)
ON CONFLICT (company_id, user_id, module_key, action) DO NOTHING;

COMMIT;

-- ═════════════════════════════════════════════════════════════════════════
-- CONTRÔLE
-- ═════════════════════════════════════════════════════════════════════════
DO $$
DECLARE reportees INTEGER; orphelines INTEGER;
BEGIN
  SELECT count(*) INTO reportees
    FROM attendance_payroll_authorizations a
   WHERE EXISTS (SELECT 1 FROM user_permission_overrides o
                  WHERE o.company_id = a.company_id AND o.user_id = a.user_id
                    AND o.module_key = 'paie' AND o.action = 'view');

  /* Une autorisation dont le compte n'existe plus : on le dit plutôt que de
     la reporter sur un identifiant qui pourrait être réattribué. */
  SELECT count(*) INTO orphelines
    FROM attendance_payroll_authorizations a
   WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id);
  IF orphelines > 0 THEN
    RAISE WARNING '089 : % autorisation(s) de paie visent un compte inexistant — non reportées.', orphelines;
  END IF;

  RAISE NOTICE 'Paie : % autorisation(s) historique(s) reportées en exceptions personnelles. Le rôle ne contourne plus les droits.', reportees;
END $$;

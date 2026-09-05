# Mission maître Triangle + FAT & MAT — suivi

Branche : `claude/emplacements-bins-dates-documents`
Base de départ : backend `1bb0271`, frontend `0bae0ee`.
Aucun accès VPS, aucun déploiement, aucune fusion.

---

## 1. Cartographie réelle (audit du 2026-09-04)

### Dépôt
- `server.js` : 18 170 lignes, monolithe Express + routeurs `routes/*.js` (19 fichiers)
  et services `services/*.js` (18 fichiers).
- `sql/` : 85 fichiers, dernier appliqué **077**.
- Aucun `AGENTS.md` ni `CLAUDE.md` dans le dépôt backend.
- Base de test locale : conteneur Docker `triangle-postgres-test`,
  reconstruite par `scripts/rebuild-test-db.sh`. Elle contient des comptes
  **fictifs** (« Essai … ») : aucun compte réel de production n'y figure.

### Sociétés
| id | nom | badge_prefix |
|----|-----|--------------|
| 1 | Triangle Logistics Transport & Intérim SARL | TRIANGLE |
| 2 | FAT & MAT Entreprise | FATMAT |

### Moteur RBAC (réel, à réutiliser — ne pas doubler)
- `permission_modules(module_key, parent_key, label, actions[])` — 36 modules,
  dont `pointage`, `badge`, `rh`, `comptabilite`, `vente`, `sable`, `ciment`.
- `role_permissions(company_id, role, module_key, action, allowed)`
- `user_permission_overrides(company_id, user_id, module_key, action, effect)` → ALLOW/DENY
- `services/permissions.js` : `chargerContexte` / `decider` / `creerRequirePermission`.
  Ordre de décision : super_admin → module masqué → exception personnelle →
  rôle → remontée sous-module → ancien modèle (`rbac-triangle.js`) → repli rôle.
  **Ajouter un module au catalogue suffit à le rendre opposable côté backend.**

### Multi-sociétés
- `services/company-context.js` : `resoudreSociete()` + `getEffectiveCompanyId()`.
- **Trou identifié** : `societesAutorisees()` n'autorise le basculement qu'au
  `super_admin`. Il n'existe **aucune** table `user_company_access`.
  Fofana (comptable) et M. Diallo (directeur) ne peuvent donc pas basculer.
  → à créer (migration 079).

### Pointage / paie existants (v2, à étendre — ne pas refaire)
- `attendance_employees` (company_id, employee_number, full_name, user_id,
  site_id, schedule_id, job_title, phone, active, effective_from/to)
- `attendance_day_records_v2` (check_in / break_out / break_in / check_out,
  status, late_minutes, worked_minutes, punched_by)
- `attendance_event_log_v2` (action_type, event_at, performed_by, **source**)
- `attendance_day_record_corrections` (migration 076)
- `attendance_sites`, `attendance_work_schedules`, `attendance_schedule_days`,
  `attendance_company_configuration` (official_start_at, timezone)
- `attendance_operator_scopes` (can_punch par site) ; `attendance_salary_viewers`
- `attendance_payroll_runs_v2` (**period_month date** → mensuel, pas 25→24)
- `attendance_payroll_items_v2` (24 colonnes, paiement + accounting_transaction_id)
- `attendance_payroll_authorizations` (can_prepare / can_pay)

### Badges
- Pas de table dédiée : `users.badge_code` + `companies.badge_prefix/badge_sequence`
  (`prochainBadge()` dans company-context.js).
- **Aucun QR employé, aucun historique d'émission/impression/remplacement.**

### Comptabilité / trésorerie
- `accounting_transactions`, `accounting_entries`, `accounting_banks`,
  `journal_entries`, `journal_entry_lines`, `caisses`, `cash_registers`,
  `treasury_accounts`, `number_counters`.
- `nextAccountingNumber(client, table, colonne, prefixe, companyId)` — server.js.

### Absents du schéma (modules à créer)
- avances sur salaire, fiscalité/impôts, acomptes/dépôts clients : **0 table**.

---

## 2. Journal d'avancement

| # | Chantier | État |
|---|----------|------|
| 078 | Unicité par société : `laboratory_cases.case_number`, `documents.document_number` | en cours |
| 079 | Accès multi-sociétés (`user_company_access`) — bascule sans second compte | **fait** — 24/24 |

### Décision 079
Il n'existait aucune table d'accès multi-sociétés : `societesAutorisees()` ne
laissait basculer que le `super_admin`. Les deux issues sans elle étaient un
second compte (deux mots de passe, deux audits, deux jeux de droits qui
divergent) ou une élévation en super_admin (bien trop large). D'où
`user_company_access` + `user_company_access_log`.

Points de sécurité retenus :
- la bascule d'un compte habilité ne s'obtient QUE par l'en-tête
  `x-active-company-id` ou le paramètre d'URL, **jamais** par
  `req.body.company_id` — c'est un nom de champ de donnée avant d'être une
  commande (piège déjà documenté sur `getEffectiveCompanyIdStrict`) ;
- une habilitation n'accorde aucun droit métier : le RBAC est réévalué avec le
  `company_id` effectif ;
- une habilitation ne franchit jamais la frontière d'un `tenant_id` ;
- la liste est résolue une fois par requête dans `authenticateToken`, avec un
  cache de 30 s invalidé à chaque écriture ; en cas de panne base la liste est
  **vide** (on n'élargit jamais sur incident).

### Correction d'une fragilité de la suite 077
`test-numerotation-comptable-par-societe.js` exigeait que les deux sociétés
produisent le même texte `REV-SAB`. Lancée après la suite des ventes de sable,
elle trouvait des compteurs décalés par de vraies écritures et échouait pour
une raison étrangère au correctif. L'égalité n'est désormais exigée que si les
deux compteurs partent réellement du même point ; l'assertion qui compte — la
seconde société n'échoue plus — est inconditionnelle.
| 080 | Badges QR + pointage QR distinct du manuel | **fait** — 50/50 |

### Décision 080
Les badges vivaient sur `users.badge_code` : un employé de pointage sans compte
utilisateur ne pouvait donc pas en porter, et le code, lisible et séquentiel,
servait aussi de clé de scan — le badge suivant se devinait en ajoutant 1.

Un badge porte désormais **deux** identifiants : `badge_code` (imprimé,
lisible, sans valeur d'authentification) et `qr_token` (24 octets aléatoires,
~192 bits, seul à valoir pointage). Le QR n'encode que le jeton : ni nom, ni
matricule, ni société.

- un badge d'une autre société est refusé du **même message** qu'un badge
  inconnu — sinon, scanner sur les deux postes révélerait à qui appartient une
  carte trouvée par terre ;
- `pg_advisory_xact_lock` par badge + fenêtre anti-rebond de 20 s : deux
  lectures rapprochées renvoient le pointage déjà écrit au lieu d'une erreur ;
- un seul badge actif par employé (index partiel) ; le remplacement invalide
  l'ancien **avant** d'émettre le nouveau ;
- `attendance_qr_scans` trace les refus, avec un indice de jeton (4 derniers
  caractères) et jamais le jeton en clair.

QR et manuel restent **deux** écrans, deux routes, deux droits
(`pointage.qr|scan` vs `pointage.manuel|create`) mais partagent un **seul**
moteur d'écriture, `A.enregistrerPointage` — le mode change qui déclenche, pas
la règle métier. La route manuelle a été rebranchée dessus sans changement de
comportement (39/39 avant comme après).

`attendance_employees.site_id` référence `attendance_work_sites`, **pas**
`attendance_sites` (l'ancienne table GPS). Les confondre fait échouer la clé
étrangère.

### Fragilité corrigée dans trois suites
`test-durcissement` réécrit `role_permissions` selon les rôles réellement
présents en base. Les suites qui s'appuyaient sur les droits posés par une
migration (sable/075, QR/080) échouaient donc selon l'ordre d'exécution, pour
une raison étrangère à ce qu'elles vérifient. Chaque jeu d'essai accorde
maintenant **nommément** les droits dont il a besoin — jamais plus larges, afin
que les tests de refus prouvent encore quelque chose. Les suites 079 et QR
créent aussi leurs propres comptes au lieu d'identifiants écrits en dur.

### Convergence sur la migration 078
Le dépôt distant avait avancé pendant ce chantier : deux commits (`9880e37`,
`7611b47`) corrigent **le même** défaut, avec les **mêmes** noms de contraintes
(`laboratory_cases_company_case_number_key`,
`documents_company_document_number_key`) et la **même** décision délibérée de
laisser `laboratory_cases.result_code` en unicité globale — conclusion atteinte
indépendamment, ce qui la confirme plutôt qu'elle ne l'infirme.

Résolution : rebase (jamais de force-push), puis suppression de **ma**
migration en double `sql/078_numerotation_unique_par_societe.sql`, qui n'avait
jamais été poussée. La version distante est conservée : elle est déjà publiée,
peut avoir été appliquée ailleurs, et garde correctement son `ADD CONSTRAINT`
derrière un contrôle `pg_constraint` (le piège `duplicate_table`).

Les deux suites de test sont conservées : la mienne (17 vérifications) couvre
en plus la non-régression volontaire de `result_code` face à une seconde
société, le vrai chemin des reçus `REC-LAB`, et les numéros NULL multiples.

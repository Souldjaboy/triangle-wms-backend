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

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
| 081 | Périodes 25→24, calendrier, workflow paie + Direction, bons | **fait** — 50/50 |
| 082 | Toute la famille de numérotation par société (5 tables restantes) | **fait** — 28/28 |

### Décision 081
- `attendance_periods` avec **contrainte d'exclusion GiST** : ce qu'il faut
  interdire n'est pas la répétition d'une date mais le **chevauchement** de
  deux périodes — deux paies qui se recouvrent paieraient deux fois les mêmes
  journées sans que rien ne le remarque. Éprouvé par insertion directe en base.
- Machine à états explicite (`TRANSITIONS`) : ce qui n'est pas listé est
  refusé. Une machine qui interdit par défaut ne laisse pas passer
  l'enchaînement auquel personne n'avait pensé.
- Le passage par la Direction ne repose **pas** sur le rôle de celui qui clique
  (un rôle se change à l'écran des droits) mais sur l'état d'un objet qu'un
  **autre compte** a dû toucher : `payroll_requests` VALIDEE, avec refus
  explicite de l'auto-validation (`SELF_APPROVAL_FORBIDDEN`) — éprouvé en
  accordant volontairement au comptable le droit `paie|validate`.
- Le bon de paiement **recopie** son contenu (`payload` jsonb) au lieu de le
  relire par jointure : un bon signé doit dire ce qu'il disait le jour de la
  signature.
- Les paies antérieures, sans période ni demande, restent payables : les
  bloquer rétroactivement empêcherait de solder ce qui est en cours.

### Défaut réel trouvé pendant l'écriture de la suite 081
Le paiement d'un salaire a échoué sur
`accounting_entries_entry_number_key` — contrainte **globale** sur une colonne
alimentée par un compteur **par société**. L'inventaire exhaustif des
appelants de `nextAccountingNumber` a montré que la famille comptait **huit**
membres, pas les trois traités par 077 et 078. Les cinq restants
(`accounting_entries`, `journal_entries`, `expense_requests`, `cash_vouchers`,
et le cas volontairement non traité de `marketplace_orders`) sont corrigés par
082, qui pose en plus un **garde-fou** : son bloc de contrôle vérifie les huit
colonnes et avertit si une nouvelle table numérotée arrive un jour sans
unicité par société.

`accounting_entries` était le plus coûteux : `createAccountingEntry()` est
appelée par **toute** opération financière — salaire, vente, encaissement,
contrepassation.

### Piège trouvé : les droits d'une migration peuvent ne rien poser
`role_permissions` n'est écrit par **aucune** route de l'application (vérifié :
l'écran des droits n'écrit que `user_permission_overrides`). Cette table n'est
donc alimentée que par les migrations — et la 063 y génère la matrice
**complète** : chaque société × chaque rôle présent × chaque action de chaque
module, en accordant tout aux rôles d'administration et rien aux autres.

Conséquence : lors d'un déploiement **linéaire**, 063 passe avant les modules
créés plus tard et ne les voit pas — les grants de 080/081 s'appliquent. Mais
lors d'un **rejeu complet** (`rebuild-test-db.sh`, ou la reconstruction d'un
environnement), 063 repasse une fois les modules existants, remplit la matrice
la première, et un `ON CONFLICT DO NOTHING` ne pose plus rien. La séparation
comptable/direction dépendait donc de l'ordre d'application des migrations.

Corrigé dans 080 et 081 : `DO UPDATE ... WHERE role_permissions.updated_by IS
NULL` — une migration corrige un défaut généré, jamais une décision humaine.

### Suite dépendante d'une base neuve
`test-import-em2s-db` vérifie des totaux de stock **absolus** : elle passe
127/127 sur base reconstruite et échoue de 3 vérifications si d'autres suites
ont déjà bougé du stock. Propriété préexistante de cette suite, sans rapport
avec ce chantier — à lancer en premier ou sur base neuve.
| 083 | Trésorerie partagée + avances sur salaire | **fait** — 53/53 |

### Décision 083
**`services/tresorerie.js`** : un seul chemin pour tout mouvement d'argent.
Avant, chaque module refaisait la même séquence — verrouiller, vérifier le
solde, le mettre à jour, écrire la transaction, écrire les deux écritures — et
c'est toujours la seconde écriture, celle qui équilibre, qu'on finit par
oublier. Le service garantit à chaque appel : `FOR UPDATE` avant lecture du
solde, refus chiffré si insuffisant (avec le **manquant**), solde jamais modifié
sans transaction ni écritures, les deux écritures posées ensemble.

**Avances** : une avance n'est pas une charge mais une **créance sur le
salarié** (compte « Créances sur le personnel ») — la comptabiliser en charges
de personnel la ferait disparaître le jour du remboursement. Le **solde** est
la seule vérité : tout part de lui, jamais du montant initial.

Les trois cas chiffrés exigés passent : 100 000 − 25 000 = **75 000** ;
25 000 par mensualités de 5 000 → **5 échéances**, net **95 000** ; solde
25 000 − remboursement direct 20 000 = **5 000**, argent rentré en caisse et
reçu numéroté.

### Défaut trouvé par le test
`poserEcheancier` renumérotait les échéances à partir de 1 lors d'un
rééchelonnement, écrasant une échéance **déjà retenue** sur une paie : elle
redevenait « à venir » et aurait été prélevée une seconde fois. Les nouveaux
rangs reprennent désormais après le dernier rang existant.

Régénérer une paie contrepasse d'abord les retenues d'avance qu'elle portait —
sans cela, préparer deux fois la paie retenait deux fois la même échéance et le
salarié remboursait le double. Vérifié explicitement par la suite.
| 084 | Acomptes / dépôts clients (sable et ciment) | **fait** — 47/47 |

### Décision 084
Un dépôt n'est **pas** une vente. Il augmente la trésorerie mais du côté du
passif : c'est une **dette envers le client** (« Avances reçues des clients »)
tant qu'aucune facture ne l'absorbe. Le comptabiliser en chiffre d'affaires
gonflerait le résultat d'un mois avec de l'argent qui ne l'a pas encore mérité.

La règle qu'il ne faut pas perdre de vue : **l'argent n'entre en banque qu'une
fois, au versement**. Imputer un dépôt sur une facture ne fait entrer aucun
argent — cela solde une dette contre une créance. C'est l'erreur la plus
naturelle du domaine (encaisser la facture « payée par acompte » comme un vrai
encaissement) et elle double le chiffre d'affaires sans que le solde bancaire
ne la contredise, puisqu'il a bel et bien augmenté… un mois plus tôt. La suite
vérifie explicitement que le solde bancaire **ne bouge pas** à l'imputation.

Affectation **FIFO** par défaut (le plus ancien versement sert en premier),
avec possibilité de flécher un dépôt nommément.

Sable et ciment ayant chacun leurs tables de clients et de factures avec des
identifiants qui se recoupent, un dépôt porte le couple (activité, id) plutôt
qu'une clé étrangère. Le prix : PostgreSQL ne peut pas garantir l'intégrité
référentielle, donc les routes vérifient l'existence dans la table de **leur**
activité à chaque écriture — ce qui assure aussi l'isolation inter-sociétés
(vérifiée : FAT & MAT ne peut pas déposer sur un client Triangle).

L'état du dépôt recalcule son solde **ligne à ligne** et signale
(`coherent: false`) toute divergence avec la fiche : un état doit pouvoir se
vérifier à la main.
| 085 | Fiscalité Mali — moteur versionné, **aucun taux activé** | **fait** — 57/57 |

### Décision 085 — ce qui n'est volontairement PAS activé
**Aucune règle n'est posée avec un taux actif. Pas une.**

Les valeurs qui circulent (CFE 3,5 %, CGS 0,5 %, TFP 2 %, TEJ 2 %, taxe
logement 1 %, impôt synthétique 3 %) sont des **candidats**, pas des vérités :
elles dépendent du régime réel de la société, de son activité, de sa
localisation et de la loi de finances en vigueur. La patente n'a jamais de
montant unique universel.

Recherche menée le 2026-09-04. Sources consultées :
- Direction Générale des Impôts du Mali — https://www.dgi.gouv.ml/
- Code général des impôts — https://www.dgi.gouv.ml/CGI/
- Ministère de l'Économie et des Finances — https://finances.ml/node/264
- Loi de finances / budget — https://budget.gouv.ml/

**Un seul chiffre a pu être corroboré, et encore indirectement** : la CFE à
3,5 % sur les rémunérations brutes. Aucune de ces sources n'a pu être lue
article par article depuis cet environnement. Inscrire ces taux comme actifs
reviendrait à faire calculer des montants que personne n'a vérifiés — et qu'un
comptable déclarerait ensuite à l'administration.

Le catalogue est donc chargé avec **15 types** (code, nom, explication simple,
organisme, base, périodicité) et **zéro taux**. Une règle naît toujours
`A_VERIFIER`, quel que soit ce que le client envoie ; elle ne calcule rien tant
qu'une personne ne l'a pas validée **avec sa référence de texte officiel** —
exigence portée par une contrainte PostgreSQL, pas seulement par la route.

Aucune pénalité n'est inventée : sans règle validée, l'API renvoie le message
convenu « Taux de pénalité non configuré — vérifier auprès de la DGI ou du
comptable. »

Déclarer crée une **dette** (écritures au passif) **sans toucher la
trésorerie** ; seul le paiement débite, une fois, et produit une quittance.
Vérifié explicitement par la suite.
| 086 | Régularisation exceptionnelle des pointages (`--preview`/`--apply`) | **fait** — 39/39 |

### Décision 086
Le piège aurait été d'écrire directement dans `attendance_day_records_v2` des
arrivées à 08h00 : plus rien ne distinguerait alors un pointage **réel** d'un
pointage **supposé**, ni à l'écran, ni dans un rapport, ni des mois plus tard
quand quelqu'un contestera une absence.

Le script n'écrit donc **jamais** dans les pointages bruts — la suite le
vérifie en comparant leur empreinte avant/après. La valeur retenue vit à côté,
dans `attendance_regularizations`, avec valeur d'origine, valeur effective,
motif, auteur et lot. Une absence réelle se marque **par-dessus**
(`overridden_*`), sans rien effacer.

`--date-to` est **obligatoire** : le script n'utilise jamais « aujourd'hui »,
sans quoi une exécution dans six mois régulariserait six mois de journées que
personne n'a demandées.

Idempotence par clé déduite de **tous** les paramètres qui changent le
résultat (période, mode du samedi, fériés, heures, employés) — sinon corriger
le mode du samedi et relancer ne changerait rien, en silence. Verrou
consultatif par société : deux exécutions simultanées produisent **un** lot et
11 lignes, pas 22 (éprouvé).

Preview d'exemple destiné à la production : voir le rapport final.
| 087 | Rapports de pointage, tableau de bord, notifications idempotentes | **fait** — 45/45 |

### Décision 087
**Les rapports lisent la valeur EFFECTIVE, pas la valeur brute.** L'ordre de
résolution de chaque journée : absence marquée par-dessus une régularisation →
valeur régularisée → pointage brut → absence si la journée était due. Chaque
ligne dit **d'où vient sa valeur** (`source`), pour qu'un chiffre contesté
puisse être remonté jusqu'à son origine.

Durées en **heures et minutes**, jamais en décimal : 7 h 30, pas 7,5. Un jour
férié n'est ni un jour dû ni une absence. QR et MANUEL apparaissent dans le
même rapport, distingués par leur source.

**Notifications** : `notifications` n'avait aucune contrainte d'unicité, donc
chaque passage d'un déclencheur recréait la même ligne. Au bout d'une semaine,
la cloche affichait quarante fois la même alerte et plus personne ne la
regardait — une notification répétée ne prévient pas davantage, elle prévient
moins. Une clé d'**événement** (pas de message) rend l'insertion idempotente :
six rafraîchissements de suite ne créent rien de plus (éprouvé).

Les destinataires sont choisis d'après les **droits**, pas les rôles :
prévenir « les comptables » laisserait de côté celui à qui on vient d'accorder
la préparation de la paie par exception personnelle.

---

## 3. Deux fragilités de tests corrigées à la validation finale

**Dépendance au jour de la semaine.** Les suites QR, avances et FAT & MAT
posaient un horaire « lundi au samedi » puis pointaient *aujourd'hui*. Lancées
un dimanche, elles échouaient sur « jour non travaillé » — un jour sur sept,
pour une raison sans aucun rapport avec ce qu'elles vérifient. Les jeux d'essai
ouvrent désormais tous les jours (ces suites portent sur les badges, les
avances et les droits, pas sur le calendrier) ; la suite FAT & MAT ouvre le
jour courant sans toucher au calendrier métier posé par le script de
configuration **réel**, qui reste lundi-samedi. Le dimanche chômé et le samedi
configurable sont éprouvés là où c'est leur sujet : suites des périodes et des
rapports.

**`/companies/available` était cassée.** Elle interrogeait
`user_company_access.is_active` — une table absente de toute migration, et une
colonne qui n'existe pas dans celle posée depuis (079, où elle se nomme
`active`). Le sélecteur d'entreprise restait donc **vide pour un super admin**,
en silence : la requête échouait, le catch renvoyait `[]`, et un sélecteur vide
se confond avec « une seule entreprise ». Elle délègue maintenant au service
d'accès — ce qui ouvre du même coup le sélecteur aux comptes habilités.

---

## 4. Audit correctif — quatre défauts bloquants

### 1. La validation de la Direction était contournable
`POST /attendance-v2/payroll-items/:id/pay` n'exigeait une demande validée que
si une demande **existait déjà**. Une paie neuve dont personne n'avait rien
soumis restait payable : il suffisait de ne pas soumettre pour n'avoir
personne à convaincre. Les contrôles étaient de surcroît faits **avant** le
`BEGIN`, sur des lignes non verrouillées.

Corrigé : tout se passe dans une seule transaction, la ligne de paie est
verrouillée d'abord, et l'exception historique est **nommée** (migration 088,
colonne `legacy_sans_validation`) au lieu d'être déduite de l'absence d'un
objet. Seules les paies existant au moment de la migration, et sans période, la
portent ; toute paie créée ensuite naît à `false`. L'exception ne peut donc pas
s'élargir. Le décideur doit en outre être différent du demandeur, y compris
pour une demande auto-validée écrite directement en base.

### 2. Le RBAC lisait les droits de la mauvaise société
`chargerContexte()` lisait `user.company_id` — la société d'**origine**. Un
comptable habilité qui basculait sur FAT & MAT y était jugé selon ses droits
Triangle.

Corrigé : `chargerContexte`, `droitsEffectifs` et `creerRequirePermission`
prennent la société **effective**, résolue par l'en-tête validé (jamais par
`req.body`). Un `x-active-company-id` non autorisé est **refusé** (403,
`COMPANY_NOT_ALLOWED`) au lieu d'être ignoré — l'ignorer ferait travailler la
personne dans sa société d'origine en croyant être dans l'autre. Le frontend
recharge ses droits à chaque bascule et refuse d'utiliser un cache portant sur
une autre société.

### 3. La paie était calculée sur un mois civil
`calculatePayroll()` calculait du 1er au 31 alors que l'écran annonçait du 25
au 24 : une présence du 25 août tombait hors de la paie de septembre.

Corrigé : `POST /paie/periodes/:code/preparer` part des bornes enregistrées,
exige un pointage validé, utilise les valeurs **effectives** après
régularisation, et rattache `period_id` — ce que l'ancienne route ne faisait
pas, laissant une paie orpheline que le verrou prenait pour une paie
historique. L'ancien point d'entrée refuse désormais si une période existe.
Unicité `(company_id, period_id)` garantie par la base.

### 4. Navigation
Les sept écrans sont au menu, chacun piloté par `can(module, action)` — un
employé sans droits n'en voit aucun. Les anciens écrans restent joignables sous
un libellé qui dit ce qu'ils sont (« Badges des comptes », « Ancien scan »).

**Défaut de mise en page trouvé en vérifiant à 375 px** : `w-64` dans un flex
en ligne, sans `shrink-0`, s'écrasait à 48 px — les libellés s'y empilaient
lettre par lettre. Le menu passe désormais au-dessus du contenu sur téléphone
(`flex-col md:flex-row`), avec des cibles de 48 px sur 327.

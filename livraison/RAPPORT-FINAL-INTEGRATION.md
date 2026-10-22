# Rapport final — phase d'intégration

Branche : `claude/droits-permissions-erreur-comptes-dyg32h` (backend et frontend)
Date : 22 octobre 2026
État : **prêt à être vérifié. Rien n'a été déployé. Aucune donnée réelle n'a été touchée.**

---

## 1. Les fichiers exacts

### Backend — 77 fichiers, 12 commits (`91f717a..HEAD`)

**Migrations (5)**
```
sql/150_transferts_internes_de_fonds.sql
sql/151_correction_bons_comptables.sql
sql/152_contrepassation_paiements_ciment.sql
sql/153_correction_demandes_validees.sql
sql/154_documents_rh.sql
sql/README-NUMEROTATION.md
```

**Retour arrière des migrations (5, nouveaux)**
```
sql/retour/150_transferts_internes_de_fonds_defaire.sql
sql/retour/151_correction_bons_comptables_defaire.sql
sql/retour/152_contrepassation_paiements_ciment_defaire.sql
sql/retour/153_correction_demandes_validees_defaire.sql
sql/retour/154_documents_rh_defaire.sql
```

**Services (8 nouveaux)**
```
services/transferts-internes.js      services/bons-comptables.js
services/demandes-correction.js      services/reconciliation-fatmat.js
services/rh-bulletin.js              services/pdf-documents-rh.js
services/format-pdf.js               services/routes-en-double.js
```

**Routeurs (4 nouveaux, 6 modifiés)**
```
nouveaux : routes/transferts-internes.js  routes/bons-comptables.js
           routes/cement-sales-cancellation.js  routes/documents-rh.js
modifiés : routes/stock-workflow.js  routes/stock-locations.js
           routes/cement-sales.js  routes/sand-sales-cancellation.js
           routes/bons-livraison-pdf.js  routes/meeting-presentation.js
```

**Modifiés par ailleurs**
```
server.js                      (montage des routeurs + détection des routes masquées)
services/location-rules.js     (PLACEHOLDER_RE : X{2,} au lieu de X+)
services/pdf-bon-livraison.js  (passe par services/format-pdf.js)
scripts/test-vente-sable-annulation.js
```

**Outils de livraison (6)**
```
livraison/deployer.sh                 déploiement, sauvegarde vérifiée, santé
livraison/retour-base.sh              retour arrière de la base, trois niveaux
livraison/repetition-deploiement.sh   répétition complète sur base jetable
livraison/rapport-fatmat.sh           rapport FAT & MAT, strictement en lecture
livraison/recuperer-v16.sh            récupération V16 depuis le VPS, en lecture
scripts/verifier-migrations.js        détection des collisions, en lecture
scripts/comparer-rh-v16.js            comparaison V16 / branche
```

**Documentation**
```
livraison/PROCEDURE-DEPLOIEMENT.md    livraison/PLAN-RETOUR-ARRIERE.md
livraison/RAPPORT-DE-LIVRAISON.md     livraison/RAPPORT-FINAL-INTEGRATION.md
sql/README-NUMEROTATION.md
livraison/documents-rh-demonstration/*.pdf   (9 PDF de démonstration)
```

**Tests (26 fichiers)** — détail au §4.

### Frontend — 13 fichiers, 4 commits (`4c6e7fd..HEAD`)

```
nouveaux : app/comptabilite/TransfertsInternes.tsx
           app/ciment/factures/PaiementsFacture.tsx
           app/demandes-stock/CorrigerDemande.tsx
           app/rh/page.tsx
           scripts/verif-transferts-internes.js
           scripts/verif-ecrans-integration.js
modifiés : app/comptabilite/page.tsx       app/ciment/factures/page.tsx
           app/demandes-stock/page.tsx     app/components/BinSelector.tsx
           app/stocks/page.tsx
           components/DashboardBackButton.tsx
           components/InternalChatShareButton.tsx
```

---

## 2. Les migrations et leurs dépendances

### La renumérotation, et pourquoi

Le numéro **106 est pris en production** par les documents RH de la V16, posés
hors de Git. Les cinq migrations du lot occupaient 103 à 107. Elles ont été
déplacées dans un bloc réservé, **150 à 199** :

| Avant | Après | Objet |
|---|---|---|
| 103 | **150** | transferts internes de fonds |
| 104 | **151** | correction des bons comptables |
| 105 | **152** | contrepassation des paiements ciment |
| 106 | **153** | correction des demandes validées |
| 107 | **154** | documents RH |

Les numéros **100, 101 et 102 n'ont pas été touchés** : ils peuvent déjà être
appliqués en production sous ces noms, et les renommer créerait la collision
qu'on cherche à éviter.

### Dépendances

| Migration | Exige | Remarque |
|---|---|---|
| 150 | `accounting_transactions`, `users`, `companies` | ajoute `show_in_financial_movements`, `is_internal_transfer`, `internal_transfer_id` + contrainte FK |
| 151 | `cash_vouchers`, 063 (permissions) | — |
| 152 | `cement_sales`, `cement_payments`, 075 (annulation sable) | ajoute l'action `remboursement_constater` au **catalogue** `permission_actions` avant de l'utiliser |
| 153 | `stock_requests`, `stock_movements`, module `demande` existant | ajoute l'action `contrepasser` au catalogue |
| 154 | `attendance_employees`, 063 | indépendante des quatre autres |

Ordre imposé : **150 → 151 → 152 → 153 → 154**. Chacune est enveloppée dans sa
propre transaction et **idempotente** : `CREATE TABLE IF NOT EXISTS`,
`ADD COLUMN IF NOT EXISTS`, `ON CONFLICT`. Le second passage de la répétition
confirme qu'elles ne rejouent rien.

### Le piège des clés de permission

`services/permissions.js` normalise `cement` → `ciment` (table `ALIAS`). Un
droit accordé sous la clé anglaise **ne répond à aucune question** : le moteur
retombe sur le rôle, personne n'a rien, et le module reste invisible malgré la
permission. Tous les droits de 152 sont posés sous `ciment`, et la migration
avertit si un module `cement` apparaît.

### Le garde-fou avant d'appliquer

`scripts/verifier-migrations.js` compare, **en lecture seule**, les fichiers de
la branche au registre `schema_migrations` et aux objets réellement présents.
Il est branché sur `deployer.sh migrer`, donc sur le chemin qu'emprunte un vrai
déploiement.

Il distingue deux situations :

- **code 2 — conflit de structures.** La branche veut créer un objet qui existe
  déjà. Le déploiement **s'arrête**.
- **code 3 — reconnaissance à faire.** Les tables RH de la V16 sont en base.
  Elles y seront toujours : en faire un blocage reviendrait à murer la porte. Le
  déploiement demande une attestation explicite, **une fois** :
  `V16_RH_RECONCILIEE=oui ./livraison/deployer.sh deployer`.

---

## 3. Les écrans réellement utilisables

| Écran | Chemin | Ce qu'on peut y faire |
|---|---|---|
| **Transferts internes** | `app/comptabilite/TransfertsInternes.tsx`, onglet de `/comptabilite` | Enregistrer un transfert banque↔caisse↔trésorerie, voir les deux soldes avant/après, annuler avec motif. L'écran affiche ce que le transfert **ne change pas** : ni recettes, ni dépenses, ni résultat. |
| **Paiements d'une facture ciment** | `app/ciment/factures/PaiementsFacture.tsx`, dans `/ciment/factures/[id]` | Historique complet, bouton « Annuler le paiement » avec motif obligatoire, et une phrase qui distingue l'annulation comptable du remboursement bancaire réel. |
| **Corriger une demande validée** | `app/demandes-stock/CorrigerDemande.tsx`, dans `/demandes-stock` | Ne propose que le geste qui a du sens pour l'état de la demande (dévalider / contre-passer / annuler). Motif de 10 caractères minimum avec compteur visible. Historique des corrections, mouvement par mouvement. Bloc spécifique aux inventaires, qui explique pourquoi la contre-passation n'y a pas de sens. |
| **Registres du personnel** | `app/rh/page.tsx`, `/rh` | Trois onglets : contrats, pièces remises, clauses. Affiche « masqué » et non zéro quand le droit `voir_remuneration` manque. |

Tous quatre ont été vérifiés dans un vrai navigateur, à 1280 px et à 375 px :
47 contrôles, dont la détection de recouvrement par `elementFromPoint`.

**Boutons posés dans les écrans existants** : « Transferts internes » dans
`/comptabilite`, « Annuler le paiement » dans la fiche facture ciment,
« Corriger » dans la liste des demandes.

---

## 4. Les tests — réussis, et non exécutés

### Exécutés le 22 octobre 2026, sur PostgreSQL 16 (port 5433)

| Suite | Contrôles | Résultat |
|---|---|---|
| `test-transferts-internes.sh` | 119 | **119 / 0** |
| `test-documents-rh.sh` | 94 | **94 / 0** |
| `test-demandes-correction.sh` | 85 | **85 / 0** |
| `test-contrepassation-ciment.sh` | 79 | **79 / 0** |
| `test-bons-comptables.sh` | 77 | **77 / 0** |
| `test-emplacements-zerbo.sh` | 69 | **69 / 0** |
| `test-reconciliation-fatmat.sh` | 50 | **50 / 0** |
| `test-retour-base.sh` | 49 | **49 / 0** |
| `repetition-deploiement.sh` | 49 | **49 / 0** |
| `test-ecrans-integration.sh` (navigateur) | 47 | **47 / 0** |
| `test-transferts-navigateur.sh` (navigateur) | 40 | **40 / 0** |
| **Total** | **758** | **758 / 0** |

La répétition du déploiement couvre : détection des conflits, `git fetch`,
`git checkout`, `git merge --ff-only` (y compris son **refus** quand la
production porte un commit local), `npm ci --omit=dev`, sauvegarde **restaurée
pour vérification**, migrations, idempotence, démarrage du serveur, contrôles de
santé, construction du frontend, retour arrière de la base et du code.

Elle tourne sur une base jetable qui reproduit le schéma de production,
**tables RH de la V16 comprises**, et vérifie qu'après les migrations ces tables
sont intactes et qu'aucune demande antérieure n'a été perdue ni modifiée
(comparaison d'empreinte de contenu, pas de simple comptage).

### Non exécutés, et pourquoi

| Ce qui n'a pas été testé | Raison |
|---|---|
| **Le déploiement sur le VPS réel** | Hors de portée de cette session (voir §7). Testé seulement sur base jetable. |
| **Le redémarrage PM2** | `pm2` n'est pas installé ici. Le script le détecte et le signale, mais le geste n'a jamais été exercé. |
| **La récupération V16 par SSH** | `livraison/recuperer-v16.sh` a été éprouvé sur un faux arbre local ; la connexion au VPS n'a pas eu lieu. |
| **Le niveau 3 du retour arrière, en vrai** | La restauration complète a été exercée par `deployer.sh retour` dans la répétition, mais pas la capture-puis-restauration de `retour-base.sh restaurer` de bout en bout. Ses refus et sa capture sont testés. |
| **Les 34 factures et 42 anomalies réelles de FAT & MAT** | La base de production n'est pas accessible d'ici. `livraison/rapport-fatmat.sh` a été éprouvé sur un jeu d'essai (40 factures, 9 anomalies) et produit un rapport exploitable. |
| **La charge, la concurrence** | Aucun test de montée en charge ni d'accès simultané. |

### Trois défauts que mes propres tests contenaient

Signalés parce qu'ils disent quelque chose sur la fiabilité d'un test vert :

1. La répétition affirmait « aucune donnée perdue : 0 avant, 0 après ». Elle
   comparait deux fois le vide. Elle écrit désormais trois demandes et compare
   une empreinte de contenu.
2. Le parcours Git se contentait de vérifier que le dépôt répondait. Il refait
   maintenant les gestes du déploiement sur une copie placée à l'état d'avant.
3. Un `| grep -q` combiné à `pipefail` transformait un contrôle réussi en échec :
   `grep` ferme le tube, le producteur reçoit SIGPIPE.

---

## 5. Les risques résiduels

### Décisions qui vous appartiennent

1. **Le rôle `admin` ne voit pas les registres RH.** La migration 154 sème
   `rh.document` pour `direction` et `comptable` seulement. C'est volontaire :
   ces documents portent les rémunérations, et `voir_remuneration` n'est pas un
   droit à accorder par défaut à un rôle technique. **Si vous voulez que
   l'administrateur y accède, dites-le** — c'est une ligne à ajouter, pas une
   correction.

2. **Les anciens mouvements qui ressemblent à des transferts internes.** La
   migration 150 crée une **vue** (`v_transferts_internes_candidats`) qui les
   recense, et **ne reclasse rien**. Reclasser en masse changerait des totaux
   déjà publiés — un bilan, un rapport remis — sans que personne puisse dire
   lesquels. À décider pièce par pièce.

3. **Les 42 anomalies FAT & MAT.** `livraison/rapport-fatmat.sh` les présente et
   désigne les candidates à l'annulation. Il n'annule rien et n'en a pas le
   pouvoir : les options `--appliquer`, `--annuler`, `--supprimer` et `--fix`
   n'existent pas.

### Défauts constatés, non corrigés (hors du cadre de l'intégration)

| Constat | Portée |
|---|---|
| **14 routes Express masquées** par un montage antérieur, dont des routes super-admin. Signalées à chaque démarrage par `services/routes-en-double.js`. | Antérieur au lot. Les corriger change le comportement de routes existantes. |
| **7 numéros de migration en double dans le dépôt** (000, 013, 040, 041, 042, 047, 090), tous antérieurs. | Documenté dans `sql/README-NUMEROTATION.md`. Sans effet tant qu'on n'y touche pas. |
| `app/stocks/page.tsx:1242` **débordement horizontal à 375 px**. | Écran antérieur. |
| **Migration `reminder_settings` manquante** : la table est utilisée, aucun fichier ne la crée. | Antérieur. |
| `role_permissions` **n'est pas semé pour une société créée après les migrations**. Les semis bouclent sur `SELECT id FROM companies`. | Structurel. Une nouvelle société n'a aucun droit sur les nouveaux modules jusqu'à configuration manuelle. |
| `scripts/test-bons-livraison-pdf.sh` cherche `../../frontend/` — chemin faux. | Test, pas code. |
| `test-acces-multi-societes.sh` échoue sur `column "active" does not exist`. | Antérieur au lot. |

### Ce qui n'est pas réversible automatiquement

- **Les migrations ne sont pas réversibles par PostgreSQL.** Les fichiers de
  `sql/retour/` sont écrits à la main. Il n'existe pas de « défaire la dernière
  migration ».
- **Un `DROP COLUMN` perd le contenu de la colonne.** Le niveau 2 l'exporte en
  CSV avant, mais un CSV n'est pas une remise en place.
- **Les soldes de trésorerie sont des cumuls.** Aucun retour arrière ne les
  recalcule.
- **Le niveau 3 perd les opérations postérieures à la sauvegarde**, sauf rejeu
  manuel.

---

## 6. Déploiement et retour arrière

### Avant

```bash
cd /var/www/triangle-wms/backend
./livraison/repetition-deploiement.sh          # 49 contrôles, base jetable
node scripts/comparer-rh-v16.js                # compare V16 et branche
./livraison/deployer.sh verifier               # ce qui serait appliqué
```

### Déployer

```bash
V16_RH_RECONCILIEE=oui ./livraison/deployer.sh deployer
```

Le script, dans cet ordre : prérequis → sauvegarde **restaurée pour
vérification** → détection des collisions → `git fetch` + `merge --ff-only`
(jamais `reset --hard`, jamais `clean`) → `npm ci --omit=dev` → migrations, une
transaction chacune → redémarrage PM2 de `triangle-backend` **seul** →
contrôles de santé.

Il s'arrête de lui-même si : moins de 500 Mo libres, la sauvegarde ne se
restaure pas, une collision de structures existe, la branche a divergé, une
migration échoue.

### Revenir en arrière

**Le code et la base ne se traitent pas de la même façon.** Le détail est dans
`livraison/PLAN-RETOUR-ARRIERE.md`. En résumé :

| | Quand | Perte |
|---|---|---|
| **Niveau 1** — remettre le code, laisser la base | défaut dans le code nouveau — **le cas courant** | **aucune** |
| **Niveau 2** — `retour-base.sh defaire-ajouts` | une structure nouvelle gêne réellement | contenu des nouvelles tables (exporté avant) |
| **Niveau 3** — `retour-base.sh restaurer <horodatage>` | le schéma est cassé | **tout ce qui a été saisi depuis la sauvegarde**, sauf rejeu manuel |

Le niveau 1 suffit parce que les cinq migrations sont **purement additives** :
l'ancien code n'interroge pas les nouvelles tables et ignore les nouvelles
colonnes.

Le niveau 2 **refuse** de retirer `show_in_financial_movements` tant que des
transferts internes existent : cela les ferait réapparaître dans les recettes et
les dépenses, et fausserait le résultat de l'entreprise.

Le niveau 3 **capture d'abord** tout ce qui a été écrit après la sauvegarde — un
CSV par table, avec un mode d'emploi du rejeu — puis vérifie que la sauvegarde
se restaure dans une base d'essai, puis sauvegarde l'état actuel, puis demande
une phrase tapée à la main. Il ne restaure pas si la sauvegarde ne se relit pas.

---

## 7. Ce que cette session n'a pas pu faire

La mission V17 décrit un environnement auquel cette session **n'a aucun accès**.
Vérifié, pas supposé :

| Chemin annoncé | État ici |
|---|---|
| `/var/www/triangle-wms/backend` et `/frontend` | absent |
| `/root/triangle-v17-final-20261022/` (archive, bundles, `deployer-v17.sh`) | absent |
| `/root/triangle-v17-fusion-backend` (`integration-v16-v17`, `212d27e`) | absent |
| `/root/triangle-v17-fusion-frontend` (`integration-v16-v17-frontend`, `dc6ef49`) | absent |
| `/root/triangle-v17-conflits-frontend.tar.gz` | absent |
| `/root/triangle-backups/`, `/root/triangle-v17-backups/` | absents |
| base `triangle_wms` | inaccessible |
| `pm2` | non installé |
| commits `e9ec8fb`, `8e07584`, `212d27e`, `dc6ef49` | inconnus des deux dépôts |

Cette session tourne dans un conteneur isolé qui contient **deux dépôts Git
clonés** (`triangle-wms-backend`, `triangle-wms-frontend`) et une base
PostgreSQL de test. Elle ne voit pas votre VPS et n'a aucun moyen de l'atteindre.

**Ne peuvent donc pas être faits d'ici** : la revue des sept conflits backend
déjà résolus, la résolution des quatre conflits frontend, la vérification des
fichiers non suivis du snapshot V16, le contrôle des sauvegardes existantes,
l'audit de l'archive V17, et l'empreinte SHA-256 d'une archive que je ne peux
pas constituer.

Ce qui **peut** l'être, et ce qui reste à faire des points 4, 6, 9 et 10 de
votre mission, est au §8.

---

## 8. Les points de la mission V17 : où en est chacun

| Point | État |
|---|---|
| **§4** Factures et paiements — historique, annulation avec motif, solde rétabli, pas de double encaissement, traces préservées, permissions, boutons avec confirmation, paiements partiels | **fait** pour le ciment et le sable (migration 152, `routes/cement-sales-cancellation.js`, écran `PaiementsFacture.tsx`, 79 contrôles) |
| **§4** Réaffecter un paiement à une autre facture | **absent** — reste à faire |
| **§5** Documents RH — contrats, attestations, certificats, bulletins, diplômes, PDF, archivage, permissions, confidentialité des salaires | **fait** (migration 154, `services/pdf-documents-rh.js`, écran `/rh`, 94 contrôles, 9 PDF de démonstration) |
| **§5** Aperçu avant validation, historique des versions | **partiel** — le PDF est généré et archivé ; l'aperçu-avant-validation et le versionnement ne sont pas là |
| **§6** Fatimata — distinguer vraies factures, renouvellements, doublons techniques, ressemblances légitimes ; présenter les cas suspects | **fait en lecture** (`livraison/rapport-fatmat.sh`, `services/reconciliation-fatmat.js`, 50 contrôles) |
| **§6** Neutraliser les doublons confirmés sans perdre l'historique | **absent** — reste à faire, et demande votre autorisation au cas par cas |
| **§7** Bons d'encaissement et de décaissement — consultation, brouillons, annulation contrôlée, contrepassation, motif, historique, permissions | **fait** (migration 151, 77 contrôles) |
| **§8** Transferts internes banque / caisse / trésorerie, atomiques, sans effet sur le résultat, annulables | **fait** (migration 150, 119 contrôles + 40 au navigateur) |
| **§9** États de factures — sélection, numérotation, PDF, archivage, exclusion des factures déjà utilisées, correction contrôlée, rapprochement des états historiques | **absent** — reste à faire, c'est le plus gros morceau |
| **§10** Stocks et emplacements (niveaux, rayons, bins, le problème de Zerbo) | **fait** (69 contrôles) |
| **§10** Matrice des fonctionnalités | **ce tableau en est le début** ; une matrice complète demande l'audit de l'archive V17, impossible d'ici |
| **§11** Phases A à E | A, C, D, E **faites dans le périmètre accessible** ; B (les deux fusions) hors de portée |

---

## 9. En une phrase

Les cinq parties de la mission précédente sont terminées, testées à 758
contrôles tous verts, renumérotées pour ne pas heurter le 106 de la V16, dotées
d'un déploiement répété à vide et d'un retour arrière à trois niveaux qui
n'écrase pas ce qui a été saisi depuis la sauvegarde. Rien n'est déployé. La
mission V17 suppose un accès au VPS que cette session n'a pas ; ce qui reste à
construire sans lui est listé au §8.

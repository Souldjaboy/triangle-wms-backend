# Rapport V17 — ce qui a été construit, testé, et ce qui reste

Branche : `claude/droits-permissions-erreur-comptes-dyg32h`, poussée sur les
deux dépôts.
Date : 22 octobre 2026.
**Rien n'a été déployé. Aucune donnée réelle n'a été touchée.**

> Les chiffres de tests ci-dessous valent pour **l'environnement isolé de
> cette session** : une base PostgreSQL 16 de travail, un jeu d'essai
> construit pour l'occasion, un Chromium local. Ils ne disent rien de votre
> VPS, dont cette session n'a aucune visibilité. Ce sont des tests de
> régression et de comportement, pas une validation de votre production.

---

## 1. Les quatre priorités

| | Backend | Migration | Écran | Tests API | Tests navigateur |
|---|---|---|---|---|---|
| **1. États de factures** | `services/etats-factures.js`, `services/pdf-etat-factures.js`, `routes/etats-factures.js` | 155 | `/etats-factures` | **126** | **52** |
| **2. Réaffectation des paiements** | `services/reaffectation-paiements.js`, `services/soldes-factures.js`, `routes/reaffectation-paiements.js` | 156 | fiche facture ciment + `/sable/impayes` | **96** | **33** |
| **3. Documents RH** | `routes/documents-rh.js`, `services/pdf-documents-rh.js` | 157 | `/rh` | **84** | **30** |
| **4. Factures en double** | `services/doublons-factures.js`, `routes/doublons-factures.js` | 158 | `/factures-doublons` | **86** | **42** |
| **5. Archives V16/V17** | `livraison/preparer-archives.sh` | — | — | éprouvées (voir §6) | — |

### 1. États de factures

Un état est une liste de factures arrêtée, numérotée (`ETS-…` pour le sable,
`ETC-…` pour le ciment), imprimée en PDF et conservée.

**La règle qui commande tout** : une facture ne figure que dans **un seul**
état validé. Elle n'est pas tenue par le code mais par un **index unique
partiel**, maintenu par un déclencheur sur le statut de l'en-tête. Deux
personnes qui valident au même instant ne peuvent pas y faire entrer la même
facture : la seconde reçoit une violation d'unicité, traduite en message
lisible. Un test insère directement une ligne en double pour vérifier que la
base refuse ce que l'application aurait pu laisser passer.

Un brouillon ne bloque rien. Annuler libère. **Corriger n'efface pas** : un
nouvel état reprend les lignes, l'ancien passe REMPLACÉ, reste consultable et
imprimable, et cesse de réclamer.

**Les états antérieurs** se reprennent par leurs numéros de facture. Les
numéros qu'aucune facture enregistrée ne porte restent en ligne « non
rapprochée » et bloquent quand même ; une facture saisie plus tard se relie à
sa ligne. Tant que la reprise n'est pas déclarée achevée, l'écran dit qu'une
facture absente de la liste **peut** figurer sur un état papier, au lieu
d'affirmer le contraire.

### 2. Réaffectation des paiements

Un encaissement imputé à la mauvaise facture se corrigeait en le
contrepassant puis en le ressaisissant : deux écritures, et un encaissement
qui apparaît deux fois dans les recettes.

La réaffectation **déplace l'imputation et rien d'autre**. Le test compte les
lignes de `accounting_transactions` avant et après : aucune n'est créée. Les
deux factures sont recalculées depuis la somme réelle de leurs paiements non
contrepassés, jamais par différence. Le déplacement est atomique — il n'existe
aucun instant où le paiement serait libre et attribuable deux fois.

Un paiement contrepassé ne bouge plus. Une facture annulée ne reçoit rien. Le
trop-perçu n'est pas interdit mais se décide, et la décision reste.

### 3. Documents RH

**L'archive en est une.** Seules l'empreinte SHA-256 et les données étaient
gardées : réimprimer revenait à régénérer, et au moindre changement du
générateur le document reproduit n'aurait plus été celui remis au salarié. Les
octets sont désormais conservés, et l'empreinte revérifiée avant de servir la
pièce — une archive altérée est refusée, pas remise.

**Le versionnement s'applique là où la pièce a une identité naturelle.** Deux
bulletins de septembre sont deux versions d'un seul document : la seconde
remplace la première, avec motif obligatoire. Une attestation demandée en
janvier puis en juin, ce sont deux pièces — les chaîner aurait exigé un
« motif de correction » pour une demande ordinaire.

**L'aperçu** construit le même document, filigrané « APERÇU — NON ÉMIS » en
travers de chaque page, et n'enregistre rien — sauf le fait qu'on ait regardé.

### 4. Factures en double

Deux factures du même client et du même montant **ne sont pas un doublon**.
Un client qui loue au mois en reçoit douze par an. Le module ne devine pas :
il rassemble les signaux — même vente, même référence, même jour, série
régulière, livraisons distinctes, encaissements des deux côtés — et installe
un registre de décisions.

**Il n'existe aucun chemin « tout nettoyer »** : trois URL de ce genre sont
testées et répondent 404. La neutralisation exige un verdict préalable
`DOUBLON_CONFIRME`, le choix explicite de la facture qui fait foi, et un motif.

Neutraliser ne supprime pas : la facture reste, annulée, désignant celle qui
fait foi, et ses encaissements sont portés sur elle **sans aucune écriture de
trésorerie**.

**Le cas qui arrête tout** : quand les deux factures ont été réglées, le
client a payé deux fois. La neutralisation refuse, chiffre les deux
encaissements et demande une confirmation explicite — après quoi le trop-perçu
reste **visible** plutôt que dissimulé.

---

## 2. Les défauts trouvés dans le code existant, et refermés

Ce ne sont pas des fonctionnalités : ce sont des choses qui ne marchaient pas.

| Constat | Où | Effet |
|---|---|---|
| **Les factures ANNULÉES comptaient parmi les impayés** | `/sand/invoices/unpaid` | Le « TOTAL RÉELLEMENT IMPAYÉ » était gonflé d'un montant que personne ne réclamera jamais |
| **Ni les états ni la réaffectation ne vérifiaient la souscription au module** | deux routeurs neufs | Une société sans le module sable aurait lu ses factures par les états |
| **La vente de sable ne suivait pas sa facture** | recalcul du sable | Après une contrepassation, le montant payé de la vente restait périmé |
| **Le même calcul de solde vivait en deux exemplaires** | annulations sable et ciment | Un troisième allait naître ; ils sont désormais dans `services/soldes-factures.js` |
| **`logActivity` appelé avec la requête HTTP** | mon propre code | PostgreSQL tentait une sérialisation circulaire ; les requêtes suivantes échouaient sur « Token invalide » |
| **Quatre migrations manquaient au retour arrière** | 155 à 158 | Un retour de niveau 2 les aurait laissées en place |

Et trois défauts dans mes propres sorties, trouvés en les regardant :

- les colonnes du PDF d'état totalisaient 562 points pour 515 utiles : la
  colonne « Restant » sortait de la feuille, titre rogné en « Restan » ;
- chaque écriture de colonne déplaçait le curseur vertical, si bien qu'une
  ligne pouvait être coupée entre deux pages ;
- `toLocaleString` sépare les milliers par une espace fine insécable,
  invisible mais présente : une recherche sur « 100 000 » tapé au clavier ne
  trouvait rien dans le message d'erreur du serveur.

---

## 3. Les migrations, et leurs dépendances

```
150  transferts internes          ← aucune
151  bons comptables              ← aucune
152  contrepassation ciment       ← 075
153  demandes validées            ← module « demande »
154  documents RH                 ← 063
155  états de factures            ← 052, modules sable et ciment
156  réaffectation des paiements  ← 152
157  versions des documents RH    ← 154
158  doublons de factures         ← 156
```

**L'ordre numérique respecte ces dépendances.** Les numéros 150–158 ont été
choisis pour ne pas approcher le **106**, déjà pris en production par les
documents RH de la V16.

Toutes sont **additives** : nouvelles tables, nouvelles colonnes avec valeur
par défaut, nouvelles vues, nouveaux droits. Aucune ne réécrit ni ne supprime
une donnée antérieure. Toutes sont **idempotentes** — la répétition le vérifie
en les rejouant.

Chacune a son fichier de défaire dans `sql/retour/`, et trois portent un
avertissement : supprimer le journal des réaffectations ne ramène pas les
paiements déplacés, supprimer le registre des verdicts ne rétablit pas les
factures neutralisées, et retirer `pdf_content` empêche de resservir les
pièces à l'identique.

---

## 4. Les tests — exécutés, et leurs résultats réels

### Sur l'API et la base (PostgreSQL 16, bases jetables)

| Suite | Contrôles |
|---|---|
| `test-etats-factures.sh` | **126 / 0** |
| `test-transferts-internes.sh` | **119 / 0** |
| `test-reaffectation-paiements.sh` | **96 / 0** |
| `test-documents-rh.sh` | **94 / 0** |
| `test-doublons-factures.sh` | **86 / 0** |
| `test-demandes-correction.sh` | **85 / 0** |
| `test-documents-rh-versions.sh` | **84 / 0** |
| `test-contrepassation-ciment.sh` | **79 / 0** |
| `test-bons-comptables.sh` | **77 / 0** |
| `test-emplacements-zerbo.sh` | **69 / 0** |
| `test-vente-sable-annulation.sh` | **60 / 0** |
| `test-retour-base.sh` | **58 / 0** |
| `test-reconciliation-fatmat.sh` | **50 / 0** |

### Dans un vrai navigateur (Chromium, 1280 px et 375 px)

| Suite | Contrôles |
|---|---|
| `test-ecrans-etats-factures.sh` | **52 / 0** |
| `test-ecrans-integration.sh` | **47 / 0** |
| `test-ecrans-doublons.sh` | **42 / 0** |
| `test-transferts-navigateur.sh` | **40 / 0** |
| `test-ecrans-reaffectation.sh` | **33 / 0** |
| `test-ecrans-rh-versions.sh` | **30 / 0** |

### Le parcours de déploiement

`livraison/repetition-deploiement.sh` — **63 / 0**. Sur une base jetable qui
reproduit le schéma de production, tables RH V16 comprises : détection des
conflits, `git fetch`, `git merge --ff-only` (y compris son **refus** quand la
copie porte un commit local), `npm ci --omit=dev`, sauvegarde **restaurée pour
vérification**, migrations, idempotence, dix tables, cinq colonnes ajoutées à
des tables antérieures, quatre vues interrogeables, démarrage, santé, build du
frontend, retour arrière de la base et du code.

**Total : 1 083 + 244 + 63 = 1 390 contrôles, tous verts.**

### Ce qui n'a PAS été testé

| | Pourquoi |
|---|---|
| **Votre VPS** | Hors de portée de cette session (voir §7) |
| **Le redémarrage PM2** | `pm2` n'est pas installé ici ; le script le détecte et le signale |
| **La récupération V16 par SSH** | Éprouvée sur un faux arbre local ; la connexion n'a pas eu lieu |
| **Les 34 factures et 42 anomalies réelles de FAT & MAT** | La base de production n'est pas accessible |
| **Le niveau 3 du retour arrière de bout en bout** | Ses refus et sa capture sont testés ; la restauration complète l'est par `deployer.sh retour` |
| **La charge et la concurrence** | Aucun test de montée en charge |
| **Les doublons réels de Fatimata** | Les signaux sont éprouvés sur un jeu construit, pas sur vos données |

---

## 5. Les écrans réellement utilisables

| Écran | Chemin | Ce qu'on y fait |
|---|---|---|
| **États de factures** | `/etats-factures` | Cocher des factures, créer un brouillon, le valider, l'imprimer, l'annuler, le corriger, reprendre un état papier. Les factures déjà prises restent **visibles, barrées**, avec le numéro de l'état qui les détient |
| **Factures en double** | `/factures-doublons` | Voir les paires avec leurs signaux, trancher (doublon / renouvellement / distinctes), neutraliser. Aucun bouton « tout traiter » |
| **Registre du personnel** | `/rh` | État de chaque pièce, versions avec motifs, historique, réimpression de l'archive, annulation motivée |
| **Réaffecter un paiement** | fiche facture ciment, `/sable/impayes` | Voir les paiements, d'où ils viennent, les porter sur la bonne facture |
| **Transferts internes** | `/comptabilite` | Banque ↔ caisse ↔ trésorerie, sans toucher au résultat |
| **Corriger une demande** | `/demandes-stock` | Dévalider, contre-passer, annuler, avec motif et historique |

Chaque confirmation **énonce ce qui devient impossible ensuite** au lieu de
demander « Êtes-vous sûr ? », et chaque motif obligatoire a son compteur
visible.

---

## 6. Les archives transférables

Votre dépôt et celui de ce poste n'ont pas la même histoire. Le lot est donc
livré sous **trois formes**, et les deux premières ont été **éprouvées** :
une copie placée à l'état d'avant récupère le bundle et fusionne sans conflit,
une autre rejoue les 101 correctifs avec `git am --3way`.

| Forme | Fichier | Quand |
|---|---|---|
| Bundle Git | `backend-*.bundle`, `frontend-*.bundle` | Si les dépôts ont un ancêtre commun |
| Correctifs | `correctifs/*.patch` | Sur n'importe quelle base |
| Fichiers | `*-fichiers-*.tar.gz` | Dernier recours |

Plus : les 9 migrations et leurs 9 fichiers de défaire, la documentation, et
les outils (`deployer.sh`, `retour-base.sh`, `repetition-deploiement.sh`,
`rapport-fatmat.sh`, `recuperer-v16.sh`).

**180 fichiers empreints**, vérifiables d'un `sha256sum -c MANIFESTE-SHA256.txt`.

La marche à suivre est dans `INTEGRATION-V16-V17.md` : elle ne suppose rien de
votre historique, donne l'ordre d'intégration et ce qu'il faut regarder après.

---

## 7. Ce que cette session n'a pas pu faire

Vérifié, pas supposé : aucun des chemins de votre mission n'existe ici.
`/var/www/triangle-wms`, `/root/triangle-v17-final-20261022/`,
`/root/triangle-v17-fusion-backend`, `/root/triangle-v17-fusion-frontend`,
`/root/triangle-v17-conflits-frontend.tar.gz`, `/root/triangle-backups/`, la
base `triangle_wms`, `pm2` — absents. Les commits `e9ec8fb`, `8e07584`,
`212d27e`, `dc6ef49` sont inconnus des deux dépôts.

**Ne peuvent donc pas être faits d'ici** : la revue des 7 conflits backend
déjà résolus, la résolution des 4 conflits frontend, la vérification des
fichiers non suivis du snapshot V16, le contrôle de vos sauvegardes, l'audit
de l'archive V17 existante.

C'est précisément pour cela que le lot est livré sous trois formes
transférables : il s'intègre à votre fusion sans exiger que les histoires
coïncident.

---

## 8. Les risques résiduels

### Décisions qui vous appartiennent

1. **Le rôle `admin` ne voit pas les registres RH.** Volontaire : ces pièces
   portent les rémunérations. Si vous voulez que l'administrateur technique y
   accède, c'est une ligne à ajouter — dites-le.
2. **Les anciens mouvements qui ressemblent à des transferts internes** sont
   recensés par une vue, et **ne sont pas reclassés**. Reclasser en masse
   changerait des totaux déjà publiés.
3. **Les 42 anomalies FAT & MAT** sont présentées par `rapport-fatmat.sh`, qui
   n'annule rien et n'en a pas le pouvoir.
4. **Les doublons de Fatimata** : le module propose, il ne tranche pas. Aucune
   facture réelle n'a été neutralisée.

### Défauts constatés, non corrigés (hors du périmètre)

| Constat | Portée |
|---|---|
| **14 routes Express masquées** par un montage antérieur, dont des routes super-admin | Antérieur au lot ; signalées à chaque démarrage |
| **7 numéros de migration en double dans le dépôt** (000, 013, 040, 041, 042, 047, 090) | Antérieurs ; documenté dans `sql/README-NUMEROTATION.md` |
| `app/stocks/page.tsx:1242` **débordement horizontal à 375 px** | Écran antérieur |
| **Migration `reminder_settings` manquante** | Antérieur |
| `role_permissions` **n'est pas semé pour une société créée après les migrations** | Structurel ; une nouvelle société n'a aucun droit sur les nouveaux modules |
| `test-acces-multi-societes.sh` échoue sur `column "active" does not exist` | Antérieur |

### Ce qui n'est pas réversible automatiquement

- **Les migrations ne sont pas réversibles par PostgreSQL.** Les fichiers de
  `sql/retour/` sont écrits à la main.
- **Un `DROP COLUMN` perd le contenu de la colonne.** Le niveau 2 l'exporte
  avant, mais un CSV n'est pas une remise en place.
- **Les paiements déplacés ne reviennent pas** en supprimant leur journal.
- **Les factures neutralisées restent annulées** si l'on supprime le registre
  des verdicts.
- **Les soldes de trésorerie sont des cumuls** : aucun retour arrière ne les
  recalcule.
- **Le niveau 3 perd les opérations postérieures à la sauvegarde**, sauf rejeu
  manuel.

---

## 9. Ce qui reste du cahier des charges V17

| Point | État |
|---|---|
| §4 Factures et paiements, y compris **réaffectation** | **fait** |
| §5 Documents RH, **aperçu, versions, archivage** | **fait** |
| §6 Fatimata, doublons et **neutralisation contrôlée** | **fait** — aucune facture réelle neutralisée |
| §7 Bons d'encaissement et de décaissement | **fait** (mission précédente) |
| §8 Transferts internes | **fait** (mission précédente) |
| §9 États de factures | **fait** |
| §10 Stocks et emplacements | **fait** (mission précédente) |
| §10 Matrice des fonctionnalités | **partielle** — ce rapport en tient lieu pour ce qui est accessible ; une matrice complète demande l'audit de l'archive V17, impossible d'ici |
| §11 Phase B — les deux fusions | **hors de portée** : demande votre VPS |
| §12 Archives, empreintes, scripts, rapport | **fait** |

---

## 10. En une phrase

Les quatre priorités sont construites, branchées à des écrans réellement
utilisables, et éprouvées par 1 390 contrôles verts **dans cet environnement
isolé** ; le lot est livré sous trois formes transférables avec leurs
empreintes, et s'intègre à votre fusion sans exiger que les histoires
coïncident. Rien n'est déployé, et aucune facture, aucun paiement, aucun
document réel n'a été modifié.

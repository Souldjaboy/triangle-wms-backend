# Intégrer ce lot à votre VPS

## Ce que ce document ne suppose pas

Votre dépôt et celui sur lequel ce travail a été fait **n'ont pas forcément la
même histoire**. Des fusions y ont été faites — `integration-v16-v17`,
`integration-v16-v17-frontend` —, des commits y existent que ce poste ne
connaît pas, et les identifiants annoncés (`e9ec8fb`, `212d27e`, `dc6ef49`…)
sont inconnus ici.

C'est pourquoi le lot est livré sous **trois formes** du même travail, et non
sous la forme d'un commit à récupérer. Prenez la première qui s'applique.

## Avant tout : vérifier ce que vous avez reçu

```bash
sha256sum triangle-livraison-<horodatage>.tar.gz
```

Comparez caractère pour caractère avec l'empreinte donnée dans le rapport.
Puis, après extraction :

```bash
cd archives && sha256sum -c MANIFESTE-SHA256.txt
```

Chaque ligne doit dire `OK`. Une seule ligne `ÉCHEC` signifie que le fichier a
été altéré pendant le transfert : recommencez le transfert, n'intégrez rien.

---

## Forme 1 — le bundle Git (à essayer en premier)

Un bundle est un dépôt dans un fichier. Il garde l'historique, les messages de
commit et les auteurs.

```bash
cd /var/www/triangle-wms/backend        # ou votre copie de travail
git bundle verify /chemin/backend-<horodatage>.bundle
git fetch /chemin/backend-<horodatage>.bundle \
    claude/droits-permissions-erreur-comptes-dyg32h:lot-integration
git log --oneline HEAD..lot-integration    # ce que le lot apporte
git merge lot-integration
```

`git bundle verify` dit de quels commits le bundle a besoin. S'il répond qu'il
lui manque des objets, c'est que vos deux dépôts n'ont pas d'ancêtre commun
reconnaissable : passez à la forme 2.

> **Ne faites pas `git merge` à l'aveugle.** Lisez d'abord
> `git log --oneline HEAD..lot-integration` et `git diff --stat`. Si vous avez
> modifié les mêmes fichiers sur le VPS, résolvez les conflits à la main —
> en particulier `server.js`, qui porte les montages de routeurs.

## Forme 2 — la série de correctifs

Un fichier `.patch` par commit, applicable sur **n'importe quelle** base.

```bash
cd /var/www/triangle-wms/backend
git checkout -b lot-integration
git am --3way /chemin/correctifs/*.patch
```

Sur un conflit, `git am` s'arrête et le dit :

```bash
git status                       # les fichiers en conflit
# … résolvez …
git add <fichiers>
git am --continue
```

Pour abandonner proprement : `git am --abort`.

L'option `--3way` permet à Git de résoudre seul les décalages de contexte
quand il retrouve les versions d'origine des fichiers.

## Forme 3 — l'archive des fichiers (dernier recours)

Quand ni l'un ni l'autre ne s'applique — dépôts sans ancêtre commun, histoire
réécrite, copie de travail sans Git.

```bash
cd /var/www/triangle-wms/backend
git checkout -b lot-integration
tar xzf /chemin/backend-fichiers-<horodatage>.tar.gz -C .
git status                       # ce qui a changé
git add -A && git commit -m "Intégration du lot"
```

> **Cette forme écrase les fichiers.** `fichiers-modifies.txt` liste
> exactement ce qui sera remplacé. Relisez-le avant de détarer, et surtout les
> fichiers marqués `M` (modifiés) : ce sont ceux où votre VPS peut porter des
> changements que l'archive effacerait.

---

## L'ordre d'intégration, et pourquoi il compte

### 1. Le backend avant le frontend

Les écrans appellent des routes qui n'existent pas encore côté serveur. Un
frontend déployé en premier affiche des pages vides et des erreurs 404.

### 2. Les migrations après le code, avant le redémarrage

```bash
V16_RH_RECONCILIEE=oui ./livraison/deployer.sh deployer
```

Le script enchaîne tout dans le bon ordre et s'arrête de lui-même si quelque
chose ne va pas. Si vous préférez procéder à la main, l'ordre est :

| Étape | Commande |
|---|---|
| Vérifier les collisions | `node scripts/verifier-migrations.js` |
| Sauvegarder **et vérifier la sauvegarde** | `./livraison/deployer.sh migrer` (le fait) |
| Appliquer 150 → 158, dans l'ordre | une transaction chacune |
| Construire le frontend | `npm run build` |
| Redémarrer | `pm2 restart triangle-backend` |
| Contrôler | `./livraison/deployer.sh sante` |

### 3. Les dépendances entre migrations

```
150  transferts internes          ← aucune
151  bons comptables              ← aucune
152  contrepassation ciment       ← 075 (annulation sable)
153  demandes validées            ← module « demande » existant
154  documents RH                 ← 063 (permissions)
155  états de factures            ← 052 (sable), 0xx (ciment)
156  réaffectation des paiements  ← 152 (contrepassations)
157  versions des documents RH    ← 154
158  doublons de factures         ← 156
```

**L'ordre numérique suffit** : il respecte ces dépendances. N'en sautez
aucune — 158 appelle la réaffectation posée par 156, et 157 ajoute des
colonnes aux tables créées par 154.

### 4. Le numéro 106

Votre production porte déjà une migration `106` pour les documents RH, posée
hors de Git. Les migrations de ce lot occupent **150 à 158** précisément pour
ne pas s'en approcher. Les numéros 100, 101 et 102 n'ont pas été renumérotés :
ils peuvent déjà être appliqués chez vous sous ces noms.

### 5. La reconnaissance V16

Au premier déploiement, le détecteur s'arrête en disant que les tables RH de
la V16 sont en base. Ce n'est pas un conflit : les deux modèles coexistent —
les tables de ce lot s'appellent `hr_contracts`, `hr_documents`,
`hr_contract_clauses`, celles de la V16 `rh_*`. Comparez-les
(`node scripts/comparer-rh-v16.js`), puis attestez-le une fois :

```bash
V16_RH_RECONCILIEE=oui ./livraison/deployer.sh deployer
```

---

## Ce qu'il faut regarder après l'intégration

```bash
./livraison/deployer.sh sante
node server.js 2>&1 | head -40        # les routes masquées sont signalées ici
```

Au démarrage, le serveur liste les **routes masquées** : une route définie
deux fois, dont la seconde ne répondra jamais. Il y en a 14 d'origine, dont
des routes super-admin ; si le nombre augmente après l'intégration, c'est
qu'un montage de ce lot recouvre une de vos routes. Le message nomme laquelle.

Vérifiez ensuite que les nouveaux écrans répondent :

| Écran | Chemin |
|---|---|
| États de factures | `/etats-factures` |
| Factures en double | `/factures-doublons` |
| Registre du personnel | `/rh` |
| Transferts internes | `/comptabilite`, onglet |
| Corriger une demande | `/demandes-stock` |
| Paiements d'une facture | `/sable/impayes`, bouton « Paiements » |

Et que les droits sont semés pour **vos** sociétés : les migrations bouclent
sur `SELECT id FROM companies` au moment où elles tournent. Une société créée
après n'aura aucun droit sur les nouveaux modules tant que personne ne les
configure.

```sql
SELECT module_key, count(*) FROM role_permissions
 WHERE module_key IN ('etat_facture','comptabilite.transfert_interne',
                      'comptabilite.bon','rh.document')
 GROUP BY 1;
```

---

## Si quelque chose tourne mal

Le détail est dans `PLAN-RETOUR-ARRIERE.md`. En une ligne : **remettre le code
en arrière suffit presque toujours**, parce que les neuf migrations n'ajoutent
que des structures et que l'ancien code les ignore. Aucune donnée n'est perdue
dans ce cas.

```bash
./livraison/retour-base.sh verifier    # ne touche à rien, dit quoi faire
```

N'employez la restauration complète que si le schéma lui-même est cassé : elle
efface tout ce qui a été saisi depuis la sauvegarde. Le script capture ces
opérations avant de restaurer, mais leur rejeu est manuel.

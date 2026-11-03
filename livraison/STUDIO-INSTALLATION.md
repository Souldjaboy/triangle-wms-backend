# Triangle Studio Pro — installation et déploiement

Ce document décrit l'installation de **Triangle Studio Pro** dans une
instance Triangle WMS Pro existante, et les commandes à exécuter sur le VPS.

> **Ce qui n'a pas pu être fait depuis la session de développement.**
> Les essais rapportés ici ont tous tourné dans un conteneur isolé, sur une
> base PostgreSQL jetable. **Ni le VPS ni la machine de l'auteur n'étaient
> joignables** : aucun déploiement, aucune lecture et aucune écriture sur la
> production n'ont eu lieu. Les commandes ci-dessous sont donc à exécuter par
> quelqu'un qui a accès au serveur, et les vérifications qu'elles contiennent
> ne sont pas facultatives.

---

## 1. Ce que Studio ajoute

| Partie | Nature | Où |
|---|---|---|
| `sql/159_chat_pieces_jointes.sql` | migration | colonnes manquantes du chat + journal des pièces jointes |
| `sql/160_studio_fondation.sql` | migration | dossiers, documents, versions, partages, journal, 9 modules de droits |
| `sql/161_studio_scanner.sql` | migration | séances de numérisation et pages |
| `sql/162_studio_signatures.sql` | migration | signatures, cachets et trace des appositions |
| `sql/163_studio_creations.sql` | migration | le plan des créations graphiques, en colonnes de `studio_documents` |
| `sql/164_studio_presentations.sql` | migration | `design_kind`, qui sépare une planche d'une présentation |
| `services/studio-stockage.js` | code | dépôt privé des fichiers, hors du dossier servi en statique |
| `services/studio-bibliotheque.js` | code | dépôt, versions, corbeille, partages |
| `services/studio-scanner.js` | code | séances, pages, assemblage |
| `services/pdf-scan.js`, `services/image-dimensions.js` | code | assemblage PDF, orientation des pages |
| `services/pieces-jointes-chat.js` | code | service authentifié des pièces jointes du chat |
| `routes/studio-*.js`, `routes/pieces-jointes-chat.js` | code | les routes correspondantes |
| `app/studio/*` (frontend) | code | accueil, bibliothèque, scanner |
| `app/lib/vision.ts`, `app/lib/ocr.ts` | code | détection de contours, reconnaissance de texte |

**Aucune table existante n'est modifiée.** Les trois migrations n'ajoutent
que des tables, des colonnes et des index ; elles sont rejouables sans
dommage.

---

## 2. Avant toute chose : la sauvegarde

```bash
# Sur le VPS, en tant que root.
mkdir -p /root/triangle-backups
HORODATAGE=$(date +%Y%m%d-%H%M%S)

# La base, en format personnalisé (restaurable table par table).
sudo -u postgres pg_dump -Fc triangle_wms \
  > /root/triangle-backups/triangle_wms-$HORODATAGE.dump

# Le code, tel qu'il tourne en ce moment.
tar czf /root/triangle-backups/code-$HORODATAGE.tar.gz \
  -C /var/www/triangle-wms backend frontend \
  --exclude=node_modules --exclude=.next
```

**Une sauvegarde qu'on n'a pas essayé de restaurer n'est pas une
sauvegarde.** On vérifie qu'elle se relit, dans une base jetable :

```bash
sudo -u postgres createdb verif_sauvegarde
sudo -u postgres pg_restore -d verif_sauvegarde \
  /root/triangle-backups/triangle_wms-$HORODATAGE.dump 2>&1 | tail -20
# Doit se terminer sans « error ». On compte quelques tables au hasard :
sudo -u postgres psql -d verif_sauvegarde -c \
  "SELECT count(*) FROM users; SELECT count(*) FROM sand_invoices;"
sudo -u postgres dropdb verif_sauvegarde
```

Si la restauration échoue, **on s'arrête là**. Rien d'autre n'a de sens tant
qu'on ne peut pas revenir en arrière.

---

## 3. Récupérer le code

```bash
cd /var/www/triangle-wms/backend
git fetch origin claude/droits-permissions-erreur-comptes-dyg32h
git log --oneline HEAD..origin/claude/droits-permissions-erreur-comptes-dyg32h

# On regarde CE QU'ON VA PRENDRE avant de le prendre.
git diff --stat HEAD origin/claude/droits-permissions-erreur-comptes-dyg32h

git merge --ff-only origin/claude/droits-permissions-erreur-comptes-dyg32h
```

Si `--ff-only` refuse, c'est que la copie du serveur porte des commits
locaux. **Ne pas forcer.** Il faut d'abord regarder lesquels :

```bash
git log --oneline origin/claude/droits-permissions-erreur-comptes-dyg32h..HEAD
```

Même opération pour le frontend, dans `/var/www/triangle-wms/frontend`.

---

## 4. Les dépendances

### Backend

Trois dépendances nouvelles côté serveur :

| Paquet | À quoi il sert |
|---|---|
| `pdf-lib` | apposer les signatures, manipuler les pages, écrire les PDF de création et de présentation |
| `jszip` | lire et écrire les archives `.pptx` — une présentation Office est un ZIP de documents XML |
| `@xmldom/xmldom` | lire ces documents XML |

`pdfkit` — qui assemble les pages d'un scan — et `multer` étaient déjà là.

**`jszip` et `@xmldom/xmldom` étaient déjà présents sur le disque**, amenés
par d'autres paquets, mais pas déclarés. Ils le sont maintenant : s'appuyer
sur une dépendance transitive, c'est attendre qu'un `npm install` la fasse
disparaître. Un `npm install` est donc nécessaire sur le VPS, pas seulement un
`npm ci --omit=dev` sur le `package-lock.json` d'avant.

```bash
cd /var/www/triangle-wms/backend
npm ci --omit=dev
```

### Frontend

Quatre paquets nouveaux, tous pour la reconnaissance de texte :

| Paquet | Rôle | Poids installé |
|---|---|---|
| `pdfjs-dist` | afficher un PDF page par page, pour y placer une signature | ~15 Mo |
| `tesseract.js` | le moteur de lecture, côté navigateur | ~1 Mo |
| `tesseract.js-core` | son cœur WebAssembly, en six variantes | ~30 Mo |
| `@tesseract.js-data/fra` | les données du français | ~7 Mo |
| `@tesseract.js-data/eng` | les données de l'anglais | ~14 Mo |

```bash
cd /var/www/triangle-wms/frontend
npm ci
```

La compilation recopie automatiquement ce qu'il faut dans
`public/vendor/tesseract/` (environ 60 Mo servis) et `public/vendor/pdfjs/`
(1 Mo). Ces fichiers **ne sont pas versionnés** : le dépôt reste léger, et
`npm ci` les réapporte.

Pour les mettre en place sans compiler :

```bash
npm run installer-ressources
```

Si les paquets manquent, le script le dit et **n'interrompt pas la
compilation** : le Studio fonctionne alors sans reconnaissance de texte, et
l'écran l'annonce au lieu de proposer une fonction qui échouerait.

---

## 5. Les migrations

```bash
cd /var/www/triangle-wms/backend

# On regarde ce que chaque migration fait AVANT de l'appliquer.
less sql/159_chat_pieces_jointes.sql
less sql/160_studio_fondation.sql
less sql/161_studio_scanner.sql
less sql/162_studio_signatures.sql
less sql/163_studio_creations.sql
less sql/164_studio_presentations.sql

# Puis on applique, en s'arrêtant à la première erreur.
for f in sql/159_chat_pieces_jointes.sql \
         sql/160_studio_fondation.sql \
         sql/161_studio_scanner.sql \
         sql/162_studio_signatures.sql \
         sql/163_studio_creations.sql \
         sql/164_studio_presentations.sql; do
  echo "── $f"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" || { echo "ÉCHEC sur $f"; break; }
done
```

Vérification :

```bash
psql "$DATABASE_URL" -c "
  SELECT tablename FROM pg_tables
   WHERE tablename LIKE 'studio_%' OR tablename = 'chat_attachment_access'
   ORDER BY tablename;"
# Attendu : chat_attachment_access, studio_access_log, studio_document_versions,
#           studio_documents, studio_folders, studio_scan_pages,
#           studio_scan_sessions, studio_shares, studio_signature_uses,
#           studio_signatures

# La 163 n'ajoute aucune table : elle ajoute quatre colonnes à studio_documents.
psql "$DATABASE_URL" -c "
  SELECT column_name FROM information_schema.columns
   WHERE table_name = 'studio_documents' AND column_name LIKE 'design%'
   ORDER BY column_name"
# Attendu : design, design_format, design_mm_height, design_mm_width

# La 164 ajoute une colonne et sa contrainte. Les lignes existantes sont
# toutes des créations du studio graphique : les présentations n'existaient
# pas avant elle.
psql "$DATABASE_URL" -c "
  SELECT design_kind, count(*) FROM studio_documents
   WHERE design IS NOT NULL GROUP BY 1"
# Attendu : uniquement CREATION juste après la migration.
psql "$DATABASE_URL" -c "
  SELECT conname FROM pg_constraint
   WHERE conname = 'studio_documents_design_kind_chk'"
# Attendu : une ligne. Sans elle, une faute de frappe dans design_kind
#           casserait les deux listes sans qu'aucune erreur ne se produise.
```

### Les droits

La migration 160 pose les droits par défaut **pour les sociétés existantes au
moment où elle tourne** :

| Rôle | Studio |
|---|---|
| direction, admin, super_admin | tout, suppression définitive comprise |
| comptable, assistant_rh | déposer, modifier, partager — **pas** supprimer |
| magasinier | lecture seule |

Elle **ne touche jamais** un droit qu'un administrateur a réglé à la main
(`role_permissions.updated_by IS NOT NULL`). Une société créée *après* la
migration n'aura pas ces lignes : il faut alors les poser depuis l'écran des
droits, ou rejouer la migration.

Le module doit aussi être ouvert pour la société :

```sql
INSERT INTO company_modules (company_id, module_key, is_enabled)
VALUES (1, 'studio', TRUE), (2, 'studio', TRUE)
ON CONFLICT (company_id, module_key) DO UPDATE SET is_enabled = TRUE;
```

---

## 6. Le dépôt des fichiers

Les documents du Studio **ne sont pas dans `uploads/`**, qui est servi en
statique : ils vivent sous `storage/`, qu'aucun middleware ne sert.

```bash
cd /var/www/triangle-wms/backend
mkdir -p storage
chown -R <utilisateur-pm2>:<groupe> storage
chmod 750 storage
```

Pour le placer ailleurs — un disque plus grand, par exemple :

```bash
# Dans le .env du backend :
STUDIO_STORAGE_DIR=/var/lib/triangle-studio
```

**Ce dossier doit être sauvegardé comme la base.** La base porte les
empreintes et les droits ; les fichiers sont ici. L'un sans l'autre ne
restaure rien :

```bash
tar czf /root/triangle-backups/studio-$HORODATAGE.tar.gz \
  -C /var/www/triangle-wms/backend storage
```

Ne jamais exposer ce dossier par Nginx. Si une règle `location /storage`
existe, elle doit être supprimée.

---

## 7. Compiler et redémarrer

```bash
cd /var/www/triangle-wms/frontend
npm run build          # recopie aussi les fichiers de reconnaissance

pm2 restart triangle-backend
pm2 restart triangle-frontend
pm2 logs triangle-backend --lines 40
```

**Ne toucher à aucune autre application.** `pm2 restart all` redémarrerait
MaliLink et HAFIYA : on nomme les processus, toujours.

---

## 8. Vérifier que ça marche

```bash
# Le backend répond.
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5050/

# Les fichiers de reconnaissance sont servis (et ne sont PAS du HTML).
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
  https://trianglewmspro.com/vendor/opencv.js
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
  https://trianglewmspro.com/vendor/tesseract/worker.min.js
# Attendu : 200 application/javascript — PAS text/html.
# Un text/html ici veut dire que la requête a été redirigée vers /login :
# c'est le défaut corrigé par le filtre de routes, et il casse le scanner.

# AUCUNE URL ne doit atteindre un document du Studio.
CLE=$(psql "$DATABASE_URL" -tAc "SELECT storage_key FROM studio_documents LIMIT 1")
curl -s -o /dev/null -w "%{http_code}\n" "https://trianglewmspro.com/uploads/$CLE"
curl -s -o /dev/null -w "%{http_code}\n" "https://trianglewmspro.com/storage/$CLE"
# Attendu : 404 aux deux. Autre chose = les fichiers sont exposés, il faut
# arrêter et corriger la configuration Nginx avant d'aller plus loin.
```

Puis, dans un navigateur, connecté : **Tableau de bord → Triangle Studio**.

---

## 9. Revenir en arrière

Le retour est en cinq niveaux, du moins destructeur au plus. Les deux
intermédiaires ne défont qu'une migration chacun : le « 1 bis » la séparation
des planches et des présentations, le « 1 ter » les créations graphiques. Ni
l'un ni l'autre n'est nécessaire pour revenir au code d'avant — les deux
colonnes acceptent de rester.

### Niveau 1 — le code seul

Les trois migrations n'ajoutent que des tables et des colonnes : **l'ancien
code fonctionne sans elles**. Revenir au commit précédent suffit dans presque
tous les cas, et ne perd aucune donnée.

```bash
cd /var/www/triangle-wms/backend
git log --oneline -8          # repérer le commit d'avant la fusion
git checkout <commit>
npm ci --omit=dev
pm2 restart triangle-backend
```

### Niveau 1 bis — défaire la seule migration 164

La 164 n'a créé aucune table : elle a ajouté `design_kind` à
`studio_documents`, avec sa contrainte, et remplacé un index.

**La retirer mélange les deux listes.** Les présentations réapparaîtraient
dans le studio graphique et les planches dans les présentations, et ouvrir
l'une dans l'éditeur de l'autre ne serait plus refusé. La garder ne casse
rien, même avec le code d'avant : la colonne a une valeur par défaut.

```sql
BEGIN;
ALTER TABLE studio_documents DROP CONSTRAINT IF EXISTS studio_documents_design_kind_chk;
ALTER TABLE studio_documents DROP COLUMN IF EXISTS design_kind;
DROP INDEX IF EXISTS studio_documents_plans_idx;
-- L'index que la 163 avait créé et que la 164 a remplacé :
CREATE INDEX IF NOT EXISTS studio_documents_creations_idx
  ON studio_documents (company_id, updated_at DESC)
  WHERE design IS NOT NULL AND trashed_at IS NULL;
COMMIT;
```

### Niveau 1 ter — défaire la seule migration 163

Si l'on ne veut revenir que sur les créations graphiques, sans toucher au
reste du Studio : la 163 n'a créé aucune table, elle a ajouté quatre colonnes
à `studio_documents`.

**Les retirer efface les plans des créations.** Le PDF d'un badge restera
dans la bibliothèque et se téléchargera encore, mais le badge ne se rouvrira
plus pour n'y changer qu'un nom : le plan est ce qui permet de le rouvrir.
Garder les colonnes ne casse rien, même avec le code d'avant — elles
acceptent `NULL`. Ne les retirez donc que si quelqu'un l'exige.

```sql
BEGIN;
ALTER TABLE studio_documents
  DROP COLUMN IF EXISTS design,
  DROP COLUMN IF EXISTS design_format,
  DROP COLUMN IF EXISTS design_mm_width,
  DROP COLUMN IF EXISTS design_mm_height;
COMMIT;
```

### Niveau 2 — défaire les tables du Studio

**Ceci efface les documents du Studio.** Les fichiers de `storage/` ne sont
pas effacés par le SQL : ils resteront sur le disque sans que rien ne les
désigne.

```sql
BEGIN;
DROP VIEW IF EXISTS v_studio_documents_signes;
DROP VIEW IF EXISTS v_studio_scans_a_reprendre;
DROP VIEW IF EXISTS v_studio_acces;
DROP TABLE IF EXISTS studio_signature_uses;
DROP TABLE IF EXISTS studio_signatures;
DROP TABLE IF EXISTS studio_scan_pages;
DROP TABLE IF EXISTS studio_scan_sessions;
DROP TABLE IF EXISTS studio_access_log;
DROP TABLE IF EXISTS studio_shares;
DROP TABLE IF EXISTS studio_document_versions;
DROP TABLE IF EXISTS studio_documents;
DROP TABLE IF EXISTS studio_folders;
DROP TABLE IF EXISTS chat_attachment_access;
-- Les colonnes ajoutées au chat peuvent rester : elles portent des valeurs
-- par défaut et aucun code ancien ne les lit. Les retirer ferait perdre les
-- pièces jointes envoyées depuis la mise à jour.
COMMIT;
```

Exporter avant, si le contenu compte :

```bash
psql "$DATABASE_URL" -c "\copy (SELECT * FROM studio_documents) TO '/root/studio-documents.csv' CSV HEADER"
```

### Niveau 3 — restaurer la sauvegarde

**Tout ce qui a été saisi depuis la sauvegarde est perdu** : factures,
paiements, pointages, tout. À ne faire que si les niveaux 1 et 2 ne
suffisent pas.

```bash
pm2 stop triangle-backend triangle-frontend
sudo -u postgres dropdb triangle_wms
sudo -u postgres createdb triangle_wms
sudo -u postgres pg_restore -d triangle_wms \
  /root/triangle-backups/triangle_wms-<horodatage>.dump
tar xzf /root/triangle-backups/studio-<horodatage>.tar.gz \
  -C /var/www/triangle-wms/backend
pm2 restart triangle-backend triangle-frontend
```

---

## 10. Rejouer les essais sur le serveur

Les suites d'essais créent **leur propre base jetable** et ne touchent jamais
`triangle_wms`. Elles demandent un PostgreSQL d'essai (port 5433 par défaut)
et, pour celles qui pilotent un navigateur, Chromium.

```bash
cd /var/www/triangle-wms/backend
bash scripts/test-pieces-jointes-chat.sh    # 46 contrôles
bash scripts/test-studio-bibliotheque.sh    # 91 contrôles
bash scripts/test-studio-scanner.sh         # 86 contrôles
bash scripts/test-studio-signatures.sh      # 70 contrôles
bash scripts/test-studio-pdf.sh             # 53 contrôles
bash scripts/test-studio-creations.sh       # 40 contrôles
bash scripts/test-studio-annotations.sh     # 50 contrôles
bash scripts/test-studio-presentations.sh   # 73 contrôles
```

Les suites qui ouvrent un navigateur demandent en plus le frontend :

```bash
bash scripts/test-ecrans-studio.sh          # 73 contrôles
bash scripts/test-ecrans-scanner.sh         # 49 contrôles, caméra simulée
bash scripts/test-ecrans-ocr.sh             # 17 contrôles
bash scripts/test-ecrans-signatures.sh      # 39 contrôles
bash scripts/test-ecrans-pdf.sh             # 25 contrôles
bash scripts/test-ecrans-photo.sh           # 25 contrôles
bash scripts/test-ecrans-design.sh          # 23 contrôles
bash scripts/test-ecrans-detente.sh         # 16 contrôles
bash scripts/test-ecrans-annoter.sh         # 48 contrôles
bash scripts/test-ecrans-presentations.sh   # 53 contrôles

# Deux essais de rendu, sans base de données ni serveur :
node scripts/verif-annotations-rotation.js  # 71 contrôles
node scripts/verif-pptx.js                  # 46 contrôles — DEMANDE LIBREOFFICE
```

**LibreOffice n'est nécessaire QU'À CET ESSAI, jamais à l'application.** Il y
sert de juge indépendant : il ouvre le `.pptx` produit et le convertit en PDF,
ce qu'il refuserait de faire si l'archive était invalide, puis il la réécrit à
sa façon pour éprouver le lecteur sur l'XML d'un autre producteur. Si
LibreOffice n'est pas installé sur le VPS, cet essai échoue au lancement et
les 46 contrôles ne disent rien ; le module des présentations, lui, fonctionne
sans lui. Pour l'installer le temps d'un essai :

```bash
apt-get install -y libreoffice-impress   # environ 400 Mo
```

Si Chromium n'est pas installé, ces trois dernières s'arrêtent en le disant.
Elles ne sont pas indispensables au déploiement, mais elles sont les seules à
prouver que les **écrans** fonctionnent, pas seulement les API.

---

## 11. Variables d'environnement

| Variable | Obligatoire | Rôle |
|---|---|---|
| `STUDIO_STORAGE_DIR` | non | où vivent les fichiers du Studio. Par défaut `<backend>/storage`. |

Aucune clé d'API, aucun secret nouveau : la reconnaissance de texte tourne
dans le navigateur de l'utilisateur, et rien n'est envoyé à un service
extérieur.

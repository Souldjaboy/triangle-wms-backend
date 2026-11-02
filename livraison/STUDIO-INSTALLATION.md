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

Aucune dépendance nouvelle. `pdfkit` et `multer` étaient déjà là.

```bash
cd /var/www/triangle-wms/backend
npm ci --omit=dev
```

### Frontend

Quatre paquets nouveaux, tous pour la reconnaissance de texte :

| Paquet | Rôle | Poids installé |
|---|---|---|
| `tesseract.js` | le moteur de lecture, côté navigateur | ~1 Mo |
| `tesseract.js-core` | son cœur WebAssembly, en six variantes | ~30 Mo |
| `@tesseract.js-data/fra` | les données du français | ~7 Mo |
| `@tesseract.js-data/eng` | les données de l'anglais | ~14 Mo |

```bash
cd /var/www/triangle-wms/frontend
npm ci
```

La compilation recopie automatiquement ce qu'il faut dans
`public/vendor/tesseract/` (environ 60 Mo servis). Ces fichiers **ne sont pas
versionnés** : le dépôt reste léger, et `npm ci` les réapporte.

Pour les mettre en place sans compiler :

```bash
npm run installer-ocr
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

# Puis on applique, en s'arrêtant à la première erreur.
for f in sql/159_chat_pieces_jointes.sql \
         sql/160_studio_fondation.sql \
         sql/161_studio_scanner.sql; do
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
#           studio_scan_sessions, studio_shares
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

Le retour est en trois niveaux, du moins destructeur au plus.

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

### Niveau 2 — défaire les tables du Studio

**Ceci efface les documents du Studio.** Les fichiers de `storage/` ne sont
pas effacés par le SQL : ils resteront sur le disque sans que rien ne les
désigne.

```sql
BEGIN;
DROP VIEW IF EXISTS v_studio_scans_a_reprendre;
DROP VIEW IF EXISTS v_studio_acces;
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
```

Les suites qui ouvrent un navigateur demandent en plus le frontend :

```bash
bash scripts/test-ecrans-studio.sh          # 73 contrôles
bash scripts/test-ecrans-scanner.sh         # 49 contrôles, caméra simulée
bash scripts/test-ecrans-ocr.sh             # 17 contrôles
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

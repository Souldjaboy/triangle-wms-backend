# Triangle Studio Pro — état réel de la livraison

Au **2 novembre 2026**. Ce rapport dit ce qui marche, ce qui ne marche pas
encore, et ce que personne n'a pu vérifier.

---

## Ce qui n'a pas pu être fait

**Aucun déploiement n'a eu lieu, et aucun n'était possible.** Le travail
décrit ici a été fait dans un conteneur isolé, sur une base PostgreSQL
jetable. Le VPS n'était pas joignable depuis cet environnement ; la machine
de l'auteur non plus. Les chemins `/var/www/triangle-wms`, `/root/triangle-v17-*`
et `/root/triangle-backups` n'existent pas ici.

**Les chiffres d'essais de ce rapport ne disent rien de votre serveur.** Ils
disent qu'un code donné, sur une base construite à partir des migrations du
dépôt, se comporte comme décrit. Rejouer ces suites sur le VPS est la seule
façon de savoir ce qu'il s'y passe — la marche à suivre est au chapitre 10 de
`STUDIO-INSTALLATION.md`.

---

## Ce qui est terminé et vérifié

### Module 8 — le 404 des pièces jointes du chat *(priorité P0)*

**Le défaut avait deux causes, et la correction « évidente » était celle
qu'il ne fallait pas faire.**

1. L'adresse renvoyée par l'envoi (`/uploads/chat/...`) n'était routée nulle
   part depuis l'origine du frontend : seul `/api/*` est transmis au backend.
2. Le dossier `uploads/` est servi en statique **sans aucune
   authentification** : qui connaissait un nom de fichier obtenait le
   fichier. Rendre le dossier joignable aurait donc « corrigé » le 404 en
   ouvrant tous les documents de l'entreprise — ce que le cahier des charges
   interdit explicitement.

Les pièces jointes passent maintenant par une route qui vérifie l'identité,
la société et l'appartenance à la conversation. Tous les refus répondent la
même chose — 404 — pour qu'un curieux n'apprenne rien.

**Au passage, un défaut plus grave a été trouvé** : `routes/chat-v2.js` lit
et écrit **neuf colonnes qu'aucune migration ne créait**. Sur toute base
reconstruite à partir des migrations, le chemin des pièces jointes était
cassé dès le départ. La migration 159 les ajoute.

*Vérifié : 46 contrôles.*

### Module 7 — la bibliothèque documentaire

Dépôt, dossiers, recherche — y compris dans le texte reconnu d'un scan —,
aperçus, versions, partages internes, liens signés, corbeille, suppression
définitive avec motif, journal d'accès, cloisonnement strict entre les deux
sociétés.

Les fichiers vivent **hors du dossier servi en statique**, sous une clé
opaque sans nom ni extension. Aucune URL ne les atteint.

**L'original ne change jamais** : une modification crée une version de plus,
la version 1 garde son fichier et son empreinte, et un index unique partiel
rend cette marque indéboulonnable. L'écran avertit quand on consulte autre
chose que l'original.

*Vérifié : 91 contrôles d'API, 73 contrôles d'écran à 1280 px et 375 px.*

**Deux défauts n'existaient que dans l'interface** et n'ont été vus qu'en la
pilotant :
- la corbeille était un cul-de-sac : la fiche d'un document jeté répondait
  « introuvable », or « Restaurer » et « Supprimer » vivent dans cette fiche.
  Un essai d'API affirmait même ce défaut comme un comportement voulu ;
- la fiche se rouvrait toute seule une seconde après qu'on l'ait fermée.

### Module 1 — le scanner

Caméra, détection des quatre coins, capture automatique sur image stable,
retouche des coins au doigt, correction de perspective, multipage,
assemblage en PDF rangé dans la bibliothèque. Sans caméra — un poste fixe —
on importe une photo : le même traitement s'applique.

**Les pages survivent.** Chacune part au serveur dès qu'elle est gardée :
fermer l'onglet, verrouiller l'écran ou recevoir un appel ne perd rien, et la
séance se reprend là où on s'est arrêté.

**L'écran ne fait pas semblant d'avoir redressé** ce qu'il n'a pas redressé :
une page gardée telle quelle est marquée comme telle.

**La reconnaissance de texte** lit le français et l'anglais, **sur
l'appareil** : aucune image ne part vers un service extérieur. C'est un choix
annoncé avec son poids, jamais imposé, et le défaut est « sans
reconnaissance ».

*Vérifié : 86 contrôles d'API, 49 contrôles d'écran avec une caméra simulée,
17 contrôles de bout en bout pour la lecture de texte.*

**Quatre défauts trouvés en pilotant l'écran**, dont trois invisibles
autrement :
- l'onglet **gelait** sans la moindre erreur : le module OpenCV possède une
  méthode `then`, donc le rendre depuis une fonction `async` lançait une
  chaîne de micro-tâches sans fin ;
- **aucune feuille n'était jamais détectée la première fois** : la boucle
  d'analyse avait figé l'état « reconnaissance non chargée » ;
- la capture automatique partait après 150 millisecondes, avant que la main
  se soit immobilisée ;
- `/vendor/opencv.js` était **redirigé vers la page de connexion** par le
  filtre de routes, ce qui cassait aussi, silencieusement, la capture de
  reçus déjà en place.

---

## Ce qui n'existe pas encore

Rien de ce qui suit n'est maquetté : l'accueil du Studio les nomme sans les
rendre cliquables, pour que personne ne clique et découvre le vide.

| Module | État | Ce qu'il faudra |
|---|---|---|
| 2 — Éditeur PDF | rien | une bibliothèque PDF côté navigateur (`pdf-lib`, `pdfjs-dist`) |
| 3 — Signatures et cachets | socle posé | la bibliothèque sait déjà stocker une signature comme document cloisonné ; l'apposition demande l'éditeur PDF |
| 4 — Studio graphique | rien | modèles **originaux** : aucun modèle sous licence ne sera repris |
| 5 — Éditeur photo | rien | travaillera sur une copie, l'original restant intact |
| 6 — Présentations | rien | import/export PowerPoint |
| 9 — Partage externe | partiel | les liens signés marchent. Le courriel demande un SMTP configuré ; les pièces jointes WhatsApp demandent un compte **WhatsApp Business API** — sans lui, rien ne part automatiquement, et il ne faut pas le laisser croire |
| 10 — Espace détente | rien | jeux courts, jamais imposés à l'ouverture |

---

## Ce qui dépend de quelque chose d'extérieur

| Fonction | Dépendance | Sans elle |
|---|---|---|
| Reconnaissance de texte | 4 paquets npm, ~60 Mo servis | le scanner marche, l'écran annonce que la lecture n'est pas disponible |
| Détection des contours | `public/vendor/opencv.js`, déjà au dépôt | la capture reste possible, sans redressement |
| Envoi par courriel | serveur SMTP | non construit |
| Pièces jointes WhatsApp | compte WhatsApp Business API | non construit |

---

## Résumé des essais

| Suite | Contrôles | Ce qu'elle éprouve |
|---|---|---|
| `test-pieces-jointes-chat.sh` | 46 | le service authentifié des pièces jointes |
| `test-studio-bibliotheque.sh` | 91 | dépôt, versions, partages, corbeille, cloisonnement |
| `test-studio-scanner.sh` | 86 | séances, pages, ordre, assemblage, orientation du PDF |
| `test-ecrans-studio.sh` | 73 | la bibliothèque dans un navigateur, 1280 px et 375 px |
| `test-ecrans-scanner.sh` | 49 | le scanner avec une caméra simulée |
| `test-ecrans-ocr.sh` | 17 | la lecture de texte, de l'image à la recherche |
| **Total** | **362** | |

Ces 362 contrôles portent sur **cet environnement**, pas sur le vôtre.

---

## Les points restés ouverts

- **Les autres sous-dossiers de `uploads/` restent servis sans
  authentification** : reçus, résultats de laboratoire. Qui connaît un nom de
  fichier obtient le document. Le Studio n'y est pas exposé — ses fichiers
  sont ailleurs — mais le défaut subsiste pour le reste de l'application. La
  correction est la même que pour le chat : une route qui vérifie, et le
  retrait du montage statique.
- **14 routes Express masquées** : du code déployé est inatteignable parce
  qu'un chemin identique est déclaré deux fois. Express retient la première
  déclaration, sans erreur ni trace. La liste s'affiche au démarrage du
  serveur.
- **7 numéros de migration en double** dans l'historique du dépôt.
- `reminder_settings` n'a pas de migration : le planificateur de rappels
  échoue toutes les heures sur une base reconstruite.
- Les sociétés créées **après** la migration 160 n'ont pas de droits Studio
  par défaut.

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

### Module 3 — les signatures et les cachets

Une signature se trace au doigt ou s'importe ; un cachet d'entreprise se pose
par un responsable. On l'appose sur un PDF en la plaçant à l'écran, et
l'apposition se fait sur le serveur.

**Une signature n'appartient qu'à son propriétaire.** Ni son rôle, ni la
direction, ni un administrateur n'y accèdent — pas même à son image, qui
n'est jamais mise en cache. Quiconque l'obtient peut signer à la place de
quelqu'un : c'est la règle qui rend tout le reste crédible, et la base la
tient par une contrainte, pas seulement le code.

**Signer produit une version de plus, jamais une réécriture.** L'original non
signé reste intact et téléchargeable. La trace garde les empreintes d'avant
et d'après, la page et la position : c'est elle qu'on relira si une signature
est contestée, et elle survit au document.

On ne supprime pas une signature, on la révoque avec un motif. Les documents
déjà signés restent signés.

*Vérifié : 70 contrôles d'API, 41 contrôles de rendu — les quatre rotations
de page possibles sont rendues et leurs pixels inspectés —, 39 contrôles
d'écran où le paraphe est tracé au pointeur puis l'encre retrouvée dans le
PDF produit.*

### Module 2 — l'éditeur de pages et les annotations

Réordonner, tourner, retirer, extraire, fusionner, découper. Ce qui modifie
le document produit une version de plus ; ce qui en fabrique d'autres ne
touche pas aux sources, et l'écran sépare les deux familles sous leurs
intitulés.

**Aucune page ne se perd en silence** : chaque action dit combien il y en
avait et combien il en reste. Le découpage se fait par coupures entre les
pages, donc les parties se suivent et aucune page ne peut être oubliée ni se
retrouver dans deux documents.

*Vérifié : 53 contrôles d'API, 25 contrôles d'écran — les pages du document
d'essai portant chacune une marque différente, l'essai lit l'ordre des
vignettes au pixel et vérifie que déplacer une page la déplace dans le
fichier.*

**Et l'on écrit maintenant SUR la page** : une mention, un tableau, un
surlignage, un cadre. On trace le cadre au doigt ou à la souris, on remplit,
et la pose se fait sur le serveur — le navigateur ne réécrit jamais le PDF.
Comme pour les pages, annoter produit une version de plus, et la note de
version dit ce qui a été posé et sur quelles pages : six mois plus tard,
c'est tout ce dont on disposera pour expliquer une mention sur un bon de
livraison.

**Le piège était la rotation de page, et il mord plus fort ici que pour une
signature.** Une signature est une image : il suffit de la redresser. Une
annotation a un sens de lecture interne — un tableau a des lignes qui vont de
gauche à droite et des lignes qui s'empilent. En ne transformant que le cadre
extérieur, sur une page tournée d'un quart de tour, les lignes du tableau
deviennent des colonnes : le cadre est juste, et le tableau illisible. Tout
se calcule donc dans le repère de l'affichage — celui que l'utilisateur a
sous les yeux — et ce repère n'est quitté qu'au dernier moment, trait par
trait.

**Rien ne déborde en silence.** Si le texte ne tient pas dans son cadre, le
refus dit combien de lignes il demande et combien le cadre en tient ; l'écran
le répète mot pour mot et sélectionne le cadre fautif, que le serveur désigne
par son rang. Réduire la police tout seul produirait un document que personne
n'a voulu ; rogner le texte en ferait disparaître une partie sans que
quiconque s'en aperçoive avant l'impression.

**Un surlignage est de l'encre, et l'écran le dit.** Dans un lecteur PDF, un
surlignage se sélectionne, se commente et se retire d'un clic. Ici c'est un
aplat translucide imprimé dans la page. L'inverse se découvrirait trop tard.

*Vérifié : 50 contrôles d'API, 71 contrôles de rendu — les quatre rotations
de page sont rendues et leurs pixels inspectés, l'en-tête du tableau d'essai
étant sur fond coloré : une bande horizontale en haut si tout va bien, une
bande verticale à gauche si c'est transposé —, et 48 contrôles d'écran où
l'essai trace à la souris, lit la position que l'écran affiche, pose, puis
rend le PDF produit pour vérifier que l'encre est là où l'écran l'avait
annoncée.*

**Trois défauts que seul un vrai navigateur a montrés** : la cloche de
notifications de l'application recouvrait le bouton « Poser » ; poser faisait
revenir en page 1, donc perdre sa place dans un dossier de vingt feuillets ;
et un simple clic créait une annotation invisible de deux pixels, qu'on
aurait retrouvée plus tard dans le PDF sans savoir d'où elle venait.

### Module 5 — l'éditeur photo

Recadrer, tourner par quarts, redresser au degré, éclaircir, contraster,
passer en noir et blanc, et le réglage qui sert le plus souvent ici :
**« document »**, qui blanchit le papier et noircit l'encre d'une photo prise
à la main.

**L'original ne bouge jamais.** Chaque enregistrement crée une version de
plus ; la version 1 garde son fichier et son empreinte. Un bouton rend
l'image d'origine à tout moment, et rien n'est écrit avant qu'on le demande.

Tout le travail se fait **dans le navigateur**, sur une toile : rien ne part
au serveur avant l'enregistrement, et aucun service extérieur ne voit la
photo.

*Vérifié : 25 contrôles d'écran — l'essai dépose une image dont il connaît
les couleurs par quadrant, puis relit les pixels du résultat après chaque
opération : un quart de tour met bien le coin rouge en haut à droite, et
« document » éclaircit le fond sans effacer le trait.*

**Deux affirmations de l'essai étaient fausses et ont été corrigées** plutôt
que contournées : l'une ignorait que la moitié basse de l'image d'essai est
volontairement plus sombre, l'autre attendait d'une image en largeur qu'elle
reste en largeur après un quart de tour.

### Module 4 — le studio graphique

Badges, cartes de visite, étiquettes de palette, en-têtes de courrier,
attestations, affichettes. Six modèles, **tous dessinés pour Triangle** :
aucun modèle sous licence n'a été repris, ni de Canva ni d'ailleurs — c'était
une interdiction explicite du cahier des charges.

On place des blocs de texte, des images, des formes, des codes QR ; on change
les polices, les couleurs, les tailles ; on aligne, on superpose, on duplique.
Le format se choisit en millimètres, et l'export PDF sort **à la dimension
réelle**, prêt pour l'imprimeur.

Un dessin se range dans la bibliothèque comme n'importe quel document : il se
rouvre, se modifie, se repartage, et chaque export est une version de plus.
Le plan de la création est gardé en JSON à côté du PDF — c'est ce qui permet
de rouvrir un badge six mois plus tard et de n'y changer que le nom.

*Vérifié : 40 contrôles d'API, 23 contrôles d'écran — l'essai pose un carré
de couleur connue à une position connue, exporte, puis relit le pixel attendu
dans le PDF rendu ; il vérifie aussi qu'un code QR produit est bien un
damier et non un carré vide.*

**Un défaut rendait l'éditeur inutilisable sur tout modèle portant un code
QR** : une fonction de référence écrite dans le corps du rendu rappelait
l'état à chaque passage, et React s'arrêtait sur une erreur de rendu infini.
Il n'apparaissait que sur les modèles à QR, donc trois des six.

### Module 6 — les présentations

Des diapositives en 16/9 ou en 4/3, six modèles originaux, et les mêmes
outils que le studio graphique : texte, rectangles, ellipses, traits, images.
Une présentation se range dans la bibliothèque comme n'importe quel
document — propriétaire, visibilité, versions, corbeille, journal d'accès.

**Ce qui est rangé est un PDF, pas un `.pptx`.** Le PDF se montre, s'imprime,
se partage par un lien signé et s'ouvre sur n'importe quel téléphone sans
rien installer — y compris chez un client qui n'a pas PowerPoint. Le `.pptx`
est un **export**, produit à la demande pour qui doit continuer le travail
dans PowerPoint ; il entre comme un document de plus, avec sa provenance
écrite, et ne remplace rien.

**L'export donne de vraies formes modifiables**, pas des images de
diapositives collées sur des pages : ouvert dans PowerPoint, le texte se
corrige et les formes se déplacent. Le `.pptx` est écrit à la main — c'est une
archive ZIP de documents XML, la norme Office Open XML —, donc aucun service
extérieur n'intervient.

**Un `.pptx` déposé est lu, MONTRÉ, et son compte rendu affiché avant qu'on
enregistre.** Un fichier PowerPoint peut contenir des tableaux, des
graphiques, des SmartArt, des animations, et des formes qui tiennent leur
position d'un masque et leur couleur d'un thème : reprendre tout cela, c'est
réécrire PowerPoint. Chaque élément non repris est donc nommé, forme par
forme, et ce compte rendu est recopié dans la provenance du document — où il
restera lisible longtemps après l'import. Deux cas du monde réel sont traités
nommément : un titre sans position — le cas le plus courant, car la plupart
des titres héritent leur géométrie du masque — garde **son texte**, placé
raisonnablement, et c'est signalé ; une couleur de thème n'est pas devinée.

*Vérifié : 73 contrôles d'API, 53 contrôles d'écran, et 46 contrôles sur le
`.pptx` où **LibreOffice Impress est le juge** : il convertit l'archive en
PDF — ce qu'il refuserait si elle était invalide —, le PDF est rendu et ses
pixels relus, puis il RÉÉCRIT l'archive à sa façon et c'est celle-là qu'on
relit. Relire sa propre écriture ne prouve presque rien : les deux moitiés
peuvent se tromper de la même façon. L'aller-retour est enfin établi comme un
point fixe — lire, réécrire, relire redonne le même plan, élément par
élément — sans quoi chaque export dégraderait un peu la présentation, ce qui
ne se voit qu'au dixième tour.*

**Ce qui n'existe pas dans ce module** : les transitions entre diapositives et
les animations d'apparition. Elles n'existent ni dans le PDF, ni dans
l'export, et l'accueil du Studio le dit.

### Module 10 — l'espace détente

Un démineur et un taquin, dans le navigateur, pour une pause de cinq minutes.

**Ce que cet espace ne fait pas est tout l'intérêt.** Il ne s'impose jamais :
rien ne s'ouvre tout seul, rien ne clignote ailleurs dans l'application,
aucune notification n'invite à jouer. Il n'envoie rien : pas de score, pas de
classement, **pas de temps de jeu** — un temps de jeu mesuré finirait par
être regardé par quelqu'un, et une pause surveillée n'est plus une pause. Il
ne retient pas : aucune récompense à revenir demain, aucune série à ne pas
briser.

Deux détails font la différence entre un jeu et une corvée : les mines sont
posées **après** le premier clic, en évitant la case touchée et ses voisines ;
et le taquin se mélange **en partant de la solution**, par des coups légaux,
car un tirage au sort donne une grille impossible une fois sur deux.

*Vérifié : 16 contrôles d'écran — l'essai écoute toutes les requêtes pendant
la partie et n'en trouve aucune qui parle de jeu, de score ou de partie ni
aucune écriture ; il rejoue vingt fois le premier clic du démineur pour
établir qu'il ne saute jamais, et calcule la parité des inversions du taquin
pour établir que le mélange est résoluble.*

---

## Ce qui n'existe pas encore

Rien de ce qui suit n'est maquetté : l'accueil du Studio les nomme sans les
rendre cliquables, pour que personne ne clique et découvre le vide.

| Module | État | Ce qu'il faudra |
|---|---|---|
| 6 — Transitions et animations | partiel | les présentations existent, avec leurs diapositives, leur PDF et leur aller-retour PowerPoint. Les transitions entre diapositives et les animations d'apparition ne sont pas faites : elles n'existent ni dans le PDF, ni dans l'export |
| 9 — Partage externe | partiel | les liens signés marchent, et les permissions avec. Le courriel demande un SMTP configuré ; les pièces jointes WhatsApp demandent un compte **WhatsApp Business API** — sans lui, rien ne part automatiquement, et il ne faut pas le laisser croire |

---

## Ce qui dépend de quelque chose d'extérieur

| Fonction | Dépendance | Sans elle |
|---|---|---|
| Reconnaissance de texte | 4 paquets npm, ~60 Mo servis | le scanner marche, l'écran annonce que la lecture n'est pas disponible |
| Détection des contours | `public/vendor/opencv.js`, installé au `prebuild` | la capture reste possible, sans redressement |
| Rendu des pages à l'écran | `pdfjs-dist` + son `worker` copié dans `public/vendor/` | l'éditeur de pages, le placement de signature et l'annotation n'affichent rien |
| Fabrication des PDF | `pdf-lib` et `pdfkit` (serveur) | ni assemblage de scan, ni apposition, ni annotation, ni export |
| Lecture et écriture des `.pptx` | `jszip` et `@xmldom/xmldom` (serveur) | les présentations se font et s'exportent en PDF, mais l'aller-retour PowerPoint est impossible |
| Juger un `.pptx` produit | **LibreOffice**, pour l'essai seulement | le module marche ; ce sont les 46 contrôles de `verif-pptx.js` qui ne disent plus rien |
| Envoi par courriel | serveur SMTP | **non construit** |
| Pièces jointes WhatsApp | compte WhatsApp Business API | **non construit** |

Les deux dernières lignes demandent un service que vous seul pouvez ouvrir.
Rien n'a été écrit qui prétende envoyer un message sans ce service — c'était
une interdiction explicite du cahier des charges.

---

## Résumé des essais

| Suite | Contrôles | Ce qu'elle éprouve |
|---|---|---|
| `test-pieces-jointes-chat.sh` | 46 | le service authentifié des pièces jointes |
| `test-studio-bibliotheque.sh` | 91 | dépôt, versions, partages, corbeille, cloisonnement |
| `test-ecrans-studio.sh` | 73 | la bibliothèque dans un navigateur, 1280 px et 375 px |
| `test-studio-scanner.sh` | 86 | séances, pages, ordre, assemblage, orientation du PDF |
| `test-ecrans-scanner.sh` | 49 | le scanner avec une caméra simulée |
| `test-ecrans-ocr.sh` | 17 | la lecture de texte, de l'image à la recherche |
| `test-studio-signatures.sh` | 70 | signatures, cachets, apposition, révocation |
| `verif-apposition-rotation.js` | 41 | les quatre rotations de page, rendues et inspectées |
| `test-ecrans-signatures.sh` | 39 | tracer un paraphe et signer un PDF à l'écran |
| `test-studio-pdf.sh` | 53 | pages : ordre, rotation, retrait, extraction, fusion, découpe |
| `test-ecrans-pdf.sh` | 25 | l'éditeur de pages dans un navigateur |
| `test-ecrans-photo.sh` | 25 | l'éditeur photo, pixels relus après chaque opération |
| `test-studio-creations.sh` | 40 | créations : plans, formats en millimètres, export PDF |
| `test-ecrans-design.sh` | 23 | le studio graphique, du modèle au PDF à la bonne dimension |
| `test-ecrans-detente.sh` | 16 | les deux jeux, et qu'ils ne rapportent rien |
| `test-studio-annotations.sh` | 50 | mentions, tableaux, surlignages : poses et refus |
| `verif-annotations-rotation.js` | 71 | les quatre rotations, rendues et inspectées au pixel |
| `test-ecrans-annoter.sh` | 48 | tracer, remplir, poser — puis relire le PDF produit |
| `test-studio-presentations.sh` | 73 | diapositives, PDF assemblé, export et lecture PowerPoint |
| `verif-pptx.js` | 46 | le `.pptx`, jugé par LibreOffice Impress dans les deux sens |
| `test-ecrans-presentations.sh` | 53 | créer, ajouter, enregistrer, exporter, réimporter |
| **Total** | **1 035** | |

Ces 1 035 contrôles portent sur **cet environnement**, pas sur le vôtre.

Deux d'entre eux ne demandent ni base de données ni serveur, et se lancent
seuls : `verif-annotations-rotation.js` et `verif-pptx.js`. Le second a besoin
de **LibreOffice** — uniquement pour l'essai, jamais pour l'application.

**Vingt-six affirmations d'essai se sont révélées fausses** au fil du travail —
un essai qui passe n'est pas forcément un essai juste. Chacune a été corrigée
avec un commentaire qui dit pourquoi elle était fausse, jamais contournée ni
supprimée. Deux sont particulièrement parlantes. Un essai d'API
**affirmait comme voulu** le cul-de-sac de la corbeille, et empêchait donc de
voir le défaut. Et l'essai de l'accueil du Studio comparait les liens des
tuiles à une **liste écrite en dur** : juste le jour où elle a été écrite, et
fausse dès le module suivant, puisque chaque écran construit ajoutait
légitimement une tuile. Il criait au lien mort pendant que le logiciel
avançait. Il suit désormais chaque lien et regarde où il atterrit — une liste
figée ne décrit pas une promesse, elle décrit un instant.

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
  serveur. Aucune des routes du Studio n'en fait partie — c'est vérifié au
  démarrage, le compte n'a pas bougé.
- **7 numéros de migration en double** dans l'historique du dépôt.
- `reminder_settings` n'a pas de migration : le planificateur de rappels
  échoue toutes les heures sur une base reconstruite.
- Les sociétés créées **après** la migration 160 n'ont pas de droits Studio
  par défaut.
- **Un `npm install` est nécessaire** sur le VPS, et non seulement un
  `npm ci --omit=dev` : `jszip` et `@xmldom/xmldom` sont désormais déclarés,
  alors qu'ils n'étaient présents qu'amenés par d'autres paquets.

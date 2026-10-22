# Retour arrière — le code et la base ne se traitent pas de la même façon

Un déploiement qui se passe mal demande deux gestes différents, et les
confondre coûte des données.

**Le code** revient en arrière sans rien perdre. Git conserve l'ancien état ;
revenir dessus est réversible, instantané, et n'efface aucune saisie.

**La base**, non. Une restauration ramène la photo du passé et **efface tout ce
qui a été enregistré depuis la sauvegarde** : les factures saisies hier, les
encaissements du matin, les bulletins édités entre-temps. Restaurer pour
corriger un défaut de code, c'est réparer une fuite en démolissant le mur.

Ce document dit quoi faire, dans quel ordre, et pourquoi le premier niveau
suffit presque toujours.

---

## Pourquoi le code seul suffit, ici

Les cinq migrations du lot (150 à 154) sont **purement additives** :

| Migration | Ce qu'elle ajoute | Ce qu'elle modifie de l'existant |
|---|---|---|
| 150 transferts internes | `internal_fund_transfers`, vue `v_transferts_internes_candidats`, 3 colonnes sur `accounting_transactions`, module `comptabilite.transfert_interne` | rien |
| 151 bons comptables | `cash_voucher_history`, vue `v_bons_incoherents`, 4 colonnes sur `cash_vouchers`, module `comptabilite.bon` | rien |
| 152 contrepassation ciment | `cement_payment_reversals`, vue `v_remboursements_attendus`, 2 actions sur le module `ciment` existant | la liste d'actions du module `ciment` |
| 153 demandes validées | `stock_request_corrections`, vue `v_demandes_incoherentes`, 5 colonnes sur `stock_requests`, 4 sur `stock_movements` | la liste d'actions du module `demande` |
| 154 documents RH | `hr_contracts`, `hr_contract_clauses`, `hr_documents`, module `rh.document` | rien |

Aucune ne réécrit, ne déplace ni ne supprime une donnée antérieure. Les
colonnes ajoutées ont toutes une valeur par défaut, donc les lignes existantes
restent valides.

**Conséquence : l'ancien code tourne sans difficulté sur la base nouvelle.** Il
n'interroge pas les nouvelles tables et ignore les nouvelles colonnes. Remettre
le code en arrière et laisser la base telle quelle est donc une opération
**sans perte** — et c'est la bonne réponse dans presque tous les cas.

C'est aussi la plus rapide : aucune restauration, aucun arrêt prolongé.

---

## Niveau 1 — remettre le code, laisser la base

**Quand :** un défaut dans le code nouveau. C'est le cas courant.

```bash
cd /var/www/triangle-wms/backend
./livraison/retour-base.sh verifier          # dit ce que la base porte, ne touche à rien
git checkout "$(cat /var/backups/triangle-wms/.commit-<horodatage>)"
npm ci --omit=dev
pm2 restart triangle-backend
./livraison/deployer.sh sante
```

Le fichier `.commit-<horodatage>` est écrit par `deployer.sh deployer` **avant**
de bouger le code : c'est lui, et non la base, qui permet de revenir au code
d'avant.

Les nouvelles tables restent en place, inertes. Si vous redéployez plus tard,
leur contenu sera relu tel quel — c'est un avantage, pas un problème.

> Ne faites **jamais** `git reset --hard` ni `git clean` sur la production :
> un fichier de configuration non suivi par Git disparaîtrait. `git checkout`
> d'un commit suffit.

---

## Niveau 2 — retirer les ajouts, sans toucher au reste

**Quand :** une structure nouvelle gêne réellement — par exemple une contrainte
d'unicité qui refuse une saisie que l'ancien code acceptait.

```bash
./livraison/retour-base.sh defaire-ajouts
```

Ce que la commande fait, dans cet ordre :

1. **Elle refuse** si des transferts internes existent (voir l'avertissement
   ci-dessous).
2. **Elle exporte** le contenu de chaque nouvelle table en CSV, plus les
   colonnes qui vont disparaître d'une table antérieure (l'historique des
   annulations de bons, celui des corrections de demandes), plus les lignes de
   droits concernées. Si un export échoue, elle s'arrête sans rien supprimer.
3. **Elle demande** la phrase `RETIRER LES AJOUTS`, tapée à la main.
4. **Elle applique** les cinq fichiers de `sql/retour/`, dans l'ordre inverse.
5. **Elle contrôle** que les tables et les vues sont parties, et que les tables
   antérieures sont toujours là.

Ce qui n'est **jamais** touché : les données antérieures, les opérations
enregistrées depuis, le catalogue `permission_actions`, les modules qui
existaient avant le lot, et **toute ligne de droits réglée par une personne**
(`updated_by IS NOT NULL`). Les migrations ne posaient leurs droits que là où
personne n'était passé ; le retour applique la même règle à l'envers.

### L'avertissement sur les transferts internes

`show_in_financial_movements` est la colonne qui empêche un transfert interne
d'être compté comme une recette ou une dépense. La retirer alors que des
transferts existent les fait **réapparaître dans les mouvements financiers** :
le résultat de l'entreprise est faussé du montant de chaque transfert, à la
hausse et à la baisse.

La commande refuse donc tant qu'un transfert est actif. Pour passer outre, il
faut le dire explicitement :

```bash
FORCER_TRANSFERTS=oui ./livraison/retour-base.sh defaire-ajouts
```

Avant de le faire : préférez le niveau 1. Il n'a pas cet inconvénient.

---

## Niveau 3 — restaurer, en dernier recours

**Quand :** le schéma lui-même est cassé — une migration interrompue au milieu,
une table dans un état que rien ne rattrape. Pas pour un défaut de code.

```bash
./livraison/retour-base.sh restaurer 20261022-063904
```

Ce que la commande fait **avant** de restaurer :

1. **Elle capture** tout ce qui a été écrit après la date de la sauvegarde : un
   fichier CSV par table, dans un dossier daté, avec un `LISEZ-MOI.txt` qui
   explique le rejeu. C'est exactement ce que la restauration va détruire.
2. **Elle vérifie que la sauvegarde se restaure**, dans une base d'essai
   jetable. Si elle ne se restaure pas, **la base n'est pas touchée**.
3. **Elle annonce le nombre de lignes** qui vont disparaître, et demande la
   phrase `JE PERDS LES DONNEES POSTERIEURES`.
4. **Elle sauvegarde l'état actuel** avant de l'écraser, pour que le retour du
   retour soit possible.

Puis elle vide le schéma (`DROP SCHEMA public CASCADE`) et restaure.
`pg_restore --clean` seul ne suffit pas : il ne supprime que les objets présents
dans le fichier, donc tout ce que le lot a créé survivrait.

### Le rejeu n'est pas automatique, et ne peut pas l'être

Le dossier de capture contient les lignes, pas un script. Le rejeu demande de
l'attention :

- **l'ordre** compte : une facture avant son paiement, un salarié avant son
  contrat ;
- **les séquences** doivent être recalées après coup
  (`SELECT setval(pg_get_serial_sequence('table','id'), (SELECT max(id) FROM table))`) ;
- **les soldes de trésorerie** (`accounting_banks.current_balance`,
  `caisses.solde_actuel`, `treasury_accounts.current_balance`) ne sont pas dans
  la capture : ce sont des cumuls, pas des opérations. Après un rejeu, ils
  refléteront la sauvegarde et non les opérations rejouées. Il faut les
  recalculer ou les corriger à la main.

C'est précisément pour éviter ce travail que les niveaux 1 et 2 existent.

---

## Ce qui n'est pas réversible automatiquement

À dire franchement, pour que personne ne compte sur une garantie qui n'existe
pas :

- **Les migrations ne sont pas réversibles par PostgreSQL.** Il n'existe pas de
  « défaire la dernière migration ». Les fichiers de `sql/retour/` sont écrits
  à la main, un par migration, et ne défont que ce que leur migration a fait.
- **Un `DROP COLUMN` perd le contenu de la colonne.** Les colonnes retirées par
  le niveau 2 portent l'historique des annulations et des corrections. Le script
  l'exporte avant, mais l'export est un CSV, pas une remise en place.
- **Les soldes de trésorerie sont des cumuls.** Aucun retour arrière ne les
  recalcule.
- **Le niveau 3 perd les opérations postérieures**, sauf rejeu manuel.

---

## Avant de déployer : la répétition

```bash
./livraison/repetition-deploiement.sh
```

Rejoue le parcours entier sur une base jetable qui reproduit le schéma de
production, **V16 comprise** : détection des conflits, `git fetch`,
`merge --ff-only`, `npm ci`, sauvegarde restaurée pour vérification, migrations,
idempotence, démarrage, contrôles de santé, construction du frontend, puis
retour arrière de la base et du code. 49 contrôles.

Elle vérifie aussi que `merge --ff-only` **refuse** d'avancer si la production
porte un commit local — sans quoi un correctif posé à la main serait écrasé.

```bash
./scripts/test-retour-base.sh
```

Éprouve les trois niveaux : le refus sur les transferts internes, l'export avant
suppression, la survie des droits réglés à la main, et l'exclusion des lignes
antérieures de la capture. 49 contrôles.

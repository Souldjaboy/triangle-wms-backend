# Rapport de livraison

Branche : `claude/droits-permissions-erreur-comptes-dyg32h`
(dépôts `triangle-wms-backend` et `triangle-wms-frontend`)

**Rien n'a été déployé. Aucune donnée de production n'a été touchée.**

---

## Ce qui est terminé et testé

| Partie | Ce qui a été fait | Tests |
|---|---|---|
| §8 Transferts internes | Déplacer des fonds n'est ni encaisser ni dépenser | 119 + 40 en navigateur |
| §7 Bons comptables | Modifier avant validation, contre-passer après | 77 |
| B Paiements de factures | Contre-passation ciment, comme le sable | 79 |
| C Demandes validées | Modifier, dévalider, contre-passer | 85 |
| E FAT & MAT | Réconciliation en lecture seule | 50 |
| F Emplacements WMS | Plus rien ne disparaît en silence | 69 |
| A Documents RH | Contrats, bulletins, attestations, diplômes | 94 |
| Qualité | Hydratation React, superpositions | inclus dans les 40 |

**573 assertions nouvelles**, toutes au vert, plus **683 assertions de
non-régression** sur les suites existantes (durcissement 104, RBAC
contournements 35, RBAC multi-sociétés 24, fiscalité 57, acomptes 47, tableau
de bord 45, vente de sable 60, urgences WMS 47, documents 58, jours chômés 77,
droits de paie 70, septembre 59).

Chaque suite part d'une base vierge, applique les migrations, pose son jeu
d'essai et rend un verdict en une commande :

```bash
bash scripts/test-transferts-internes.sh
bash scripts/test-bons-comptables.sh
bash scripts/test-contrepassation-ciment.sh
bash scripts/test-demandes-correction.sh
bash scripts/test-reconciliation-fatmat.sh
bash scripts/test-emplacements-zerbo.sh
bash scripts/test-documents-rh.sh
bash scripts/test-transferts-navigateur.sh   # 1280 px et 375 px
```

---

## Défauts trouvés dans le code existant

Ceux-ci n'étaient pas dans le périmètre demandé ; ils ont été rencontrés en
chemin.

1. **Le tableau de bord financier échouait en production.** `server.js`
   agrège les recettes du jour avec `COALESCE(show_in_financial_movements,
   TRUE)`, mais aucune migration ne créait cette colonne. La requête renvoyait
   `column does not exist`.
2. **Vos bons de livraison impriment des montants malformés.**
   `toLocaleString("fr-FR")` sépare les milliers par une espace fine
   insécable que les polices de pdfkit n'encodent pas : « 450 /000 FCFA ».
3. **Un bon validé puis « refusé »** laissait l'argent sorti et la dépense
   dans le résultat, sans qu'aucun écran ne la montre active.
4. **L'index unique annoncé par la migration 075** (anti-double
   contre-passation côté sable) n'existait pas réellement.
5. **Le recalcul du solde d'une facture ciment** comptait les paiements
   contre-passés.
6. **La zone « X »** de l'entrepôt était prise pour une valeur générée et
   disparaissait des sélecteurs, avec son stock.
7. **Un bac archivé** restait proposé comme destination de transfert.
8. **« N/A »** était refusé par la règle JavaScript et accepté par son
   équivalent SQL.
9. **L'erreur d'hydratation React #418** sur l'écran Comptabilité : le DOM
   était entièrement refait, focus et champs perdus.
10. **Dix-sept fenêtres de confirmation** étaient recouvertes par les boutons
    flottants sur téléphone.

---

## Décisions prises, qui demandent votre accord

Chacune est documentée dans le code et réversible.

1. **Annuler quand les fonds sont repartis est refusé**, plutôt que de
   creuser un solde négatif en silence.
2. **Un inventaire ne se contre-passe pas** : il a fixé le stock à une valeur
   comptée. Le message renvoie vers un nouvel inventaire.
3. **Contre-passer est un droit distinct de faire** : le comptable déplace
   des fonds mais n'annule pas ; le magasinier réceptionne mais ne défait
   pas. Réglable dans Droits et permissions.
4. **Un salarié n'a qu'un contrat actif** : deux voudraient dire deux
   salaires.
5. **Un encaissement « espèces » en Sable et Ciment crédite la trésorerie
   générale**, jamais une caisse physique. C'est le comportement existant,
   signalé parce qu'il change la lecture de vos chiffres.

---

## Ce que je n'ai pas pu faire

1. **La V16 des documents RH n'est pas dans le dépôt Git.** Elle n'existe que
   sur votre VPS. Je n'ai donc rien pu « terminer » : j'ai construit la partie
   A de façon additive, sous des noms neufs (`hr_contracts`, `hr_documents`,
   `rh.document`), qui n'écrasent rien. Si vous poussez la V16 sur la branche,
   je rapproche les deux.
2. **Les relevés FAT & MAT donnent des agrégats, pas le détail.** La
   réconciliation compare nombre et total, puis examine chaque facture pour
   expliquer l'écart. Le fichier de référence prévoit déjà l'emplacement du
   détail ligne à ligne si vous l'obtenez.
3. **Les 42 anomalies annoncées** ne peuvent être confrontées qu'aux données
   réelles. L'outil tourne en lecture seule sur la production :
   `DATABASE_URL=… node scripts/reconcilier-fatmat.js`.
4. **Le logo de l'entreprise** n'est pas dans le dépôt : les documents RH le
   cherchent dans `uploads/logo.png` et s'en passent proprement s'il manque.

---

## Non testé

- Le script de déploiement a été éprouvé contre une base d'essai : prérequis,
  sauvegarde vérifiée par restauration réelle, 119 migrations, retour arrière.
  **Il n'a jamais tourné contre la production**, et la partie `git` + `npm ci`
  du déploiement n'a pas été exercée.
- Le rendu des documents RH a été vérifié page par page en image, mais
  **aucun n'a été imprimé sur papier**.
- Les écrans de la partie C et du registre RH n'ont pas d'interface
  dédiée : les routes existent et sont testées, les écrans restent à faire.

# Déploiement et retour arrière — Triangle WMS Pro

Ce dossier contient tout ce qu'il faut pour mettre en production le lot
développé sur la branche `claude/droits-permissions-erreur-comptes-dyg32h`,
et pour revenir en arrière si quelque chose se passe mal.

**Rien n'a été déployé.** Les migrations n'ont été appliquées qu'à des bases
d'essai.

---

## Avant de commencer

Le script ne contient aucun mot de passe. Il lit `DATABASE_URL` depuis
l'environnement, ou à défaut depuis le `.env` de l'application — qu'il
n'affiche ni ne recopie jamais.

```bash
cd /var/www/triangle-wms/backend
git fetch origin claude/droits-permissions-erreur-comptes-dyg32h
cp -r livraison /root/deploiement-triangle   # le script, hors de l'arbre servi
cd /root/deploiement-triangle
```

---

## 1. Regarder sans rien changer

```bash
./deployer.sh verifier
```

Affiche les prérequis, les migrations en attente, l'écart entre le code
déployé et la branche. **Ne modifie rien.**

## 2. Sauvegarder, et vérifier la sauvegarde

```bash
./deployer.sh sauvegarder
```

Écrit un `pg_dump` au format `custom`, puis — c'est le point important — le
**restaure dans une base jetable** et recompte les tables. Une sauvegarde
qu'on n'a pas relue n'est pas une sauvegarde : si elle ne se restaure pas,
le script s'arrête et refuse d'aller plus loin.

## 3. Déployer

```bash
./deployer.sh deployer
```

Enchaîne : prérequis → sauvegarde vérifiée → mise à jour du code →
dépendances → migrations → redémarrage PM2 → contrôle de santé.

Chaque migration s'applique dans **sa propre transaction** et est enregistrée
dans `schema_migrations` : une migration qui échoue n'en laisse pas une autre
à moitié appliquée, et un second passage ne rejoue rien.

Le script s'arrête à la première erreur et indique la commande de retour.

### Variante : le schéma seul

```bash
./deployer.sh migrer
```

Sauvegarde puis applique les migrations, **sans toucher au code**. Utile pour
une reprise après incident.

## 4. Vérifier

```bash
./deployer.sh sante
```

Contrôle que le serveur répond, que la base répond, et que la colonne
`show_in_financial_movements` existe — celle dont l'absence faisait échouer
le bloc financier du tableau de bord.

## 5. Revenir en arrière

```bash
./deployer.sh sauvegardes              # lister
./deployer.sh retour 20261021-203605   # revenir
```

Demande de taper `RETOUR ARRIERE` en toutes lettres. **Sauvegarde d'abord
l'état actuel** — revenir en arrière ne doit pas être un geste sans retour —
puis vide le schéma et restaure.

> **Pourquoi vider le schéma.** `pg_restore --clean` ne supprime que les
> objets présents dans la sauvegarde. Les tables créées *après* elle — celles
> qu'un retour arrière doit justement faire disparaître — lui sont inconnues
> et survivraient. On obtiendrait une base hybride : l'ancien schéma plus les
> nouvelles tables, à moitié peuplées, en croyant être revenu en arrière.

---

## Les migrations de ce lot

| Fichier | Ce qu'elle fait | Destructive ? |
|---|---|---|
| `103_transferts_internes_de_fonds.sql` | Crée `show_in_financial_movements` (absente, et pourtant lue par le tableau de bord), `internal_fund_transfers`, la vue des anciens mouvements candidats | Non |
| `104_correction_bons_comptables.sql` | Historique et contre-passation des bons, vue des bons incohérents | Non |
| `105_contrepassation_paiements_ciment.sql` | `cement_payment_reversals` et l'index unique manquant côté sable | Non |
| `106_correction_demandes_validees.sql` | Journal des corrections de demandes, marques d'annulation sur les mouvements | Non |
| `107_documents_rh.sql` | Contrats, clauses, registre des documents du personnel | Non |

**Toutes sont additives et idempotentes.** Aucune ne supprime de donnée,
aucune ne modifie une ligne existante, aucune ne reclasse d'écriture
ancienne. Chacune se termine par un bloc de contrôle qui échoue bruyamment
si le résultat n'est pas celui attendu.

---

## Ce qui reste à faire À LA MAIN, volontairement

Le logiciel refuse de décider à votre place sur ces quatre points.

1. **Saisir les taux de cotisation** (Fiscalité et cotisations), chacun avec
   sa référence de texte officiel et sa date de vérification. Sans eux, les
   bulletins affichent « NET À PAYER : NON CALCULÉ » — un net inventé aurait
   l'air juste.
2. **Faire valider les quatorze clauses de contrat** par un conseil
   juridique. Tant que ce n'est pas fait, chaque contrat imprimé porte un
   bandeau rouge le signalant.
3. **Examiner les anciens mouvements** que la vue
   `v_transferts_internes_candidats` recense. Les reclasser en masse
   changerait des totaux déjà remis.
4. **Décider des factures FAT & MAT à annuler**, une par une, à partir du
   rapport de réconciliation. Aucun script ne les annulera.

---

## En cas de problème

| Symptôme | Quoi faire |
|---|---|
| Une migration échoue | `./deployer.sh retour <horodatage>` — l'horodatage est affiché par le script |
| Le serveur ne redémarre pas | `pm2 logs triangle-backend --lines 100`, puis retour arrière si besoin |
| Le tableau de bord financier échoue | `./deployer.sh sante` dira si la colonne manque |
| Un écart de solde apparaît | Rien n'a été effacé : tout mouvement a sa contre-écriture. Voir les journaux `stock_request_corrections`, `cash_voucher_history`, `internal_fund_transfers` |

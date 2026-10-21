# Numérotation des migrations

## Le bloc réservé 150–199

Les migrations de la branche
`claude/droits-permissions-erreur-comptes-dyg32h` occupent **150 à 154**.

Elles étaient d'abord numérotées 103–107. Le numéro **106 est déjà utilisé en
production** par la V16 des documents RH — une migration posée directement sur
le serveur, absente de Git. Deux fichiers portant le même numéro, c'est un
ordre d'application ambigu et deux lignes de registre qu'on croit être la même.

| Avant | Après | Objet |
|---|---|---|
| 103 | **150** | Transferts internes de fonds |
| 104 | **151** | Correction des bons comptables |
| 105 | **152** | Contre-passation des paiements ciment |
| 106 | **153** | Correction des demandes validées |
| 107 | **154** | Documents du personnel |

Les migrations **100, 101 et 102 n'ont pas été renumérotées** : elles ont pu
être appliquées en production sous leur nom actuel, et les renommer les ferait
rejouer. Elles sont idempotentes, donc sans dommage — mais ce serait du bruit
qui masquerait un vrai problème.

## Avant tout déploiement

```bash
DATABASE_URL=… node scripts/verifier-migrations.js
```

Lecture seule. Le script compare les fichiers de la branche à ce que la base
porte réellement et distingue trois cas :

- **collision branche / base** — un numéro partagé entre un fichier de la
  branche et un fichier que seule la base connaît : bloquant ;
- **doublon interne au dépôt** — deux fichiers versionnés de même numéro :
  l'ordre est figé depuis longtemps, non bloquant ;
- **migration hors branche** — appliquée sur le serveur, absente de Git : à
  rapatrier.

Il vérifie aussi quelles **structures** la branche veut créer et qui existent
déjà. C'est la question qui compte : un numéro n'est qu'une étiquette, une
table de même nom mais de forme différente est un vrai danger.

Il sort en code **2** s'il trouve un point bloquant, et le script de
déploiement s'arrête alors.

## Sept doublons anciens

Le dépôt porte déjà sept numéros utilisés deux fois : 000, 013, 040, 041,
042, 047, 090. Les deux fichiers de chaque paire sont versionnés et appliqués
depuis longtemps ; l'ordre entre eux est figé. Non bloquant, mais à ne pas
reproduire.

## Pour la suite

Prenez le numéro suivant dans le bloc réservé (155, 156…) et vérifiez avant de
pousser :

```bash
ls sql/ | grep -E "^$(date +%j)" ; DATABASE_URL=… node scripts/verifier-migrations.js
```

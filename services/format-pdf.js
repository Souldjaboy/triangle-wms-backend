"use strict";

/**
 * FORMATER DES NOMBRES POUR UN PDF.
 *
 * `toLocaleString("fr-FR")` sépare les milliers avec une ESPACE FINE
 * INSÉCABLE (U+202F). C'est typographiquement juste, et illisible dans un
 * PDF : les polices standard de pdfkit encodent en WinAnsi, qui ne connaît
 * pas ce caractère. Le lecteur voit « 450 /000 FCFA » — un montant faux
 * d'apparence, sur un contrat ou un bon de livraison signé.
 *
 * On remplace donc tous les espaces exotiques par l'espace ordinaire, qui
 * s'encode partout. Le rendu reste correct, et le montant redevient lisible.
 *
 * Ce module est partagé : les bons de livraison et les documents du personnel
 * doivent écrire un montant de la même façon.
 */

/* U+00A0 insécable, U+202F fine insécable, U+2009 fine, U+2007 chiffre. */
const ESPACES_EXOTIQUES = /[    ]/g;

/** Un nombre à la française, mais avec des espaces que le PDF sait écrire. */
function nombreFr(valeur, options = {}) {
  return Number(valeur || 0).toLocaleString("fr-FR", options)
    .replace(ESPACES_EXOTIQUES, " ");
}

/** Le FCFA n'a pas de centime : un montant s'écrit en francs entiers. */
function fcfa(valeur) {
  return `${nombreFr(Math.round(Number(valeur || 0)))} FCFA`;
}

/** Toute chaîne destinée à un PDF, débarrassée de ses espaces exotiques. */
function texteSur(valeur) {
  return String(valeur ?? "").replace(ESPACES_EXOTIQUES, " ");
}

module.exports = { nombreFr, fcfa, texteSur, ESPACES_EXOTIQUES };

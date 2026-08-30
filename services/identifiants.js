"use strict";

/**
 * IDENTIFIANTS DE CONNEXION : EMAIL OU TÉLÉPHONE.
 *
 * Tout le monde n'a pas d'adresse email. Un magasinier a un téléphone, et
 * c'est avec lui qu'il doit pouvoir entrer. Ce module donne au numéro la même
 * fiabilité qu'à l'email : une forme unique, stable, sur laquelle on peut
 * poser une contrainte d'unicité et faire une recherche exacte.
 *
 * Le même numéro s'écrit de cinq façons — « 76 32 77 99 », « 76327799 »,
 * « +223 76 32 77 99 », « 00223 76327799 », « 223-76-32-77-99 ». Sans forme
 * normalisée, ce sont cinq comptes différents, et la personne qui essaie de
 * se connecter avec une écriture qu'elle n'a pas utilisée à l'inscription
 * reste dehors sans comprendre pourquoi.
 */

/** Indicatif par défaut : le Mali. */
const INDICATIF_DEFAUT = "223";
/** Longueur d'un numéro malien sans indicatif. */
const LONGUEUR_LOCALE = 8;

/**
 * Ramène un numéro à sa forme internationale : `+223XXXXXXXX`.
 *
 * Renvoie `""` si l'entrée ne peut pas être un numéro — l'appelant décide
 * alors s'il refuse ou s'il ignore le champ. On ne devine jamais un numéro
 * à moitié : mieux vaut refuser que rattacher un compte au mauvais abonné.
 */
function normaliserTelephone(brut) {
  const texte = String(brut ?? "").trim();
  if (!texte) return "";

  /* Le « + » ne compte que s'il ouvre le numéro ; ailleurs c'est du bruit. */
  const plusInitial = texte.startsWith("+");
  let chiffres = texte.replace(/[^0-9]/g, "");
  if (!chiffres) return "";

  /* « 00223… » est l'autre écriture de « +223… ». */
  if (!plusInitial && chiffres.startsWith("00")) chiffres = chiffres.slice(2);
  else if (plusInitial) { /* déjà international */ }
  else if (chiffres.length === LONGUEUR_LOCALE) chiffres = INDICATIF_DEFAUT + chiffres;
  else if (chiffres.startsWith(INDICATIF_DEFAUT)
           && chiffres.length === INDICATIF_DEFAUT.length + LONGUEUR_LOCALE) {
    /* « 22376327799 » saisi sans le plus ni le double zéro. */
  }

  /* Un numéro plus court qu'un numéro local n'est pas un numéro. La borne
     haute suit la recommandation E.164 : quinze chiffres au maximum. */
  if (chiffres.length < LONGUEUR_LOCALE || chiffres.length > 15) return "";

  return `+${chiffres}`;
}

/** Un identifiant qui contient un « @ » est traité comme une adresse. */
function estEmail(identifiant) {
  return String(identifiant ?? "").includes("@");
}

/**
 * Email utilisable : présent, et pas l'une des adresses de remplissage que
 * l'ancien code fabriquait pour contourner la contrainte NOT NULL.
 */
const DOMAINES_FICTIFS = ["@pending.trianglewmspro.local"];

function emailReel(email) {
  const texte = String(email ?? "").trim();
  if (!texte || !texte.includes("@")) return "";
  if (DOMAINES_FICTIFS.some((d) => texte.toLowerCase().endsWith(d))) return "";
  return texte;
}

/**
 * Décrit ce qu'on a reçu comme identifiants, une fois pour toutes, pour que
 * la création et la connexion partagent exactement la même lecture.
 */
function lireIdentifiants({ email, phone }) {
  const adresse = emailReel(email);
  const numero = normaliserTelephone(phone);
  const numeroFourni = String(phone ?? "").trim() !== "";

  return {
    email: adresse || null,
    emailNormalise: adresse ? adresse.toLowerCase() : null,
    telephone: numero || null,
    /* Un numéro fourni mais illisible est une erreur de saisie, pas une
       absence : il faut le dire plutôt que de créer un compte sans numéro. */
    telephoneIllisible: numeroFourni && !numero,
  };
}

module.exports = {
  INDICATIF_DEFAUT,
  normaliserTelephone,
  estEmail,
  emailReel,
  lireIdentifiants,
};

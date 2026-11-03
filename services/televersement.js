"use strict";
/**
 * RECEVOIR UN FICHIER, ET DIRE CE QUI N'A PAS MARCHÉ.
 *
 * multer limite les CHAMPS de formulaire à un mégaoctet par défaut. Or
 * plusieurs de nos envois portent, à côté du fichier, un champ qui peut être
 * gros : le texte reconnu d'un scan de trente pages, ou le plan d'une mise
 * en page. Au-delà de la limite, multer refuse AVANT que le code applicatif
 * ait vu quoi que ce soit, et son erreur part dans le gestionnaire
 * d'erreurs d'Express — c'est-à-dire en 500 sans message utile.
 *
 * L'utilisateur voyait donc « erreur serveur » là où il fallait lire « votre
 * document contient trop de texte reconnu ». Ce module donne une limite de
 * champ cohérente avec ce que le code accepte ensuite, et traduit les refus
 * de multer en réponses lisibles.
 */
const multer = require("multer");
const S = require("./studio-stockage");

/* Trois mégaoctets : au-dessus de la limite applicative la plus large (deux
   mégaoctets de texte reconnu ou de plan), pour que ce soit le contrôle
   applicatif — qui explique quoi faire — qui tranche, et non multer. */
const CHAMP_MAX = 3 * 1024 * 1024;

const MESSAGES = {
  LIMIT_FILE_SIZE: "Le fichier dépasse la taille autorisée.",
  LIMIT_FIELD_VALUE: "Un champ de cet envoi est trop lourd.",
  LIMIT_FIELD_COUNT: "Trop de champs dans cet envoi.",
  LIMIT_FILE_COUNT: "Un seul fichier à la fois.",
  LIMIT_PART_COUNT: "Envoi trop découpé.",
};

/**
 * @param champ le nom du champ qui porte le fichier
 * @param options.tailleMax taille maximale du fichier
 * @param options.messages  messages propres à l'appelant, par code multer
 */
function recevoir(champ, { tailleMax = S.TAILLE_MAX, messages = {} } = {}) {
  const outil = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: tailleMax, files: 1, fieldSize: CHAMP_MAX },
  }).single(champ);

  return function middleware(req, res, suite) {
    outil(req, res, (e) => {
      if (!e) return suite();
      const code = e.code || "";
      const message = messages[code] || MESSAGES[code];
      res.status(413).json({
        error: message
          || (code === "LIMIT_UNEXPECTED_FILE"
            ? `Champ de fichier inattendu : il doit s'appeler « ${champ} ».`
            : `Envoi refusé (${code || e.message}).`),
        code: code || "ENVOI_REFUSE",
      });
    });
  };
}

/**
 * PLUSIEURS FICHIERS SOUS LE MÊME NOM DE CHAMP.
 *
 * Une présentation s'enregistre d'un coup : le plan, et une image par
 * diapositive. Les envoyer un par un laisserait, en cas de coupure, un
 * document dont les pages ne correspondent plus à son plan.
 *
 * @param champ     le nom du champ qui porte les fichiers
 * @param maximum   combien au plus
 * @param options.tailleMax  taille maximale PAR fichier
 */
function recevoirPlusieurs(champ, maximum, { tailleMax = S.TAILLE_MAX, messages = {} } = {}) {
  const outil = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: tailleMax, files: maximum, fieldSize: CHAMP_MAX,
      /* Chaque fichier et chaque champ est une « partie » du corps multipart.
         La limite par défaut est basse : une présentation de deux cents
         diapositives la dépasserait, et le refus arriverait en 500 muet. */
      parts: maximum + 20,
    },
  }).array(champ, maximum);

  return function middleware(req, res, suite) {
    outil(req, res, (e) => {
      if (!e) return suite();
      const code = e.code || "";
      const message = messages[code] || (code === "LIMIT_FILE_COUNT"
        ? `Pas plus de ${maximum} fichiers dans un même envoi.`
        : MESSAGES[code]);
      res.status(413).json({
        error: message
          || (code === "LIMIT_UNEXPECTED_FILE"
            ? `Champ de fichier inattendu : il doit s'appeler « ${champ} ».`
            : `Envoi refusé (${code || e.message}).`),
        code: code || "ENVOI_REFUSE",
      });
    });
  };
}

module.exports = { recevoir, recevoirPlusieurs, CHAMP_MAX };

"use strict";

/**
 * Erreur métier du noyau biométrique : un code stable (pour l'écran et les
 * tests), un message lisible, un statut HTTP. Ne transporte JAMAIS de gabarit,
 * d'image ni de secret.
 */
class BiometrieError extends Error {
  constructor(message, code, httpStatus = 400, details = undefined) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

module.exports = { BiometrieError };

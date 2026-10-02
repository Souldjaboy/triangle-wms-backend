"use strict";

/**
 * REGISTRE DES FOURNISSEURS — le seul endroit qui instancie un fournisseur.
 *
 * Garde-fou : les simulateurs (« mock ») ne s'activent QUE si
 * NODE_ENV=test ET BIOMETRIC_ALLOW_MOCK=1. En production ils sont refusés,
 * même si une société les a choisis en base.
 *
 * Aucun fournisseur cloud n'est branché : en ajouter un exige une décision
 * explicite (transfert de données biométriques hors de l'entreprise).
 */

const { BiometrieError } = require("../core/erreurs");
const face = require("./face");
const empreinte = require("./fingerprint");

function mockAutorise(env = process.env) {
  return env.NODE_ENV === "test" && env.BIOMETRIC_ALLOW_MOCK === "1";
}

const VISAGE = {
  local: (env) => new face.LocalHttpFaceProvider(env),
  terminal: () => new face.TerminalFaceProvider(),
  mock: () => new face.MockFaceProvider(),
};

const EMPREINTE = {
  terminal: () => new empreinte.TerminalFingerprintProvider(),
  agent_local: () => new empreinte.AgentLocalFingerprintProvider(),
  mock: () => new empreinte.MockFingerprintProvider(),
};

function fournisseur(type, nom, env = process.env) {
  const table = type === "face" ? VISAGE : type === "fingerprint" ? EMPREINTE : null;
  if (!table) throw new BiometrieError("Type biométrique inconnu.", "TYPE_INVALIDE", 400);
  const cle = String(nom || "").trim();
  if (!cle) {
    throw new BiometrieError(
      type === "face" ? "Aucun fournisseur de reconnaissance faciale n'est choisi pour cette entreprise."
        : "Aucun fournisseur d'empreinte n'est choisi pour cette entreprise.",
      "FOURNISSEUR_NON_CONFIGURE", 503);
  }
  if (cle === "mock" && !mockAutorise(env)) {
    throw new BiometrieError("Le simulateur biométrique est interdit hors des tests automatisés.",
      "FOURNISSEUR_INTERDIT", 403);
  }
  const fabrique = table[cle];
  if (!fabrique) throw new BiometrieError("Fournisseur biométrique inconnu.", "FOURNISSEUR_INCONNU", 400);
  return fabrique(env);
}

/** Ce qu'un écran peut proposer, sans rien promettre d'inactif. */
function catalogue(env = process.env) {
  const local = new face.LocalHttpFaceProvider(env);
  return {
    face: [
      { cle: "local", label: "Moteur local auto-hébergé", disponible: local.configure,
        note: local.configure ? "Configuré" : "FACE_ENGINE_URL non défini : inactif" },
      { cle: "terminal", label: "Terminal biométrique (visage)", disponible: true,
        note: "Comparaison sur l'appareil, événements signés" },
      ...(mockAutorise(env) ? [{ cle: "mock", label: "Simulateur (tests)", disponible: true, note: "Tests uniquement" }] : []),
    ],
    fingerprint: [
      { cle: "terminal", label: "Terminal biométrique (empreinte)", disponible: true,
        note: "ZKTeco, Hikvision, Suprema… comparaison sur l'appareil" },
      { cle: "agent_local", label: "Lecteur USB + agent local", disponible: true,
        note: "SDK du fabricant sur le PC, événements signés" },
      ...(mockAutorise(env) ? [{ cle: "mock", label: "Simulateur (tests)", disponible: true, note: "Tests uniquement" }] : []),
    ],
  };
}

module.exports = { fournisseur, catalogue, mockAutorise };

"use strict";

/**
 * FOURNISSEURS D'EMPREINTE DIGITALE.
 *
 * Un navigateur ne lit PAS un lecteur d'empreinte : aucune API web ne le
 * permet. Deux voies réelles seulement :
 *
 *   A. TERMINAL biométrique (ZKTeco, Hikvision, Suprema…) : il capture,
 *      compare et envoie au serveur un événement SIGNÉ (devices/evenements).
 *   B. AGENT LOCAL sur un PC équipé d'un lecteur USB : l'agent utilise le SDK
 *      du fabricant, compare localement et envoie lui aussi un événement signé.
 *
 * Dans les deux cas la comparaison se fait sur l'appareil : le serveur ne
 * stocke que la référence de la personne dans l'appareil, jamais l'empreinte.
 *
 * Interface commune (FingerprintProvider) :
 *   nom, correspondanceServeur, identificationSupportee
 *   async extraire(capture) → { gabarit: Buffer, format, qualite }   (serveur)
 *   comparer(a, b) → 0..1                                              (serveur)
 *
 * Le simulateur (MockFingerprintProvider) est le seul à comparer côté
 * serveur — pour exercer le chemin chiffré dans les tests. Il est refusé en
 * production par le registre.
 */

const crypto = require("crypto");
const { BiometrieError } = require("../core/erreurs");

class FingerprintProvider {
  constructor(nom) {
    this.nom = nom;
    this.correspondanceServeur = false;
    this.identificationSupportee = false;
  }

  // eslint-disable-next-line no-unused-vars
  async extraire(capture) {
    throw new BiometrieError(
      "L'empreinte se capture et se compare sur le terminal ou l'agent local, jamais dans le navigateur.",
      "MODE_APPAREIL", 400);
  }

  // eslint-disable-next-line no-unused-vars
  comparer(a, b) {
    return 0;
  }
}

/** Terminal biométrique : enrôlement et comparaison sur l'appareil. */
class TerminalFingerprintProvider extends FingerprintProvider {
  constructor() {
    super("terminal");
    this.identificationSupportee = true; // 1:N fait par le terminal lui-même
  }
}

/** Agent local + lecteur USB + SDK fabricant (DigitalPersona, SecuGen, ZKFinger…). */
class AgentLocalFingerprintProvider extends FingerprintProvider {
  constructor() {
    super("agent_local");
    this.identificationSupportee = true;
  }
}

/** SIMULATEUR — TESTS AUTOMATISÉS UNIQUEMENT (voir registre). */
class MockFingerprintProvider extends FingerprintProvider {
  constructor() {
    super("mock");
    this.correspondanceServeur = true;
  }

  async extraire(capture) {
    if (capture?.mock_erreur) throw new BiometrieError("Erreur simulée du lecteur.", "FOURNISSEUR_ERREUR", 502);
    const doigt = String(capture?.mock_doigt || "");
    if (!doigt) throw new BiometrieError("Capture de test invalide.", "CAPTURE_INVALIDE", 400);
    return {
      gabarit: crypto.createHash("sha256").update(`empreinte:${doigt}`).digest(),
      format: "mock-sha256",
      qualite: Number(capture.qualite ?? 0.9),
    };
  }

  comparer(a, b) {
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? 0.99 : 0.02;
  }
}

module.exports = {
  FingerprintProvider,
  TerminalFingerprintProvider,
  AgentLocalFingerprintProvider,
  MockFingerprintProvider,
};

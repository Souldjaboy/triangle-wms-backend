"use strict";

/**
 * DEUX ROUTEURS QUI DÉCLARENT LA MÊME ROUTE.
 *
 * Express retient la PREMIÈRE enregistrée et ignore la seconde. Sans erreur,
 * sans avertissement, sans rien dans les journaux. Le code qu'on vient de
 * déployer est inatteignable, et on cherche des heures pourquoi « la
 * correction n'a rien changé ».
 *
 * Le cas concret : la V16 RH, posée directement sur le serveur, déclare
 * `GET /rh/contrats` et `POST /rh/contrats`. Le nouveau routeur les déclare
 * aussi. Selon l'ordre de montage, l'un des deux disparaît.
 *
 * Ce module parcourt la pile Express APRÈS tous les montages et dit ce qui
 * est masqué. Il n'enlève rien : retirer une route au démarrage serait pire
 * que le mal. Il nomme le problème, et laisse décider.
 */

/** Les routes d'une pile Express, à plat, dans l'ordre d'enregistrement. */
function parcourir(pile, prefixe = "") {
  const out = [];
  for (const couche of pile || []) {
    if (couche.route) {
      const chemin = prefixe + (couche.route.path || "");
      for (const [methode, actif] of Object.entries(couche.route.methods || {})) {
        if (actif) out.push({ methode: methode.toUpperCase(), chemin });
      }
    } else if (couche.name === "router" && couche.handle?.stack) {
      /* Le préfixe d'un sous-routeur n'est pas exposé directement : on le
         reconstitue depuis l'expression régulière de la couche. */
      let sous = "";
      const src = String(couche.regexp || "");
      const m = src.match(/^\/\^\\\/((?:[A-Za-z0-9_\-\\/.]|\\.)*)/);
      if (m && m[1]) sous = "/" + m[1].replace(/\\(.)/g, "$1").replace(/\/$/, "");
      if (sous === "/") sous = "";
      out.push(...parcourir(couche.handle.stack, prefixe + sous));
    }
  }
  return out;
}

/**
 * Les routes masquées par une déclaration antérieure.
 * @returns {Array<{methode, chemin, position_servie, position_masquee}>}
 */
function doublons(app) {
  const routes = parcourir(app?._router?.stack || app?.router?.stack);
  const vues = new Map();
  const masquees = [];
  routes.forEach((r, i) => {
    const cle = `${r.methode} ${r.chemin}`;
    if (vues.has(cle)) {
      masquees.push({ ...r, position_servie: vues.get(cle), position_masquee: i });
    } else {
      vues.set(cle, i);
    }
  });
  return { total: routes.length, masquees };
}

/**
 * Signale les routes masquées au démarrage. Bruyant par choix : un message
 * discret passerait inaperçu, et c'est précisément ce qui rend ce défaut si
 * coûteux à trouver.
 */
function signaler(app, { logger = console } = {}) {
  const { total, masquees } = doublons(app);
  if (!masquees.length) return { total, masquees: [] };

  logger.warn("");
  logger.warn("  ┌─────────────────────────────────────────────────────────────┐");
  logger.warn("  │  ROUTES MASQUÉES — du code déployé est INATTEIGNABLE        │");
  logger.warn("  └─────────────────────────────────────────────────────────────┘");
  for (const m of masquees) {
    logger.warn(`    ${m.methode} ${m.chemin}`);
    logger.warn(`      servie par la déclaration n° ${m.position_servie}, `
      + `celle n° ${m.position_masquee} est ignorée.`);
  }
  logger.warn("");
  logger.warn("    Express retient la première route enregistrée. Si deux");
  logger.warn("    routeurs déclarent le même chemin, le second ne répondra");
  logger.warn("    jamais — sans erreur, sans trace.");
  logger.warn("");
  return { total, masquees };
}

module.exports = { parcourir, doublons, signaler };

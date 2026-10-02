"use strict";

/**
 * Rate limiter à store ENFICHABLE (#3).
 *
 * L'algorithme (fenêtre fixe : max `max` requêtes / `windowMs` par clé
 * IP+chemin) est séparé du stockage. Deux stores fournis :
 *
 *   - MemoryStore : par défaut, mono-instance, sans dépendance ;
 *   - RedisStore  : activé si REDIS_URL est défini ET le client `redis`
 *                   est installé. Compatible multi-instances (INCR+PEXPIRE).
 *
 * Ajouter Redis ne demande AUCUN refactoring : il suffit de définir
 * REDIS_URL et d'installer le paquet `redis`. En son absence, dégradation
 * automatique et silencieuse vers la mémoire (avec un avertissement).
 */

/* ───────────────────────────── Stores ───────────────────────────── */

class MemoryStore {
  constructor() {
    this.buckets = new Map();
    const CLEANUP_MS = 5 * 60 * 1000;
    this._timer = setInterval(() => {
      const now = Date.now();
      for (const [k, e] of this.buckets) if (e.resetAt <= now) this.buckets.delete(k);
    }, CLEANUP_MS);
    this._timer.unref?.();
  }
  // Renvoie { count, resetAt } après incrément.
  async hit(key, windowMs) {
    const now = Date.now();
    let entry = this.buckets.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, entry);
    }
    entry.count += 1;
    return { count: entry.count, resetAt: entry.resetAt };
  }
}

class RedisStore {
  constructor(client) {
    this.client = client;
    this.prefix = "rl:";
  }
  async hit(key, windowMs) {
    const k = this.prefix + key;
    const count = await this.client.incr(k);
    if (count === 1) {
      // Premier hit de la fenêtre : poser l'expiration.
      await this.client.pExpire(k, windowMs);
    }
    let ttl = await this.client.pTTL(k);
    if (ttl < 0) ttl = windowMs; // clé sans TTL : garde-fou
    return { count, resetAt: Date.now() + ttl };
  }
}

/* Sélection du store selon l'environnement. Lazy-require de `redis` pour
   ne pas imposer la dépendance quand elle n'est pas utilisée. */
function buildStore() {
  const url = process.env.REDIS_URL;
  if (!url) return new MemoryStore();
  try {
    // eslint-disable-next-line global-require
    const { createClient } = require("redis");
    const client = createClient({ url });
    client.on("error", (e) => console.warn("⚠️  [rate-limit] Redis:", e.message));
    client.connect().catch((e) =>
      console.warn("⚠️  [rate-limit] connexion Redis échouée, mémoire utilisée:", e.message)
    );
    console.log("ℹ️  [rate-limit] store Redis actif (multi-instances).");
    return new RedisStore(client);
  } catch (e) {
    console.warn("⚠️  [rate-limit] paquet `redis` absent — repli mémoire. Détail:", e.message);
    return new MemoryStore();
  }
}

// Store partagé par tous les limiteurs (une seule connexion).
let sharedStore = null;
function getStore() {
  if (!sharedStore) sharedStore = buildStore();
  return sharedStore;
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || "unknown";
}

/**
 * Crée un middleware de rate limiting.
 * @param {Object} options
 * @param {number} options.windowMs - durée de la fenêtre en ms
 * @param {number} options.max - nombre max de requêtes par fenêtre
 * @param {string} [options.message] - message renvoyé en cas de dépassement
 * @param {Object} [options.store] - store personnalisé (tests / injection)
 */
function createRateLimiter({ windowMs, max, message, store }) {
  const backing = store || getStore();
  return function rateLimiter(req, res, next) {
    const key = `${getClientIp(req)}:${req.path}`;
    backing
      .hit(key, windowMs)
      .then(({ count, resetAt }) => {
        if (count > max) {
          const retryAfterSec = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
          res.setHeader("Retry-After", String(retryAfterSec));
          return res.status(429).json({
            error: message || "Trop de tentatives. Veuillez réessayer plus tard.",
            retry_after_seconds: retryAfterSec
          });
        }
        return next();
      })
      .catch(() => next()); // le rate-limit ne doit jamais casser une requête
  };
}

const SENSITIVE_PREFIXES = [
  "/login",
  "/client/login",
  "/register-saas",
  "/client/register",
  "/password-reset",
  "/verification",
  "/auth/social",
  "/support/contact"
];

const authLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: "Trop de tentatives d'authentification. Réessayez dans quelques minutes."
});

function sensitiveRoutesRateLimit(req, res, next) {
  const isSensitive = SENSITIVE_PREFIXES.some(
    (prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`)
  );
  if (!isSensitive) return next();
  return authLimiter(req, res, next);
}

module.exports = {
  createRateLimiter,
  sensitiveRoutesRateLimit,
  MemoryStore,
  RedisStore,
  getStore
};

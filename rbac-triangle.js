"use strict";

/**
 * RBAC Triangle — la table `user_permissions` devient la SOURCE DE VÉRITÉ.
 *
 * CAUSE DU BUG CORRIGÉE : `user_permissions` était écrite par l'écran
 * Permissions et relue pour l'affichage, mais AUCUN garde ne la consultait —
 * l'autorisation réelle passait uniquement par authorizeRoles()/`role === "..."`.
 * Une case « Valider » cochée pour responsable_entrepot n'avait donc aucun effet.
 *
 * RÈGLES (non régressives) :
 *  1. super_admin : toujours autorisé (architecture existante).
 *  2. Ligne explicite (user_id, module_key) → elle FAIT FOI :
 *       case cochée   = action autorisée
 *       case décochée = action REFUSÉE (même si le rôle l'autoriserait)
 *  3. Aucune ligne pour ce module → repli sur les rôles historiques
 *     (comportement actuel préservé : rien ne casse pour les comptes
 *     n'ayant jamais été configurés dans l'écran Permissions).
 */

const ACTIONS = ["view", "create", "update", "delete", "validate"];

// Action -> colonne réelle de user_permissions.
const ACTION_COLUMN = {
  view: "can_view",
  create: "can_create",
  update: "can_edit",
  delete: "can_delete",
  validate: "can_validate",
};

// Méthode HTTP -> action (convention PHASE 30).
const METHOD_ACTION = {
  GET: "view", HEAD: "view", OPTIONS: "view",
  POST: "create", PUT: "update", PATCH: "update", DELETE: "delete",
};

/**
 * Normalise une clé de module (PHASE 33 : supprime les doublons d'affichage,
 * ex. « inventaires »/« inventaire », « emplacements »/« emplacement »).
 * Une clé fine `stock.request.validate` retombe sur son module parent `stock`.
 */
function normalizeModuleKey(key) {
  let k = String(key || "").trim().toLowerCase();
  if (!k) return "";
  k = k.replace(/\s+/g, "_");
  const ALIASES = {
    stocks: "stock", inventaires: "inventaire", emplacements: "emplacement",
    produits: "produit", utilisateurs: "utilisateur", entrepots: "entrepot",
    demandes: "demande", receptions: "reception", documents: "document",
    rapports: "rapport", assistant_ia: "ia", assistant: "ia",
    comptabilite: "comptabilite", tresorerie: "comptabilite",
    factures: "comptabilite", camions: "logistique",
  };
  return ALIASES[k] || k;
}

/** Racine d'une clé fine : "stock.request.validate" -> "stock". */
function moduleRoot(key) {
  return normalizeModuleKey(String(key || "").split(".")[0]);
}

// Rôles disposant historiquement d'un accès large (repli seulement).
const ADMIN_ROLES = ["super_admin", "admin", "administrateur", "direction", "directeur", "gerant", "manager"];

function isSuperAdmin(user) {
  return user && (user.is_super_admin === true || user.is_super_admin === "true" || user.is_super_admin === 1 ||
    String(user.role || "").toLowerCase() === "super_admin");
}

/**
 * Charge les lignes de permissions d'un utilisateur, indexées par module normalisé.
 * @returns Map<moduleKey, row>
 */
async function loadUserPermissions(pool, userId) {
  const map = new Map();
  if (!userId) return map;
  try {
    const { rows } = await pool.query(
      "SELECT module_key, can_view, can_create, can_edit, can_delete, can_validate FROM user_permissions WHERE user_id=$1",
      [userId]
    );
    for (const r of rows) map.set(normalizeModuleKey(r.module_key), r);
  } catch (error) {
    // Table absente / erreur : on ne bloque jamais (repli rôle).
    console.error("loadUserPermissions:", error.message || error);
  }
  return map;
}

/**
 * Décide si `user` peut faire `action` sur `moduleKey`.
 * @returns { allowed: boolean, source: "super_admin"|"explicit"|"role" }
 */
function decide(permRow, user, action) {
  if (isSuperAdmin(user)) return { allowed: true, source: "super_admin" };

  if (permRow) {
    const col = ACTION_COLUMN[action] || "can_view";
    // Une valeur explicite (true/false) fait foi. NULL = non renseigné -> repli rôle.
    const value = permRow[col];
    if (value === true) return { allowed: true, source: "explicit" };
    if (value === false) return { allowed: false, source: "explicit" };
  }

  // Repli : comportement historique par rôle (non-régression).
  const role = String(user && user.role || "").toLowerCase().trim();
  return { allowed: ADMIN_ROLES.includes(role), source: "role" };
}

/**
 * Middleware : requirePermission("stock", "validate").
 * Si `action` est omise, elle est déduite de la méthode HTTP.
 */
function createRequirePermission(pool) {
  return function requirePermission(moduleKey, action) {
    const root = moduleRoot(moduleKey);
    return async (req, res, next) => {
      try {
        if (!req.user) return next(); // auth gérée en amont par authenticateToken
        const act = action || METHOD_ACTION[req.method] || "view";
        if (isSuperAdmin(req.user)) return next();
        const perms = await loadUserPermissions(pool, req.user.id);
        // Clé fine d'abord (ex. stock.request), puis module racine (stock).
        const row = perms.get(normalizeModuleKey(moduleKey)) || perms.get(root) || null;
        const verdict = decide(row, req.user, act);
        if (!verdict.allowed) {
          return res.status(403).json({
            error: `Action « ${act} » non autorisée sur « ${moduleKey} ».`,
            code: "PERMISSION_DENIED",
            module: moduleKey,
            action: act,
            source: verdict.source,
          });
        }
        return next();
      } catch (error) {
        console.error("requirePermission:", error.message || error);
        return next(); // ne jamais bloquer sur une erreur de garde
      }
    };
  };
}

/**
 * Permissions effectives d'un utilisateur, pour le frontend (PHASE 31 :
 * propagation immédiate — le front interroge cet endpoint, pas le JWT).
 */
async function effectivePermissions(pool, user) {
  const perms = await loadUserPermissions(pool, user && user.id);
  const out = {};
  for (const [moduleKey, row] of perms.entries()) {
    out[moduleKey] = {};
    for (const a of ACTIONS) out[moduleKey][a] = decide(row, user, a).allowed;
  }
  return {
    is_super_admin: isSuperAdmin(user),
    role: user && user.role,
    modules: out,
    // Repli appliqué aux modules non listés (le front l'utilise par défaut).
    fallback_allowed: isSuperAdmin(user) || ADMIN_ROLES.includes(String(user && user.role || "").toLowerCase().trim()),
  };
}

module.exports = {
  ACTIONS, ACTION_COLUMN, METHOD_ACTION,
  normalizeModuleKey, moduleRoot, isSuperAdmin,
  loadUserPermissions, decide, createRequirePermission, effectivePermissions,
};

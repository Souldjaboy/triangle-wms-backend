"use strict";

/**
 * DROITS EFFECTIFS — SOURCE UNIQUE DE VÉRITÉ.
 *
 * Prolonge `rbac-triangle.js` au lieu de le remplacer : les comptes déjà
 * configurés dans l'ancien écran continuent de fonctionner, et un module non
 * couvert par le nouveau modèle retombe sur le comportement historique.
 *
 * L'ordre de décision, du plus fort au plus faible :
 *
 *   1. super admin                     toujours autorisé
 *   2. le module est masqué            tout est refusé, y compris « voir »
 *   3. exception utilisateur           ALLOW ou DENY, elle fait foi
 *   4. droit du rôle                   la base commune de l'entreprise
 *   5. ancienne table user_permissions  comptes configurés avant ce module
 *   6. repli par rôle historique       ce que faisait le code jusqu'ici
 *
 * « Visible » n'est pas un habillage : un module masqué refuse ses routes.
 * Cacher un bouton n'a jamais empêché personne d'appeler l'API.
 */

const legacy = require("../rbac-triangle");

/* Rôles disposant historiquement d'un accès large. Repli seulement : dès
   qu'un droit explicite existe, il l'emporte. */
const ROLES_ADMIN = [
  "super_admin", "admin", "administrateur", "direction", "directeur", "gerant", "manager",
];

/* Le centre des droits lui-même : jamais refusé au dernier super admin. */
const MODULE_PERMISSIONS = "utilisateur.permissions";

/** Alias historiques → clés du référentiel. Mêmes règles que la migration. */
const ALIAS = {
  stocks: "stock", inventaires: "stock.inventaire", inventaire: "stock.inventaire",
  emplacements: "stock.emplacement", emplacement: "stock.emplacement",
  produits: "produit", utilisateurs: "utilisateur", entrepots: "entrepot",
  demandes: "demande", receptions: "reception", documents: "document",
  rapports: "rapport", badges: "badge", notifications: "notification",
  assistant_ia: "ia", assistant: "ia", tresorerie: "comptabilite",
  factures: "comptabilite", camions: "logistique", clients: "crm",
  fournisseurs: "fournisseur", partenaires: "partenaire",
  ventes: "vente", achats: "achat", parametres: "parametre",
  /* Les routes de vente gardent leurs modules sous les clés anglaises
     `cement` et `sand`, tandis que le catalogue les nomme en français. Sans
     ces deux lignes, un droit accordé sur « sable » ne répond à aucune
     question posée sur « sand » : le moteur retombe sur le rôle, un employé
     n'y a droit à rien, et le module reste invisible malgré la permission. */
  cement: "ciment", sand: "sable",
};

function normaliser(cle) {
  const k = String(cle || "").trim().toLowerCase().replace(/\s+/g, "_");
  return ALIAS[k] || k;
}

const estSuperAdmin = (user) => legacy.isSuperAdmin(user);

/* Une clé fine « stock.entree.valider » retombe sur « stock.entree » puis
   « stock » : on cherche du plus précis au plus général. */
function chaineDeCles(cle) {
  const normalisee = normaliser(cle);
  const morceaux = normalisee.split(".");
  const out = [];
  for (let i = morceaux.length; i > 0; i -= 1) out.push(morceaux.slice(0, i).join("."));
  return [...new Set(out)];
}

/**
 * Charge tout ce qui décide, en une fois. Trois requêtes plutôt qu'une par
 * case : l'écran des droits en évalue plusieurs centaines.
 */
async function chargerContexte(pool, user) {
  const companyId = Number(user?.company_id || 0);
  const userId = Number(user?.id || 0);
  const role = String(user?.role || "").trim().toLowerCase();

  const [modules, roleRows, overrideRows] = await Promise.all([
    pool.query(
      `SELECT module_key, parent_key, label, description, sort_order, is_active, is_system, actions
         FROM permission_modules WHERE is_active ORDER BY sort_order, module_key`
    ),
    companyId
      ? pool.query(
          `SELECT module_key, action, allowed FROM role_permissions
            WHERE company_id = $1 AND lower(role) = $2`,
          [companyId, role]
        )
      : { rows: [] },
    companyId && userId
      ? pool.query(
          `SELECT module_key, action, effect FROM user_permission_overrides
            WHERE company_id = $1 AND user_id = $2`,
          [companyId, userId]
        )
      : { rows: [] },
  ]);

  const parRole = new Map();
  roleRows.rows.forEach((r) => parRole.set(`${r.module_key}|${r.action}`, r.allowed));
  const exceptions = new Map();
  overrideRows.rows.forEach((r) => exceptions.set(`${r.module_key}|${r.action}`, r.effect));

  return {
    user,
    modules: modules.rows,
    parModule: new Map(modules.rows.map((m) => [m.module_key, m])),
    parRole,
    exceptions,
    /* Ancien modèle, chargé à la demande seulement. */
    ancien: await legacy.loadUserPermissions(pool, userId),
  };
}

/** Verdict pour un couple module / action, avec sa provenance. */
function decider(ctx, cleModule, action) {
  if (estSuperAdmin(ctx.user)) return { autorise: true, source: "super_admin" };

  const candidats = chaineDeCles(cleModule);
  const cle = candidats.find((c) => ctx.parModule.has(c)) || candidats[candidats.length - 1];

  /* Un module masqué ferme tout : inutile d'examiner les actions d'un écran
     auquel on n'a pas accès. */
  if (action !== "visible") {
    const visible = decider(ctx, cle, "visible");
    if (!visible.autorise) return { autorise: false, source: "module_masque" };
  }

  for (const candidat of candidats) {
    const exception = ctx.exceptions.get(`${candidat}|${action}`);
    if (exception === "ALLOW") return { autorise: true, source: "override" };
    if (exception === "DENY") return { autorise: false, source: "override" };
  }

  for (const candidat of candidats) {
    const parRole = ctx.parRole.get(`${candidat}|${action}`);
    if (parRole === true) return { autorise: true, source: "role" };
    if (parRole === false) return { autorise: false, source: "role" };
  }

  /* Le module parent ne déclare pas cette action, ses sous-modules si.
     « Créer » sur les stocks n'existe pas au niveau du parent : la création
     vit sur les entrées, sorties, transferts et inventaires. Sans cette
     remontée, la page demandait can("stock","create"), ne trouvait rien,
     retombait sur le rôle — et un employé restait en lecture seule alors
     que le droit d'enregistrer une entrée lui avait été accordé.
     On répond donc « peut-on le faire quelque part sous ce module ? ». Le
     garde des routes, lui, interroge toujours la clé précise.

     Ce test passe AVANT l'ancien modèle : une ligne héritée disant « ne peut
     pas créer sur stocks » ne doit pas annuler un droit d'entrée accordé
     explicitement aujourd'hui. L'ancien modèle est un repli, pas un veto sur
     les décisions récentes. */
  const parent = ctx.parModule.get(cle);
  if (parent && !parent.actions.includes(action)) {
    const enfants = ctx.modules.filter((m) => m.parent_key === cle && m.actions.includes(action));
    for (const enfant of enfants) {
      if (decider(ctx, enfant.module_key, action).autorise) {
        return { autorise: true, source: "sous_module" };
      }
    }
    if (enfants.length) return { autorise: false, source: "sous_module" };
  }

  /* Comptes configurés dans l'ancien écran, avant ce module. */
  for (const candidat of candidats) {
    const ligne = ctx.ancien.get(legacy.normalizeModuleKey(candidat));
    if (ligne) {
      const actionAncienne = action === "visible" ? "view" : action;
      const colonne = legacy.ACTION_COLUMN[actionAncienne];
      if (colonne) {
        const valeur = ligne[colonne];
        if (valeur === true) return { autorise: true, source: "legacy" };
        if (valeur === false) return { autorise: false, source: "legacy" };
      }
    }
  }

  const role = String(ctx.user?.role || "").trim().toLowerCase();
  return { autorise: ROLES_ADMIN.includes(role), source: "repli_role" };
}

/* Actions qui modifient. Sert au seul signal « lecture seule » : un écran ne
   doit pas s'annoncer en lecture seule à qui peut transférer, même s'il ne
   peut rien créer. */
const ACTIONS_ECRITURE = [
  "create", "update", "delete", "import", "validate", "cancel",
  "putaway", "transfer", "reserve", "assign", "configure", "share",
  "archive", "reorganize", "manage",
];

/**
 * Le compte peut-il écrire quelque part sous ce module ?
 *
 * Le distinguer de `create` importe : quelqu'un qui n'a que le droit de
 * transférer ne crée rien, et son écran ne doit pourtant pas s'annoncer en
 * lecture seule. Chaque bouton garde son contrôle propre ; ceci ne décide que
 * du bandeau.
 */
function peutEcrire(ctx, cleModule) {
  const candidats = chaineDeCles(cleModule);
  const cle = candidats.find((c) => ctx.parModule.has(c)) || candidats[0];
  const famille = [cle, ...ctx.modules.filter((m) => m.parent_key === cle).map((m) => m.module_key)];
  for (const module of famille) {
    const declaration = ctx.parModule.get(module);
    if (!declaration) continue;
    for (const action of declaration.actions) {
      if (!ACTIONS_ECRITURE.includes(action)) continue;
      if (decider(ctx, module, action).autorise) return true;
    }
  }
  return false;
}

/** Tous les droits d'un utilisateur, prêts pour le frontend. */
async function droitsEffectifs(pool, user) {
  const ctx = await chargerContexte(pool, user);
  const out = {};
  for (const m of ctx.modules) {
    out[m.module_key] = {};
    for (const action of m.actions) {
      out[m.module_key][action] = decider(ctx, m.module_key, action).autorise;
    }
  }
  return {
    is_super_admin: estSuperAdmin(user),
    role: user?.role || "",
    company_id: user?.company_id || null,
    modules: ctx.modules.map((m) => ({
      module_key: m.module_key, parent_key: m.parent_key, label: m.label,
      description: m.description, sort_order: m.sort_order,
      is_system: m.is_system, actions: m.actions,
    })),
    permissions: out,
    /* Par module : une action d'écriture y est-elle ouverte ? C'est ce qui
       décide du bandeau « Lecture seule », et non le seul droit de créer. */
    ecriture: Object.fromEntries(
      ctx.modules.filter((m) => !m.parent_key)
        .map((m) => [m.module_key, peutEcrire(ctx, m.module_key)])
    ),
  };
}

/**
 * Middleware. `requirePermission("stock.entree", "create")`.
 * Sans action, elle se déduit de la méthode HTTP.
 */
function creerRequirePermission(pool) {
  return function requirePermission(cleModule, action) {
    return async (req, res, next) => {
      try {
        if (!req.user) return next(); // authenticateToken s'en charge en amont
        if (estSuperAdmin(req.user)) return next();

        const act = action || legacy.METHOD_ACTION[req.method] || "view";
        const ctx = await chargerContexte(pool, req.user);
        const verdict = decider(ctx, cleModule, act);

        if (!verdict.autorise) {
          /* Un module masqué se comporte comme s'il n'existait pas : révéler
             « interdit » apprendrait déjà qu'il existe. */
          if (verdict.source === "module_masque") {
            return res.status(404).json({ error: "Ressource introuvable.", code: "NOT_FOUND" });
          }
          return res.status(403).json({
            error: `Action « ${act} » non autorisée sur « ${cleModule} ».`,
            code: "PERMISSION_DENIED",
            module: cleModule, action: act, source: verdict.source,
          });
        }
        return next();
      } catch (e) {
        console.error("requirePermission:", e.message || e);
        /* Une panne du garde ne doit pas ouvrir les portes. On refuse, et
           l'incident se voit dans les journaux plutôt que dans les données. */
        return res.status(503).json({
          error: "Contrôle des droits indisponible.", code: "PERMISSION_CHECK_FAILED",
        });
      }
    };
  };
}

module.exports = {
  ROLES_ADMIN, MODULE_PERMISSIONS, ALIAS, ACTIONS_ECRITURE, peutEcrire,
  normaliser, chaineDeCles, estSuperAdmin,
  chargerContexte, decider, droitsEffectifs, creerRequirePermission,
};

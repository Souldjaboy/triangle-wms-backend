"use strict";

/**
 * Registre déclaratif des profils d'importation (multi-produits).
 * Chaque profil décrit : produit, module, champs requis/optionnels, types,
 * alias supplémentaires, règle de doublon, permission, et (phases suivantes)
 * les fonctions de simulation / exécution / rollback.
 *
 * Clé du profil = import_type unique (ex. "triangle.stock_in").
 */
const REGISTRY = new Map();

function register(profile) {
  if (!profile || !profile.key) throw new Error("Profil sans clé.");
  REGISTRY.set(profile.key, profile);
  return profile;
}

function getProfile(key) {
  return REGISTRY.get(key) || null;
}

function listProfiles(productCode) {
  const all = [...REGISTRY.values()];
  return (productCode ? all.filter((p) => p.product_code === productCode) : all).map((p) => ({
    key: p.key,
    product_code: p.product_code,
    module_key: p.module_key,
    submodule_key: p.submodule_key || null,
    name: p.name,
    requiredFields: p.requiredFields || [],
    optionalFields: p.optionalFields || [],
    permission: p.permission || "import",
  }));
}

// Charge les profils de chaque produit (effet de bord : appellent register()).
require("./products/triangle")({ register });
require("./products/triangle-real")({ register });
require("./products/malilink")({ register });
require("./products/hafiya")({ register });

module.exports = { register, getProfile, listProfiles, REGISTRY };

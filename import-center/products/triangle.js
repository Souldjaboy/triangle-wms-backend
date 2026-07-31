"use strict";

/**
 * Profils d'importation Triangle WMS Pro (stock & logistique, comptabilité…).
 * Les mouvements de stock sont TRAÇABLES : chaque ligne produit un mouvement
 * (voir executor, phase 3). Aucune addition SQL directe sur products.quantity.
 */

const MOVEMENT_TYPES = ["OPENING_STOCK", "IN", "OUT", "DAMAGE", "LOSS", "ADJUSTMENT_IN", "ADJUSTMENT_OUT", "TRANSFER_IN", "TRANSFER_OUT", "INVENTORY_CORRECTION"];

// Normalise un libellé de mouvement du fichier (FR/EN) vers un type officiel.
function normalizeMovementType(value) {
  const v = String(value ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  if (/(stock initial|opening)/.test(v)) return "OPENING_STOCK";
  if (/(entree|reception|in\b|approvision)/.test(v)) return "IN";
  if (/(sortie|livraison|consommation|out\b|issued)/.test(v)) return "OUT";
  if (/(casse|damage|avarie)/.test(v)) return "DAMAGE";
  if (/(perte|loss|wastage)/.test(v)) return "LOSS";
  if (/(ajust|adjust|correction|inventaire)/.test(v)) return "ADJUSTMENT_IN";
  if (/(transfert|transfer)/.test(v)) return "TRANSFER_OUT";
  return null;
}

module.exports = function registerTriangle({ register }) {
  // --- Produits (catalogue) ---
  register({
    key: "triangle.products",
    product_code: "triangle",
    module_key: "produits",
    name: "Produits (catalogue)",
    permission: "produits",
    requiredFields: ["product_name"],
    optionalFields: ["product_code", "barcode", "quantity", "unit_price", "description"],
    fieldTypes: { product_name: "text", product_code: "text", barcode: "text", quantity: "quantity", unit_price: "amount" },
    entity: {
      table: "products",
      labelColumn: "name",
      map: { name: "product_name", reference: "product_code", barcode: "barcode", sale_price: "unit_price", description: "description" },
      compute: { stock: (m) => Number(m.quantity) || 0 },
      defaults: { is_active: true },
      dedupBy: [["barcode"], ["sku"], ["reference"], ["name"]],
      updatable: ["sale_price", "description", "barcode"],
      canDelete: true,
      dependencyCheck: async (client, id, companyId) => {
        const r = await client.query("SELECT COUNT(*)::int n FROM stock_movements WHERE product_id=$1 AND company_id=$2", [id, companyId]);
        return r.rows[0].n > 0;
      },
    },
    dedupKey: (m) => ["product", (m.product_code || m.barcode || m.product_name || "").toString().trim().toLowerCase()].join("|"),
    validate: (m) => {
      const errs = [];
      if (!m.product_name || String(m.product_name).trim() === "") errs.push({ field: "product_name", code: "REQUIRED", message: "Nom du produit manquant.", severity: "error" });
      if (m.unit_price != null && m.unit_price < 0) errs.push({ field: "unit_price", code: "NEGATIVE", message: "Prix négatif.", severity: "error" });
      return errs;
    },
  });

  // --- Mouvements de stock (générique + spécialisés) ---
  const stockProfile = (key, name, forcedType, submodule) => register({
    key,
    product_code: "triangle",
    module_key: "logistique",
    submodule_key: submodule,
    name,
    permission: "stock",
    requiredFields: forcedType ? ["product_name", "quantity"] : ["product_name", "quantity", "movement_type"],
    optionalFields: ["product_code", "barcode", "transaction_date", "description", "movement_type"],
    fieldTypes: { product_name: "text", product_code: "text", quantity: "quantity", movement_type: "enum", transaction_date: "date", description: "text" },
    forcedMovementType: forcedType || null,
    movementTypes: MOVEMENT_TYPES,
    normalizeMovementType,
    dedupKey: (m) => ["stock", forcedType || normalizeMovementType(m.movement_type) || "?", (m.product_code || m.product_name || "").toString().trim().toLowerCase(), String(m.quantity ?? ""), m.transaction_date ? String(m.transaction_date) : ""].join("|"),
    validate: (m) => {
      const errs = [];
      if (!m.product_name || String(m.product_name).trim() === "") errs.push({ field: "product_name", code: "REQUIRED", message: "Produit manquant.", severity: "error" });
      const q = Number(m.quantity);
      if (!Number.isFinite(q) || q <= 0) errs.push({ field: "quantity", code: "INVALID_QTY", message: "Quantité invalide (doit être > 0).", severity: "error" });
      if (!forcedType) {
        const t = normalizeMovementType(m.movement_type);
        if (!t) errs.push({ field: "movement_type", code: "UNKNOWN_TYPE", message: "Type de mouvement non reconnu (ENTRÉE/SORTIE/CASSE…).", severity: "error" });
      }
      return errs;
    },
  });

  stockProfile("triangle.stock_movement", "Mouvements de stock (mixte)", null, "mouvements");
  stockProfile("triangle.opening_stock", "Stock initial", "OPENING_STOCK", "mouvements");
  stockProfile("triangle.stock_in", "Entrées de stock", "IN", "mouvements");
  stockProfile("triangle.stock_out", "Sorties de stock", "OUT", "mouvements");
  stockProfile("triangle.damage", "Casse et pertes", "DAMAGE", "mouvements");
  stockProfile("triangle.loss", "Pertes", "LOSS", "mouvements");
  stockProfile("triangle.adjustment", "Ajustements", "ADJUSTMENT_IN", "inventaire");
  stockProfile("triangle.inventory", "Inventaire (correction)", "INVENTORY_CORRECTION", "inventaire");

  // Transferts : double mouvement (TRANSFER_OUT source + TRANSFER_IN destination).
  register({
    key: "triangle.transfer",
    product_code: "triangle",
    module_key: "logistique",
    submodule_key: "mouvements",
    name: "Transferts entre entrepôts",
    permission: "stock",
    isTransfer: true,
    requiredFields: ["product_name", "quantity", "source_warehouse", "destination_warehouse"],
    optionalFields: ["product_code", "transaction_date", "description"],
    fieldTypes: { product_name: "text", quantity: "quantity", source_warehouse: "text", destination_warehouse: "text", transaction_date: "date" },
    dedupKey: (m) => ["transfer", (m.product_code || m.product_name || "").toString().trim().toLowerCase(), String(m.quantity ?? ""), (m.source_warehouse || "") + ">" + (m.destination_warehouse || ""), String(m.transaction_date || "")].join("|"),
    validate: (m) => {
      const errs = [];
      if (!m.product_name) errs.push({ field: "product_name", code: "REQUIRED", message: "Produit manquant.", severity: "error" });
      if (!(Number(m.quantity) > 0)) errs.push({ field: "quantity", code: "INVALID_QTY", message: "Quantité invalide.", severity: "error" });
      if (!m.source_warehouse) errs.push({ field: "source_warehouse", code: "REQUIRED", message: "Entrepôt source manquant.", severity: "error" });
      if (!m.destination_warehouse) errs.push({ field: "destination_warehouse", code: "REQUIRED", message: "Entrepôt destination manquant.", severity: "error" });
      if (m.source_warehouse && m.source_warehouse === m.destination_warehouse) errs.push({ field: "destination_warehouse", code: "SAME_WH", message: "Source et destination identiques.", severity: "error" });
      return errs;
    },
  });

  // Fournisseurs (entité réelle -> table suppliers).
  register({
    key: "triangle.suppliers",
    product_code: "triangle",
    module_key: "partenaires",
    submodule_key: "fournisseurs",
    name: "Fournisseurs",
    permission: "partenaires",
    requiredFields: ["supplier_name"],
    optionalFields: ["phone", "email", "description"],
    fieldTypes: { supplier_name: "text", phone: "text", email: "text" },
    entity: {
      table: "suppliers",
      labelColumn: "name",
      map: { name: "supplier_name", phone: "phone", email: "email", address: "description" },
      defaults: { status: "actif" },
      dedupBy: [["phone"], ["email"], ["name"]],
      updatable: ["phone", "email", "address"],
      canDelete: true,
    },
    dedupKey: (m) => ["supplier", (m.phone || m.email || m.supplier_name || "").toString().trim().toLowerCase()].join("|"),
    validate: (m) => (!m.supplier_name ? [{ field: "supplier_name", code: "REQUIRED", message: "Nom du fournisseur manquant.", severity: "error" }] : []),
  });

  // --- Comptabilité (Phase 4 pour l'exécution ; profil déclaré dès maintenant) ---
  register({
    key: "triangle.expenses",
    product_code: "triangle",
    module_key: "comptabilite",
    submodule_key: "depenses",
    name: "Dépenses",
    permission: "comptabilite",
    requiredFields: ["transaction_date", "expense_amount"],
    optionalFields: ["description", "supplier_name", "product_code"],
    fieldTypes: { transaction_date: "date", expense_amount: "amount", description: "text" },
    dedupKey: (m) => ["expense", String(m.transaction_date || ""), String(m.expense_amount || ""), (m.description || "").toString().trim().toLowerCase()].join("|"),
    validate: (m) => {
      const errs = [];
      if (!m.transaction_date) errs.push({ field: "transaction_date", code: "REQUIRED", message: "Date manquante.", severity: "error" });
      if (!(Number(m.expense_amount) > 0)) errs.push({ field: "expense_amount", code: "INVALID_AMOUNT", message: "Montant de dépense invalide.", severity: "error" });
      return errs;
    },
  });
  register({
    key: "triangle.income",
    product_code: "triangle",
    module_key: "comptabilite",
    submodule_key: "recettes",
    name: "Recettes",
    permission: "comptabilite",
    requiredFields: ["transaction_date", "income_amount"],
    optionalFields: ["description", "customer_name"],
    fieldTypes: { transaction_date: "date", income_amount: "amount", description: "text" },
    dedupKey: (m) => ["income", String(m.transaction_date || ""), String(m.income_amount || ""), (m.description || "").toString().trim().toLowerCase()].join("|"),
    validate: (m) => {
      const errs = [];
      if (!m.transaction_date) errs.push({ field: "transaction_date", code: "REQUIRED", message: "Date manquante.", severity: "error" });
      if (!(Number(m.income_amount) > 0)) errs.push({ field: "income_amount", code: "INVALID_AMOUNT", message: "Montant de recette invalide.", severity: "error" });
      return errs;
    },
  });
};

module.exports.normalizeMovementType = normalizeMovementType;
module.exports.MOVEMENT_TYPES = MOVEMENT_TYPES;

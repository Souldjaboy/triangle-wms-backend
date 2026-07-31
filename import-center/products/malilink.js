"use strict";

/** Profils d'importation MaliLink (marketplace, clients, etc.). */
module.exports = function registerMaliLink({ register }) {
  register({
    key: "malilink.marketplace_products",
    product_code: "malilink",
    module_key: "marketplace",
    submodule_key: "produits",
    name: "Produits marketplace",
    permission: "produits",
    requiredFields: ["product_name", "unit_price"],
    optionalFields: ["product_code", "barcode", "quantity", "description", "supplier_name"],
    fieldTypes: { product_name: "text", unit_price: "amount", quantity: "quantity" },
    entity: {
      table: "marketplace_products",
      labelColumn: "title",
      map: { title: "product_name", description: "description", category: "category", price: "unit_price" },
      compute: { available_stock: (m) => Number(m.quantity) || 0 },
      defaults: { status: "draft" },
      createdByColumn: "created_by",
      dedupBy: [["title"]],
      updatable: ["price", "description", "category"],
      canDelete: true,
      // Ne pas supprimer un produit déjà commandé.
      dependencyCheck: async (client, id) => {
        const r = await client.query("SELECT COUNT(*)::int n FROM marketplace_order_items WHERE product_id=$1", [id]).catch(() => ({ rows: [{ n: 0 }] }));
        return r.rows[0].n > 0;
      },
    },
    dedupKey: (m) => ["mlk_product", (m.product_code || m.barcode || m.product_name || "").toString().trim().toLowerCase()].join("|"),
    validate: (m) => {
      const errs = [];
      if (!m.product_name) errs.push({ field: "product_name", code: "REQUIRED", message: "Nom du produit manquant.", severity: "error" });
      if (!(Number(m.unit_price) >= 0)) errs.push({ field: "unit_price", code: "INVALID_AMOUNT", message: "Prix invalide.", severity: "error" });
      return errs;
    },
  });

  // Profils supplémentaires (simulation ; exécution branchable ultérieurement).
  for (const [key, name, mod, sub] of [
    ["malilink.orders", "Commandes", "marketplace", "commandes"],
    ["malilink.payments", "Paiements", "marketplace", "paiements"],
    ["malilink.vehicles", "Véhicules", "automobile", "vehicules"],
    ["malilink.properties", "Biens immobiliers", "immobilier", "biens"],
    ["malilink.restaurant_menu", "Menus restaurant", "restaurant", "menu"],
  ]) {
    register({
      key, product_code: "malilink", module_key: mod, submodule_key: sub, name, permission: mod,
      requiredFields: ["product_name"], optionalFields: ["unit_price", "quantity", "description", "customer_name", "transaction_date"],
      fieldTypes: { product_name: "text", unit_price: "amount", quantity: "quantity", transaction_date: "date" },
      dedupKey: (m) => [key, (m.product_code || m.product_name || "").toString().trim().toLowerCase(), String(m.transaction_date || "")].join("|"),
      validate: (m) => (!m.product_name ? [{ field: "product_name", code: "REQUIRED", message: "Libellé manquant.", severity: "error" }] : []),
    });
  }

  register({
    key: "malilink.customers",
    product_code: "malilink",
    module_key: "crm",
    submodule_key: "clients",
    name: "Clients",
    permission: "partenaires",
    requiredFields: ["customer_name"],
    optionalFields: ["phone", "email", "description"],
    fieldTypes: { customer_name: "text", phone: "text", email: "text" },
    dedupKey: (m) => ["mlk_customer", (m.phone || m.email || m.customer_name || "").toString().trim().toLowerCase()].join("|"),
    validate: (m) => {
      const errs = [];
      if (!m.customer_name) errs.push({ field: "customer_name", code: "REQUIRED", message: "Nom du client manquant.", severity: "error" });
      return errs;
    },
  });
};

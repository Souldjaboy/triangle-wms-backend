"use strict";

/**
 * Profils d'importation HAFIYA (laboratoire). Les données médicales sont
 * sensibles : les résultats importés ne sont JAMAIS validés automatiquement
 * (statut BROUILLON par défaut, voir executor phase 6).
 */
module.exports = function registerHafiya({ register }) {
  register({
    key: "hafiya.patients",
    product_code: "hafiya",
    module_key: "laboratoire",
    submodule_key: "patients",
    name: "Patients",
    permission: "laboratoire",
    requiredFields: ["last_name", "first_name"],
    optionalFields: ["patient_id", "gender", "birth_date", "phone", "email", "description"],
    fieldTypes: { last_name: "text", first_name: "text", birth_date: "date", phone: "text", email: "text" },
    entity: {
      table: "laboratory_patients",
      labelColumn: "full_name",
      map: { phone: "phone", email: "email", gender: "gender", birth_date: "birth_date", address: "description" },
      compute: { full_name: (m) => `${m.first_name || ""} ${m.last_name || ""}`.trim() },
      // Doublon patient : téléphone > email > nom complet + naissance. Jamais de fusion sur simple ressemblance.
      dedupBy: [["phone"], ["email"], ["full_name", "birth_date"]],
      updatable: ["phone", "email", "gender", "address"],
      canDelete: true,
      // Ne pas supprimer un patient ayant déjà des dossiers/analyses/paiements.
      dependencyCheck: async (client, id) => {
        const r = await client.query("SELECT (SELECT COUNT(*) FROM laboratory_cases WHERE patient_id=$1) + (SELECT COUNT(*) FROM laboratory_appointments WHERE patient_id=$1) + (SELECT COUNT(*) FROM laboratory_payments WHERE patient_id=$1) AS n", [id]).catch(() => ({ rows: [{ n: 0 }] }));
        return Number(r.rows[0].n) > 0;
      },
    },
    // Doublon patient : id > téléphone > email > nom+prénom+naissance. Jamais de fusion auto sur simple ressemblance.
    dedupKey: (m) => {
      if (m.patient_id) return ["patient", "id", String(m.patient_id).trim().toLowerCase()].join("|");
      if (m.phone) return ["patient", "tel", String(m.phone).replace(/\s/g, "")].join("|");
      if (m.email) return ["patient", "mail", String(m.email).trim().toLowerCase()].join("|");
      return ["patient", "nom", (m.last_name || "").toString().trim().toLowerCase(), (m.first_name || "").toString().trim().toLowerCase(), String(m.birth_date || "")].join("|");
    },
    validate: (m) => {
      const errs = [];
      if (!m.last_name) errs.push({ field: "last_name", code: "REQUIRED", message: "Nom manquant.", severity: "error" });
      if (!m.first_name) errs.push({ field: "first_name", code: "REQUIRED", message: "Prénom manquant.", severity: "error" });
      return errs;
    },
  });

  register({
    key: "hafiya.lab_results",
    product_code: "hafiya",
    module_key: "laboratoire",
    submodule_key: "resultats",
    name: "Résultats d'analyses",
    permission: "laboratoire",
    // Statut d'import : toujours BROUILLON (validation médicale manuelle obligatoire).
    importStatus: "BROUILLON",
    requiredFields: ["patient_id", "description"],
    optionalFields: ["transaction_date", "balance"],
    fieldTypes: { patient_id: "text", description: "text", transaction_date: "date" },
    dedupKey: (m) => ["result", String(m.patient_id || ""), (m.description || "").toString().trim().toLowerCase(), String(m.transaction_date || "")].join("|"),
    validate: (m) => {
      const errs = [];
      if (!m.patient_id) errs.push({ field: "patient_id", code: "REQUIRED", message: "Identifiant patient manquant.", severity: "error" });
      if (!m.description) errs.push({ field: "description", code: "REQUIRED", message: "Analyse/description manquante.", severity: "error" });
      return errs;
    },
  });

  // Catalogue des analyses (exécutable → laboratory_analyses).
  register({
    key: "hafiya.analyses_catalog",
    product_code: "hafiya",
    module_key: "laboratoire",
    submodule_key: "analyses",
    name: "Catalogue des analyses",
    permission: "laboratoire",
    requiredFields: ["product_name"],
    optionalFields: ["unit_price", "description"],
    fieldTypes: { product_name: "text", unit_price: "amount", description: "text" },
    entity: {
      table: "laboratory_analyses",
      labelColumn: "name",
      map: { name: "product_name", price: "unit_price", description: "description" },
      defaults: { is_available: true },
      dedupBy: [["name"]],
      updatable: ["price", "description"],
      canDelete: true,
    },
    dedupKey: (m) => ["analysis", (m.product_name || "").toString().trim().toLowerCase()].join("|"),
    validate: (m) => (!m.product_name ? [{ field: "product_name", code: "REQUIRED", message: "Nom de l'analyse manquant.", severity: "error" }] : []),
  });

  // Profils supplémentaires (simulation).
  for (const [key, name, sub] of [
    ["hafiya.appointments", "Rendez-vous", "rendez_vous"],
    ["hafiya.payments", "Paiements", "paiements"],
    ["hafiya.reagents_stock", "Stock réactifs", "stock"],
  ]) {
    register({
      key, product_code: "hafiya", module_key: "laboratoire", submodule_key: sub, name, permission: "laboratoire",
      requiredFields: ["product_name"], optionalFields: ["transaction_date", "unit_price", "quantity", "description"],
      fieldTypes: { product_name: "text", transaction_date: "date", unit_price: "amount", quantity: "quantity" },
      dedupKey: (m) => [key, (m.product_name || "").toString().trim().toLowerCase(), String(m.transaction_date || "")].join("|"),
      validate: (m) => (!m.product_name ? [{ field: "product_name", code: "REQUIRED", message: "Libellé manquant.", severity: "error" }] : []),
    });
  }
};

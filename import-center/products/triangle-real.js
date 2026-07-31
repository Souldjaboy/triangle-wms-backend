"use strict";

/**
 * Profils Triangle adaptés aux FICHIERS RÉELS de l'entreprise (officiels) :
 *  - triangle.factures  : « Etats global des factures » (Triangle / Fat et Mat)
 *  - triangle.tresorerie: « Tableau de Trésorerie » (Date/Libellé/Entrée/Sortie/Solde)
 *  - triangle.suivi     : « Tableau de suivi comptable » (Recettes/Dépenses [+ Camion])
 *
 * Chaque profil porte un `headerMap` EXACT (en-tête normalisé -> champ) et des
 * jetons de reconnaissance `recognize` pour la détection automatique du type.
 * On adapte le logiciel aux fichiers, pas l'inverse.
 */
const { normalize } = require("../detector");

// Statut de facture recalculé (logique du fichier réel).
function invoiceStatus(invoiced, paid) {
  const inv = Number(invoiced) || 0, pd = Number(paid) || 0;
  if (inv > 0 && pd >= inv) return "paye";
  if (pd <= 0) return "impaye";
  return "partiel";
}

module.exports = function registerTriangleReal({ register }) {
  register({
    key: "triangle.factures",
    product_code: "triangle",
    module_key: "comptabilite",
    submodule_key: "factures",
    name: "États des factures",
    permission: "comptabilite",
    kind: "factures",
    recognize: ["montant facture", "reste a payer", "statut"],
    headerMap: {
      "n": "numero",
      "date de facture": "invoice_date",
      "ref n facture": "reference",
      "localite site": "site",
      "description": "description",
      "montant facture en f cfa": "invoiced_amount",
      "montant paye en f cfa": "paid_amount",
      "reste a payer en f cfa": "remaining_amount",
      "date de paiement": "payment_date",
      "statut": "status_source",
      "obervations": "observations",
      "observations": "observations",
    },
    requiredFields: ["reference", "invoiced_amount"],
    optionalFields: ["numero", "invoice_date", "site", "description", "paid_amount", "remaining_amount", "payment_date", "status_source", "observations"],
    fieldTypes: { invoice_date: "date", payment_date: "date", invoiced_amount: "amount", paid_amount: "amount", remaining_amount: "amount" },
    invoiceStatus,
    dedupKey: (m) => ["facture", String(m.reference || "").trim().toLowerCase()].join("|"),
    validate: (m) => {
      const errs = [];
      if (!m.reference || String(m.reference).trim() === "") errs.push({ field: "reference", code: "REQUIRED", message: "Référence de facture manquante.", severity: "error" });
      if (!(Number(m.invoiced_amount) > 0)) errs.push({ field: "invoiced_amount", code: "INVALID_AMOUNT", message: "Montant facturé invalide.", severity: "error" });
      const inv = Number(m.invoiced_amount) || 0, pd = Number(m.paid_amount) || 0;
      if (pd > inv) errs.push({ field: "paid_amount", code: "OVERPAID", message: "Montant payé supérieur au montant facturé.", severity: "warning" });
      return errs;
    },
  });

  register({
    key: "triangle.tresorerie",
    product_code: "triangle",
    module_key: "comptabilite",
    submodule_key: "tresorerie",
    name: "Tableau de trésorerie",
    permission: "comptabilite",
    kind: "cashbook",
    recognize: ["entree", "sortie", "solde"],
    recognizeExclude: ["recettes"],
    headerMap: {
      "date": "op_date",
      "libelle": "libelle",
      "entree": "income",
      "sortie": "expense",
      "solde": "_ignore_solde",
    },
    requiredFields: ["op_date"],
    optionalFields: ["libelle", "income", "expense"],
    fieldTypes: { op_date: "date", income: "amount", expense: "amount" },
    dedupKey: (m) => ["treso", String(m.op_date || ""), String(m.libelle || "").trim().toLowerCase(), String(m.income || ""), String(m.expense || "")].join("|"),
    skipRow: (m) => /^(total|solde au)/i.test(String(m.libelle || "").trim()),
    validate: (m) => {
      const errs = [];
      const hasAmount = Number(m.income) > 0 || Number(m.expense) > 0;
      if (!hasAmount) errs.push({ field: "income", code: "NO_AMOUNT", message: "Ni entrée ni sortie sur cette ligne.", severity: "error" });
      return errs;
    },
  });

  register({
    key: "triangle.suivi",
    product_code: "triangle",
    module_key: "comptabilite",
    submodule_key: "suivi",
    name: "Suivi comptable (recettes / dépenses)",
    permission: "comptabilite",
    kind: "cashbook",
    hasCamion: true,
    recognize: ["recettes", "depenses"],
    headerMap: {
      "date": "op_date",
      "libelle de l operation": "libelle",
      "camion": "camion",
      "piece justificatif n": "piece_ref",
      "recettes f cfa": "income",
      "depenses f cfa": "expense",
      "solde f cfa": "_ignore_solde",
      "observations": "observations",
    },
    requiredFields: ["op_date"],
    optionalFields: ["libelle", "camion", "piece_ref", "income", "expense", "observations"],
    fieldTypes: { op_date: "date", income: "amount", expense: "amount" },
    dedupKey: (m) => ["suivi", String(m.op_date || ""), String(m.libelle || "").trim().toLowerCase(), String(m.income || ""), String(m.expense || ""), String(m.camion || "")].join("|"),
    // Ignore les lignes d'ouverture et de totaux par camion.
    skipRow: (m) => {
      const l = String(m.libelle || "").trim();
      const c = String(m.camion || "").trim();
      if (/^(solde au|total)/i.test(l)) return true;
      if (/plaque|^la voiture|^camion \d/i.test(c)) return true; // lignes de sous-totaux
      return false;
    },
    // Une valeur de la colonne Camion est-elle un vrai camion (et non un site/label) ?
    isRealCamion: (v) => {
      const s = String(v || "").trim();
      return !!s && !/plaque|chantier|entrepot|^la voiture/i.test(s);
    },
    validate: (m) => {
      const errs = [];
      const hasAmount = Number(m.income) > 0 || Number(m.expense) > 0;
      if (!hasAmount) errs.push({ field: "income", code: "NO_AMOUNT", message: "Ni recette ni dépense sur cette ligne.", severity: "error" });
      return errs;
    },
  });
};

module.exports.invoiceStatus = invoiceStatus;
module.exports.normalizeHeader = normalize;

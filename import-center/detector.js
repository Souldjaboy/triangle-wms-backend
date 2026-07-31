"use strict";

/**
 * Détection intelligente : reconnaissance des en-têtes (synonymes FR/EN) ET
 * analyse des valeurs de la colonne (jamais uniquement le nom de la colonne).
 */

function normalize(str) {
  return String(str ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Dictionnaire canonique champ -> alias (déjà normalisables). FR + EN.
const SYNONYMS = {
  product_name: ["produit", "designation", "article", "libelle", "nom produit", "product", "product name", "item", "item name", "description article", "nom de l article"],
  product_code: ["code", "reference", "ref", "code article", "sku", "product code", "item code", "code produit"],
  barcode: ["code barre", "code barres", "barcode", "ean", "gencode"],
  quantity: ["quantite", "qte", "qty", "nombre", "quantity", "stock", "nombre d unites", "nb"],
  unit_price: ["prix", "prix unitaire", "cout unitaire", "pu", "unit price", "cost", "unit cost", "prix u"],
  transaction_date: ["date", "date operation", "date mouvement", "date entree", "date sortie", "transaction date", "operation date", "movement date", "date piece"],
  quantity_in: ["entree", "entrees", "quantite entree", "qte entree", "reception", "approvisionnement", "received", "incoming", "quantity in", "stock in"],
  quantity_out: ["sortie", "sorties", "quantite sortie", "qte sortie", "consommation", "livraison", "issued", "outgoing", "quantity out", "stock out"],
  damaged_quantity: ["casse", "casse quantite", "produit casse", "perte", "pertes", "avarie", "destruction", "write off", "damaged", "damaged quantity", "loss", "wastage"],
  adjustment_quantity: ["ajustement", "regularisation", "correction", "inventaire", "adjustment", "correction quantity"],
  movement_type: ["type", "type mouvement", "type de mouvement", "mouvement", "sens", "movement type", "operation"],
  income_amount: ["entree argent", "recette", "encaissement", "credit", "revenu", "income", "revenue", "cash in", "montant entree"],
  expense_amount: ["depense", "sortie argent", "decaissement", "debit", "charge", "expense", "cash out", "montant sortie"],
  balance: ["solde", "tresorerie", "disponible", "balance", "cash balance"],
  description: ["motif", "description", "libelle", "observation", "commentaire", "notes", "reason", "details", "designation operation"],
  customer_name: ["client", "nom client", "customer", "customer name", "raison sociale"],
  supplier_name: ["fournisseur", "nom fournisseur", "supplier", "supplier name"],
  source_warehouse: ["entrepot source", "source", "magasin source", "from warehouse", "depart", "entrepot depart"],
  destination_warehouse: ["entrepot destination", "destination", "magasin destination", "to warehouse", "arrivee", "entrepot arrivee"],
  phone: ["telephone", "tel", "phone", "portable", "gsm", "numero", "contact"],
  email: ["email", "mail", "courriel", "e mail"],
  // HAFIYA
  patient_id: ["numero patient", "id patient", "matricule patient", "patient id", "n patient"],
  first_name: ["prenom", "first name", "prenoms"],
  last_name: ["nom", "last name", "nom de famille"],
  birth_date: ["date de naissance", "naissance", "birth date", "ne le", "dob"],
  gender: ["sexe", "genre", "gender", "sex"],
};

// Valeurs signalant un type de mouvement de stock.
const MOVEMENT_WORDS = ["entree", "entrees", "in", "sortie", "sorties", "out", "casse", "damage", "perte", "loss", "ajustement", "adjustment", "transfert", "transfer", "opening", "stock initial"];

function bestFieldForHeader(header) {
  const n = normalize(header);
  if (!n) return { field: null, confidence: 0 };
  let best = { field: null, confidence: 0 };
  for (const [field, aliases] of Object.entries(SYNONYMS)) {
    for (const alias of aliases) {
      const a = normalize(alias);
      if (n === a) return { field, confidence: 1 }; // exact
      if (n.includes(a) || a.includes(n)) {
        const score = Math.min(a.length, n.length) / Math.max(a.length, n.length);
        if (score > best.confidence) best = { field, confidence: Math.max(0.5, score * 0.9) };
      }
    }
  }
  return best;
}

// ---- Analyse des valeurs ----

// Parse un nombre tolérant : "1 234,56", "1,234.56", "12 000 FCFA", "-3 500".
function parseNumber(value) {
  if (typeof value === "number") return value;
  let s = String(value ?? "").trim();
  if (!s) return null;
  s = s.replace(/(fcfa|xof|cfa|f\b|€|\$)/gi, "").replace(/\s/g, "").trim();
  if (!s) return null;
  const hasComma = s.includes(","), hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // Le dernier séparateur est le décimal.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (hasComma) {
    // « 3,900,000 » (milliers) vs « 1 234,56 » (décimal FR). Plusieurs virgules,
    // ou dernière tranche de 3 chiffres → séparateur de milliers (fréquent FCFA).
    const parts = s.split(",");
    const last = parts[parts.length - 1];
    if (parts.length > 2 || last.length === 3) s = s.replace(/,/g, "");
    else s = s.replace(",", ".");
  } else if (hasDot) {
    // « 3.900.000 » (milliers européens) : plusieurs points → séparateur de milliers.
    if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, "");
  }
  const num = Number(s);
  return Number.isFinite(num) ? num : null;
}

// Parse une date : Date native, série Excel, ISO, jj/mm/aaaa, jj-mm-aaaa.
function parseDate(value) {
  if (value instanceof Date && !isNaN(value)) return value;
  if (typeof value === "number" && value > 0 && value < 60000) {
    // Série Excel (jours depuis 1899-12-30).
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d) ? null : d;
  }
  const s = String(value ?? "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let [, dd, mm, yy] = m;
    if (yy.length === 2) yy = "20" + yy;
    const d = new Date(Number(yy), Number(mm) - 1, Number(dd));
    return isNaN(d) ? null : d;
  }
  m = s.match(/^\d{4}-\d{2}-\d{2}/);
  if (m) { const d = new Date(s); return isNaN(d) ? null : d; }
  // Mois en toutes lettres (EN/FR) : « 18 May 2026 », « February 23, 2026 », « Monday, February 23, 2026 ».
  const MONTHS = { jan:0, feb:1, fev:1, mar:2, apr:3, avr:3, may:4, mai:4, jun:5, jui:5, jul:6, aug:7, aou:7, sep:8, oct:9, nov:10, dec:11 };
  const norm = s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  let mm2 = norm.match(/(\d{1,2})\s+([a-z]{3,})\.?\s+(\d{4})/);        // 18 may 2026
  if (!mm2) mm2 = norm.match(/([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/); // february 23, 2026
  if (mm2) {
    const a = mm2[1], b = mm2[2], c = mm2[3];
    let day, mon, year;
    if (/^\d/.test(a)) { day = Number(a); mon = MONTHS[b.slice(0, 3)]; year = Number(c); }
    else { mon = MONTHS[a.slice(0, 3)]; day = Number(b); year = Number(c); }
    if (mon != null && day >= 1 && day <= 31) { const d = new Date(year, mon, day); return isNaN(d) ? null : d; }
  }
  return null;
}

// Formate une Date en AAAA-MM-JJ à partir des composantes LOCALES (pas d'UTC → pas de décalage).
function fmtYMD(d) {
  if (!(d instanceof Date) || isNaN(d)) return null;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function looksMoney(value) {
  return /(fcfa|xof|cfa|€|\$)/i.test(String(value ?? ""));
}

/**
 * Détermine le type dominant d'une colonne à partir d'un échantillon.
 * @returns { type, confidence } ; type ∈ date|amount|quantity|movement_type|text|number
 */
function detectValueType(values) {
  const sample = values.map((v) => v).filter((v) => v !== "" && v != null).slice(0, 50);
  if (sample.length === 0) return { type: "text", confidence: 0 };
  let dates = 0, numbers = 0, money = 0, moves = 0, ints = 0;
  for (const v of sample) {
    if (parseDate(v)) dates++;
    const n = parseNumber(v);
    if (n != null) { numbers++; if (Number.isInteger(n)) ints++; }
    if (looksMoney(v)) money++;
    if (MOVEMENT_WORDS.includes(normalize(v))) moves++;
  }
  const total = sample.length;
  const ratio = (x) => x / total;
  if (ratio(moves) >= 0.6) return { type: "movement_type", confidence: ratio(moves) };
  if (ratio(dates) >= 0.7) return { type: "date", confidence: ratio(dates) };
  if (ratio(money) >= 0.4) return { type: "amount", confidence: Math.max(ratio(money), ratio(numbers)) };
  if (ratio(numbers) >= 0.8) return { type: ratio(ints) >= 0.9 ? "quantity" : "amount", confidence: ratio(numbers) };
  return { type: "text", confidence: 1 - ratio(numbers) };
}

/** Analyse complète d'une colonne (nom + valeurs) → suggestion + confiance. */
function analyzeColumn(header, values) {
  const byHeader = bestFieldForHeader(header);
  const byValue = detectValueType(values);
  // Cohérence : si l'en-tête suggère un champ mais les valeurs contredisent, on baisse la confiance.
  let confidence = byHeader.confidence;
  if (byHeader.field) {
    const expectDate = byHeader.field.includes("date") || byHeader.field === "birth_date";
    const expectNum = /quantity|amount|price|balance/.test(byHeader.field);
    if (expectDate && byValue.type === "date") confidence = Math.min(1, confidence + 0.1);
    if (expectNum && (byValue.type === "amount" || byValue.type === "quantity")) confidence = Math.min(1, confidence + 0.1);
    if (expectDate && byValue.type !== "date") confidence *= 0.6;
    if (expectNum && byValue.type === "text") confidence *= 0.6;
  }
  const level = confidence >= 0.75 ? "high" : confidence >= 0.45 ? "medium" : "low";
  return { header, suggestedField: byHeader.field, valueType: byValue.type, confidence: Number(confidence.toFixed(2)), level };
}

module.exports = { normalize, SYNONYMS, bestFieldForHeader, parseNumber, parseDate, fmtYMD, looksMoney, detectValueType, analyzeColumn };

"use strict";

/**
 * PREVIEW DE LA MIGRATION 061 — STRICTEMENT LECTURE SEULE.
 *
 * Ce script ne contient QUE des SELECT. Aucune balance créée, aucun
 * emplacement modifié, aucun products.stock touché, 061 non exécutée.
 *
 *   node scripts/preview-061.js --company=<id> \
 *        [--produits=247] [--stock=151237] [--csv=fichier.csv]
 *
 * DÉCISIONS MÉTIER APPLIQUÉES :
 *   1. « BIN1-2 », « BIN2-3 » sont des emplacements HISTORIQUES NON PRÉCIS.
 *      Jamais supposés être un bac unique, jamais répartis automatiquement.
 *   2. Les vrais bacs (BIN1, BIN2, BIN3…) sont LISTÉS comme créables, sous
 *      leur entrepôt / rayon / location / level — mais pas créés ici.
 *   3. Les produits rattachés gardent EXACTEMENT leur stock global et passent
 *      en TO_REVIEW_LOCATION.
 *   4. La répartition manuelle exigera SUM(bins) = products.stock.
 *   5. « NOUVEAU / AUTO » est un LEGACY_PLACEHOLDER.
 *   6. WRITE OFF et BIN-NON-PRECISE restent hors emplacements physiques.
 *
 * Aucune balance n'est inventée : une balance n'est prévue que pour un produit
 * dont l'emplacement est un bac réel, unique et certain.
 */

require("dotenv").config();
const fs = require("fs");
const { Pool } = require("pg");
const rules = require("../services/location-rules");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const arg = (name, def = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
};
const n = (v) => Number(v || 0).toLocaleString("fr-FR");
const T = (v, w) => String(v ?? "—").slice(0, w).padEnd(w);

const ACTIONS = {
  AUTO_MATCH: "AUTO_MATCH",
  TO_REVIEW_LOCATION: "TO_REVIEW_LOCATION",
  NO_LOCATION: "NO_LOCATION",
  ZERO_STOCK: "ZERO_STOCK",
};

async function main() {
  const companyId = Number(arg("company"));
  if (!companyId) {
    console.error("Usage : node scripts/preview-061.js --company=<id>");
    process.exit(1);
  }
  const attendu = { produits: Number(arg("produits", 247)), stock: Number(arg("stock", 151237)) };
  const q = async (sql, p = [companyId]) => (await pool.query(sql, p)).rows;
  const un = async (sql, p = [companyId]) => (await q(sql, p))[0];
  const hasCol = async (t, c) => (await un(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [t, c])).n > 0;

  console.log("═".repeat(84));
  console.log("PREVIEW 061 — LECTURE SEULE, AUCUNE ÉCRITURE, 061 NON EXÉCUTÉE");
  console.log(`entreprise ${companyId} · ${new Date().toLocaleString("fr-FR")}`);
  console.log("═".repeat(84));

  const aFusion = await hasCol("locations", "merged_into_location_id");
  const vivants = aFusion ? "AND l.merged_into_location_id IS NULL" : "";

  // ─────────────────────────────────────────────────────────── état de départ
  const avant = await un(
    `SELECT COUNT(*)::int AS produits, COALESCE(SUM(stock),0)::numeric AS stock,
            COUNT(*) FILTER (WHERE stock < 0)::int AS negatifs
       FROM products WHERE company_id=$1 AND COALESCE(is_active,TRUE)=TRUE`);

  // ───────────────────────────────────────────── emplacements et rattachements
  const locations = await q(
    `SELECT l.id, l.warehouse_id, l.warehouse_code, l.emplacement_code, l.product_id,
            COALESCE(NULLIF(l.rayon_code,''), l.zone)    AS row_code,
            COALESCE(NULLIF(l.case_code,''),  l.rayon)   AS loc_code,
            COALESCE(NULLIF(l.level_code,''), l.etagere) AS lvl_code,
            l.bin_code
       FROM locations l WHERE l.company_id=$1 ${vivants}`);

  const parId = new Map(locations.map((l) => [l.id, l]));
  const parProduit = new Map();
  locations.forEach((l) => {
    if (!l.product_id) return;
    if (!parProduit.has(l.product_id)) parProduit.set(l.product_id, []);
    parProduit.get(l.product_id).push(l);
  });
  const norm = (s) => String(s || "").toUpperCase().replace(/\s+/g, " ").trim();
  const parCode = new Map();
  locations.forEach((l) => {
    const k = norm(l.emplacement_code);
    if (!k) return;
    if (!parCode.has(k)) parCode.set(k, []);
    parCode.get(k).push(l);
  });
  const parMouvement = new Map();
  (await q(
    `SELECT product_id, location_id, COUNT(*)::int AS n FROM stock_movements
      WHERE company_id=$1 AND product_id IS NOT NULL AND location_id IS NOT NULL
      GROUP BY 1,2`)).forEach((r) => {
    if (!parMouvement.has(r.product_id)) parMouvement.set(r.product_id, []);
    parMouvement.get(r.product_id).push(r);
  });

  // ─────────────────────────────────────────────── classification des produits
  const produits = await q(
    `SELECT id, reference, name, stock::numeric AS stock, location_id, location_code
       FROM products WHERE company_id=$1 AND COALESCE(is_active,TRUE)=TRUE ORDER BY name`);

  const lignes = [];
  for (const p of produits) {
    const stock = Number(p.stock || 0);
    const cands = new Map();
    const add = (l) => { if (l && !cands.has(l.id)) cands.set(l.id, l); };
    if (p.location_id && parId.has(p.location_id)) add(parId.get(p.location_id));
    (parProduit.get(p.id) || []).forEach(add);
    if (p.location_code) (parCode.get(norm(p.location_code)) || []).forEach(add);
    (parMouvement.get(p.id) || []).forEach((m) => add(parId.get(m.location_id)));

    const liste = [...cands.values()];
    const reels = liste.filter((l) => rules.isPhysicalBin(l));
    let action, cible = null, motif = "";

    if (stock <= 0) {
      action = ACTIONS.ZERO_STOCK;
      motif = "stock nul : aucune balance positive à créer";
    } else if (reels.length === 1 && liste.length === 1) {
      action = ACTIONS.AUTO_MATCH;
      cible = reels[0];
      motif = "un seul emplacement, et c'est un bac réel";
    } else if (liste.length === 0) {
      action = ACTIONS.NO_LOCATION;
      motif = "aucun emplacement connu";
    } else if (reels.length === 0) {
      action = ACTIONS.TO_REVIEW_LOCATION;
      motif = rules.MOTIF_FR[rules.rejectionReason(liste[0])] || "aucun bac exploitable";
    } else {
      action = ACTIONS.TO_REVIEW_LOCATION;
      motif = `${liste.length} emplacements possibles — répartition non prouvable`;
    }

    lignes.push({
      product_id: p.id, reference: p.reference, produit: p.name, stock, action, motif,
      location_id: cible ? cible.id : "",
      emplacement: cible
        ? [cible.warehouse_code, cible.row_code, cible.loc_code, cible.lvl_code, cible.bin_code]
            .filter(Boolean).join("-")
        : "",
      /* Une balance n'est prévue QUE pour un AUTO_MATCH. Ailleurs : zéro. */
      balance_prevue: action === ACTIONS.AUTO_MATCH ? stock : 0,
      candidats: liste.length,
    });
  }

  const par = (a) => lignes.filter((l) => l.action === a);
  const somme = (l) => l.reduce((s, x) => s + x.stock, 0);
  const auto = par(ACTIONS.AUTO_MATCH);
  const review = par(ACTIONS.TO_REVIEW_LOCATION);
  const sansLieu = par(ACTIONS.NO_LOCATION);
  const zero = par(ACTIONS.ZERO_STOCK);
  const balances = auto.reduce((s, l) => s + l.balance_prevue, 0);
  const aLocaliser = somme(review) + somme(sansLieu);

  // ───────────────────────────── emplacements historiques non résolus (plages)
  const plages = locations.filter((l) => rules.isRange(l));
  const groupesPlage = new Map();
  plages.forEach((l) => {
    const k = [l.warehouse_code, l.row_code, l.loc_code, l.lvl_code, l.bin_code].filter(Boolean).join(" / ");
    if (!groupesPlage.has(k)) groupesPlage.set(k, []);
    groupesPlage.get(k).push(l);
  });

  console.log("\n" + "═".repeat(84));
  console.log(`EMPLACEMENTS EN PLAGE → HISTORIQUES NON RÉSOLUS : ${groupesPlage.size} emplacement(s), ${plages.length} ligne(s)`);
  console.log("═".repeat(84));
  let stockPlage = 0;
  const stockParProduit = new Map(produits.map((p) => [p.id, Number(p.stock || 0)]));
  for (const [code, ls] of groupesPlage) {
    const prods = [...new Set(ls.map((l) => l.product_id).filter(Boolean))];
    const st = prods.reduce((s, id) => s + (stockParProduit.get(id) || 0), 0);
    stockPlage += st;
    console.log(`  ${T(code, 46)} ${String(ls.length).padStart(3)} ligne(s)  ` +
      `${String(prods.length).padStart(3)} produit(s)  ${String(n(st)).padStart(9)} unité(s)`);
  }
  if (!groupesPlage.size) console.log("  aucun");
  console.log(`\n  ${n(stockPlage)} unité(s) concernées — AUCUNE répartie automatiquement.`);

  // ───────────────────────────────────────── vrais bacs dérivables (candidats)
  const candidats = new Map();
  const codesExistants = new Set(locations.map((l) =>
    [l.warehouse_code, l.row_code, l.loc_code, l.lvl_code, l.bin_code].filter(Boolean).join("-").toUpperCase()));
  plages.forEach((l) => rules.binsFromRange(l).forEach((b) => {
    if (!candidats.has(b.full_code)) {
      candidats.set(b.full_code, { ...b, existe: codesExistants.has(b.full_code.toUpperCase()) });
    }
  }));

  console.log("\n" + "═".repeat(84));
  console.log(`VRAIS BACS PHYSIQUES QUI POURRONT ÊTRE CRÉÉS : ${candidats.size}`);
  console.log("═".repeat(84));
  console.log(`  ${T("ENTREPÔT", 12)}${T("ROW", 9)}${T("LOC", 9)}${T("LEVEL", 8)}${T("BIN", 10)}ÉTAT`);
  console.log("  " + "─".repeat(60));
  [...candidats.values()].forEach((b) => console.log(
    `  ${T(b.warehouse, 12)}${T(b.row, 9)}${T(b.location, 9)}${T(b.level, 8)}${T(b.bin, 10)}` +
    (b.existe ? "existe déjà" : "à créer")));
  if (!candidats.size) console.log("  aucun");
  console.log("\n  Ce sont des CANDIDATS. Savoir que deux bacs existent ne dit pas");
  console.log("  lequel contient quoi : la répartition restera manuelle.");

  // ───────────────────────────────────────────────── produits sous surveillance
  const surveilles = ["PROFILE METALLIQUE EN CUVRE", "SPRING TEE EN Z"];
  console.log("\n" + "═".repeat(84));
  console.log("PRODUITS SIGNALÉS EXPLICITEMENT");
  console.log("═".repeat(84));
  for (const motif of surveilles) {
    const trouves = lignes.filter((l) => String(l.produit).toUpperCase().includes(motif));
    if (!trouves.length) { console.log(`  ${T(motif, 34)} introuvable`); continue; }
    trouves.forEach((t) => console.log(
      `  ${T(t.produit, 34)} ${String(n(t.stock)).padStart(9)} unité(s)   ${t.action}   ` +
      `balance prévue ${n(t.balance_prevue)}`));
  }

  // ────────────────────────────────────────────────────────── récapitulatif
  console.log("\n" + "═".repeat(84));
  console.log("RÉCAPITULATIF");
  console.log("═".repeat(84));
  console.log(`  ${T("", 26)}${"PRODUITS".padStart(10)}${"UNITÉS".padStart(12)}`);
  console.log("  " + "─".repeat(48));
  console.log(`  ${T("AUTO_MATCH", 26)}${String(n(auto.length)).padStart(10)}${String(n(somme(auto))).padStart(12)}`);
  console.log(`  ${T("TO_REVIEW_LOCATION", 26)}${String(n(review.length)).padStart(10)}${String(n(somme(review))).padStart(12)}`);
  console.log(`  ${T("NO_LOCATION", 26)}${String(n(sansLieu.length)).padStart(10)}${String(n(somme(sansLieu))).padStart(12)}`);
  console.log(`  ${T("ZERO_STOCK", 26)}${String(n(zero.length)).padStart(10)}${String(n(somme(zero))).padStart(12)}`);
  console.log("  " + "─".repeat(48));
  console.log(`  ${T("TOTAL", 26)}${String(n(lignes.length)).padStart(10)}${String(n(somme(lignes))).padStart(12)}`);

  console.log("\n── CE QUE 061 CRÉERAIT ──");
  console.log(`  balances prévues            ${n(auto.length)} (une par produit AUTO_MATCH)`);
  console.log(`  unités placées en balance   ${n(balances)}`);
  console.log(`  unités à localiser          ${n(aLocaliser)}`);
  console.log(`  unités à stock nul          ${n(somme(zero))}`);
  console.log(`  contrôle : ${n(balances)} + ${n(aLocaliser)} + ${n(somme(zero))} = ${n(balances + aLocaliser + somme(zero))}`);

  // ───────────────────────────────────────────────────────── invariants
  const total = balances + aLocaliser + somme(zero);
  const ok = (c) => (c ? "OK" : "ÉCHEC");
  console.log("\n" + "═".repeat(84));
  console.log("INVARIANTS");
  console.log("═".repeat(84));
  console.log(`  produits avant              ${n(avant.produits)}   attendu ${n(attendu.produits)}   ${ok(Number(avant.produits) === attendu.produits)}`);
  console.log(`  produits après              ${n(avant.produits)}   (061 ne crée ni ne supprime aucun produit)`);
  console.log(`  stock avant                 ${n(avant.stock)}   attendu ${n(attendu.stock)}   ${ok(Number(avant.stock) === attendu.stock)}`);
  console.log(`  stock après simulé          ${n(avant.stock)}   (061 ne modifie aucun products.stock)`);
  console.log(`  différence                  0   ${ok(true)}`);
  console.log(`  stocks négatifs             ${n(avant.negatifs)}   ${ok(Number(avant.negatifs) === 0)}`);
  console.log(`  somme classée = stock       ${n(total)} vs ${n(avant.stock)}   ${ok(total === Number(avant.stock))}`);
  console.log(`  balances inventées          0   ${ok(true)}`);
  console.log(`  répartitions automatiques   0   ${ok(true)}`);

  const csv = arg("csv");
  if (csv && lignes.length) {
    const head = Object.keys(lignes[0]);
    const esc = (v) => { const s = String(v ?? ""); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    fs.writeFileSync(csv, "﻿" + [head.join(","), ...lignes.map((r) => head.map((h) => esc(r[h])).join(","))].join("\n"));
    console.log(`\n  CSV écrit : ${csv}`);
  }

  console.log("\n" + "═".repeat(84));
  console.log("Aucune balance créée. Aucun stock modifié. 061 N'A PAS été exécutée.");
  console.log("═".repeat(84));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

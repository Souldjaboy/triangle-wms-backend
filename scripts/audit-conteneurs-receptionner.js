"use strict";
/**
 * AUDIT — « CONTENEUR RECEPTIONNER.xlsx » CONTRE TRIANGLE WMS PRO.
 *
 * STRICTEMENT EN LECTURE SEULE. Ce fichier ne contient ni INSERT, ni UPDATE,
 * ni DELETE, ni DDL. Il lit le classeur, lit la base, et produit le rapport
 * A → E. Il ne crée aucun entrepôt, aucun produit, aucune réception, et ne
 * touche aucun stock.
 *
 *   node scripts/audit-conteneurs-receptionner.js \
 *     --fichier="/chemin/CONTENEUR RECEPTIONNER.xlsx" --societe=1
 *
 * Correspondances d'entrepôts PROVISOIRES, à confirmer par la base :
 *   --entrepot-E=W-EM2S-E   --entrepot-C=W-EM2S-C
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POURQUOI UN LECTEUR DE CLASSEUR À PART
 *
 * `import-inventory/excel-inventory-parser.js` lit déjà des feuilles de
 * réception — celles du classeur EM2S : feuilles W-EM2S-A/B/C, blocs délimités
 * par un en-tête « CONTAINER NUMBER », désignation en colonne E, quantité en
 * colonne I. Ce classeur-ci ne suit aucune de ces conventions, et ses deux
 * feuilles ne suivent même pas la même : quantité en colonne H dans
 * WAREHOUSE-E, en colonne G dans WAREHOUSE-C.
 *
 * On lit donc les colonnes que le classeur ANNONCE : les cellules « QUANTITI »
 * et « UNITI » disent où elles sont.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RÉCEPTION ENREGISTRÉE ≠ MARCHANDISE EN STOCK
 *
 * La distinction est la raison d'être de ce rapport. Une réception peut exister
 * sans qu'un seul article soit rangé : le stock ne bouge qu'à la mise en stock
 * (`stock_putaways` + `stock_movements`). Une correction qui confondrait les
 * deux augmenterait le stock une seconde fois. Chaque conteneur porte donc DEUX
 * états : celui de sa réception, et celui de sa mise en stock.
 */

const path = require("path");
const XLSX = require("xlsx");
const { Pool } = require("pg");

const args = process.argv.slice(2);
const opt = (nom, defaut = null) => {
  const t = args.find((a) => a.startsWith(`--${nom}=`));
  return t ? t.split("=").slice(1).join("=") : defaut;
};
const FICHIER = opt("fichier");
const SOCIETE = Number(opt("societe", "1"));
/* Correspondances provisoires : ce que l'audit SUPPOSE, et qu'il va confronter
   à la base. Elles ne créent rien et ne renomment rien. */
const PROVISOIRE = { E: opt("entrepot-E", "W-EM2S-E"), C: opt("entrepot-C", "W-EM2S-C") };
if (!FICHIER) { console.error("Usage : --fichier=<classeur.xlsx> [--societe=1]"); process.exit(1); }

/* ══════════════════════════════════════════════════════════════════════════
   LIRE LE CLASSEUR
   ══════════════════════════════════════════════════════════════════════════ */
const RE_CONTENEUR = /\b([A-Z]{4})\s*[-—]?\s*([0-9]{6})\s*\/?\s*([0-9])?\b/;
function lireConteneur(cellule) {
  const t = String(cellule == null ? "" : cellule).toUpperCase().trim();
  if (!t) return null;
  if (/^N\s*°?\s*V\s*:/i.test(t)) return null;   // une plaque n'est pas un conteneur
  const m = t.match(RE_CONTENEUR);
  if (!m) return null;
  return { brut: m[0].trim(), normalise: m[3] ? `${m[1]} ${m[2]}/${m[3]}` : `${m[1]} ${m[2]}` };
}
const RE_DATE = /^DATE\s*:?\s*(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{2,4})/i;
function lireDate(cellule) {
  const m = String(cellule == null ? "" : cellule).trim().match(RE_DATE);
  if (!m) return null;
  const [, j, mo, a] = m;
  const iso = `${a.length === 2 ? `20${a}` : a}-${String(mo).padStart(2, "0")}-${String(j).padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}
function lireVehicule(cellule) {
  const m = String(cellule == null ? "" : cellule).trim().match(/^N\s*°?\s*V\s*:?\s*(.*)$/i);
  return m ? m[1].trim() : null;
}
const nombre = (v) => {
  if (v == null) return null;
  const t = String(v).replace(/\s| | /g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const EST_ENTETE_ARTICLE = /ITEMS?\s*DESCRIPTION|RECEIVED\s*ITEMS|ITEMS\s*RECEIVED/i;

function lireClasseur(fichier) {
  const wb = XLSX.readFile(fichier, { cellDates: false, raw: true });
  const receptions = [], anomalies = [];
  for (const nomFeuille of wb.SheetNames) {
    const lignes = XLSX.utils.sheet_to_json(wb.Sheets[nomFeuille],
      { header: 1, defval: null, raw: true, blankrows: true });
    let colQte = null, colUnite = null, colDesc = null;
    const annonces = (r) => r.forEach((c, i) => {
      const t = String(c == null ? "" : c).toUpperCase().trim();
      if (/^QUANTIT/.test(t)) colQte = i;
      else if (/^UNIT/.test(t)) colUnite = i;
      else if (EST_ENTETE_ARTICLE.test(t) && colDesc === null) colDesc = i;
    });
    const departs = [];
    lignes.forEach((r, i) => { if (r && lireDate(r[0])) departs.push(i); });
    if (!departs.length) {
      anomalies.push({ feuille: nomFeuille, type: "FEUILLE_SANS_BLOC",
        detail: "Aucune ligne « DATE: … » : feuille non interprétée." });
      continue;
    }
    for (let b = 0; b < departs.length; b += 1) {
      const de = departs[b];
      const bloc = lignes.slice(de, b + 1 < departs.length ? departs[b + 1] : lignes.length)
        .map((r) => r || []);
      bloc.forEach(annonces);
      let vehicule = null, vehiculeDeclare = false;
      for (const r of bloc) {
        const v = lireVehicule(r[0]);
        if (v !== null) { vehiculeDeclare = true; vehicule = v || null; break; }
      }
      let conteneur = null;
      for (const r of bloc) { const c = lireConteneur(r[0]); if (c) { conteneur = c; break; } }
      const cd = colDesc == null ? 2 : colDesc;
      const articles = [];
      bloc.forEach((r, k) => {
        const libelle = r[cd] == null ? "" : String(r[cd]).trim();
        if (!libelle || EST_ENTETE_ARTICLE.test(libelle) || lireConteneur(libelle)) return;
        const unite = colUnite == null || r[colUnite] == null ? "" : String(r[colUnite]).trim().toUpperCase();
        articles.push({
          libelle, quantite: colQte == null ? null : nombre(r[colQte]),
          unite: unite && unite !== "UNITI" ? unite : "",
          ligneExcel: de + k + 1, feuille: nomFeuille,
        });
      });
      receptions.push({ feuille: nomFeuille, bloc: b + 1, date: lireDate(bloc[0][0]),
                        conteneur, vehicule, vehiculeDeclare, articles, ligneExcel: de + 1 });
    }
  }
  return { receptions, anomalies };
}

/* ══════════════════════════════════════════════════════════════════════════
   NORMALISER SANS FUSIONNER

   La normalisation RAPPROCHE, elle ne décide pas. Le séparateur de dimensions
   s'unifie seulement entre deux chiffres : sans cette borne, « TRX600 » devenait
   « TR*600 » — on abîmait un nom de modèle au lieu de le rapprocher.
   ══════════════════════════════════════════════════════════════════════════ */
const cle = (s) => String(s || "").toUpperCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/(\d)\s*[*×X]\s*(?=\d)/g, "$1*")
  .replace(/[()]/g, " ").replace(/[^A-Z0-9*+.-]+/g, " ")
  .replace(/\s+/g, " ").trim();
/* Les nombres d'un libellé : « 1800 LEDGER » et « 1000 LEDGER » sont deux
   produits, pas deux orthographes. */
const chiffresDe = (k) => (String(k).match(/\d+/g) || []).sort().join(",");
function proximite(a, b) {
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}
/* Les couples que l'utilisateur a nommés : on ne tranche JAMAIS sur la seule
   orthographe. Une différence qui tient à l'un de ces mots reste « à
   confirmer », même à 97 % de proximité. */
const VARIANTES_SENSIBLES = [
  ["STANDARD", "STANDART"], ["AJUSTABLE", "ADJUSTABLE"], ["ADJUSTTABLE", "ADJUSTABLE"],
  ["FORKHEAD", "FORHEAD"], ["LEDGE", "LEDGER"], ["BEARD", "BOARD"],
];
const differenceSensible = (a, b) => VARIANTES_SENSIBLES.some(([x, y]) =>
  (a.includes(x) && b.includes(y)) || (a.includes(y) && b.includes(x)));

/* ══════════════════════════════════════════════════════════════════════════
   LIRE LA BASE — UNIQUEMENT DES SELECT
   ══════════════════════════════════════════════════════════════════════════ */
async function lireBase(pool, companyId) {
  const q = async (s, p = []) => (await pool.query(s, p)).rows;
  /* Une table ou une colonne absente ne doit pas se traduire par un « 0 »
     silencieux : un rapport qui annonce « aucun mouvement » parce qu'il n'a pas
     su lire la table est plus dangereux qu'un rapport qui s'arrête. On le DIT. */
  const lacunes = [];
  const sansTable = async (promesse, secours, quoi) => {
    try { return await promesse; } catch (e) {
      if (e.code === "42P01" || e.code === "42703") {
        lacunes.push(`${quoi} : ${e.message}`);
        return secours;
      }
      throw e;
    }
  };
  const [entrepots, receptions, lignes, produits, putaways, mouvements, emplacements] =
    await Promise.all([
      q(`SELECT id, code, name, location, status, company_id, racks_count
           FROM warehouses WHERE company_id = $1 ORDER BY code`, [companyId]),
      q(`SELECT id, reception_number, container_number, reception_date::text AS reception_date,
                warehouse_code, warehouse_id, status, source, source_file, notes,
                supplier_name, supplier_reference, carrier, created_at, created_by
           FROM stock_receptions WHERE company_id = $1
          ORDER BY reception_date DESC, id DESC`, [companyId]),
      q(`SELECT id, reception_id, line_no, received_label, product_id, match_status,
                unit, quantity_received, quantity_putaway, warehouse_code, notes
           FROM stock_reception_lines WHERE company_id = $1
          ORDER BY reception_id, line_no`, [companyId]),
      q(`SELECT id, name, reference, unit, stock, warehouse, category, is_active
           FROM products WHERE company_id = $1`, [companyId]),
      sansTable(q(`SELECT id, reception_id, reception_line_id, product_id, movement_id,
                          quantity, stock_before, stock_after, warehouse_code, created_at
                     FROM stock_putaways WHERE company_id = $1`, [companyId]), [], "stock_putaways"),
      /* La colonne s'appelle `type`, pas `movement_type` : on la lit sous son
         vrai nom plutôt que de retomber sur un tableau vide. */
      sansTable(q(`SELECT id, reception_id, product_id, type AS movement_type, quantity,
                          source_reference, reason, stock_before, stock_after, created_at
                     FROM stock_movements WHERE company_id = $1
                      AND reception_id IS NOT NULL`, [companyId]), [], "stock_movements"),
      sansTable(q(`SELECT warehouse_id, count(*)::int AS n FROM locations
                    WHERE company_id = $1 GROUP BY warehouse_id`, [companyId]), [], "locations"),
    ]);
  /* Combien de mouvements par produit : un produit qui a de l'histoire est un
     meilleur candidat qu'une fiche jamais utilisée. */
  const historique = await sansTable(
    q(`SELECT product_id, count(*)::int AS n FROM stock_movements
        WHERE company_id = $1 AND product_id IS NOT NULL GROUP BY product_id`, [companyId]),
    [], "stock_movements (historique par produit)");
  return { entrepots, receptions, lignes, produits, putaways, mouvements, emplacements, lacunes,
           historique: new Map(historique.map((h) => [Number(h.product_id), h.n])) };
}

/* ══════════════════════════════════════════════════════════════════════════
   LE RAPPORT
   ══════════════════════════════════════════════════════════════════════════ */
const pad = (v, n) => String(v == null ? "" : v).padEnd(n);
const padG = (v, n) => String(v == null ? "" : v).padStart(n);
const titre = (t) => {
  console.log(`\n${"═".repeat(76)}`);
  console.log(t);
  console.log("═".repeat(76));
};

(async () => {
  console.log("╔════════════════════════════════════════════════════════════════════════╗");
  console.log("║  AUDIT — CONTENEUR RECEPTIONNER.xlsx × TRIANGLE WMS PRO                ║");
  console.log("║  LECTURE SEULE : aucun INSERT, UPDATE, DELETE ni DDL dans ce script.   ║");
  console.log("╚════════════════════════════════════════════════════════════════════════╝");
  console.log(`Fichier : ${path.basename(FICHIER)}`);
  console.log(`Société : ${SOCIETE}`);
  console.log(`Correspondances provisoires : WAREHOUSE-E → ${PROVISOIRE.E} · WAREHOUSE-C → ${PROVISOIRE.C}`);
  console.log(`Exécuté le : ${new Date().toISOString()}`);

  const { receptions, anomalies } = lireClasseur(FICHIER);
  for (const a of anomalies) console.log(`⚠ ${a.type} — ${a.feuille} : ${a.detail}`);
  const avertirLacunes = (b) => {
    if (!b?.lacunes?.length) return;
    console.log("\n⚠ DONNÉES NON LUES — les chiffres qui en dépendent sont incomplets :");
    for (const l of b.lacunes) console.log(`   • ${l}`);
  };

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let base = null, erreurBase = null;
  try { base = await lireBase(pool, SOCIETE); }
  catch (e) { erreurBase = e.message; }

  if (erreurBase) {
    titre("BASE INACCESSIBLE — LE RAPPORT NE PEUT PAS ÊTRE ÉTABLI");
    console.log(`   ${erreurBase}`);
    console.log("   Relancez avec DATABASE_URL pointant sur la base à auditer.");
    await pool.end().catch(() => {});
    process.exit(2);
  }

  avertirLacunes(base);

  /* ─────────────────────────────────────────────────────────────────────
     A. LES ENTREPÔTS
     ───────────────────────────────────────────────────────────────────── */
  titre("A. ENTREPÔTS RÉELS DE LA SOCIÉTÉ " + SOCIETE);
  const nbEmp = new Map(base.emplacements.map((e) => [Number(e.warehouse_id), e.n]));
  const stockParEntrepot = new Map();
  for (const p of base.produits) {
    const k = cle(p.warehouse);
    if (!k) continue;
    stockParEntrepot.set(k, (stockParEntrepot.get(k) || 0) + Number(p.stock || 0));
  }
  console.log(`   ${pad("ID", 5)}${pad("Société", 8)}${pad("Code", 14)}${pad("Nom", 26)}`
    + `${pad("Site / adresse", 20)}${pad("Statut", 10)}${padG("Empl.", 7)}${padG("Stock", 9)}`);
  for (const e of base.entrepots) {
    const actif = /^(actif|active)$/i.test(String(e.status || "").trim());
    console.log(`   ${pad(e.id, 5)}${pad(e.company_id, 8)}${pad(e.code || "—", 14)}`
      + `${pad(e.name || "—", 26)}${pad(e.location || "—", 20)}`
      + `${pad(`${e.status || "?"}${actif ? "" : " (!)"}`, 10)}`
      + `${padG(nbEmp.get(Number(e.id)) ?? "—", 7)}`
      + `${padG(stockParEntrepot.get(cle(e.code)) ?? "—", 9)}`);
  }
  if (!base.entrepots.length) console.log("   Aucun entrepôt pour cette société.");

  /* La correspondance est CONFRONTÉE, pas décrétée. */
  const verdictEntrepot = {};
  for (const [lettre, codeVoulu] of Object.entries(PROVISOIRE)) {
    const feuille = `WAREHOUSE-${lettre}`;
    const exact = base.entrepots.find((e) => cle(e.code) === cle(codeVoulu));
    const homonyme = base.entrepots.find((e) => cle(e.code) === cle(feuille) || cle(e.name) === cle(feuille));
    const memeLettre = base.entrepots.filter((e) =>
      new RegExp(`[-_ ]${lettre}$`, "i").test(String(e.code || "")));
    let verdict, detail;
    if (homonyme) {
      verdict = "CONFLIT";
      detail = `un entrepôt porte déjà le nom de la feuille (#${homonyme.id} ${homonyme.code}) — `
        + `deux entrepôts pourraient désigner le même lieu.`;
    } else if (!exact) {
      verdict = "NON CONFIRMÉE";
      detail = `${codeVoulu} n'existe pas dans la société ${SOCIETE}.`
        + (memeLettre.length ? ` Candidats de même lettre : ${memeLettre.map((e) => e.code).join(", ")}.` : "");
    } else if (memeLettre.length > 1) {
      verdict = "AMBIGUË";
      detail = `${memeLettre.length} entrepôts finissent par « ${lettre} » : `
        + `${memeLettre.map((e) => `#${e.id} ${e.code}`).join(", ")}.`;
    } else {
      const actif = /^(actif|active)$/i.test(String(exact.status || "").trim());
      verdict = actif ? "CONFIRMÉE" : "CONFIRMÉE MAIS INACTIVE";
      detail = `#${exact.id} ${exact.code} « ${exact.name} »`
        + `${exact.location ? ` — ${exact.location}` : ""} [${exact.status}]`;
    }
    verdictEntrepot[lettre] = { verdict, detail, entrepot: exact || null };
    console.log(`\n   ${feuille} = ${codeVoulu} → ${verdict}`);
    console.log(`      ${detail}`);
  }

  /* ─────────────────────────────────────────────────────────────────────
     B. LES 27 RÉCEPTIONS
     ───────────────────────────────────────────────────────────────────── */
  titre("B. LES RÉCEPTIONS DU CLASSEUR, CONFRONTÉES À TRIANGLE");
  console.log("   Réception Triangle = la réception est ENREGISTRÉE.");
  console.log("   Putaway/stock      = la marchandise est RANGÉE et a bougé le stock.");
  console.log("   Les deux sont indépendants : une réception enregistrée et non rangée");
  console.log("   n'a touché AUCUN stock.\n");

  const parCleExacte = new Map(), parConteneur = new Map();
  for (const r of base.receptions) {
    const kc = cle(r.container_number);
    if (!kc) continue;
    parCleExacte.set(`${kc}|${r.reception_date}`, r);
    if (!parConteneur.has(kc)) parConteneur.set(kc, []);
    parConteneur.get(kc).push(r);
  }
  const lignesDe = (id) => base.lignes.filter((l) => l.reception_id === id);
  const putawaysDe = (id) => base.putaways.filter((p) => p.reception_id === id);
  const mouvementsDe = (id) => base.mouvements.filter((m) => m.reception_id === id);

  const lignesExcel = [];
  const B = [];
  for (const r of receptions) {
    const lettre = (r.feuille.match(/([A-Z])\s*$/i) || [])[1]?.toUpperCase() || "?";
    const cible = verdictEntrepot[lettre];
    const conteneur = r.conteneur?.normalise || null;
    const qteExcel = r.articles.reduce((s, a) => s + (a.quantite || 0), 0);
    const sansQte = r.articles.filter((a) => a.quantite == null).length;
    r.articles.forEach((a) => lignesExcel.push({ ...a, conteneur, date: r.date, lettre }));

    let etat = "ABSENT", difference = "", reception = "—", stock = "—", decision = "À créer";

    if (!conteneur || !r.date) {
      etat = "AMBIGU";
      difference = [!conteneur ? "conteneur illisible" : null, !r.date ? "date illisible" : null]
        .filter(Boolean).join(", ");
      decision = "à trancher";
    } else {
      const exacte = parCleExacte.get(`${cle(conteneur)}|${r.date}`);
      const memes = parConteneur.get(cle(conteneur)) || [];
      const cible2 = exacte || (memes.length === 1 ? memes[0] : null);

      if (!exacte && memes.length) {
        etat = "AMBIGU";
        reception = memes.map((m) => `${m.reception_number} (${m.reception_date})`).join(", ");
        difference = `conteneur connu à une AUTRE date ; le classeur dit ${r.date}`;
        decision = "à trancher";
      } else if (!exacte) {
        etat = "ABSENT";
        decision = sansQte ? "à compléter puis créer" : "à créer";
        if (sansQte) difference = `${sansQte} article(s) sans quantité`;
      }

      if (cible2) {
        const l = lignesDe(cible2.id);
        const p = putawaysDe(cible2.id);
        const mv = mouvementsDe(cible2.id);
        const qteBase = l.reduce((s, x) => s + Number(x.quantity_received || 0), 0);
        const qteRangee = l.reduce((s, x) => s + Number(x.quantity_putaway || 0), 0);
        reception = `${cible2.reception_number} · ${cible2.status} · ${l.length} l. · ${qteBase}`;
        stock = qteRangee > 0
          ? `RANGÉ ${qteRangee}/${qteBase} · ${p.length} putaway(s) · ${mv.length} mouvement(s)`
          : `NON RANGÉ (stock intact)`;

        /* Comparaison ligne à ligne, sur le libellé normalisé ET la quantité. */
        const resteBase = l.map((x) => ({ k: cle(x.received_label), q: Number(x.quantity_received || 0),
                                          w: cle(x.warehouse_code) }));
        const ecarts = [];
        for (const a of r.articles) {
          const k = cle(a.libelle);
          const i = resteBase.findIndex((x) => x.k === k);
          if (i === -1) { ecarts.push(`absente en base : « ${a.libelle} »`); continue; }
          const b = resteBase.splice(i, 1)[0];
          if (a.quantite != null && Math.abs(b.q - a.quantite) > 0.001) {
            ecarts.push(`« ${a.libelle} » : ${b.q} en base ≠ ${a.quantite} dans Excel`);
          }
          if (cible.entrepot && b.w && b.w !== cle(cible.entrepot.code)) {
            ecarts.push(`« ${a.libelle} » rangée sur ${b.w}, pas ${cible.entrepot.code}`);
          }
        }
        for (const b of resteBase) ecarts.push(`en base seulement : « ${b.k} » (${b.q})`);

        if (exacte) {
          if (!ecarts.length) { etat = "EXISTE IDENTIQUE"; decision = "ne rien faire"; }
          else if (l.length < r.articles.length && !ecarts.some((e) => /≠/.test(e))) {
            etat = "EXISTE MAIS INCOMPLET";
            decision = qteRangee > 0 ? "compléter SANS re-ranger l'existant" : "compléter";
            difference = ecarts.join(" ; ");
          } else {
            etat = "EXISTE AVEC DIFFÉRENCES";
            decision = qteRangee > 0 ? "à trancher — stock déjà impacté" : "à trancher";
            difference = ecarts.join(" ; ");
          }
        }
      }
    }

    B.push({
      feuille: r.feuille,
      triangle: cible?.entrepot ? cible.entrepot.code : `${PROVISOIRE[lettre] || "?"} (${cible?.verdict || "?"})`,
      conteneur: conteneur || "—", date: r.date || "—",
      vehicule: r.vehicule || (r.vehiculeDeclare ? "(déclaré vide)" : "—"),
      articles: r.articles.length, qteExcel, reception, stock, etat, difference, decision,
    });
  }

  const L = {
    f: Math.max(11, ...B.map((b) => b.feuille.length)),
    t: Math.max(16, ...B.map((b) => b.triangle.length)),
    c: 14, d: 10,
    v: Math.max(14, ...B.map((b) => b.vehicule.length)),
    e: Math.max(22, ...B.map((b) => b.etat.length)),
  };
  console.log(`   ${pad("Feuille", L.f)}│${pad("Triangle", L.t)}│${pad("Conteneur", L.c)}│`
    + `${pad("Date", L.d)}│${pad("Véhicule", L.v)}│${padG("Art", 4)}│${padG("Qté", 7)}│${pad("État", L.e)}`);
  console.log(`   ${"─".repeat(L.f)}┼${"─".repeat(L.t)}┼${"─".repeat(L.c)}┼${"─".repeat(L.d)}┼`
    + `${"─".repeat(L.v)}┼────┼───────┼${"─".repeat(L.e)}`);
  for (const b of B) {
    console.log(`   ${pad(b.feuille, L.f)}│${pad(b.triangle, L.t)}│${pad(b.conteneur, L.c)}│`
      + `${pad(b.date, L.d)}│${pad(b.vehicule, L.v)}│${padG(b.articles, 4)}│${padG(b.qteExcel, 7)}│${pad(b.etat, L.e)}`);
    console.log(`   ${" ".repeat(L.f)}│ Réception : ${b.reception}`);
    console.log(`   ${" ".repeat(L.f)}│ Stock     : ${b.stock}`);
    if (b.difference) console.log(`   ${" ".repeat(L.f)}│ Différence: ${b.difference}`);
    console.log(`   ${" ".repeat(L.f)}│ Décision  : ${b.decision}`);
  }

  /* ─────────────────────────────────────────────────────────────────────
     C. LES PRODUITS
     ───────────────────────────────────────────────────────────────────── */
  titre("C. LES LIBELLÉS DU CLASSEUR, CONFRONTÉS AU CATALOGUE");
  const libelles = new Map();
  for (const a of lignesExcel) {
    const k = cle(a.libelle);
    if (!libelles.has(k)) libelles.set(k, { k, variantes: new Set(), qte: 0, lignes: 0, unites: new Set() });
    const e = libelles.get(k);
    e.variantes.add(a.libelle); e.qte += a.quantite || 0; e.lignes += 1;
    if (a.unite) e.unites.add(a.unite);
  }

  const C = [];
  for (const e of [...libelles.values()].sort((a, b) => b.qte - a.qte)) {
    const exacts = base.produits.filter((p) => cle(p.name) === e.k || cle(p.reference) === e.k);
    let decision, propose = "—", idsku = "—", confiance = "—", preuve = "";

    if (exacts.length === 1) {
      decision = "CORRESPONDANCE EXACTE"; confiance = "100 %";
      propose = exacts[0].name; idsku = `#${exacts[0].id} / ${exacts[0].reference || "sans SKU"}`;
      preuve = cle(exacts[0].reference) === e.k ? "SKU identique" : "désignation identique";
    } else if (exacts.length > 1) {
      decision = "PLUSIEURS CANDIDATS"; confiance = "100 % ×" + exacts.length;
      propose = exacts.map((p) => p.name).join(" | ");
      idsku = exacts.map((p) => `#${p.id}`).join(" | ");
      preuve = "plusieurs fiches portent ce nom";
    } else {
      const candidats = base.produits
        .map((p) => ({ p, s: Math.max(proximite(cle(p.name), e.k), proximite(cle(p.reference), e.k)) }))
        .filter((x) => x.s >= 0.82)
        .sort((a, b) => b.s - a.s);
      if (!candidats.length) { decision = "PRODUIT ABSENT"; }
      else {
        const top = candidats[0];
        const kp = cle(top.p.name);
        const memesChiffres = chiffresDe(kp) === chiffresDe(e.k);
        const memeUnite = e.unites.size === 0 || [...e.unites].some((u) =>
          cle(u) === cle(top.p.unit) || (cle(u) === "EACH" && /^(PIECE|PIÈCE|UNITE|UNITÉ|EA|EACH)$/i.test(String(top.p.unit || ""))));
        const vu = base.historique.get(Number(top.p.id)) || 0;
        const sensible = differenceSensible(kp, e.k);
        propose = top.p.name;
        idsku = `#${top.p.id} / ${top.p.reference || "sans SKU"}`;
        confiance = `${Math.round(top.s * 100)} %`;
        preuve = [memesChiffres ? "dimensions identiques" : "DIMENSIONS DIFFÉRENTES",
                  memeUnite ? `unité compatible (${top.p.unit || "?"})` : `unité différente (${top.p.unit || "?"})`,
                  vu ? `${vu} mouvement(s) historiques` : "aucun mouvement historique",
                  sensible ? "écart d'orthographe listé comme sensible" : null,
                 ].filter(Boolean).join(", ");
        const plusieursProches = candidats.length > 1 && candidats[1].s >= top.s - 0.03;
        if (plusieursProches) decision = "PLUSIEURS CANDIDATS";
        else if (!memesChiffres) decision = "À CONFIRMER";
        else if (sensible) decision = "À CONFIRMER";          // jamais tranché sur l'orthographe
        else if (memeUnite && top.s >= 0.9) decision = "CORRESPONDANCE PROBABLE";
        else decision = "À CONFIRMER";
        if (plusieursProches) {
          propose = candidats.slice(0, 3).map((x) => `${x.p.name} (${Math.round(x.s * 100)} %)`).join(" | ");
          idsku = candidats.slice(0, 3).map((x) => `#${x.p.id}`).join(" | ");
        }
      }
    }
    C.push({ excel: e.k, variantes: [...e.variantes], qte: e.qte, lignes: e.lignes,
             unites: [...e.unites], propose, idsku, confiance, decision, preuve });
  }

  for (const c of C) {
    console.log(`\n   ${padG(c.qte, 7)} · ${c.excel}   [${c.decision}]`);
    if (c.variantes.length > 1) console.log(`            écritures Excel : ${c.variantes.join(" | ")}`);
    console.log(`            unité Excel : ${c.unites.join(",") || "non renseignée"} · ${c.lignes} ligne(s)`);
    console.log(`            Triangle    : ${c.propose}  ${c.idsku}  confiance ${c.confiance}`);
    if (c.preuve) console.log(`            indices     : ${c.preuve}`);
  }

  /* §4 — LE CAS FAUX PLAFOND */
  titre("C-bis. LE CAS « FAUX PLAFOND »");
  const fauxExcel = C.filter((c) => /FAUX PLAFOND/.test(c.excel));
  const fauxBase = base.produits.filter((p) => /FAUX\s*PLAFOND/i.test(String(p.name || ""))
    || /FAUX\s*PLAFOND/i.test(String(p.reference || "")));
  console.log(`   Dans le classeur : ${fauxExcel.length} libellé(s) distinct(s)`);
  for (const c of fauxExcel) console.log(`     • ${c.excel} — ${c.qte} unités, ${c.lignes} ligne(s) → ${c.decision}`);
  console.log(`   Dans Triangle    : ${fauxBase.length} produit(s)`);
  for (const p of fauxBase) {
    console.log(`     • #${p.id} « ${p.name} » SKU ${p.reference || "—"} unité ${p.unit || "—"} `
      + `stock ${p.stock ?? "—"} ${base.historique.get(Number(p.id)) || 0} mouvement(s)`);
  }
  console.log(`   Verdict : ${
    fauxBase.length === 0 ? "AUCUNE CORRESPONDANCE — les trois libellés sont absents du catalogue."
    : fauxBase.length === 1 ? "UN SEUL produit Triangle pour 3 libellés Excel : c'est à vous de dire "
      + "s'il s'agit du même article ou s'il en manque deux."
    : "PLUSIEURS produits Triangle : la répartition des trois libellés reste à confirmer."}`);
  console.log("   Aucune fusion n'est proposée : « GRAND » et « + ACCESSOIR » peuvent désigner");
  console.log("   des articles physiquement différents, et un stock faux coûte plus qu'une question.");

  /* §5 — TGBU 686373/0 */
  titre("C-ter. TGBU 686373/0 — « ÉTÉS DE FER », QUANTITÉ ABSENTE");
  const tgbu = "TGBU 686373";
  const recTgbu = base.receptions.filter((r) => cle(r.container_number).startsWith(cle(tgbu)));
  const lignesFer = base.lignes.filter((l) => /ETES?\s*DE\s*FER|ETAI|ETAIS/i.test(
    String(l.received_label || "").normalize("NFD").replace(/[̀-ͯ]/g, "")));
  const produitsFer = base.produits.filter((p) => /ETES?\s*DE\s*FER|ETAI/i.test(
    String(p.name || "").normalize("NFD").replace(/[̀-ͯ]/g, "")));
  const mvTgbu = base.mouvements.filter((m) => cle(m.source_reference).includes(cle(tgbu))
    || cle(m.reason).includes(cle(tgbu)));
  console.log(`   Réceptions Triangle portant ce conteneur : ${recTgbu.length}`);
  for (const r of recTgbu) {
    const l = lignesDe(r.id);
    console.log(`     • ${r.reception_number} du ${r.reception_date} — ${l.length} ligne(s) — `
      + `${l.reduce((s, x) => s + Number(x.quantity_received || 0), 0)} reçus, `
      + `${l.reduce((s, x) => s + Number(x.quantity_putaway || 0), 0)} rangés`);
    for (const x of l) console.log(`         « ${x.received_label} » ${x.quantity_received} ${x.unit || ""}`);
  }
  console.log(`   Lignes de réception « étés/étais de fer » ailleurs : ${lignesFer.length}`);
  for (const l of lignesFer.slice(0, 10)) {
    const r = base.receptions.find((x) => x.id === l.reception_id);
    console.log(`     • ${r?.reception_number || "?"} (${r?.reception_date || "?"}) `
      + `« ${l.received_label} » ${l.quantity_received} ${l.unit || ""}`);
  }
  console.log(`   Produits au catalogue : ${produitsFer.length}`);
  for (const p of produitsFer) console.log(`     • #${p.id} « ${p.name} » stock ${p.stock ?? "—"}`);
  console.log(`   Mouvements citant le conteneur : ${mvTgbu.length}`);
  const quantiteRetrouvee = recTgbu.length
    ? lignesDe(recTgbu[0].id).reduce((s, x) => s + Number(x.quantity_received || 0), 0) : 0;
  console.log(`\n   Verdict : ${quantiteRetrouvee > 0
    ? `une quantité de ${quantiteRetrouvee} existe dans Triangle pour ce conteneur — à confronter au document papier.`
    : "QUANTITÉ À CONFIRMER — rien dans Triangle ne permet de la retrouver. Aucun chiffre n'est proposé."}`);

  /* §6 — LES VÉHICULES MANQUANTS */
  titre("C-quater. LES RÉCEPTIONS SANS VÉHICULE");
  const sansVehicule = receptions.filter((r) => !r.vehicule);
  console.log(`   ${sansVehicule.length} réception(s) sans plaque dans le classeur.`);
  console.log("   Rappel : stock_receptions n'a AUCUN champ vehicule aujourd'hui"
    + " (carrier, supplier_name, supplier_reference seulement).");
  for (const r of sansVehicule) {
    const k = cle(r.conteneur?.normalise);
    const rec = base.receptions.filter((x) => cle(x.container_number) === k);
    const indices = [];
    for (const x of rec) {
      for (const [champ, valeur] of Object.entries({ carrier: x.carrier, notes: x.notes,
        supplier_reference: x.supplier_reference, supplier_name: x.supplier_name })) {
        if (valeur && String(valeur).trim()) indices.push(`${x.reception_number}.${champ} = « ${valeur} »`);
      }
    }
    const mv = base.mouvements.filter((m) => cle(m.source_reference).includes(k) || cle(m.reason).includes(k));
    for (const m of mv) if (m.reason) indices.push(`mouvement #${m.id}.reason = « ${m.reason} »`);
    console.log(`\n     ${r.conteneur?.normalise || "sans conteneur"} du ${r.date} (${r.feuille})`);
    console.log(`       réceptions Triangle : ${rec.length ? rec.map((x) => x.reception_number).join(", ") : "aucune"}`);
    console.log(`       indices exploitables : ${indices.length ? indices.join(" ; ") : "AUCUN"}`);
    console.log(`       → ${indices.length ? "à examiner par vous" : "VÉHICULE À CONFIRMER — rien ne permet de le retrouver"}`);
  }

  /* ─────────────────────────────────────────────────────────────────────
     D. RÉSUMÉ CHIFFRÉ
     ───────────────────────────────────────────────────────────────────── */
  titre("D. RÉSUMÉ CHIFFRÉ");
  const n = (etat) => B.filter((b) => b.etat === etat).length;
  const presentes = n("EXISTE IDENTIQUE");
  const incompletes = n("EXISTE MAIS INCOMPLET") + n("EXISTE AVEC DIFFÉRENCES");
  const absentes = n("ABSENT");
  const ambigues = n("AMBIGU");

  /* Une ligne Excel est « déjà présente » si sa réception existe et qu'une
     ligne de même libellé normalisé et même quantité y figure. */
  let lignesPresentes = 0;
  for (const r of receptions) {
    const conteneur = r.conteneur?.normalise;
    if (!conteneur || !r.date) continue;
    const rec = parCleExacte.get(`${cle(conteneur)}|${r.date}`);
    if (!rec) continue;
    const l = lignesDe(rec.id).map((x) => ({ k: cle(x.received_label), q: Number(x.quantity_received || 0) }));
    for (const a of r.articles) {
      const i = l.findIndex((x) => x.k === cle(a.libelle)
        && (a.quantite == null || Math.abs(x.q - a.quantite) < 0.001));
      if (i !== -1) { l.splice(i, 1); lignesPresentes += 1; }
    }
  }
  const d = (etat) => C.filter((c) => c.decision === etat).length;
  console.log(`   Réceptions : ${presentes}/${B.length} déjà présentes (identiques)`);
  console.log(`                ${absentes}/${B.length} absentes`);
  console.log(`                ${incompletes}/${B.length} incomplètes ou avec différences`);
  console.log(`                ${ambigues}/${B.length} ambiguës`);
  console.log(`   Lignes     : ${lignesPresentes}/${lignesExcel.length} déjà présentes`);
  console.log(`                ${lignesExcel.length - lignesPresentes}/${lignesExcel.length} absentes`);
  console.log(`   Produits   : ${d("CORRESPONDANCE EXACTE")}/${C.length} reconnus exactement`);
  console.log(`                ${d("CORRESPONDANCE PROBABLE")}/${C.length} correspondances probables`);
  console.log(`                ${d("PRODUIT ABSENT")}/${C.length} absents du catalogue`);
  console.log(`                ${d("PLUSIEURS CANDIDATS") + d("À CONFIRMER")}/${C.length} ambigus ou à confirmer`);

  /* ─────────────────────────────────────────────────────────────────────
     E. IMPACT FUTUR — SIMULATION
     ───────────────────────────────────────────────────────────────────── */
  titre("E. IMPACT D'UN IMPORT DES SEULES DONNÉES MANQUANTES — SIMULATION");
  const aCreer = B.filter((b) => b.etat === "ABSENT");
  const aCompleter = B.filter((b) => b.etat === "EXISTE MAIS INCOMPLET");
  const lignesACreer = lignesExcel.length - lignesPresentes;
  const parLettre = (lettre) => aCreer.filter((b) => /([A-Z])\s*$/.test(b.feuille)
    && b.feuille.slice(-1).toUpperCase() === lettre);
  const qte = (liste) => liste.reduce((s, b) => s + b.qteExcel, 0);
  console.log(`   Nouvelles réceptions          : ${aCreer.length}`);
  console.log(`   Réceptions à compléter        : ${aCompleter.length}`);
  console.log(`   Nouvelles lignes              : ${lignesACreer}`);
  console.log(`   Quantités concernées          : ${qte(aCreer).toLocaleString("fr-FR")} unités`);
  console.log(`   Entrepôt ${PROVISOIRE.E.padEnd(12)}        : ${parLettre("E").length} réception(s), `
    + `${qte(parLettre("E")).toLocaleString("fr-FR")} unités`);
  console.log(`   Entrepôt ${PROVISOIRE.C.padEnd(12)}        : ${parLettre("C").length} réception(s), `
    + `${qte(parLettre("C")).toLocaleString("fr-FR")} unités`);
  console.log(`   Produits concernés            : ${C.length} libellés, dont `
    + `${d("PRODUIT ABSENT")} absents du catalogue`);
  console.log(`\n   IMPACT STOCK DE L'IMPORT      : 0`);
  console.log(`   L'import crée des réceptions, jamais un mouvement. Le stock ne bouge qu'à`);
  console.log(`   la mise en stock, ligne par ligne, avec un produit CONFIRMÉ — et une ligne`);
  console.log(`   déjà rangée est refusée par le service (ALREADY_PUTAWAY).`);
  console.log(`\n   IMPACT STOCK SI TOUT ÉTAIT ENSUITE RANGÉ (simulation) :`);
  const parProduit = new Map();
  for (const a of lignesExcel) {
    if (a.quantite == null) continue;
    const k = cle(a.libelle);
    parProduit.set(k, (parProduit.get(k) || 0) + a.quantite);
  }
  const rangeable = C.filter((c) => c.decision === "CORRESPONDANCE EXACTE");
  console.log(`     ${qte(aCreer).toLocaleString("fr-FR")} unités au total, réparties sur ${parProduit.size} libellés.`);
  console.log(`     Rangeable sans décision humaine : ${rangeable.length}/${C.length} libellés `
    + `(${rangeable.reduce((s, c) => s + c.qte, 0).toLocaleString("fr-FR")} unités).`);
  console.log(`     Le reste exige qu'une personne confirme le produit : c'est voulu.`);

  titre("FIN — AUCUNE ÉCRITURE N'A ÉTÉ EFFECTUÉE");
  console.log("   Ce script ne contient aucun INSERT, UPDATE, DELETE ni DDL.");
  await pool.end().catch(() => {});
})().catch((e) => { console.error(e); process.exit(1); });

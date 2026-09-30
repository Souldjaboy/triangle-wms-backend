"use strict";
/**
 * AUDIT — « CONTENEUR RECEPTIONNER.xlsx » CONTRE TRIANGLE WMS PRO.
 *
 * STRICTEMENT EN LECTURE SEULE. Ce script n'a aucun chemin d'écriture : pas un
 * INSERT, pas un UPDATE, pas un DELETE. Il lit le classeur, lit la base, et dit
 * ce qui existe déjà, ce qui manque, et ce qui est ambigu.
 *
 *   node scripts/audit-conteneurs-receptionner.js --fichier=<x.xlsx> [--societe=1]
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POURQUOI UN NOUVEAU LECTEUR DE CLASSEUR
 *
 * `import-inventory/excel-inventory-parser.js` lit déjà des feuilles de
 * réception, mais celles du classeur EM2S : feuilles nommées W-EM2S-A/B/C,
 * blocs délimités par un en-tête « CONTAINER NUMBER », désignation en colonne E,
 * quantité en colonne I. Ce classeur-ci ne suit AUCUNE de ces conventions, et
 * ses deux feuilles ne suivent même pas la même : la quantité est en colonne H
 * dans WAREHOUSE-E et en colonne G dans WAREHOUSE-C.
 *
 * Plutôt que de coder deux positions en dur, on lit les colonnes que le
 * classeur ANNONCE : les cellules « QUANTITI » et « UNITI » disent où elles
 * sont. Un classeur qui déplace ses colonnes reste lisible ; un classeur qui
 * n'annonce rien est signalé, pas devin  é.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CE QUE CE SCRIPT NE FAIT JAMAIS
 *
 *   • créer un entrepôt parce qu'une feuille porte son nom ;
 *   • fusionner deux libellés d'articles parce qu'ils se ressemblent ;
 *   • inventer une quantité, une date, un numéro de conteneur ou un véhicule.
 *
 * Toute donnée douteuse ressort en AMBIGU, avec la raison.
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
if (!FICHIER) { console.error("Usage : --fichier=<classeur.xlsx> [--societe=1]"); process.exit(1); }

/* ══════════════════════════════════════════════════════════════════════════
   1. LIRE LE CLASSEUR
   ══════════════════════════════════════════════════════════════════════════ */

/** Un numéro de conteneur ISO : quatre lettres, six chiffres, une clé. */
const RE_CONTENEUR = /\b([A-Z]{4})\s*[-—]?\s*([0-9]{6})\s*\/?\s*([0-9])?\b/;
function lireConteneur(cellule) {
  const t = String(cellule == null ? "" : cellule).toUpperCase().trim();
  if (!t) return null;
  /* Une plaque de véhicule n'est pas un conteneur : on ne regarde pas les
     cellules qui s'annoncent comme telles. */
  if (/^N\s*°?\s*V\s*:/i.test(t)) return null;
  const m = t.match(RE_CONTENEUR);
  if (!m) return null;
  return {
    brut: m[0].trim(),
    normalise: m[3] ? `${m[1]} ${m[2]}/${m[3]}` : `${m[1]} ${m[2]}`,
  };
}

const RE_DATE = /^DATE\s*:?\s*(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{2,4})/i;
function lireDate(cellule) {
  const t = String(cellule == null ? "" : cellule).trim();
  const m = t.match(RE_DATE);
  if (!m) return null;
  const [, j, mo, a] = m;
  const annee = a.length === 2 ? `20${a}` : a;
  const iso = `${annee}-${String(mo).padStart(2, "0")}-${String(j).padStart(2, "0")}`;
  /* Une date impossible n'est pas corrigée en silence. */
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

const RE_VEHICULE = /^N\s*°?\s*V\s*:?\s*(.*)$/i;
function lireVehicule(cellule) {
  const t = String(cellule == null ? "" : cellule).trim();
  const m = t.match(RE_VEHICULE);
  if (!m) return null;
  return m[1].trim();   // peut être vide : le classeur ne l'a pas renseigné
}

const nombre = (v) => {
  if (v == null) return null;
  const t = String(v).replace(/\s| | /g, "").replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const EST_ENTETE_ARTICLE = /ITEMS?\s*DESCRIPTION|RECEIVED\s*ITEMS|ITEMS\s*RECEIVED/i;

/**
 * Le classeur, bloc par bloc. Un bloc commence à une ligne « DATE: … » et
 * s'arrête à la suivante. Les colonnes de quantité et d'unité sont celles que
 * le bloc — ou la feuille — ANNONCE.
 */
function lireClasseur(fichier) {
  const wb = XLSX.readFile(fichier, { cellDates: false, raw: true });
  const receptions = [];
  const anomalies = [];

  for (const nomFeuille of wb.SheetNames) {
    const ws = wb.Sheets[nomFeuille];
    const lignes = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, blankrows: true });

    /* Les colonnes annoncées, au niveau de la feuille : un bloc qui ne les
       réannonce pas hérite des dernières vues. */
    let colQte = null, colUnite = null, colDesc = null;
    const annonces = (r) => {
      r.forEach((c, i) => {
        const t = String(c == null ? "" : c).toUpperCase().trim();
        if (/^QUANTIT/.test(t)) colQte = i;
        else if (/^UNIT/.test(t)) colUnite = i;
        else if (EST_ENTETE_ARTICLE.test(t) && colDesc === null) colDesc = i;
      });
    };

    const departs = [];
    lignes.forEach((r, i) => { if (r && lireDate(r[0])) departs.push(i); });
    if (!departs.length) {
      anomalies.push({ feuille: nomFeuille, type: "FEUILLE_SANS_BLOC",
        detail: "Aucune ligne « DATE: … » : la feuille n'a pas été interprétée." });
      continue;
    }

    for (let b = 0; b < departs.length; b += 1) {
      const de = departs[b];
      const a = b + 1 < departs.length ? departs[b + 1] : lignes.length;
      const bloc = lignes.slice(de, a).map((r) => r || []);
      bloc.forEach(annonces);

      const date = lireDate(bloc[0][0]);
      /* Le véhicule, où qu'il soit dans le bloc, en colonne A. */
      let vehicule = null, vehiculeDeclare = false;
      for (const r of bloc) {
        const v = lireVehicule(r[0]);
        if (v !== null) { vehiculeDeclare = true; vehicule = v || null; break; }
      }
      /* Le conteneur, où qu'il soit dans le bloc, en colonne A — il arrive
         parfois APRÈS les articles, parfois sur la ligne de date. */
      let conteneur = null;
      for (const r of bloc) {
        const c = lireConteneur(r[0]);
        if (c) { conteneur = c; break; }
      }

      const articles = [];
      const cd = colDesc == null ? 2 : colDesc;
      bloc.forEach((r, k) => {
        const libelle = r[cd] == null ? "" : String(r[cd]).trim();
        if (!libelle || EST_ENTETE_ARTICLE.test(libelle)) return;
        if (lireConteneur(libelle)) return;
        const q = colQte == null ? null : nombre(r[colQte]);
        const unite = colUnite == null || r[colUnite] == null
          ? "" : String(r[colUnite]).trim().toUpperCase();
        articles.push({
          libelle, quantite: q,
          unite: unite && unite !== "UNITI" ? unite : "",
          ligneExcel: de + k + 1,
          feuille: nomFeuille,
        });
      });

      receptions.push({
        feuille: nomFeuille, bloc: b + 1,
        date, conteneur, vehicule, vehiculeDeclare, articles,
        ligneExcel: de + 1,
      });
    }
  }
  return { receptions, anomalies };
}

/* ══════════════════════════════════════════════════════════════════════════
   2. NORMALISER SANS FUSIONNER

   La normalisation sert à RAPPROCHER, jamais à décider. Deux libellés dont la
   clé normalisée diffère d'une lettre sont signalés comme proches — et c'est
   une personne qui tranche. Fusionner « FAUX PLAFOND » et « FAUX PLAFOND
   GRAND » parce qu'ils se ressemblent créerait un stock faux.
   ══════════════════════════════════════════════════════════════════════════ */
const cle = (s) => String(s || "")
  .toUpperCase()
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  /* Le séparateur de dimensions s'unifie — 1800X2000, 1800*2000, 1800 × 2000 —
     mais SEULEMENT entre deux chiffres. Sans cette borne, « TRX600 » devenait
     « TR*600 » : la normalisation abîmait un nom de modèle au lieu de le
     rapprocher. */
  .replace(/(\d)\s*[*×X]\s*(?=\d)/g, "$1*")
  .replace(/[()]/g, " ")
  .replace(/[^A-Z0-9*+.-]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

/* Les nombres d'un libellé : « 1800 LEDGER » et « 1000 LEDGER » sont deux
   produits, pas deux orthographes. Séparer les deux cas rend la liste des
   proximités utilisable au lieu de noyer le vrai signal. */
const chiffresDe = (k) => (String(k).match(/\d+/g) || []).sort().join(",");

/** Distance de Levenshtein, bornée : sert seulement à SIGNALER une proximité. */
function proximite(a, b) {
  if (a === b) return 1;
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/* ══════════════════════════════════════════════════════════════════════════
   3. CONFRONTER À LA BASE — EN LECTURE SEULE
   ══════════════════════════════════════════════════════════════════════════ */
async function lireBase(pool, companyId) {
  const q = async (s, p = []) => (await pool.query(s, p)).rows;
  const [entrepots, receptions, lignes, produits] = await Promise.all([
    q(`SELECT id, code, name, location, status, company_id
         FROM warehouses WHERE company_id = $1 ORDER BY code`, [companyId]),
    q(`SELECT id, reception_number, container_number, reception_date::text AS reception_date,
              warehouse_code, status, source, source_file, notes, created_at
         FROM stock_receptions WHERE company_id = $1
        ORDER BY reception_date DESC, id DESC`, [companyId]),
    q(`SELECT l.reception_id, l.received_label, l.quantity_received, l.unit,
              l.warehouse_code, l.product_id, l.match_status, l.quantity_putaway
         FROM stock_reception_lines l
         JOIN stock_receptions r ON r.id = l.reception_id
        WHERE l.company_id = $1 ORDER BY l.reception_id, l.line_no`, [companyId]),
    q(`SELECT id, name, reference, unit FROM products WHERE company_id = $1`, [companyId]),
  ]);
  return { entrepots, receptions, lignes, produits };
}

/** L'entrepôt de Triangle qui correspond à cette feuille — sans jamais en créer. */
function rapprocherEntrepot(nomFeuille, entrepots) {
  const suffixe = (String(nomFeuille).match(/([A-Z])\s*$/i) || [])[1];
  const k = cle(nomFeuille);
  const candidats = [];
  for (const e of entrepots) {
    const codeK = cle(e.code), nomK = cle(e.name);
    if (codeK === k || nomK === k) { candidats.push({ e, raison: "code ou nom identique", score: 1 }); continue; }
    /* « WAREHOUSE-E » et « W-EM2S-E » désignent le même entrepôt si la lettre
       finale concorde — mais c'est une CORRESPONDANCE PROPOSÉE, pas décidée. */
    if (suffixe && new RegExp(`[-_ ]${suffixe}$`, "i").test(String(e.code || ""))) {
      candidats.push({ e, raison: `même lettre finale « ${suffixe.toUpperCase()} »`, score: 0.8 });
      continue;
    }
    const p = Math.max(proximite(codeK, k), proximite(nomK, k));
    if (p >= 0.6) candidats.push({ e, raison: `libellés proches (${Math.round(p * 100)} %)`, score: p });
  }
  candidats.sort((x, y) => y.score - x.score);
  return candidats;
}

(async () => {
  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  AUDIT — CONTENEUR RECEPTIONNER.xlsx  ·  LECTURE SEULE               ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");
  console.log(`Fichier  : ${path.basename(FICHIER)}`);
  console.log(`Société  : ${SOCIETE}`);

  const { receptions, anomalies } = lireClasseur(FICHIER);

  /* ── LE CLASSEUR ───────────────────────────────────────────────────── */
  const feuilles = [...new Set(receptions.map((r) => r.feuille))];
  const totalArticles = receptions.reduce((s, r) => s + r.articles.length, 0);
  const sansQuantite = receptions.flatMap((r) =>
    r.articles.filter((a) => a.quantite == null).map((a) => ({ ...a, conteneur: r.conteneur?.normalise || null })));
  const sansConteneur = receptions.filter((r) => !r.conteneur);
  const sansVehicule = receptions.filter((r) => !r.vehicule);
  const sansDate = receptions.filter((r) => !r.date);

  console.log(`\n── LE CLASSEUR`);
  console.log(`   Feuilles                : ${feuilles.join(", ")}`);
  console.log(`   Réceptions (blocs)      : ${receptions.length}`);
  console.log(`   Lignes d'articles       : ${totalArticles}`);
  console.log(`   Quantité totale lue     : ${receptions.reduce((s, r) =>
    s + r.articles.reduce((t, a) => t + (a.quantite || 0), 0), 0).toLocaleString("fr-FR")}`);
  console.log(`   Sans numéro de conteneur: ${sansConteneur.length}`);
  console.log(`   Sans véhicule           : ${sansVehicule.length}`);
  console.log(`   Sans date exploitable   : ${sansDate.length}`);
  console.log(`   Articles sans quantité  : ${sansQuantite.length}`);
  for (const a of anomalies) console.log(`   ⚠ ${a.type} — ${a.feuille} : ${a.detail}`);

  /* ── LA BASE ───────────────────────────────────────────────────────── */
  let base = null, erreurBase = null;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try { base = await lireBase(pool, SOCIETE); }
  catch (e) { erreurBase = e.message; }

  if (erreurBase) {
    console.log(`\n── LA BASE : INACCESSIBLE (${erreurBase})`);
    console.log("   L'état « dans Triangle » ne peut pas être établi sans base.");
    console.log("   Relancez ce script avec DATABASE_URL pointant sur la base à auditer.");
  } else {
    console.log(`\n── LA BASE (société ${SOCIETE})`);
    console.log(`   Entrepôts              : ${base.entrepots.length}`);
    for (const e of base.entrepots) {
      console.log(`     • #${e.id} ${e.code || "(sans code)"} — ${e.name || "(sans nom)"} `
        + `[${e.status || "?"}]${e.location ? ` — ${e.location}` : ""}`);
    }
    console.log(`   Réceptions enregistrées: ${base.receptions.length}`);
    console.log(`   Lignes de réception    : ${base.lignes.length}`);
    console.log(`   Produits au catalogue  : ${base.produits.length}`);
  }

  /* ── CORRESPONDANCE DES ENTREPÔTS ──────────────────────────────────── */
  console.log(`\n── CORRESPONDANCE DES ENTREPÔTS (aucune création)`);
  const corres = new Map();
  for (const f of feuilles) {
    if (!base) { console.log(`   ${f} → indéterminable (base inaccessible)`); continue; }
    const c = rapprocherEntrepot(f, base.entrepots);
    if (!c.length) {
      corres.set(f, { etat: "ABSENT", candidats: [] });
      console.log(`   ${f} → AUCUN entrepôt correspondant. À décider par vous : `
        + `rattacher à un entrepôt existant, ou en créer un explicitement.`);
    } else if (c.length === 1 || c[0].score > c[1].score) {
      corres.set(f, { etat: c[0].score === 1 ? "EXACT" : "PROPOSE", entrepot: c[0].e, raison: c[0].raison });
      console.log(`   ${f} → #${c[0].e.id} ${c[0].e.code} « ${c[0].e.name} » `
        + `(${c[0].score === 1 ? "correspondance exacte" : `PROPOSÉE : ${c[0].raison}`})`);
    } else {
      corres.set(f, { etat: "AMBIGU", candidats: c.slice(0, 4) });
      console.log(`   ${f} → AMBIGU, ${c.length} candidats : `
        + c.slice(0, 4).map((x) => `${x.e.code} (${x.raison})`).join(" | "));
    }
  }

  /* ── LE TABLEAU DEMANDÉ ────────────────────────────────────────────── */
  console.log(`\n── ÉTAT DE CHAQUE RÉCEPTION`);
  const parConteneurDate = new Map();
  if (base) {
    for (const r of base.receptions) {
      const k = `${cle(r.container_number)}|${r.reception_date}`;
      parConteneurDate.set(k, r);
      /* Le même conteneur à une autre date reste un indice utile. */
      const kc = cle(r.container_number);
      if (!parConteneurDate.has(kc)) parConteneurDate.set(kc, r);
    }
  }

  const tableau = [];
  for (const r of receptions) {
    const conteneur = r.conteneur?.normalise || null;
    const articles = r.articles.length;
    const qte = r.articles.reduce((s, a) => s + (a.quantite || 0), 0);
    let etat = "ABSENT", action = "À créer", detail = "";

    if (!conteneur || !r.date) {
      etat = "AMBIGU";
      action = "À trancher avant import";
      detail = [!conteneur ? "numéro de conteneur illisible" : null,
                !r.date ? "date illisible" : null].filter(Boolean).join(", ");
    } else if (r.articles.some((a) => a.quantite == null)) {
      etat = "AMBIGU";
      action = "À compléter avant import";
      detail = `${r.articles.filter((a) => a.quantite == null).length} article(s) sans quantité`;
    } else if (!base) {
      etat = "NON VÉRIFIÉ";
      action = "Base inaccessible";
    } else {
      const exact = parConteneurDate.get(`${cle(conteneur)}|${r.date}`);
      const memeConteneur = parConteneurDate.get(cle(conteneur));
      if (exact) {
        const l = base.lignes.filter((x) => x.reception_id === exact.id);
        const qteBase = l.reduce((s, x) => s + Number(x.quantity_received || 0), 0);
        if (l.length === articles && Math.abs(qteBase - qte) < 0.001) {
          etat = "EXISTE"; action = "Ne rien faire";
          detail = `${exact.reception_number}, ${l.length} ligne(s), ${qteBase}`;
        } else {
          etat = "EXISTE MAIS INCOMPLET"; action = "À compléter";
          detail = `${exact.reception_number} : ${l.length} ligne(s)/${qteBase} en base `
                 + `contre ${articles}/${qte} dans Excel`;
        }
      } else if (memeConteneur) {
        etat = "AMBIGU"; action = "À trancher";
        detail = `conteneur déjà reçu le ${memeConteneur.reception_date} `
               + `(${memeConteneur.reception_number}), Excel dit ${r.date}`;
      }
    }

    const corr = corres.get(r.feuille);
    tableau.push({
      feuille: r.feuille,
      entrepot: corr?.entrepot ? corr.entrepot.code : `${r.feuille} → ${corr?.etat || "?"}`,
      conteneur: conteneur || "—", date: r.date || "—",
      vehicule: r.vehicule || (r.vehiculeDeclare ? "(déclaré vide)" : "—"),
      articles, qte, etat, action, detail,
    });
  }

  const largeur = (k, min) => Math.max(min, ...tableau.map((t) => String(t[k]).length));
  const L = { entrepot: largeur("entrepot", 10), conteneur: largeur("conteneur", 14),
              date: 10, vehicule: largeur("vehicule", 12), etat: largeur("etat", 21) };
  const pad = (v, n) => String(v).padEnd(n);
  console.log(`   ${pad("Entrepôt", L.entrepot)} | ${pad("Conteneur", L.conteneur)} | `
    + `${pad("Date", L.date)} | ${pad("Véhicule", L.vehicule)} | Art | Qté    | ${pad("État", L.etat)} | Action`);
  for (const t of tableau) {
    console.log(`   ${pad(t.entrepot, L.entrepot)} | ${pad(t.conteneur, L.conteneur)} | `
      + `${pad(t.date, L.date)} | ${pad(t.vehicule, L.vehicule)} | `
      + `${String(t.articles).padStart(3)} | ${String(t.qte).padStart(6)} | `
      + `${pad(t.etat, L.etat)} | ${t.action}${t.detail ? ` — ${t.detail}` : ""}`);
  }

  const parEtat = tableau.reduce((m, t) => ({ ...m, [t.etat]: (m[t.etat] || 0) + 1 }), {});
  console.log(`\n   Récapitulatif : ` + Object.entries(parEtat).map(([k, n]) => `${k} ${n}`).join(" · "));

  /* ── LES ARTICLES ──────────────────────────────────────────────────── */
  console.log(`\n── LES ARTICLES DU CLASSEUR`);
  const libelles = new Map();
  for (const r of receptions) {
    for (const a of r.articles) {
      const k = cle(a.libelle);
      if (!libelles.has(k)) libelles.set(k, { cle: k, variantes: new Set(), qte: 0, lignes: 0 });
      const e = libelles.get(k);
      e.variantes.add(a.libelle);
      e.qte += a.quantite || 0;
      e.lignes += 1;
    }
  }
  console.log(`   Libellés distincts (après normalisation) : ${libelles.size}`);

  const listeCles = [...libelles.keys()];
  const proches = [];
  for (let i = 0; i < listeCles.length; i += 1) {
    for (let j = i + 1; j < listeCles.length; j += 1) {
      const p = proximite(listeCles[i], listeCles[j]);
      if (p >= 0.82) proches.push({ a: listeCles[i], b: listeCles[j], p });
    }
  }
  proches.sort((x, y) => y.p - x.p);

  for (const e of [...libelles.values()].sort((a, b) => b.qte - a.qte)) {
    const trouve = base
      ? base.produits.filter((p) => cle(p.name) === e.cle || cle(p.reference) === e.cle)
      : [];
    const approche = base && !trouve.length
      ? base.produits.map((p) => ({ p, s: proximite(cle(p.name), e.cle) }))
        .filter((x) => x.s >= 0.82).sort((a, b) => b.s - a.s).slice(0, 3)
      : [];
    const etat = !base ? "NON VÉRIFIÉ"
      : trouve.length === 1 ? `EXISTE (#${trouve[0].id})`
      : trouve.length > 1 ? `AMBIGU (${trouve.length} produits de même nom)`
      : approche.length ? `AMBIGU — proche de ${approche.map((x) => `${x.p.name} (${Math.round(x.s * 100)} %)`).join(", ")}`
      : "ABSENT";
    console.log(`   ${String(e.qte).padStart(7)} · ${e.cle}`);
    if (e.variantes.size > 1) {
      console.log(`             écritures dans le classeur : ${[...e.variantes].join(" | ")}`);
    }
    console.log(`             → ${etat}`);
  }

  if (proches.length) {
    const orthographe = proches.filter((x) => chiffresDe(x.a) === chiffresDe(x.b));
    const dimensions = proches.filter((x) => chiffresDe(x.a) !== chiffresDe(x.b));
    if (orthographe.length) {
      console.log(`\n   ⚠ MÊMES DIMENSIONS, ORTHOGRAPHES DIFFÉRENTES — probablement le MÊME
     article. À confirmer par vous ; JAMAIS fusionné d'office :`);
      for (const x of orthographe) {
        console.log(`     ${Math.round(x.p * 100)} %  « ${x.a} »  ≈  « ${x.b} »`);
      }
    }
    if (dimensions.length) {
      console.log(`\n   · Libellés proches mais aux DIMENSIONS DIFFÉRENTES — presque sûrement
     deux articles distincts. Listés pour mémoire, aucune action attendue :`);
      for (const x of dimensions) {
        console.log(`     ${Math.round(x.p * 100)} %  « ${x.a} »  ≠  « ${x.b} »`);
      }
    }
  }

  if (sansQuantite.length) {
    console.log(`\n   ⚠ ARTICLES SANS QUANTITÉ — non importables en l'état :`);
    for (const a of sansQuantite) {
      console.log(`     ${a.feuille} L${a.ligneExcel} · conteneur ${a.conteneur || "—"} · « ${a.libelle} »`);
    }
  }
  if (sansVehicule.length) {
    console.log(`\n   ⚠ RÉCEPTIONS SANS VÉHICULE :`);
    for (const r of sansVehicule) {
      console.log(`     ${r.feuille} bloc ${r.bloc} · ${r.conteneur?.normalise || "sans conteneur"} · ${r.date || "sans date"}`);
    }
  }

  console.log(`\n── AUCUNE ÉCRITURE N'A ÉTÉ EFFECTUÉE. Ce script n'en contient aucune.`);
  await pool.end().catch(() => {});
})().catch((e) => { console.error(e); process.exit(1); });

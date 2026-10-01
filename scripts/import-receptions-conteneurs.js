"use strict";
/**
 * IMPORT DES RÉCEPTIONS DE CONTENEURS — DRY-RUN PAR DÉFAUT.
 *
 *   node scripts/import-receptions-conteneurs.js \
 *     --fichier="/chemin/CONTENEUR RECEPTIONNER.xlsx" --societe=1 \
 *     --mapping=WAREHOUSE-E=W-EM2S-E --mapping=WAREHOUSE-C=W-EM2S-C
 *
 * SANS `--appliquer`, RIEN N'EST ÉCRIT. Et `--appliquer` exige encore
 * `--je-confirme` : deux gestes, parce qu'un import se lance une fois et se
 * défait difficilement.
 *
 * Ce script n'appelle jamais le moteur de stock : `impactStock` vaut 0, et une
 * marchandise n'entre en stock qu'à la mise en stock, avec un produit confirmé.
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const IMP = require("../services/import-receptions-conteneurs");

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const t = args.find((a) => a.startsWith(`--${n}=`));
  return t ? t.split("=").slice(1).join("=") : d;
};
const flag = (n) => args.includes(`--${n}`);
const FICHIER = opt("fichier");
const SOCIETE = Number(opt("societe", "1"));
const APPLIQUER = flag("appliquer");
const CONFIRME = flag("je-confirme");

const mappings = args.filter((a) => a.startsWith("--mapping="))
  .map((a) => a.slice("--mapping=".length))
  .reduce((m, v) => {
    const i = v.indexOf("=");
    if (i > 0) m[v.slice(0, i).trim()] = v.slice(i + 1).trim();
    return m;
  }, {});

if (!FICHIER) { console.error("Usage : --fichier=<classeur.xlsx> [--societe=1] [--mapping=FEUILLE=CODE]"); process.exit(1); }
if (!Object.keys(mappings).length) {
  console.error("Au moins un --mapping=FEUILLE=CODE_ENTREPOT est requis.");
  console.error("Aucun entrepôt n'est deviné depuis le nom d'une feuille : la correspondance");
  console.error("doit être donnée explicitement, ou enregistrée comme alias en base.");
  process.exit(1);
}

const pad = (v, n) => String(v == null ? "" : v).padEnd(n);
const padG = (v, n) => String(v == null ? "" : v).padStart(n);
const titre = (t) => { console.log(`\n${"═".repeat(78)}`); console.log(t); console.log("═".repeat(78)); };
const nb = (v) => Number(v || 0).toLocaleString("fr-FR");

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const buffer = fs.readFileSync(FICHIER);

  console.log("╔══════════════════════════════════════════════════════════════════════════╗");
  console.log(`║  IMPORT RÉCEPTIONS CONTENEURS — ${APPLIQUER ? "APPLICATION RÉELLE" : "DRY-RUN (aucune écriture)"}`.padEnd(75) + "║");
  console.log("╚══════════════════════════════════════════════════════════════════════════╝");
  console.log(`Fichier : ${path.basename(FICHIER)}`);
  console.log(`Société : ${SOCIETE}`);
  console.log(`Plan    : ${Object.entries(mappings).map(([f, c]) => `${f} → ${c}`).join(" · ")}`);

  const client = await pool.connect();
  let plan;
  try {
    plan = await IMP.planifier(client, {
      companyId: SOCIETE, buffer, nomFichier: path.basename(FICHIER), plan: mappings,
    });
  } finally { client.release(); }

  console.log(`Empreinte du fichier : ${plan.fichier.sha256.slice(0, 16)}… (${nb(plan.fichier.taille)} octets)`);
  console.log(`Dispositions détectées : ${Object.entries(plan.dispositions)
    .map(([f, d]) => `${f}=${d || "INCONNUE"}`).join(" · ")}`);
  for (const f of plan.feuillesIgnorees) console.log(`⚠ feuille ignorée : ${f.feuille} (${f.raison})`);

  /* ── LES ENTREPÔTS ─────────────────────────────────────────────────── */
  titre("ENTREPÔTS — RÉSOLUS, JAMAIS CRÉÉS");
  for (const [feuille, e] of Object.entries(plan.entrepots)) {
    if (e.ok) {
      console.log(`   ${pad(feuille, 14)} → #${e.id} ${pad(e.code, 12)} « ${e.nom} »`
        + `${e.site ? ` — ${e.site}` : ""} [${e.statut}] (par ${e.source}${e.alias ? ` « ${e.alias} »` : ""})`);
    } else {
      console.log(`   ${pad(feuille, 14)} → ÉCHEC : ${e.erreur}`);
    }
  }

  /* ── LE DÉTAIL PAR RÉCEPTION ───────────────────────────────────────── */
  titre("DÉTAIL PAR RÉCEPTION");
  console.log(`   ${pad("Conteneur", 14)}│${pad("Date", 10)}│${pad("Plaque", 14)}│${pad("Entrepôt", 10)}`
    + `│${padG("Lig", 4)}│${padG("Qté", 7)}│${pad("État", 11)}│${padG("Exact", 6)}│${padG("Manq", 5)}│${padG("Amb", 4)}`);
  console.log(`   ${"─".repeat(14)}┼${"─".repeat(10)}┼${"─".repeat(14)}┼${"─".repeat(10)}`
    + `┼────┼───────┼${"─".repeat(11)}┼──────┼─────┼────`);
  for (const r of plan.receptions) {
    const d = (dec) => r.lignes.filter((l) => l.decisionProduit === dec).length;
    console.log(`   ${pad(r.conteneur || "—", 14)}│${pad(r.date || "—", 10)}`
      + `│${pad(r.vehicule || (r.vehiculeDeclare ? "(vide)" : "—"), 14)}│${pad(r.entrepot || "—", 10)}`
      + `│${padG(r.lignesDocument, 4)}│${padG(r.quantiteDocument, 7)}│${pad(r.etat, 11)}`
      + `│${padG(d(IMP.DECISION.EXACT), 6)}│${padG(d(IMP.DECISION.A_CREER), 5)}`
      + `│${padG(d(IMP.DECISION.AMBIGU) + d(IMP.DECISION.PROBABLE), 4)}`);
    if (r.existante) {
      console.log(`                 │ en base : ${r.existante.numero} · ${r.existante.statut}`
        + ` · ${r.existante.lignes} l. · reçu ${r.existante.recu} · rangé ${r.existante.range}`
        + ` · empreinte ${r.existante.empreinte}`);
    }
    for (const m of r.motifs) console.log(`                 │ ${m}`);
    const aCreer = r.lignes.filter((l) => l.action === "A_CREER");
    const bloquees = r.lignes.filter((l) => l.action === "BLOQUEE");
    if (aCreer.length) {
      console.log(`                 │ à ajouter : ${aCreer.length} ligne(s), `
        + `${nb(aCreer.reduce((s, l) => s + Number(l.quantite || 0), 0))} unités`);
    }
    for (const l of bloquees) console.log(`                 │ BLOQUÉE : « ${l.libelle} » — ${l.raison}`);
    console.log(`                 │ décision : ${
      r.etat === IMP.ETAT.IDENTIQUE ? "NE RIEN FAIRE"
      : r.etat === IMP.ETAT.ABSENTE ? "créer la réception"
      : r.etat === IMP.ETAT.INCOMPLETE ? "compléter les lignes manquantes seulement"
      : r.etat === IMP.ETAT.DIVERGENTE ? "NE RIEN ÉCRIRE — divergence à trancher"
      : r.etat === IMP.ETAT.AMBIGUE ? "NE RIEN ÉCRIRE — ambiguïté à trancher"
      : "NE RIEN ÉCRIRE — bloquée"} · impact stock 0`);
  }

  /* ── LES ARTICLES ──────────────────────────────────────────────────── */
  titre("ARTICLES — TABLE DE DÉCISION");
  const ordre = [IMP.DECISION.EXACT, IMP.DECISION.PROBABLE, IMP.DECISION.AMBIGU,
                 IMP.DECISION.A_CREER, IMP.DECISION.BLOQUE];
  for (const dec of ordre) {
    const lot = plan.produits.filter((p) => p.decision === dec);
    if (!lot.length) continue;
    console.log(`\n   ── ${dec} (${lot.length})`);
    for (const p of lot) {
      const cible = p.produit || p.propose;
      console.log(`      « ${p.libelle} »`);
      console.log(`        unité document : ${p.unites.join(",") || "non renseignée"}`);
      console.log(`        Triangle : ${cible ? `#${cible.id} « ${cible.name}` + "»"
        + `${cible.reference ? ` SKU ${cible.reference}` : ""}` : "—"}`
        + `  confiance ${Math.round((p.confiance || 0) * 100)} %`);
      console.log(`        preuves  : ${(p.preuves || []).join(", ")}`);
      if (p.candidats && p.candidats.length > 1) {
        console.log(`        candidats: ${p.candidats.map((c) =>
          `#${c.id} ${c.name}${c.confiance ? ` (${Math.round(c.confiance * 100)} %)` : ""}`).join(" | ")}`);
      }
    }
  }

  /* ── LES ANOMALIES ─────────────────────────────────────────────────── */
  titre(`ANOMALIES À TRANCHER (${plan.anomalies.length})`);
  const parType = plan.anomalies.reduce((m, a) => ({ ...m, [a.type]: [...(m[a.type] || []), a] }), {});
  for (const [type, lot] of Object.entries(parType)) {
    console.log(`\n   ── ${type} (${lot.length})`);
    for (const a of lot) {
      console.log(`      ${a.feuille || "?"}${a.ligne ? ` L${a.ligne}` : ""}`
        + `${a.cellule ? ` (${a.cellule})` : ""} : ${a.message}`);
    }
  }
  if (!plan.anomalies.length) console.log("   Aucune.");

  /* ── LES TOTAUX ────────────────────────────────────────────────────── */
  const t = plan.totaux;
  titre("TOTAUX");
  console.log(`   Réceptions du document : ${t.receptions}`);
  console.log(`     identiques (rien à faire) : ${t.identiques}`);
  console.log(`     absentes (à créer)        : ${t.absentes}`);
  console.log(`     incomplètes (à compléter) : ${t.incompletes}`);
  console.log(`     divergentes               : ${t.divergentes}`);
  console.log(`     ambiguës                  : ${t.ambigues}`);
  console.log(`     bloquées                  : ${t.bloquees}`);
  console.log(`   Lignes du document     : ${t.lignes}`);
  console.log(`     à créer                   : ${t.lignesACreer}`);
  console.log(`     déjà présentes            : ${t.lignesDejaPresentes}`);
  console.log(`     déjà importées (clé vue)  : ${t.lignesDejaImportees}`);
  console.log(`     bloquées                  : ${t.lignesBloquees}`);
  console.log(`   Quantité à créer       : ${nb(t.quantiteACreer)} unités`);
  console.log(`   Libellés distincts     : ${t.libelles}`);
  console.log(`     exacts ${t.produitsExacts} · probables ${t.produitsProbables} · `
    + `ambigus ${t.produitsAmbigus} · à créer ${t.produitsACreer} · bloqués ${t.produitsBloques}`);
  console.log(`   Anomalies              : ${t.anomalies}`);
  console.log(`\n   IMPACT STOCK           : ${t.impactStock}`);
  console.log(`   Une réception n'est pas une mise en stock. Ce script n'appelle jamais le`);
  console.log(`   moteur de stock : aucun mouvement, aucun putaway, aucun solde modifié.`);

  /* ── APPLIQUER, OU NON ─────────────────────────────────────────────── */
  if (!APPLIQUER) {
    titre("DRY-RUN — AUCUNE ÉCRITURE");
    const sim = await IMP.appliquer(pool, { companyId: SOCIETE, plan, dryRun: true });
    console.log(`   Créerait    : ${sim.creees.length} réception(s)`);
    for (const c of sim.creees) {
      console.log(`     ${c.conteneur} ${c.date} → ${c.entrepot} · ${c.lignes} l. · ${nb(c.quantite)} u.`
        + `${c.vehicule ? ` · plaque ${c.vehicule}` : ""}`);
    }
    console.log(`   Compléterait: ${sim.completees.length} réception(s)`);
    for (const c of sim.completees) {
      console.log(`     ${c.conteneur} ${c.date} (${c.numero}) → +${c.lignes} l. · ${nb(c.quantite)} u.`);
    }
    console.log(`   Sauterait   : ${sim.sautees.length}`);
    for (const c of sim.sautees) console.log(`     ${c.conteneur || "?"} ${c.date || ""} — ${c.etat} : ${c.raison}`);
    console.log(`\n   Pour écrire réellement : ajoutez --appliquer --je-confirme`);
    await pool.end();
    return;
  }

  if (!CONFIRME) {
    titre("REFUSÉ — CONFIRMATION MANQUANTE");
    console.log("   `--appliquer` exige aussi `--je-confirme`. Rien n'a été écrit.");
    await pool.end();
    process.exit(3);
  }

  titre("APPLICATION");
  const out = await IMP.appliquer(pool, { companyId: SOCIETE, plan, dryRun: false });
  console.log(`   Créées     : ${out.creees.length}`);
  for (const c of out.creees) console.log(`     ${c.numero} · ${c.conteneur} ${c.date} → ${c.entrepot} · ${c.lignes} l.`);
  console.log(`   Complétées : ${out.completees.length}`);
  for (const c of out.completees) console.log(`     ${c.numero} · ${c.conteneur} → +${c.lignes} l.`);
  console.log(`   Sautées    : ${out.sautees.length}`);
  for (const c of out.sautees) console.log(`     ${c.conteneur || "?"} — ${c.etat} : ${c.raison}`);
  console.log(`\n   IMPACT STOCK : ${out.impactStock}`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });

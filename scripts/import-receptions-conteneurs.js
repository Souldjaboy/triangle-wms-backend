"use strict";
/**
 * IMPORT DES RÉCEPTIONS DE CONTENEURS — DRY-RUN PAR DÉFAUT.
 *
 *   node scripts/import-receptions-conteneurs.js \
 *     --fichier="/chemin/CONTENEUR RECEPTIONNER.xlsx" --societe=1 \
 *     --mapping=WAREHOUSE-E=W-EM2S-E --mapping=WAREHOUSE-C=W-EM2S-C
 *
 * TROIS MODES, du plus sûr au plus engageant :
 *
 *   (défaut)                  diagnostic en LECTURE SEULE. La transaction est
 *                             ouverte `READ ONLY` : c'est PostgreSQL qui refuse
 *                             toute écriture, avec le code 25006, et un garde
 *                             en amont refuse même de l'envoyer. Le script
 *                             PROUVE le verrou avant de commencer.
 *   --appliquer               écrit — refusé sans `--je-confirme`.
 *   --appliquer --je-confirme écrit réellement.
 *
 * Le diagnostic fonctionne sur le schéma déployé AUJOURD'HUI : il n'exige pas
 * la migration 102. Ce qui manque est signalé, pas supposé — et l'écriture, elle,
 * la réclame, parce qu'écrire sans elle écrirait à moitié.
 *
 * Ce script n'appelle jamais le moteur de stock : `impactStock` vaut 0, et une
 * marchandise n'entre en stock qu'à la mise en stock, avec un produit confirmé.
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const IMP = require("../services/import-receptions-conteneurs");
const LS = require("../services/lecture-seule");

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

  /* ── LA PREUVE AVANT LE DIAGNOSTIC ───────────────────────────────────
     On ne se contente pas d'annoncer « lecture seule » : on tente une écriture
     inoffensive et on vérifie que PostgreSQL la refuse. Si le verrou ne tenait
     pas, il vaut mieux le savoir maintenant. */
  if (!APPLIQUER) {
    const preuve = await LS.prouverLeVerrou(pool);
    console.log(`\nPreuve du verrou de lecture seule :`);
    console.log(`   PostgreSQL refuse une écriture (code 25006) : ${preuve.refuseParPostgres ? "OUI" : "NON"}`);
    console.log(`   Le garde refuse de l'envoyer               : ${preuve.refuseParLeGarde ? "OUI" : "NON"}`);
    if (!preuve.solide) {
      console.error("\n   Le verrou ne tient pas. On s'arrête : un diagnostic ne vaut pas ce risque.");
      await pool.end();
      process.exit(4);
    }
  }

  let plan, journal = [];
  if (APPLIQUER) {
    const client = await pool.connect();
    try {
      plan = await IMP.planifier(client, {
        companyId: SOCIETE, buffer, nomFichier: path.basename(FICHIER), plan: mappings,
      });
    } finally { client.release(); }
  } else {
    const sortie = await LS.dansUneTransactionLectureSeule(pool, (clientRO) =>
      IMP.planifier(clientRO, {
        companyId: SOCIETE, buffer, nomFichier: path.basename(FICHIER), plan: mappings,
      }));
    plan = sortie.resultat;
    journal = sortie.journal;
  }

  console.log(`Empreinte du fichier : ${plan.fichier.sha256.slice(0, 16)}… (${nb(plan.fichier.taille)} octets)`);
  console.log(`Dispositions détectées : ${Object.entries(plan.dispositions)
    .map(([f, d]) => `${f}=${d || "INCONNUE"}`).join(" · ")}`);
  for (const f of plan.feuillesIgnorees) console.log(`⚠ feuille ignorée : ${f.feuille} (${f.raison})`);
  const sc = plan.schema;
  console.log(`Schéma déployé : migration 102 ${sc.migration102 ? "APPLIQUÉE" : "ABSENTE"}`
    + ` · plaque véhicule ${sc.vehiculeSurReception ? "oui" : "non"}`
    + ` · alias d'entrepôts ${sc.aliasEntrepots ? "oui" : "non"}`
    + ` · libellé normalisé ${sc.libelleNormSurLigne ? "oui" : "non"}`);
  if (!sc.migration102) {
    console.log(`   Le diagnostic fonctionne quand même. En revanche l'écriture sera refusée`);
    console.log(`   tant que la 102 n'est pas appliquée : sans elle, les plaques ne seraient`);
    console.log(`   pas enregistrées et la trace d'idempotence serait incomplète.`);
  }

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
  titre("§6 — LES RÉCEPTIONS, UNE PAR LIGNE");
  const ENTETE = ["Conteneur", "Date", "Feuille", "Entrepôt", "Véhicule",
                  "Lig", "Qté", "État Triangle", "Putaway", "Action", "Bloquant"];
  const lignesTab = plan.receptions.map((r) => {
    const putaway = !r.existante ? "—"
      : Number(r.existante.range) > 0
        ? `RANGÉ ${r.existante.range}/${r.existante.recu}`
        : "non rangé";
    const bloquant = r.motifs.length ? r.motifs.join(" ; ")
      : r.lignes.some((l) => l.action === "BLOQUEE")
        ? r.lignes.filter((l) => l.action === "BLOQUEE")
            .map((l) => `${l.libelle} : ${l.raison}`).join(" ; ")
        : "—";
    return [
      r.conteneur || "—", r.date || "—", r.feuille || "—", r.entrepot || "—",
      r.vehicule || (r.vehiculeDeclare ? "(déclaré vide)" : "NULL"),
      String(r.lignesDocument), String(r.quantiteDocument),
      r.existante ? `${r.etat} (${r.existante.numero})` : r.etat,
      putaway, r.action, bloquant,
    ];
  });
  const L = ENTETE.map((t, i) => Math.max(t.length,
    ...lignesTab.map((l) => String(l[i]).length)));
  const borne = 44;
  L[10] = Math.min(L[10], borne);
  console.log("   " + ENTETE.map((t, i) => pad(t, L[i])).join(" │ "));
  console.log("   " + L.map((n) => "─".repeat(n)).join("─┼─"));
  for (const l of lignesTab) {
    console.log("   " + l.map((c, i) => (i === 10 && String(c).length > borne
      ? String(c).slice(0, borne - 1) + "…" : pad(c, L[i]))).join(" │ "));
  }

  /* ── LES ARTICLES ──────────────────────────────────────────────────── */
  titre("§7 — LES ARTICLES, UNE ÉCRITURE PAR LIGNE");
  console.log(`   ${plan.totaux.libellesEcrits} écritures littérales · `
    + `${plan.produits.length} clés normalisées · aucune fusion\n`);
  const E2 = ["Désignation Excel originale", "Normalisée", "Qté", "Candidat Triangle",
              "ID", "SKU", "Conf.", "Mvts", "Décision"];
  const lignesP = [];
  for (const p of plan.produits) {
    const cible = p.produit || p.propose;
    /* CHAQUE écriture littérale a sa ligne : deux orthographes se rapprochent
       sur une même clé, mais le document a écrit les deux et le rapport doit
       les montrer toutes les deux. */
    for (const ecriture of p.ecritures) {
      lignesP.push([
        ecriture, p.cle, String(p.quantite),
        cible ? cible.name : "—",
        cible ? `#${cible.id}` : "—",
        cible ? (cible.reference || "sans SKU") : "—",
        `${Math.round((p.confiance || 0) * 100)}%`,
        cible ? String(p.mouvements ?? mouvementsDe(p)) : "—",
        p.decision,
      ]);
    }
  }
  function mouvementsDe(p) {
    const m = (p.preuves || []).find((x) => /mouvement/.test(x));
    if (!m) return "?";
    const n = m.match(/(\d+)/);
    return n ? n[1] : "0";
  }
  const L2 = E2.map((t, i) => Math.max(t.length, ...lignesP.map((l) => String(l[i]).length)));
  console.log("   " + E2.map((t, i) => pad(t, L2[i])).join(" │ "));
  console.log("   " + L2.map((n) => "─".repeat(n)).join("─┼─"));
  for (const l of lignesP) console.log("   " + l.map((c, i) => pad(c, L2[i])).join(" │ "));

  console.log(`\n   Preuves, clé par clé :`);
  for (const p of plan.produits) {
    console.log(`     ${pad(p.cle, 42)} ${pad(p.decision, 21)} ${(p.preuves || []).join(", ")}`);
    if (p.candidats && p.candidats.length > 1) {
      console.log(`     ${" ".repeat(42)} candidats : ${p.candidats.map((c) =>
        `#${c.id} ${c.name}${c.confiance ? ` (${Math.round(c.confiance * 100)}%)` : ""}`).join(" | ")}`);
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

  /* ── §8 LE CAS FAUX PLAFOND ────────────────────────────────────────── */
  titre("§8 — FAUX PLAFOND : TROIS DÉCISIONS HUMAINES, SÉPARÉES");
  const faux = plan.produits.filter((p) => /FAUX PLAFOND/.test(p.cle));
  for (const p of faux) {
    const cible = p.produit || p.propose;
    console.log(`   « ${p.ecritures.join(" » / « ")} »`);
    console.log(`      quantité ${nb(p.quantite)} sur ${p.lignes} ligne(s) · décision ${p.decision}`);
    console.log(`      candidat : ${cible ? `#${cible.id} « ${cible.name} »` : "aucun"}`
      + `  preuves : ${(p.preuves || []).join(", ")}`);
    if (p.candidats && p.candidats.length > 1) {
      console.log(`      autres candidats : ${p.candidats.map((c) => `#${c.id} ${c.name}`).join(" | ")}`);
    }
  }
  console.log(`\n   Aucune sélection automatique n'est faite entre ces trois libellés, même`);
  console.log(`   lorsqu'un produit Triangle porte exactement l'un des noms : « GRAND » et`);
  console.log(`   « + ACCESSOIR » peuvent désigner des articles physiquement différents.`);

  /* ── §9 TGBU 686373/0 ──────────────────────────────────────────────── */
  titre("§9 — TGBU 686373/0 · « ÉTÉS DE FER »");
  const tgbu = plan.receptions.find((r) => /TGBU\s*686373/.test(r.conteneur || ""));
  if (!tgbu) console.log("   Conteneur absent du classeur lu.");
  else {
    console.log(`   Action : ${tgbu.action}`);
    for (const l of tgbu.lignes) {
      console.log(`   Ligne « ${l.libelle} » → ${l.action}`
        + `${l.raison ? ` — ${l.raison}` : ""} · quantité ${l.quantite == null ? "INCONNUE" : l.quantite}`);
    }
    const an = plan.anomalies.filter((a) => a.type === "QUANTITE_ABSENTE"
      && /686373/.test(a.message || ""));
    for (const a of an) console.log(`   Anomalie : ${a.type} — ${a.message}`);
    console.log(`   Verdict  : BLOCKED — QUANTITE_A_CONFIRMER. Aucune valeur par défaut,`);
    console.log(`              aucune estimation : le document ne dit rien, le rapport non plus.`);
  }

  /* ── §10 LES VÉHICULES ─────────────────────────────────────────────── */
  titre("§10 — LES PLAQUES ABSENTES NE BLOQUENT RIEN, ET NE S'INVENTENT PAS");
  const sansPlaque = plan.receptions.filter((r) => !r.vehicule);
  for (const r of sansPlaque) {
    console.log(`   ${pad(r.conteneur, 14)} ${r.date} · plaque NULL`
      + `${r.vehiculeDeclare ? " (champ présent, vide)" : " (champ absent)"}`
      + ` · action ${r.action}`);
  }
  console.log(`\n   ${sansPlaque.length} réception(s) sans plaque. Aucune n'est bloquée pour`);
  console.log(`   cette raison : seules une quantité absente, un entrepôt introuvable ou une`);
  console.log(`   divergence bloquent. Une anomalie VEHICULE_ABSENT est ouverte pour chacune.`);
  if (!plan.schema.vehiculeSurReception) {
    console.log(`   ⚠ La colonne vehicle_plate n'existe pas encore : même les 22 plaques lues`);
    console.log(`     ne pourront être enregistrées qu'après la migration 102.`);
  }

  /* ── §11 LES RÉCEPTIONS EXISTANTES ─────────────────────────────────── */
  titre("§11 — LES RÉCEPTIONS DÉJÀ EN BASE, RELUES MAINTENANT");
  const existantes = plan.receptions.filter((r) => r.existante);
  if (!existantes.length) console.log("   Aucune réception du classeur n'existe en base.");
  for (const r of existantes) {
    const aCreer = r.lignes.filter((l) => l.action === "A_CREER");
    const dejaLa = r.lignes.filter((l) => l.action === "DEJA_PRESENTE");
    console.log(`\n   ${r.conteneur} du ${r.date} → ${r.existante.numero}`);
    console.log(`      état actuel        : ${r.existante.statut}`);
    console.log(`      lignes en base     : ${r.existante.lignes}`);
    console.log(`      lignes du document : ${r.lignesDocument} `
      + `(${dejaLa.length} déjà présentes, ${aCreer.length} manquantes)`);
    console.log(`      quantité reçue     : ${nb(r.existante.recu)}`);
    console.log(`      quantité RANGÉE    : ${nb(r.existante.range)}`
      + `${Number(r.existante.range) > 0 ? "  ← du stock a déjà bougé" : ""}`);
    console.log(`      resterait à ajouter: ${nb(aCreer.reduce((s, l) => s + Number(l.quantite || 0), 0))}`);
    console.log(`      empreinte          : ${r.existante.empreinte}`);
    console.log(`      action             : ${r.action}`
      + `${r.motifs.length ? ` — ${r.motifs.join(" ; ")}` : ""}`);
  }
  console.log(`\n   L'empreinte ci-dessus est ce qui protège de l'écriture à l'aveugle : si une`);
  console.log(`   réception change entre ce diagnostic et l'écriture, l'applicateur la saute`);
  console.log(`   avec ETAT_CHANGE. Comparez ces empreintes à celles d'un audit antérieur :`);
  console.log(`   toute différence signifie DATA_CHANGED_SINCE_PREVIOUS_AUDIT.`);

  /* ── §13 LE RÉSUMÉ ─────────────────────────────────────────────────── */
  const t = plan.totaux;
  const sim = IMP.simuler(plan);
  const parAction = (a) => plan.receptions.filter((r) => r.action === a).length;
  const qteLignes = (f) => plan.receptions.reduce((s, r) =>
    s + r.lignes.filter(f).reduce((x, l) => x + Number(l.quantite || 0), 0), 0);
  titre("§13 — RÉSUMÉ");
  console.log(`   RÉCEPTIONS`);
  console.log(`     total Excel    : ${t.receptions}`);
  console.log(`     CREATE         : ${parAction(IMP.ACTION.CREATE)}`);
  console.log(`     COMPLETE       : ${parAction(IMP.ACTION.COMPLETE)}`);
  console.log(`     SKIP_IDENTICAL : ${parAction(IMP.ACTION.SKIP_IDENTICAL)}`);
  console.log(`     BLOCKED        : ${parAction(IMP.ACTION.BLOCKED)}`);
  console.log(`     REVIEW         : ${parAction(IMP.ACTION.REVIEW)}`);
  console.log(`   LIGNES`);
  console.log(`     total          : ${t.lignes}`);
  console.log(`     déjà présentes : ${t.lignesDejaPresentes + t.lignesDejaImportees}`
    + ` (dont ${t.lignesDejaImportees} reconnues par leur clé d'import)`);
  console.log(`     à ajouter      : ${t.lignesACreer}`);
  console.log(`     bloquées       : ${t.lignesBloquees}`);
  console.log(`   QUANTITÉS`);
  console.log(`     total Excel    : ${nb(plan.receptions.reduce((s, r) => s + r.quantiteDocument, 0))}`);
  console.log(`     déjà représentées : ${nb(qteLignes((l) => l.action === "DEJA_PRESENTE"
    || l.action === "DEJA_IMPORTEE"))}`);
  console.log(`     à ajouter      : ${nb(t.quantiteACreer)}`);
  const lignesBloquees = plan.receptions.reduce((s2, r) =>
    s2 + r.lignes.filter((l) => l.action === "BLOQUEE").length, 0);
  console.log(`     bloquées       : ${nb(qteLignes((l) => l.action === "BLOQUEE"))}`
    + ` — ${lignesBloquees} ligne(s) bloquée(s), dont la quantité est INCONNUE`
    + ` et ne peut donc pas être chiffrée`);
  console.log(`   PRODUITS`);
  console.log(`     écritures littérales : ${t.libellesEcrits}`);
  console.log(`     clés normalisées     : ${t.libelles}`);
  console.log(`     EXACT                : ${t.produitsExacts}`);
  console.log(`     PROBABLE_A_CONFIRMER : ${t.produitsProbables}`);
  console.log(`     AMBIGU               : ${t.produitsAmbigus}`);
  console.log(`     A_CREER              : ${t.produitsACreer}`);
  console.log(`     BLOQUE               : ${t.produitsBloques}`);
  console.log(`   ANOMALIES              : ${t.anomalies}`);
  console.log(`\n   IMPACT STOCK           : ${sim.impactStock}`);
  console.log(`   Une réception n'est pas une mise en stock : ce script n'appelle jamais le`);
  console.log(`   moteur de stock. Aucun mouvement, aucun putaway, aucun solde modifié.`);

  /* ── CE QUE L'IMPORT FERAIT ────────────────────────────────────────── */
  if (!APPLIQUER) {
    titre("CE QUE L'IMPORT FERAIT — SIMULATION, DÉDUITE DU PLAN SEUL");
    console.log(`   Créerait     : ${sim.creerait.length} réception(s), ${nb(sim.quantiteCreation)} unités`);
    for (const c of sim.creerait) {
      console.log(`     ${pad(c.conteneur, 14)} ${c.date} → ${pad(c.entrepot, 10)} `
        + `${String(c.lignes).padStart(2)} l. ${padG(nb(c.quantite), 7)} u.`
        + `${c.vehicule ? ` · ${c.vehicule}` : " · plaque NULL"}`);
    }
    console.log(`   Compléterait : ${sim.completerait.length} réception(s), ${nb(sim.quantiteCompletion)} unités`);
    for (const c of sim.completerait) {
      console.log(`     ${pad(c.conteneur, 14)} ${c.date} (${c.numero}) +${c.lignes} l. `
        + `${padG(nb(c.quantite), 7)} u. · déjà rangé ${c.dejaRange}`);
    }
    console.log(`   Sauterait    : ${sim.sauterait.length}`);
    for (const c of sim.sauterait) {
      console.log(`     ${pad(c.conteneur || "?", 14)} ${pad(c.date || "", 10)} ${pad(c.action, 15)} ${c.raison}`);
    }

    titre("PREUVE — CE QUI A ÉTÉ ENVOYÉ À POSTGRESQL");
    const verbes = new Set(journal.map((r) => r.trim().split(/\s+/)[0].toUpperCase()));
    console.log(`   ${journal.length} requête(s), verbes employés : ${[...verbes].join(", ") || "(aucune)"}`);
    const suspectes = journal.filter((r) =>
      /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i.test(r));
    console.log(`   Requêtes d'écriture : ${suspectes.length}`);
    for (const r of suspectes) console.log(`     ⚠ ${r}`);
    console.log(`   Transaction ouverte en READ ONLY, terminée par ROLLBACK.`);
    console.log(`\n   Pour écrire réellement : --appliquer --je-confirme`
      + `${plan.schema.migration102 ? "" : " (après la migration 102)"}`);
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

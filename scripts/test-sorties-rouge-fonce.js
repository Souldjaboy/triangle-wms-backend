"use strict";

/**
 * LA RECONSTRUCTION DES 21 SORTIES ROUGE FONCÉ, DE BOUT EN BOUT.
 *
 *   DATABASE_URL=… node scripts/test-sorties-rouge-fonce.js
 *
 * Le cas réel : l'ancien chemin d'import a écrit 43 mouvements de sortie pour
 * 12 193 unités là où le classeur ne décrit que 21 sorties pour 739. Les
 * sorties d'un même produit ont été additionnées — trois sorties STADE 4 AOUT
 * de 7, 7 et 6 sont devenues un mouvement de 20 — et personne ne peut faire
 * signer un bon de 20 pour une opération qui n'a jamais eu lieu ainsi.
 *
 * Ces contrôles vérifient ce qui compte vraiment :
 *   • le classeur donne bien 21 lignes et 739 unités, et rien d'autre ne
 *     passe ;
 *   • 2 + 3 restent deux bons, 6 + 1 deux bons, 7 + 7 + 6 trois bons ;
 *   • aucun bon ne porte 5, 7 ou 20 quand ces chiffres sont des sommes ;
 *   • MAMBRANE, qui n'a aucun mouvement, est signalée et non inventée ;
 *   • TETE DE JACK ne garde qu'un seul bon actif ;
 *   • rejouer, subir une panne ou lancer deux exécutions simultanées ne
 *     produit ni doublon ni écriture partielle ;
 *   • le stock ne bouge pas d'une unité.
 */

const { Pool } = require("pg");
const { execFileSync, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

const V = "\x1b[32m", R = "\x1b[31m", G = "\x1b[1m", Z = "\x1b[0m";
let reussis = 0, echoues = 0;

function verifier(titre, condition, detail = "") {
  if (condition) { reussis += 1; console.log(`${V}  ✓${Z} ${titre}`); }
  else { echoues += 1; console.log(`${R}  ✗ ${titre}${Z}${detail ? `  — ${detail}` : ""}`); }
}

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL manquant."); process.exit(1); }

const CLASSEUR = process.env.CLASSEUR_EM2S
  || `${process.env.HOME}/Downloads/administratif/Copie de dernier actualisation bby me.xlsx`;

if (!fs.existsSync(CLASSEUR)) {
  console.error(`${R}Classeur introuvable : ${CLASSEUR}${Z}`);
  console.error("Indiquez-le avec CLASSEUR_EM2S=… — sans lui, rien ici n'est vérifiable.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const RECONSTRUIRE = path.join(__dirname, "reconstruire-sorties-rouge-fonce.js");
const JEU = path.join(__dirname, "jeu-essai-import3-consolide.js");

function lancer(...args) {
  try {
    return { code: 0, sortie: execFileSync(process.execPath, [RECONSTRUIRE, ...args, `--fichier=${CLASSEUR}`],
      { encoding: "utf8", env: process.env }) };
  } catch (e) {
    return { code: e.status || 1, sortie: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

const lancerAsync = (...args) => new Promise((resolve) => {
  execFile(process.execPath, [RECONSTRUIRE, ...args, `--fichier=${CLASSEUR}`],
    { encoding: "utf8", env: process.env },
    (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, sortie: `${stdout}${stderr}` }));
});

function poserLeJeu() {
  execFileSync(process.execPath, [JEU], { encoding: "utf8", env: process.env });
}

async function q(sql, params = []) { return (await pool.query(sql, params)).rows; }

/** Les tables qui n'ont pas le droit de bouger. */
async function empreinte() {
  const r = await q(`
    SELECT (SELECT coalesce(json_agg(json_build_object('i',id,'s',stock) ORDER BY id),'[]') FROM products)                AS produits,
           (SELECT coalesce(json_agg(json_build_object('i',id,'q',quantity) ORDER BY id),'[]') FROM stock_movements)      AS mouvements,
           (SELECT coalesce(json_agg(json_build_object('i',id,'q',quantity) ORDER BY id),'[]') FROM stock_location_balances) AS balances,
           (SELECT count(*) FROM users)       AS utilisateurs,
           (SELECT count(*) FROM inventory_imports) AS imports`);
  return JSON.stringify(r[0]);
}

async function main() {
  console.log(`\n${G}RECONSTRUCTION DES SORTIES ROUGE FONCÉ${Z}`);

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}LE CLASSEUR EST LE GARDE-FOU${Z}`);
  {
    poserLeJeu();
    const r = lancer("--preview");
    verifier("le preview lit 21 lignes rouge foncé",
      /lignes rouge foncé : 21 \(attendu 21\)/.test(r.sortie));
    verifier("pour 739 unités", /total des unités   : 739 \(attendu 739\)/.test(r.sortie));
    verifier("il reconnaît l'import n°3", /n°3 — Copie de dernier actualisation/.test(r.sortie));
    verifier("il vérifie l'empreinte du fichier", /empreinte.*conforme/.test(r.sortie));
    verifier("il annonce 43 mouvements pour 12193 unités",
      /43 pour 12193 unités/.test(r.sortie));

    /* Un autre fichier — n'importe lequel — ne doit pas passer. */
    const autre = path.join(__dirname, "..", "package.json");
    let refus;
    try {
      execFileSync(process.execPath, [RECONSTRUIRE, "--preview", `--fichier=${autre}`],
        { encoding: "utf8", env: process.env });
      refus = { code: 0, sortie: "" };
    } catch (e) { refus = { code: e.status || 1, sortie: `${e.stdout || ""}${e.stderr || ""}` }; }
    verifier("un fichier qui n'est pas le classeur est refusé", refus.code !== 0);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}LE PREVIEW N'ÉCRIT RIEN${Z}`);
  {
    const avant = await empreinte();
    const docsAvant = JSON.stringify(await q(
      `SELECT id, document_number, cancelled_at FROM documents ORDER BY id`));
    lancer("--preview");
    verifier("aucun événement n'a été créé",
      Number((await q(`SELECT count(*) n FROM stock_import_movement_events`))[0].n) === 0);
    verifier("aucun document n'a changé",
      docsAvant === JSON.stringify(await q(
        `SELECT id, document_number, cancelled_at FROM documents ORDER BY id`)));
    verifier("le stock n'a pas bougé", avant === (await empreinte()));
    verifier("aucun numéro n'a été consommé",
      Number((await q(`SELECT count(*) n FROM stock_request_counters`))[0].n) === 0);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}--apply EXIGE UNE CONFIRMATION EXACTE${Z}`);
  {
    verifier("sans confirmation, refus", lancer("--apply").code !== 0);
    verifier("avec une confirmation approximative, refus",
      lancer("--apply", "--confirmer=oui").code !== 0);
    verifier("les deux modes à la fois, refus",
      lancer("--preview", "--apply", "--confirmer=OUI-JE-RECONSTRUIS").code !== 0);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}LA RECONSTRUCTION${Z}`);
  const stockAvant = await empreinte();
  {
    const r = lancer("--apply", "--confirmer=OUI-JE-RECONSTRUIS");
    verifier("elle s'exécute", r.code === 0, r.sortie.slice(-300));

    const ev = await q(`SELECT * FROM stock_import_movement_events ORDER BY excel_row`);
    verifier("21 événements", ev.length === 21, String(ev.length));
    verifier("739 unités", ev.reduce((s, e) => s + Number(e.quantity), 0) === 739);
    verifier("tous de direction OUT", ev.every((e) => e.direction === "OUT"));
    verifier("tous sur la feuille LISTE DES STOCK",
      ev.every((e) => e.excel_sheet === "LISTE DES STOCK"));
    verifier("tous en colonne M", ev.every((e) => /^M\d+$/.test(e.excel_cell)));
    verifier("tous en société 1", ev.every((e) => e.company_id === 1));
    verifier("chaque event_key est unique", new Set(ev.map((e) => e.event_key)).size === 21);
    verifier("chacun porte son import et sa couleur",
      ev.every((e) => e.source_context.import_id === 3
        && e.source_context.couleur === "C00000"));
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}LES CONSOLIDATIONS RESTENT DES ÉVÉNEMENTS DISTINCTS${Z}`);
  {
    const parMouvement = new Map();
    for (const e of await q(
      `SELECT movement_id, quantity FROM stock_import_movement_events
        WHERE movement_id IS NOT NULL`)) {
      const k = String(e.movement_id);
      if (!parMouvement.has(k)) parMouvement.set(k, []);
      parMouvement.get(k).push(Number(e.quantity));
    }
    const groupes = [...parMouvement.values()].map((a) => a.sort((x, y) => y - x));

    verifier("2 + 3 : deux événements sur le mouvement de 5",
      groupes.some((g) => g.length === 2 && g[0] === 3 && g[1] === 2), JSON.stringify(groupes));
    verifier("6 + 1 : deux événements sur le mouvement de 7",
      groupes.some((g) => g.length === 2 && g[0] === 6 && g[1] === 1));
    verifier("7 + 7 + 6 : trois événements sur le mouvement de 20",
      groupes.some((g) => g.length === 3 && g[0] === 7 && g[1] === 7 && g[2] === 6));
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}UN BON PAR SORTIE RÉELLE, JAMAIS PAR CONSOLIDATION${Z}`);
  {
    const actifs = await q(
      `SELECT d.id, d.document_number, d.stock_import_movement_event_id AS ev,
              (SELECT sum(quantity) FROM document_items i WHERE i.document_id = d.id) AS q
         FROM documents d WHERE d.cancelled_at IS NULL ORDER BY d.id`);
    const quantites = actifs.map((d) => Number(d.q));

    verifier("20 bons actifs — 21 événements moins MAMBRANE, non rattachée",
      actifs.length === 20, String(actifs.length));
    verifier("chaque bon actif porte son événement", actifs.every((d) => d.ev !== null));
    verifier("un seul document actif par événement",
      new Set(actifs.map((d) => String(d.ev))).size === actifs.length);
    verifier("deux bons distincts de 2 et 3",
      quantites.includes(2) && quantites.includes(3));
    verifier("deux bons distincts de 6 et 1",
      quantites.includes(6) && quantites.includes(1));
    verifier("trois bons de 7, 7 et 6",
      quantites.filter((x) => x === 7).length >= 2 && quantites.includes(6));
    verifier("aucun bon de 20 : c'était une somme", !quantites.includes(20));
    verifier("aucun bon de 5 : c'était une somme", !quantites.includes(5));
    verifier("les quantités imprimées totalisent 714 (739 moins MAMBRANE)",
      quantites.reduce((s, x) => s + x, 0) === 714,
      String(quantites.reduce((s, x) => s + x, 0)));

    const consolidees = await q(
      `SELECT d.id FROM documents d
         JOIN stock_import_movement_events e ON e.id = d.stock_import_movement_event_id
         JOIN stock_movements m ON m.id = e.movement_id
        WHERE d.cancelled_at IS NULL
          AND (SELECT sum(quantity) FROM document_items i WHERE i.document_id = d.id) = m.quantity
          AND m.quantity <> e.quantity`);
    verifier("aucun bon ne reprend la quantité du mouvement quand elle diffère",
      consolidees.length === 0, JSON.stringify(consolidees));
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}LES DATES ET LA PROVENANCE${Z}`);
  {
    const attendu = {
      167: ["2026-07-29", 2], 171: ["2026-07-20", 6], 175: ["2026-07-27", 8],
      196: ["2026-07-20", 8], 199: ["2026-07-27", 7], 205: ["2026-08-31", 7],
      207: ["2026-08-31", 7], 208: ["2026-08-31", 6], 234: ["2026-08-17", 2],
      248: ["2026-08-25", 25], 250: ["2026-07-31", 8], 253: ["2026-07-24", 6],
      255: ["2026-08-17", 2], 256: ["2026-07-27", 504], 260: ["2026-08-17", 2],
      263: ["2026-07-09", 1], 265: ["2026-08-25", 1], 266: ["2026-08-25", 6],
      267: ["2026-08-25", 3], 297: ["2026-08-20", 80], 342: ["2026-08-21", 48],
    };
    const ev = await q(
      `SELECT excel_row, effective_date::text AS d, quantity FROM stock_import_movement_events
        ORDER BY excel_row`);
    const ecarts = ev.filter((e) => {
      const a = attendu[e.excel_row];
      return !a || a[0] !== e.d || a[1] !== Number(e.quantity);
    });
    verifier("les 21 lignes, dates et quantités correspondent à la liste certifiée",
      ecarts.length === 0 && ev.length === 21,
      JSON.stringify(ecarts.map((e) => [e.excel_row, e.d, Number(e.quantity)])));

    const bons = await q(
      `SELECT d.document_number, d.document_datetime::date::text AS dd,
              e.effective_date::text AS de, d.observation
         FROM documents d JOIN stock_import_movement_events e
           ON e.id = d.stock_import_movement_event_id
        WHERE d.cancelled_at IS NULL`);
    verifier("chaque bon porte la date métier de son événement",
      bons.length === 20 && bons.every((b) => b.dd === b.de),
      JSON.stringify(bons.filter((b) => b.dd !== b.de)));
    verifier("chaque bon cite sa ligne Excel et sa cellule",
      bons.every((b) => /ligne \d+ · cellule M\d+/.test(b.observation || "")));
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}MAMBRANE : SIGNALÉE, PAS INVENTÉE${Z}`);
  {
    const mam = (await q(
      `SELECT * FROM stock_import_movement_events
        WHERE source_context->>'produit' = 'MAMBRANE'`))[0];
    verifier("l'événement existe", !!mam);
    verifier("il porte 25 unités", mam && Number(mam.quantity) === 25);
    verifier("aucun mouvement ne lui a été inventé", mam && mam.movement_id === null);
    verifier("son statut dit qu'il n'est pas importé", mam && mam.status === "READY", mam?.status);
    verifier("aucun bon ne lui a été émis sans qu'on le demande",
      Number((await q(
        `SELECT count(*) n FROM documents
          WHERE stock_import_movement_event_id = $1 AND cancelled_at IS NULL`,
        [mam.id]))[0].n) === 0);

    /* Il faut le demander explicitement — et alors le bon porte 25. */
    const r = lancer("--apply", "--confirmer=OUI-JE-RECONSTRUIS", "--documenter-non-rattaches");
    verifier("avec --documenter-non-rattaches, le bon est émis", r.code === 0);
    const doc = (await q(
      `SELECT d.document_number, (SELECT sum(quantity) FROM document_items i
         WHERE i.document_id = d.id) AS q
         FROM documents d
        WHERE d.stock_import_movement_event_id = $1 AND d.cancelled_at IS NULL`,
      [mam.id]))[0];
    verifier("et il porte exactement 25", doc && Number(doc.q) === 25, JSON.stringify(doc));
    verifier("le mouvement reste absent : rien n'a été inventé",
      (await q(`SELECT movement_id FROM stock_import_movement_events WHERE id = $1`,
        [mam.id]))[0].movement_id === null);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}TETE DE JACK : LE DOUBLON${Z}`);
  {
    const jack = await q(
      `SELECT d.id, d.document_number, d.cancelled_at IS NOT NULL AS annule,
              d.cancellation_reason, d.duplicate_of_document_id
         FROM documents d
        WHERE d.document_number IN ('BS-260902-129','BS-260902-130') ORDER BY d.id`);
    verifier("les deux bons existent toujours", jack.length === 2);
    verifier("un seul est actif", jack.filter((d) => !d.annule).length === 1);
    verifier("l'autre est annulé, pas supprimé", jack.some((d) => d.annule));
    verifier("l'annulé porte le motif de doublon",
      jack.some((d) => /doublon/i.test(d.cancellation_reason || "")));
    verifier("et pointe vers celui qui reste",
      jack.some((d) => d.duplicate_of_document_id === jack.find((x) => !x.annule).id));
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}LE STOCK N'A PAS BOUGÉ${Z}`);
  {
    verifier("produits, mouvements, balances, utilisateurs, imports : identiques",
      (await empreinte()) === stockAvant);
    verifier("43 mouvements de sortie, toujours 12 193 unités",
      (await q(`SELECT sum(quantity) q FROM stock_movements
                 WHERE import_id = 3 AND type = 'Sortie'`))[0].q === "12193");
    verifier("aucun mouvement n'a été créé",
      Number((await q(`SELECT count(*) n FROM stock_movements`))[0].n) === 43);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}REJOUER NE DUPLIQUE RIEN${Z}`);
  {
    const avant = JSON.stringify(await q(
      `SELECT id, document_number, cancelled_at, stock_import_movement_event_id
         FROM documents ORDER BY id`));
    const compteursAvant = JSON.stringify(await q(
      `SELECT * FROM stock_request_counters ORDER BY company_id, prefix`));
    const evAvant = Number((await q(
      `SELECT count(*) n FROM stock_import_movement_events`))[0].n);

    const r = lancer("--apply", "--confirmer=OUI-JE-RECONSTRUIS", "--documenter-non-rattaches");
    verifier("le second passage s'exécute", r.code === 0, r.sortie.slice(-200));
    verifier("aucun événement de plus",
      Number((await q(`SELECT count(*) n FROM stock_import_movement_events`))[0].n) === evAvant);
    verifier("aucun document créé ni modifié",
      avant === JSON.stringify(await q(
        `SELECT id, document_number, cancelled_at, stock_import_movement_event_id
           FROM documents ORDER BY id`)));
    verifier("aucun numéro consommé",
      compteursAvant === JSON.stringify(await q(
        `SELECT * FROM stock_request_counters ORDER BY company_id, prefix`)));
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}UNE PANNE AU MILIEU N'ÉCRIT RIEN${Z}`);
  {
    poserLeJeu();
    const avant = JSON.stringify(await q(
      `SELECT id, document_number, cancelled_at FROM documents ORDER BY id`));
    const stockPanne = await empreinte();

    await pool.query(`CREATE TABLE IF NOT EXISTS essai_compteur_bs (n INTEGER NOT NULL DEFAULT 0)`);
    await pool.query(`DELETE FROM essai_compteur_bs`);
    await pool.query(`INSERT INTO essai_compteur_bs VALUES (0)`);
    await pool.query(`
      CREATE OR REPLACE FUNCTION essai_panne_bs() RETURNS trigger AS $$
      DECLARE c INTEGER;
      BEGIN
        IF NEW.document_type = 'Bon de sortie' THEN
          UPDATE essai_compteur_bs SET n = n + 1 RETURNING n INTO c;
          IF c >= 9 THEN RAISE EXCEPTION 'PANNE SIMULÉE au 9e bon'; END IF;
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await pool.query(`DROP TRIGGER IF EXISTS essai_panne_bs_trg ON documents`);
    await pool.query(`CREATE TRIGGER essai_panne_bs_trg BEFORE INSERT ON documents
                       FOR EACH ROW EXECUTE FUNCTION essai_panne_bs()`);

    const r = lancer("--apply", "--confirmer=OUI-JE-RECONSTRUIS");
    verifier("le script échoue franchement", r.code !== 0);
    verifier("il annonce que rien n'a été écrit", /Aucun événement, aucun document/.test(r.sortie));
    verifier("aucun événement n'a été créé",
      Number((await q(`SELECT count(*) n FROM stock_import_movement_events`))[0].n) === 0);
    verifier("aucun document créé ni annulé",
      avant === JSON.stringify(await q(
        `SELECT id, document_number, cancelled_at FROM documents ORDER BY id`)));
    verifier("aucun numéro consommé",
      Number((await q(`SELECT count(*) n FROM stock_request_counters`))[0].n) === 0);
    verifier("le stock est intact", stockPanne === (await empreinte()));

    await pool.query(`DROP TRIGGER IF EXISTS essai_panne_bs_trg ON documents`);
    await pool.query(`DROP FUNCTION IF EXISTS essai_panne_bs()`);
    await pool.query(`DROP TABLE IF EXISTS essai_compteur_bs`);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}DEUX EXÉCUTIONS SIMULTANÉES${Z}`);
  {
    poserLeJeu();
    const [a, b] = await Promise.all([
      lancerAsync("--apply", "--confirmer=OUI-JE-RECONSTRUIS"),
      lancerAsync("--apply", "--confirmer=OUI-JE-RECONSTRUIS"),
    ]);
    verifier("les deux se terminent sans casse", a.code === 0 && b.code === 0,
      `A=${a.code} B=${b.code}`);
    verifier("21 événements, pas 42",
      Number((await q(`SELECT count(*) n FROM stock_import_movement_events`))[0].n) === 21);

    const doublons = await q(`
      SELECT stock_import_movement_event_id FROM documents
       WHERE stock_import_movement_event_id IS NOT NULL AND cancelled_at IS NULL
       GROUP BY 1 HAVING count(*) > 1`);
    verifier("un seul document actif par événement", doublons.length === 0,
      JSON.stringify(doublons));

    const numeros = await q(
      `SELECT company_id, document_number, count(*) n FROM documents
        GROUP BY 1, 2 HAVING count(*) > 1`);
    verifier("aucun numéro en double", numeros.length === 0, JSON.stringify(numeros));
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}ISOLATION ENTRE SOCIÉTÉS${Z}`);
  {
    verifier("aucun événement hors de la société 1",
      Number((await q(
        `SELECT count(*) n FROM stock_import_movement_events WHERE company_id <> 1`))[0].n) === 0);
    verifier("aucun document créé hors de la société 1",
      Number((await q(
        `SELECT count(*) n FROM documents WHERE company_id <> 1`))[0].n) === 0);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}L'INDEX D'UNICITÉ SE POSE UNE FOIS LES DOUBLONS TRAITÉS${Z}`);
  {
    /* Le jeu d'essai retire les index, comme la production qui ne les a
       jamais reçus. Une fois la reconstruction faite, rejouer 074 doit
       pouvoir les poser : c'est la séquence de déploiement. */
    const migration = fs.readFileSync(
      path.join(__dirname, "..", "sql", "074_documents_par_evenement_import.sql"), "utf8");
    await pool.query(migration);
    const index = await q(
      `SELECT indexname FROM pg_indexes
        WHERE indexname IN ('documents_evenement_actif_uidx','documents_mouvement_actif_uidx')`);
    verifier("les deux index d'unicité sont posés après la correction",
      index.length === 2, JSON.stringify(index.map((i) => i.indexname)));
  }

  console.log(`\n${G}BILAN${Z}`);
  console.log(`  ${reussis} réussis, ${echoues} échoués\n`);
  await pool.end();
  process.exit(echoues > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`${R}ÉCHEC : ${e.message}${Z}`);
  console.error(e.stack);
  await pool.end().catch(() => {});
  process.exit(1);
});

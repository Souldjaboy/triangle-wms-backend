"use strict";

/**
 * LE RETRAIT DES MENTIONS TECHNIQUES, DE BOUT EN BOUT.
 *
 *   DATABASE_URL=… node scripts/test-retirer-observations-techniques.js
 *
 * Le classeur EM2S a laissé, sur les 21 bons de sortie reconstruits, une
 * observation technique — fichier, feuille, ligne, cellule, parfois la
 * mention « VERSION MÉTIER VALIDÉE » avec les deux empreintes SHA-256. Un
 * client qui reçoit un de ces bons n'a rien à faire de ce jargon.
 *
 * Ces contrôles vérifient que le nettoyage :
 *   • ne touche QUE les 21 bons actifs de société 1 / empreinte certifiée,
 *     jamais un document d'une autre société, d'un autre import, annulé, ou
 *     sans événement lié ;
 *   • journalise chaque changement dans document_content_revisions AVANT de
 *     l'appliquer, avec le motif exact demandé et l'auteur système ;
 *   • ne touche jamais le numéro, la date, les lignes, le lien vers
 *     l'événement ou le mouvement, ni le statut ;
 *   • laisse intacts stock_import_movement_events.source_context (la preuve
 *     technique complète) et tout le stock ;
 *   • se rejoue sans effet, résiste à une panne au milieu et à une
 *     concurrence.
 */

const { Pool } = require("pg");
const { execFileSync, execFile } = require("child_process");
const path = require("path");

const V = "\x1b[32m", R = "\x1b[31m", G = "\x1b[1m", Z = "\x1b[0m";
let reussis = 0, echoues = 0;

function verifier(titre, condition, detail = "") {
  if (condition) { reussis += 1; console.log(`${V}  ✓${Z} ${titre}`); }
  else { echoues += 1; console.log(`${R}  ✗ ${titre}${Z}${detail ? `  — ${detail}` : ""}`); }
}

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL manquant."); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const SCRIPT = path.join(__dirname, "retirer-observations-techniques.js");
const JEU = path.join(__dirname, "jeu-essai-observations-techniques.js");

const CIBLE_SHA = "61b7104201a146f27812c6b2603ee3b9dbc790879282b0c081d81e6379690e9e";
const PHRASE = "OUI-JE-RETIRE-LES-OBSERVATIONS";

function lancer(...args) {
  try {
    return { code: 0, sortie: execFileSync(process.execPath, [SCRIPT, ...args],
      { encoding: "utf8", env: process.env }) };
  } catch (e) {
    return { code: e.status || 1, sortie: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

const lancerAsync = (...args) => new Promise((resolve) => {
  execFile(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: process.env },
    (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, sortie: `${stdout}${stderr}` }));
});

function poserLeJeu() {
  execFileSync(process.execPath, [JEU], { encoding: "utf8", env: process.env });
}

async function q(sql, params = []) { return (await pool.query(sql, params)).rows; }

async function empreinteStock() {
  const r = await q(`
    SELECT (SELECT coalesce(json_agg(json_build_object('i',id,'s',stock) ORDER BY id),'[]') FROM products)                   AS produits,
           (SELECT coalesce(json_agg(json_build_object('i',id,'q',quantity) ORDER BY id),'[]') FROM stock_movements)         AS mouvements,
           (SELECT coalesce(json_agg(json_build_object('i',id,'q',quantity) ORDER BY id),'[]') FROM stock_location_balances) AS balances`);
  return JSON.stringify(r[0]);
}

async function cibles() {
  return q(`SELECT d.id, d.document_number, d.observation, d.document_datetime,
                   d.stock_movement_id, d.stock_import_movement_event_id, d.document_revision,
                   d.print_count, d.printed_at, d.cancelled_at,
                   (SELECT sum(quantity) FROM document_items i WHERE i.document_id = d.id) AS quantite
              FROM documents d
              JOIN stock_import_movement_events e ON e.id = d.stock_import_movement_event_id
             WHERE e.company_id = 1 AND e.file_sha256 = $1 AND d.cancelled_at IS NULL
             ORDER BY d.id`, [CIBLE_SHA]);
}

async function main() {
  console.log(`\n${G}RETIRER LES MENTIONS TECHNIQUES — 21 BONS EM2S${Z}`);

  poserLeJeu();
  const stockDepart = await empreinteStock();

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}LE PREVIEW N'ÉCRIT RIEN${Z}`);
  {
    const avant = JSON.stringify(await q(`SELECT id, observation, document_revision
      FROM documents ORDER BY id`));
    const revisionsAvant = Number((await q(`SELECT count(*) n FROM document_content_revisions`))[0].n);

    const r = lancer("--preview");
    verifier("le preview s'exécute", r.code === 0, r.sortie.slice(-300));
    verifier("il annonce exactement 21 documents ciblés",
      /documents ciblés : 21 \(attendu 21\)/.test(r.sortie));
    verifier("il annonce exactement 739 unités",
      /total des unités : 739 \(attendu 739\)/.test(r.sortie));
    verifier("il annonce 0 mouvement modifié", /mouvements modifiés\s*: 0/.test(r.sortie));
    verifier("il annonce 0 stock modifié", /stock modifié\s*: 0/.test(r.sortie));
    verifier("il liste les documents ciblés",
      /BS-260902-126/.test(r.sortie) && /BS-260902-146/.test(r.sortie));

    verifier("aucun document n'a changé",
      avant === JSON.stringify(await q(`SELECT id, observation, document_revision FROM documents ORDER BY id`)));
    verifier("aucune révision n'a été créée",
      Number((await q(`SELECT count(*) n FROM document_content_revisions`))[0].n) === revisionsAvant);
    verifier("le stock n'a pas bougé", (await empreinteStock()) === stockDepart);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}EXACTEMENT 21 DOCUMENTS CIBLÉS${Z}`);
  {
    const c = await cibles();
    verifier("21 documents dans le périmètre exact", c.length === 21, String(c.length));
    verifier("739 unités au total",
      c.reduce((s, d) => s + Number(d.quantite), 0) === 739);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}--apply EXIGE UNE CONFIRMATION EXACTE${Z}`);
  {
    verifier("sans confirmation, refus", lancer("--apply").code !== 0);
    verifier("avec une confirmation approximative, refus",
      lancer("--apply", "--confirmer=oui").code !== 0);
    verifier("les deux modes à la fois, refus",
      lancer("--preview", "--apply", `--confirmer=${PHRASE}`).code !== 0);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}L'APPLICATION${Z}`);
  const avantApply = await cibles();
  {
    const r = lancer("--apply", `--confirmer=${PHRASE}`);
    verifier("elle s'exécute", r.code === 0, r.sortie.slice(-400));
    verifier("21 documents modifiés", /documents modifiés : 21/.test(r.sortie));
    verifier("21 révisions écrites", /révisions écrites  : 21/.test(r.sortie));

    const apres = await cibles();
    verifier("observation vide sur les 21 documents",
      apres.length === 21 && apres.every((d) => (d.observation || "") === ""),
      JSON.stringify(apres.filter((d) => d.observation)));

    verifier("aucun document supprimé — toujours 21 actifs dans le périmètre",
      apres.length === 21);

    /* Numéros, dates, quantités, liens : rigoureusement inchangés. */
    const parId = new Map(avantApply.map((d) => [d.id, d]));
    verifier("document_number inchangé",
      apres.every((d) => d.document_number === parId.get(d.id).document_number));
    verifier("document_datetime inchangé",
      apres.every((d) => String(d.document_datetime) === String(parId.get(d.id).document_datetime)));
    verifier("stock_movement_id inchangé",
      apres.every((d) => d.stock_movement_id === parId.get(d.id).stock_movement_id));
    verifier("stock_import_movement_event_id inchangé",
      apres.every((d) => d.stock_import_movement_event_id === parId.get(d.id).stock_import_movement_event_id));
    verifier("quantité imprimée inchangée",
      apres.every((d) => Number(d.quantite) === Number(parId.get(d.id).quantite)));
    verifier("print_count et printed_at inchangés",
      apres.every((d) => Number(d.print_count) === Number(parId.get(d.id).print_count)
        && String(d.printed_at) === String(parId.get(d.id).printed_at)));
    verifier("cancelled_at toujours NULL — aucun document annulé",
      apres.every((d) => d.cancelled_at === null));

    const items = await q(`SELECT document_id, id, quantity FROM document_items
       WHERE document_id = ANY($1::int[]) ORDER BY document_id, id`,
      [apres.map((d) => d.id)]);
    verifier("document_items totalement inchangés (aucune ligne créée ni modifiée)",
      items.length === 21);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}LES RÉVISIONS ÉCRITES${Z}`);
  {
    const revs = await q(`SELECT dcr.*, d.document_number
       FROM document_content_revisions dcr JOIN documents d ON d.id = dcr.document_id
      WHERE d.stock_import_movement_event_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM stock_import_movement_events e
                     WHERE e.id = d.stock_import_movement_event_id
                       AND e.company_id = 1 AND e.file_sha256 = $1)
      ORDER BY dcr.document_id`, [CIBLE_SHA]);
    verifier("une révision par document modifié — 21 au total", revs.length === 21,
      String(revs.length));
    verifier("chaque révision porte le motif exact",
      revs.every((r) => r.reason === "Retrait des mentions techniques internes du bon imprimable"));
    verifier("chaque révision cite un auteur système clairement identifié",
      revs.every((r) => /retirer-observations-techniques/.test(r.changed_by_name || "")));
    verifier("le contenu avant porte l'ancienne observation",
      revs.every((r) => (r.old_items?.observation || "").length > 0));
    verifier("le contenu après porte une observation vide",
      revs.every((r) => r.new_items?.observation === ""));
    verifier("document_number avant/après inchangé dans la révision",
      revs.every((r) => r.old_document_number === r.new_document_number
        && r.old_document_number === r.document_number));

    /* Impression : les trois états posés par le jeu d'essai. */
    const parNumero = new Map(revs.map((r) => [r.document_number, r]));
    verifier("le document imprimé via print_count ET printed_at est marqué was_printed",
      parNumero.get("BS-260902-126")?.was_printed === true);
    verifier("le document imprimé via printed_at seul est marqué was_printed",
      parNumero.get("BS-260902-127")?.was_printed === true);
    verifier("le document imprimé via print_count seul est marqué was_printed",
      parNumero.get("BS-260902-128")?.was_printed === true);
    verifier("un document jamais imprimé n'est PAS marqué was_printed",
      parNumero.get("BS-260902-129")?.was_printed === false);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}L'AUDIT TECHNIQUE RESTE ENTIER${Z}`);
  {
    const ev = await q(`SELECT e.* FROM stock_import_movement_events e
       WHERE e.company_id = 1 AND e.file_sha256 = $1`, [CIBLE_SHA]);
    /* 22, pas 21 : le jeu d'essai place volontairement un événement lié au
       document ANNULÉ dans le même périmètre société/empreinte, pour prouver
       que l'annulé ne compte pas parmi les 21 actifs. Les deux existent. */
    verifier("les 22 événements du périmètre existent toujours (21 actifs + 1 annulé)",
      ev.length === 22, String(ev.length));
    verifier("aucun n'a perdu son empreinte, son alias potentiel ou sa ligne Excel",
      ev.every((e) => e.source_context && e.source_context.empreinte_import
        && e.source_context.empreinte_fichier_relu && e.excel_row && e.excel_cell));
    verifier("les empreintes dans source_context sont exactes",
      ev.every((e) => e.source_context.empreinte_import === CIBLE_SHA
        && e.source_context.empreinte_fichier_relu
          === "2ceb0871526eb452a003fdab0852c2881892e131cfbd41974242b9a737f5bc42"));
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}LE STOCK N'A PAS BOUGÉ${Z}`);
  {
    verifier("products, stock_movements et balances strictement identiques",
      (await empreinteStock()) === stockDepart);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}CE QUI N'EST PAS DANS LE PÉRIMÈTRE N'EST JAMAIS TOUCHÉ${Z}`);
  {
    const hors = await q(`SELECT document_number, observation FROM documents
       WHERE document_number IN
         ('BS-260902-999', 'BS-AUTRE-IMPORT-001', 'BS-AUTRE-SOCIETE-001', 'BS-SANS-EVENEMENT-001')
       ORDER BY document_number`);
    verifier("les 4 documents hors périmètre existent",
      hors.length === 4, JSON.stringify(hors.map((d) => d.document_number)));
    verifier("le document ANNULÉ du même périmètre garde son observation",
      hors.find((d) => d.document_number === "BS-260902-999")?.observation.length > 0);
    verifier("le document d'un AUTRE import (même société) garde son observation",
      hors.find((d) => d.document_number === "BS-AUTRE-IMPORT-001")?.observation.length > 0);
    verifier("le document d'une AUTRE société (même empreinte) garde son observation",
      hors.find((d) => d.document_number === "BS-AUTRE-SOCIETE-001")?.observation.length > 0);
    verifier("le document sans événement lié garde son observation",
      hors.find((d) => d.document_number === "BS-SANS-EVENEMENT-001")?.observation.length > 0);
    verifier("aucune révision n'a été écrite pour les documents hors périmètre",
      Number((await q(`SELECT count(*) n FROM document_content_revisions dcr
         JOIN documents d ON d.id = dcr.document_id
        WHERE d.document_number IN
          ('BS-260902-999','BS-AUTRE-IMPORT-001','BS-AUTRE-SOCIETE-001','BS-SANS-EVENEMENT-001')`))[0].n) === 0);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}REJEU SANS EFFET${Z}`);
  {
    const avant = JSON.stringify(await q(`SELECT id, observation, document_revision FROM documents ORDER BY id`));
    const revisionsAvant = Number((await q(`SELECT count(*) n FROM document_content_revisions`))[0].n);

    const r = lancer("--apply", `--confirmer=${PHRASE}`);
    verifier("le second passage s'exécute", r.code === 0, r.sortie.slice(-300));
    verifier("il annonce 0 document modifié", /documents modifiés : 0/.test(r.sortie));
    verifier("il annonce 0 révision écrite", /révisions écrites  : 0/.test(r.sortie));
    verifier("aucun document n'a changé",
      avant === JSON.stringify(await q(`SELECT id, observation, document_revision FROM documents ORDER BY id`)));
    verifier("aucune nouvelle révision",
      Number((await q(`SELECT count(*) n FROM document_content_revisions`))[0].n) === revisionsAvant);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}PANNE AU MILIEU : ROLLBACK COMPLET${Z}`);
  {
    poserLeJeu();
    const avant = JSON.stringify(await q(`SELECT id, observation, document_revision FROM documents ORDER BY id`));
    const stockAvant = await empreinteStock();

    await pool.query(`CREATE TABLE IF NOT EXISTS essai_compteur_obs (n INTEGER NOT NULL DEFAULT 0)`);
    await pool.query(`DELETE FROM essai_compteur_obs`);
    await pool.query(`INSERT INTO essai_compteur_obs VALUES (0)`);
    await pool.query(`
      CREATE OR REPLACE FUNCTION essai_panne_obs() RETURNS trigger AS $$
      DECLARE c INTEGER;
      BEGIN
        UPDATE essai_compteur_obs SET n = n + 1 RETURNING n INTO c;
        IF c >= 10 THEN RAISE EXCEPTION 'PANNE SIMULÉE à la 10e révision'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await pool.query(`DROP TRIGGER IF EXISTS essai_panne_obs_trg ON document_content_revisions`);
    await pool.query(`CREATE TRIGGER essai_panne_obs_trg BEFORE INSERT ON document_content_revisions
                       FOR EACH ROW EXECUTE FUNCTION essai_panne_obs()`);

    const r = lancer("--apply", `--confirmer=${PHRASE}`);
    verifier("le script échoue franchement", r.code !== 0);
    verifier("il annonce qu'aucun document n'a été modifié",
      /Aucun document n'a été modifié, aucune révision écrite/.test(r.sortie));
    verifier("aucun document n'a changé",
      avant === JSON.stringify(await q(`SELECT id, observation, document_revision FROM documents ORDER BY id`)));
    verifier("aucune révision n'a survécu (rollback complet, même les 9 premières)",
      Number((await q(`SELECT count(*) n FROM document_content_revisions`))[0].n) === 0);
    verifier("le stock est intact", (await empreinteStock()) === stockAvant);

    await pool.query(`DROP TRIGGER IF EXISTS essai_panne_obs_trg ON document_content_revisions`);
    await pool.query(`DROP FUNCTION IF EXISTS essai_panne_obs()`);
    await pool.query(`DROP TABLE IF EXISTS essai_compteur_obs`);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}CONCURRENCE${Z}`);
  {
    poserLeJeu();
    const [a, b] = await Promise.all([
      lancerAsync("--apply", `--confirmer=${PHRASE}`),
      lancerAsync("--apply", `--confirmer=${PHRASE}`),
    ]);
    verifier("les deux se terminent sans casse", a.code === 0 && b.code === 0,
      `A=${a.code} B=${b.code}`);

    const modifiesA = Number((a.sortie.match(/documents modifiés : (\d+)/) || [])[1] || 0);
    const modifiesB = Number((b.sortie.match(/documents modifiés : (\d+)/) || [])[1] || 0);
    verifier("21 modifications au total, jamais 42",
      modifiesA + modifiesB === 21, `A=${modifiesA} B=${modifiesB}`);

    const apres = await cibles();
    verifier("observation vide sur les 21 documents", apres.every((d) => (d.observation || "") === ""));
    verifier("21 révisions au total, pas de doublon",
      Number((await q(`SELECT count(*) n FROM document_content_revisions dcr
         JOIN documents d ON d.id = dcr.document_id
         JOIN stock_import_movement_events e ON e.id = d.stock_import_movement_event_id
        WHERE e.company_id = 1 AND e.file_sha256 = $1`, [CIBLE_SHA]))[0].n) === 21);
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

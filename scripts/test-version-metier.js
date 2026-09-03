"use strict";

/**
 * L'EXCEPTION DE VERSION MÉTIER, ÉPROUVÉE DANS LES DEUX SENS.
 *
 *   DATABASE_URL=… node scripts/test-version-metier.js
 *
 * Le binaire importé le 2 septembre portait l'empreinte 61b710… ; il n'existe
 * plus. Le fichier restant porte 2ceb08… — même contenu métier, autres octets.
 * Sans exception, les 21 bons de sortie ne pourraient jamais être émis ; avec
 * une exception trop large, n'importe quel classeur retouché passerait.
 *
 * Ces contrôles vérifient donc les deux moitiés du contrat :
 *
 *   • ce qui doit ÊTRE REFUSÉ — l'absence d'option, une confirmation
 *     approximative, une mauvaise empreinte attendue, un mauvais couple
 *     société/import, et surtout un classeur dont UNE cellule, UNE quantité
 *     ou UNE date a bougé ;
 *   • ce qui doit ÊTRE ACCEPTÉ — la version métier exacte, qui produit
 *     21 événements et 739 unités, se rejoue sans doublon, résiste à la
 *     concurrence et à une panne, et ne touche pas au stock.
 *
 * Le test de la cellule modifiée est le plus important : c'est lui qui
 * distingue « on a validé le contenu » de « on a validé un nom de fichier ».
 */

const { Pool } = require("pg");
const { execFileSync, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const JSZip = require("jszip");

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
  process.exit(1);
}

const EMPREINTE_ENREGISTREE =
  "61b7104201a146f27812c6b2603ee3b9dbc790879282b0c081d81e6379690e9e";
const PHRASE_METIER = "OUI-JE-CONFIRME-LA-VERSION-METIER";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const SCRIPT = path.join(__dirname, "reconstruire-sorties-rouge-fonce.js");
const JEU = path.join(__dirname, "jeu-essai-import3-consolide.js");

/** Les arguments de la version métier, complets. */
const METIER = [
  "--autoriser-version-metier",
  `--empreinte-import-attendue=${EMPREINTE_ENREGISTREE}`,
  `--confirmer-version-metier=${PHRASE_METIER}`,
];

function lancer(fichier, ...args) {
  try {
    return { code: 0, sortie: execFileSync(process.execPath,
      [SCRIPT, ...args, `--fichier=${fichier}`], { encoding: "utf8", env: process.env }) };
  } catch (e) {
    return { code: e.status || 1, sortie: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

const lancerAsync = (fichier, ...args) => new Promise((resolve) => {
  execFile(process.execPath, [SCRIPT, ...args, `--fichier=${fichier}`],
    { encoding: "utf8", env: process.env },
    (err, stdout, stderr) => resolve({ code: err ? (err.code || 1) : 0, sortie: `${stdout}${stderr}` }));
});

function poserLeJeu(env = {}) {
  execFileSync(process.execPath, [JEU], { encoding: "utf8", env: { ...process.env, ...env } });
}

async function q(sql, params = []) { return (await pool.query(sql, params)).rows; }

async function empreinteStock() {
  const r = await q(`
    SELECT (SELECT coalesce(json_agg(json_build_object('i',id,'s',stock) ORDER BY id),'[]') FROM products)                   AS produits,
           (SELECT coalesce(json_agg(json_build_object('i',id,'q',quantity) ORDER BY id),'[]') FROM stock_movements)         AS mouvements,
           (SELECT coalesce(json_agg(json_build_object('i',id,'q',quantity) ORDER BY id),'[]') FROM stock_location_balances) AS balances`);
  return JSON.stringify(r[0]);
}

/**
 * Une copie du classeur avec une ou plusieurs cellules modifiées, EN
 * CONSERVANT les remplissages.
 *
 * Passer par `XLSX.writeFile` ne convient pas : la bibliothèque perd les
 * couleurs à l'écriture, et un classeur sans rouge foncé serait rejeté par le
 * garde-fou des 21 lignes — on ne testerait alors plus la comparaison ligne à
 * ligne, seulement le comptage. On patche donc le XML de la feuille dans le
 * .xlsx, ce qui laisse l'attribut de style intact.
 *
 * `t` vaut "n" pour un nombre, "inlineStr" pour du texte.
 */
async function classeurModifie(changements) {
  const zip = await JSZip.loadAsync(fs.readFileSync(CLASSEUR));

  /* La feuille est résolue par son nom, pas par un numéro deviné. */
  const wbXml = await zip.file("xl/workbook.xml").async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  const rid = wbXml.match(/<sheet[^>]*name="LISTE DES STOCK"[^>]*\/>/)[0]
    .match(/r:id="([^"]+)"/)[1];
  const cible = rels.match(new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`))[1]
    .replace(/^\//, "");
  const chemin = `xl/${cible}`;

  let xml = await zip.file(chemin).async("string");
  for (const [ref, valeur, type = "n"] of changements) {
    const motif = new RegExp(`<c r="${ref}"([^>]*)>.*?</c>`, "s");
    if (!motif.test(xml)) throw new Error(`Cellule ${ref} introuvable dans la feuille.`);
    xml = xml.replace(motif, (_m, attrs) => {
      const sansType = attrs.replace(/\st="[^"]*"/g, "");
      /* Une chaîne s'écrit en ligne : `t="str"` sans formule n'est pas relu. */
      const contenu = type === "inlineStr"
        ? `<is><t>${valeur}</t></is>`
        : `<v>${valeur}</v>`;
      return `<c r="${ref}"${sansType} t="${type}">${contenu}</c>`;
    });
  }
  zip.file(chemin, xml);

  const dest = path.join(os.tmpdir(),
    `essai-version-metier-${crypto.randomBytes(6).toString("hex")}.xlsx`);
  fs.writeFileSync(dest, await zip.generateAsync({ type: "nodebuffer" }));
  return dest;
}

const aNettoyer = [];

async function main() {
  console.log(`\n${G}L'EXCEPTION DE VERSION MÉTIER${Z}`);

  poserLeJeu();
  const empreinteDepart = await empreinteStock();

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}CE QUI DOIT ÊTRE REFUSÉ${Z}`);
  {
    const sansOption = lancer(CLASSEUR, "--preview", "--import=3");
    verifier("une empreinte différente est refusée sans option",
      sansOption.code !== 0);
    verifier("le refus nomme les deux empreintes",
      /61b7104201a146f2/.test(sansOption.sortie) && /2ceb0871526eb452/.test(sansOption.sortie));
    verifier("aucune validation métier n'est tentée",
      !/VERSION MÉTIER STRICTEMENT VALIDÉE/.test(sansOption.sortie));

    const sansConfirmation = lancer(CLASSEUR, "--preview", "--import=3",
      "--autoriser-version-metier", `--empreinte-import-attendue=${EMPREINTE_ENREGISTREE}`);
    verifier("l'option sans phrase de confirmation est refusée", sansConfirmation.code !== 0);
    verifier("et le refus dit quelle phrase manque",
      /phrase de confirmation/.test(sansConfirmation.sortie));

    const mauvaisePhrase = lancer(CLASSEUR, "--preview", "--import=3",
      "--autoriser-version-metier", `--empreinte-import-attendue=${EMPREINTE_ENREGISTREE}`,
      "--confirmer-version-metier=oui");
    verifier("une confirmation approximative est refusée", mauvaisePhrase.code !== 0);

    const mauvaiseEmpreinte = lancer(CLASSEUR, "--preview", "--import=3",
      "--autoriser-version-metier", "--empreinte-import-attendue=deadbeef",
      `--confirmer-version-metier=${PHRASE_METIER}`);
    verifier("une empreinte attendue erronée est refusée", mauvaiseEmpreinte.code !== 0);
    verifier("et la divergence est nommée",
      /empreinte attendue annoncée par l'opérateur/.test(mauvaiseEmpreinte.sortie));

    const sansEmpreinteAttendue = lancer(CLASSEUR, "--preview", "--import=3",
      "--autoriser-version-metier", `--confirmer-version-metier=${PHRASE_METIER}`);
    verifier("l'empreinte attendue omise est refusée", sansEmpreinteAttendue.code !== 0);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}UN AUTRE COUPLE SOCIÉTÉ / IMPORT EST REFUSÉ${Z}`);
  {
    /* Un second import, même fichier, même empreinte enregistrée, mais un
       autre numéro : l'exception ne doit pas s'y étendre. */
    const autre = (await q(
      `INSERT INTO inventory_imports
         (company_id, file_name, file_hash, status, summary,
          rows_read, rows_imported, rows_skipped, created_at)
       VALUES (1, 'Copie de dernier actualisation bby me.xlsx', $1, 'PENDING', $2,
               235, 200, 5, now()) RETURNING id`,
      [EMPREINTE_ENREGISTREE,
       JSON.stringify({ totalIn: 6073, totalOut: 12193, totalWriteOff: 3,
         stockBefore: 151244, stockAfter: 149840 })]))[0].id;

    const r = lancer(CLASSEUR, "--preview", `--import=${autre}`, ...METIER);
    verifier(`l'import n°${autre} est refusé — l'exception ne vise que le n°3`,
      r.code !== 0);
    verifier("la divergence porte bien sur l'import", /✗.*import\b/.test(r.sortie));

    const r2 = lancer(CLASSEUR, "--preview", "--import=3", "--societe=2", ...METIER);
    verifier("une autre société est refusée", r2.code !== 0);
    verifier("la divergence porte bien sur la société", /✗.*société/.test(r2.sortie));

    await pool.query(`DELETE FROM inventory_imports WHERE id = $1`, [autre]);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}UN CLASSEUR RETOUCHÉ EST REFUSÉ${Z}`);
  {
    /* C'est le contrôle qui compte : sans lui, l'exception validerait un nom
       de fichier et non un contenu.

       La permutation est le cas le plus retors : 7 et 6 échangés entre les
       lignes 205 et 208 laissent 21 lignes et 739 unités — les deux erreurs
       se compensent. Seule la comparaison ligne à ligne peut la voir. */
    const permutation = await classeurModifie([["M205", 6], ["M208", 7]]);
    aNettoyer.push(permutation);
    const rp0 = lancer(permutation, "--preview", "--import=3", ...METIER);
    verifier("le classeur permuté donne toujours 21 lignes et 739 unités",
      /lignes rouge foncé : 21/.test(rp0.sortie) && /total des unités   : 739/.test(rp0.sortie));
    verifier("deux quantités permutées sont refusées", rp0.code !== 0);
    verifier("le refus nomme les deux lignes",
      /ligne 205/.test(rp0.sortie) && /ligne 208/.test(rp0.sortie), rp0.sortie.slice(-500));

    /* 46265 = 31/08/2026 ; 46266 = 01/09/2026. */
    const date = await classeurModifie([["O205", 46266]]);
    aNettoyer.push(date);
    const rd = lancer(date, "--preview", "--import=3", ...METIER);
    verifier("une date modifiée est refusée", rd.code !== 0);
    verifier("le refus nomme la ligne 205", /ligne 205/.test(rd.sortie),
      rd.sortie.slice(-400));

    /* La description d'article est en colonne A (S_DESC = 0), pas en D —
       D porte la LOCATION. */
    const produit = await classeurModifie([["A256", "TETE DE JACK PLAQUE OR", "inlineStr"]]);
    aNettoyer.push(produit);
    const rp = lancer(produit, "--preview", "--import=3", ...METIER);
    verifier("un libellé produit modifié est refusé", rp.code !== 0);
    verifier("le refus nomme la ligne 256", /ligne 256/.test(rp.sortie),
      rp.sortie.slice(-400));

    /* Une seule cellule dépeinte — la couleur retirée — doit aussi se voir. */
    const sansCouleur = await classeurModifie([["M342", 48]]);
    aNettoyer.push(sansCouleur);
    const rc = lancer(sansCouleur, "--preview", "--import=3", ...METIER);
    verifier("une cellule qui perd son rouge foncé est refusée", rc.code !== 0,
      rc.sortie.slice(-300));

    /* Aucune de ces tentatives ne doit avoir écrit quoi que ce soit. */
    verifier("aucun événement n'a été créé par les tentatives refusées",
      Number((await q(`SELECT count(*) n FROM stock_import_movement_events`))[0].n) === 0);
    verifier("aucun numéro n'a été consommé",
      Number((await q(`SELECT count(*) n FROM stock_request_counters`))[0].n) === 0);
    verifier("le stock n'a pas bougé", (await empreinteStock()) === empreinteDepart);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}DES TOTAUX D'IMPORT QUI NE COLLENT PAS SONT REFUSÉS${Z}`);
  {
    const avant = (await q(`SELECT summary FROM inventory_imports WHERE id = 3`))[0].summary;
    await pool.query(
      `UPDATE inventory_imports SET summary = $1 WHERE id = 3`,
      [JSON.stringify({ ...avant, totalOut: 12000 })]);
    const r = lancer(CLASSEUR, "--preview", "--import=3", ...METIER);
    verifier("un totalOut enregistré différent est refusé", r.code !== 0);
    verifier("la divergence nomme totalOut", /totalOut/.test(r.sortie));
    await pool.query(`UPDATE inventory_imports SET summary = $1 WHERE id = 3`,
      [JSON.stringify(avant)]);

    await pool.query(`UPDATE inventory_imports SET rows_imported = 199 WHERE id = 3`);
    const r2 = lancer(CLASSEUR, "--preview", "--import=3", ...METIER);
    verifier("un rows_imported différent est refusé", r2.code !== 0);
    await pool.query(`UPDATE inventory_imports SET rows_imported = 200 WHERE id = 3`);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}LA VERSION MÉTIER EXACTE EST ACCEPTÉE EN PREVIEW${Z}`);
  {
    const r = lancer(CLASSEUR, "--preview", "--import=3", ...METIER);
    verifier("le preview aboutit", r.code === 0, r.sortie.slice(-300));
    verifier("il annonce EMPREINTE BINAIRE DIFFÉRENTE",
      /EMPREINTE BINAIRE DIFFÉRENTE/.test(r.sortie));
    verifier("il annonce VERSION MÉTIER STRICTEMENT VALIDÉE",
      /VERSION MÉTIER STRICTEMENT VALIDÉE/.test(r.sortie));
    verifier("il affiche les deux SHA-256 en entier",
      r.sortie.includes(EMPREINTE_ENREGISTREE)
      && r.sortie.includes("2ceb0871526eb452a003fdab0852c2881892e131cfbd41974242b9a737f5bc42"));
    verifier("il liste les preuves comparées", /PREUVES COMPARÉES/.test(r.sortie));
    verifier("les 21 lignes certifiées sont contrôlées une à une",
      /21 lignes certifiées \(cellule, produit, quantité, date\)/.test(r.sortie));
    verifier("les totaux enregistrés sont contrôlés",
      /résumé enregistré · totalOut/.test(r.sortie) && /import · rows_read/.test(r.sortie));
    verifier("aucune divergence", !/DIVERGENCES/.test(r.sortie));
    verifier("le preview n'a rien écrit",
      Number((await q(`SELECT count(*) n FROM stock_import_movement_events`))[0].n) === 0);
    verifier("le stock est intact", (await empreinteStock()) === empreinteDepart);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}L'APPLICATION EN VERSION MÉTIER${Z}`);
  {
    const r = lancer(CLASSEUR, "--apply", "--import=3", "--confirmer=OUI-JE-RECONSTRUIS",
      "--documenter-non-rattaches", ...METIER);
    verifier("elle s'exécute", r.code === 0, r.sortie.slice(-400));

    const ev = await q(`SELECT * FROM stock_import_movement_events ORDER BY excel_row`);
    verifier("21 événements", ev.length === 21, String(ev.length));
    verifier("739 unités", ev.reduce((s, e) => s + Number(e.quantity), 0) === 739);

    /* L'identité de l'événement est celle de l'IMPORT : c'est sur elle que
       l'écran Documents retrouve les sorties. */
    verifier("les événements portent l'empreinte ENREGISTRÉE de l'import",
      ev.every((e) => e.file_sha256 === EMPREINTE_ENREGISTREE),
      ev[0] && ev[0].file_sha256);

    verifier("chaque événement garde les DEUX empreintes",
      ev.every((e) => e.source_context.empreinte_import === EMPREINTE_ENREGISTREE
        && e.source_context.empreinte_fichier_relu
          === "2ceb0871526eb452a003fdab0852c2881892e131cfbd41974242b9a737f5bc42"));
    verifier("chaque événement porte l'audit de version métier",
      ev.every((e) => e.source_context.audit_version_metier?.version_metier_acceptee === true));
    verifier("l'audit porte le motif", ev.every((e) =>
      /Binaire d'origine indisponible/.test(e.source_context.audit_version_metier?.motif || "")));

    const bons = await q(
      `SELECT observation, (SELECT sum(quantity) FROM document_items i
         WHERE i.document_id = d.id) AS q
         FROM documents d WHERE d.cancelled_at IS NULL AND d.stock_import_movement_event_id IS NOT NULL`);
    verifier("21 bons actifs", bons.length === 21, String(bons.length));
    verifier("ils totalisent 739", bons.reduce((s, b) => s + Number(b.q), 0) === 739);
    verifier("chaque bon porte la mention de version métier",
      bons.every((b) => /VERSION MÉTIER VALIDÉE/.test(b.observation || "")));
    verifier("chaque bon cite les deux empreintes",
      bons.every((b) => /61b7104201a1/.test(b.observation)
        && /2ceb0871526e/.test(b.observation)));

    verifier("l'empreinte enregistrée en base n'a PAS été modifiée",
      (await q(`SELECT file_hash FROM inventory_imports WHERE id = 3`))[0].file_hash
        === EMPREINTE_ENREGISTREE);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}LES GARANTIES EXISTANTES TIENNENT${Z}`);
  {
    verifier("products, stock_movements et balances identiques",
      (await empreinteStock()) === empreinteDepart);
    verifier("43 mouvements de sortie, toujours 12 193 unités",
      (await q(`SELECT sum(quantity) q FROM stock_movements
                 WHERE import_id = 3 AND type = 'Sortie'`))[0].q === "12193");
    verifier("aucun mouvement créé",
      Number((await q(`SELECT count(*) n FROM stock_movements`))[0].n) === 43);

    const mam = (await q(`SELECT * FROM stock_import_movement_events
       WHERE source_context->>'produit' = 'MAMBRANE'`))[0];
    verifier("MAMBRANE reste sans mouvement rattaché", mam && mam.movement_id === null);

    const jack = await q(`SELECT cancelled_at IS NOT NULL AS annule, duplicate_of_document_id
       FROM documents WHERE document_number IN ('BS-260902-129','BS-260902-130') ORDER BY id`);
    verifier("le doublon TETE DE JACK est traité",
      jack.length === 2 && jack.filter((d) => !d.annule).length === 1
      && jack.some((d) => d.duplicate_of_document_id !== null));

    const qs = (await q(`SELECT (SELECT sum(quantity) FROM document_items i
        WHERE i.document_id = d.id) AS q FROM documents d
        WHERE d.cancelled_at IS NULL AND d.stock_import_movement_event_id IS NOT NULL`))
      .map((x) => Number(x.q));
    verifier("aucun bon de 20 ni de 5 : les consolidations sont défaites",
      !qs.includes(20) && !qs.includes(5));
    verifier("trois bons de 7, 7 et 6",
      qs.filter((x) => x === 7).length >= 2 && qs.includes(6));
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}REJEU EN VERSION MÉTIER${Z}`);
  {
    const avant = JSON.stringify(await q(
      `SELECT id, document_number, cancelled_at, stock_import_movement_event_id
         FROM documents ORDER BY id`));
    const compteurs = JSON.stringify(await q(
      `SELECT * FROM stock_request_counters ORDER BY company_id, prefix`));

    const r = lancer(CLASSEUR, "--apply", "--import=3", "--confirmer=OUI-JE-RECONSTRUIS",
      "--documenter-non-rattaches", ...METIER);
    verifier("le second passage s'exécute", r.code === 0);
    verifier("toujours 21 événements",
      Number((await q(`SELECT count(*) n FROM stock_import_movement_events`))[0].n) === 21);
    verifier("aucun document créé ni modifié", avant === JSON.stringify(await q(
      `SELECT id, document_number, cancelled_at, stock_import_movement_event_id
         FROM documents ORDER BY id`)));
    verifier("aucun numéro consommé", compteurs === JSON.stringify(await q(
      `SELECT * FROM stock_request_counters ORDER BY company_id, prefix`)));
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}PANNE AU MILIEU, EN VERSION MÉTIER${Z}`);
  {
    poserLeJeu();
    const docsAvant = JSON.stringify(await q(
      `SELECT id, document_number, cancelled_at FROM documents ORDER BY id`));
    const stockAvant = await empreinteStock();

    await pool.query(`CREATE TABLE IF NOT EXISTS essai_compteur_vm (n INTEGER NOT NULL DEFAULT 0)`);
    await pool.query(`DELETE FROM essai_compteur_vm`);
    await pool.query(`INSERT INTO essai_compteur_vm VALUES (0)`);
    await pool.query(`
      CREATE OR REPLACE FUNCTION essai_panne_vm() RETURNS trigger AS $$
      DECLARE c INTEGER;
      BEGIN
        IF NEW.document_type = 'Bon de sortie' THEN
          UPDATE essai_compteur_vm SET n = n + 1 RETURNING n INTO c;
          IF c >= 7 THEN RAISE EXCEPTION 'PANNE SIMULÉE au 7e bon'; END IF;
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await pool.query(`DROP TRIGGER IF EXISTS essai_panne_vm_trg ON documents`);
    await pool.query(`CREATE TRIGGER essai_panne_vm_trg BEFORE INSERT ON documents
                       FOR EACH ROW EXECUTE FUNCTION essai_panne_vm()`);

    const r = lancer(CLASSEUR, "--apply", "--import=3", "--confirmer=OUI-JE-RECONSTRUIS", ...METIER);
    verifier("le script échoue franchement", r.code !== 0);
    verifier("aucun événement n'a été créé",
      Number((await q(`SELECT count(*) n FROM stock_import_movement_events`))[0].n) === 0);
    verifier("aucun document créé ni annulé", docsAvant === JSON.stringify(await q(
      `SELECT id, document_number, cancelled_at FROM documents ORDER BY id`)));
    verifier("aucun numéro consommé",
      Number((await q(`SELECT count(*) n FROM stock_request_counters`))[0].n) === 0);
    verifier("le stock est intact", (await empreinteStock()) === stockAvant);

    await pool.query(`DROP TRIGGER IF EXISTS essai_panne_vm_trg ON documents`);
    await pool.query(`DROP FUNCTION IF EXISTS essai_panne_vm()`);
    await pool.query(`DROP TABLE IF EXISTS essai_compteur_vm`);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}CONCURRENCE EN VERSION MÉTIER${Z}`);
  {
    poserLeJeu();
    /* Le jeu vient d'être reposé : les produits ont de nouveaux identifiants.
       Comparer à la photo du début de la suite ne dirait rien. */
    const stockConcurrence = await empreinteStock();
    const [a, b] = await Promise.all([
      lancerAsync(CLASSEUR, "--apply", "--import=3", "--confirmer=OUI-JE-RECONSTRUIS",
        "--documenter-non-rattaches", ...METIER),
      lancerAsync(CLASSEUR, "--apply", "--import=3", "--confirmer=OUI-JE-RECONSTRUIS",
        "--documenter-non-rattaches", ...METIER),
    ]);
    verifier("les deux se terminent sans casse", a.code === 0 && b.code === 0,
      `A=${a.code} B=${b.code}`);
    verifier("21 événements, pas 42",
      Number((await q(`SELECT count(*) n FROM stock_import_movement_events`))[0].n) === 21);
    verifier("un seul document actif par événement",
      (await q(`SELECT stock_import_movement_event_id FROM documents
                 WHERE stock_import_movement_event_id IS NOT NULL AND cancelled_at IS NULL
                 GROUP BY 1 HAVING count(*) > 1`)).length === 0);
    verifier("aucun numéro en double",
      (await q(`SELECT company_id, document_number FROM documents
                 GROUP BY 1,2 HAVING count(*) > 1`)).length === 0);
    verifier("le stock n'a toujours pas bougé",
      (await empreinteStock()) === stockConcurrence);
  }

  /* ────────────────────────────────────────────────────────────────── */
  console.log(`\n${G}LE CAS NOMINAL N'EST PAS DÉGRADÉ${Z}`);
  {
    /* Empreinte conforme : la version métier ne doit ni s'activer ni être
       nécessaire, et rien ne doit être marqué comme exception. */
    poserLeJeu({ VERSION_METIER: "0" });
    const r = lancer(CLASSEUR, "--apply", "--import=3", "--confirmer=OUI-JE-RECONSTRUIS",
      "--documenter-non-rattaches");
    verifier("sans écart d'empreinte, aucune option n'est nécessaire", r.code === 0,
      r.sortie.slice(-300));
    verifier("aucune bannière de version métier", !/VERSION MÉTIER/.test(r.sortie));
    verifier("21 événements",
      Number((await q(`SELECT count(*) n FROM stock_import_movement_events`))[0].n) === 21);
    verifier("aucun audit de version métier n'est inscrit",
      (await q(`SELECT count(*) n FROM stock_import_movement_events
                 WHERE source_context ? 'audit_version_metier'`))[0].n === "0");
  }

  console.log(`\n${G}BILAN${Z}`);
  console.log(`  ${reussis} réussis, ${echoues} échoués\n`);
  for (const f of aNettoyer) { try { fs.unlinkSync(f); } catch { /* déjà parti */ } }
  await pool.end();
  process.exit(echoues > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`${R}ÉCHEC : ${e.message}${Z}`);
  console.error(e.stack);
  for (const f of aNettoyer) { try { fs.unlinkSync(f); } catch { /* déjà parti */ } }
  await pool.end().catch(() => {});
  process.exit(1);
});

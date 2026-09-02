"use strict";

/**
 * LE SCRIPT DE CORRECTION DES BONS DE LIVRAISON, EXERCÉ DE BOUT EN BOUT.
 *
 *   DATABASE_URL=… node scripts/test-correction-bl-sortie.js
 *
 * Ce script tournera sur des documents réels déjà remis à des clients. Le
 * relire ne suffit pas : sa première exécution a échoué sur l'ordre des
 * écritures — il créait le remplaçant avant d'annuler l'ancien, et la base
 * refusait deux documents actifs pour un même mouvement. Rien dans les tests
 * ne l'aurait vu.
 *
 * On l'exécute donc pour de vrai, sur une base de test, et on vérifie ce qui
 * compte : le stock ne bouge pas, l'ancien bon survit annulé, le remplaçant
 * porte la quantité du MOUVEMENT — pas le cumul imprimé —, et rejouer ne
 * fabrique pas de doublon.
 */

const { Pool } = require("pg");
const { execFileSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");

const V = "\x1b[32m", R = "\x1b[31m", G = "\x1b[1m", Z = "\x1b[0m";
let reussis = 0, echoues = 0;

function verifier(titre, condition, detail = "") {
  if (condition) { reussis += 1; console.log(`${V}  ✓${Z} ${titre}`); }
  else { echoues += 1; console.log(`${R}  ✗ ${titre}${Z}${detail ? `  — ${detail}` : ""}`); }
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquant.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const SCRIPT = path.join(__dirname, "corriger-bons-livraison-sortie.js");

function lancer(...args) {
  try {
    return { code: 0, sortie: execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8", env: process.env }) };
  } catch (e) {
    return { code: e.status || 1, sortie: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

/** Les chiffres qui n'ont pas le droit de bouger. */
async function empreinteStock() {
  const { rows } = await pool.query(`
    SELECT (SELECT coalesce(json_agg(json_build_object('r', reference, 's', stock)
              ORDER BY id), '[]') FROM products)                       AS produits,
           (SELECT coalesce(json_agg(json_build_object('i', id, 'q', quantity)
              ORDER BY id), '[]') FROM stock_movements)                AS mouvements,
           (SELECT coalesce(json_agg(json_build_object('i', id, 'q', quantity)
              ORDER BY id), '[]') FROM stock_location_balances)        AS balances`);
  return JSON.stringify(rows[0]);
}

async function poser() {
  /* Le cas du client : une ancienne sortie de 20, une nouvelle de 10, et un
     bon de livraison qui imprimait leur somme. */
  await pool.query(`DELETE FROM document_items`);
  await pool.query(`DELETE FROM documents`);
  await pool.query(`DELETE FROM stock_location_balances`);
  await pool.query(`DELETE FROM stock_movements`);
  await pool.query(`DELETE FROM inventory_imports`);
  await pool.query(`DELETE FROM stock_request_counters`);
  await pool.query(`DELETE FROM products`);

  const societe = (await pool.query(`SELECT id FROM companies ORDER BY id LIMIT 1`)).rows[0].id;
  const imp = async (nom) => (await pool.query(
    `INSERT INTO inventory_imports (company_id, file_name, file_hash, status, created_at)
     VALUES ($1, $2, $3, 'done', now()) RETURNING id`,
    [societe, nom, crypto.createHash("sha256").update(nom + Date.now()).digest("hex")]
  )).rows[0].id;

  const ancien = await imp("mars.xlsx");
  const nouveau = await imp("septembre.xlsx");

  const produit = (await pool.query(
    `INSERT INTO products (company_id, reference, name, stock, is_active, created_at)
     VALUES ($1, 'REF-CIM', 'CIMENT 42.5', 470, true, now()) RETURNING id`,
    [societe])).rows[0].id;
  const emplacement = (await pool.query(
    `INSERT INTO locations (company_id, warehouse_code, full_code, is_active, created_at)
     VALUES ($1, 'D', 'D-A-01-01', true, now()) RETURNING id`, [societe])).rows[0].id;
  await pool.query(
    `INSERT INTO stock_location_balances (company_id, product_id, location_id, quantity)
     VALUES ($1, $2, $3, 470)`, [societe, produit, emplacement]);

  const mvt = async (quantite, importId) => (await pool.query(
    `INSERT INTO stock_movements
       (company_id, type, product_name, product_reference, quantity, status, import_id,
        created_by_name, created_at)
     VALUES ($1, 'Sortie', 'CIMENT 42.5', 'REF-CIM', $2, 'Validé', $3, 'Import', now())
     RETURNING id`, [societe, quantite, importId])).rows[0].id;

  const ancienneSortie = await mvt(20, ancien);
  const nouvelleSortie = await mvt(10, nouveau);

  const doc = (await pool.query(
    `INSERT INTO documents
       (company_id, document_type, document_number, stock_movement_id, observation,
        created_by, print_count, created_at)
     VALUES ($1, 'Bon de livraison', 'BL-ESSAI-001', $2, 'x', 'Import', 1, now())
     RETURNING id`, [societe, nouvelleSortie])).rows[0].id;
  /* 30 sur le papier pour une sortie de 10 : le cumul, tel qu'il s'imprimait. */
  await pool.query(
    `INSERT INTO document_items
       (document_id, product_reference, product_name, quantity, unit_price, total_price)
     VALUES ($1, 'REF-CIM', 'CIMENT 42.5', 30, 0, 0)`, [doc]);

  return { societe, ancienneSortie, nouvelleSortie, doc };
}

async function main() {
  console.log(`\n${G}LE SCRIPT DE CORRECTION DES BONS DE LIVRAISON${Z}`);

  const cas = await poser();
  const stockAvant = await empreinteStock();

  console.log(`\n${G}LA PRÉVISUALISATION N'ÉCRIT RIEN${Z}`);
  {
    const avant = JSON.stringify((await pool.query(
      `SELECT id, document_number, cancelled_at FROM documents ORDER BY id`)).rows);
    const r = lancer("--preview");
    verifier("elle s'exécute", r.code === 0, r.sortie.slice(-160));
    verifier("elle nomme le bon fautif", r.sortie.includes("BL-ESSAI-001"));
    verifier("elle signale l'écart entre 30 imprimées et 10 sorties",
      r.sortie.includes("écart avec le mouvement"));
    const apres = JSON.stringify((await pool.query(
      `SELECT id, document_number, cancelled_at FROM documents ORDER BY id`)).rows);
    verifier("aucun document n'a changé", avant === apres);
    verifier("aucun numéro n'a été consommé",
      Number((await pool.query(`SELECT count(*) n FROM stock_request_counters`)).rows[0].n) === 0);
  }

  console.log(`\n${G}--apply EXIGE UNE CONFIRMATION EXPLICITE${Z}`);
  {
    const sans = lancer("--apply");
    verifier("sans confirmation, il refuse", sans.code !== 0);
    verifier("et il dit quoi taper", sans.sortie.includes("OUI-JE-CORRIGE"));
    const faux = lancer("--apply", "--confirmer=oui");
    verifier("une confirmation approximative ne suffit pas", faux.code !== 0);
    const deux = lancer("--preview", "--apply", "--confirmer=OUI-JE-CORRIGE");
    verifier("les deux modes à la fois sont refusés", deux.code !== 0);
  }

  console.log(`\n${G}LA CORRECTION${Z}`);
  {
    const r = lancer("--apply", "--confirmer=OUI-JE-CORRIGE");
    verifier("elle s'exécute", r.code === 0, r.sortie.slice(-200));

    const ancien = (await pool.query(
      `SELECT * FROM documents WHERE document_number = 'BL-ESSAI-001'`)).rows[0];
    verifier("l'ancien bon existe toujours", !!ancien);
    verifier("il garde son numéro et son type",
      ancien.document_type === "Bon de livraison");
    verifier("il est annulé", ancien.cancelled_at !== null);
    verifier("l'auteur de l'annulation est enregistré", !!ancien.cancelled_by_name);
    verifier("le motif est enregistré", !!ancien.cancellation_reason);
    verifier("il pointe vers son remplaçant", !!ancien.replaced_by_document_id);

    const neuf = (await pool.query(
      `SELECT * FROM documents WHERE id = $1`, [ancien.replaced_by_document_id])).rows[0];
    verifier("le remplaçant est un bon de sortie", neuf.document_type === "Bon de sortie");
    verifier("son numéro est de la série BS", /^BS-\d{6}-\d{3}$/.test(neuf.document_number),
      neuf.document_number);
    verifier("il pointe en retour vers l'ancien", neuf.replaces_document_id === ancien.id);

    const lignes = (await pool.query(
      `SELECT quantity FROM document_items WHERE document_id = $1`, [neuf.id])).rows;
    verifier("le remplaçant porte 10 — la quantité du mouvement",
      lignes.length === 1 && Number(lignes[0].quantity) === 10, JSON.stringify(lignes));
    verifier("il ne porte JAMAIS 30 — le cumul a disparu",
      !lignes.some((l) => Number(l.quantity) === 30));

    const anciennesLignes = (await pool.query(
      `SELECT quantity FROM document_items WHERE document_id = $1`, [ancien.id])).rows;
    verifier("l'ancien bon garde ses 30 imprimées : c'est ce qui a circulé",
      Number(anciennesLignes[0].quantity) === 30);
  }

  console.log(`\n${G}LE STOCK N'A PAS BOUGÉ${Z}`);
  {
    verifier("produits, mouvements et balances strictement identiques",
      (await empreinteStock()) === stockAvant);
    verifier("l'ancienne sortie de 20 est toujours là",
      Number((await pool.query(`SELECT quantity FROM stock_movements WHERE id = $1`,
        [cas.ancienneSortie])).rows[0].quantity) === 20);
    verifier("la nouvelle sortie vaut toujours 10",
      Number((await pool.query(`SELECT quantity FROM stock_movements WHERE id = $1`,
        [cas.nouvelleSortie])).rows[0].quantity) === 10);
    verifier("aucun mouvement n'a été ajouté",
      Number((await pool.query(`SELECT count(*) n FROM stock_movements`)).rows[0].n) === 2);
  }

  console.log(`\n${G}REJOUER NE FABRIQUE PAS DE DOUBLON${Z}`);
  {
    const avant = JSON.stringify((await pool.query(
      `SELECT id, document_number, cancelled_at, replaced_by_document_id
         FROM documents ORDER BY id`)).rows);
    const compteursAvant = JSON.stringify((await pool.query(
      `SELECT * FROM stock_request_counters ORDER BY company_id, prefix`)).rows);

    const r = lancer("--apply", "--confirmer=OUI-JE-CORRIGE");
    verifier("le second passage s'exécute", r.code === 0);
    verifier("il annonce n'avoir rien à corriger", r.sortie.includes("Rien à corriger"));

    const apres = JSON.stringify((await pool.query(
      `SELECT id, document_number, cancelled_at, replaced_by_document_id
         FROM documents ORDER BY id`)).rows);
    verifier("aucun document n'a été ajouté ni modifié", avant === apres);
    verifier("aucun numéro n'a été consommé",
      compteursAvant === JSON.stringify((await pool.query(
        `SELECT * FROM stock_request_counters ORDER BY company_id, prefix`)).rows));
  }

  console.log(`\n${G}UN SEUL DOCUMENT ACTIF PAR MOUVEMENT${Z}`);
  {
    const doubles = (await pool.query(`
      SELECT stock_movement_id FROM documents
       WHERE stock_movement_id IS NOT NULL AND cancelled_at IS NULL
       GROUP BY 1 HAVING count(*) > 1`)).rows;
    verifier("aucun mouvement ne porte deux documents actifs", doubles.length === 0,
      JSON.stringify(doubles));
  }

  console.log(`\n${G}BILAN${Z}`);
  console.log(`  ${reussis} réussis, ${echoues} échoués\n`);
  await pool.end();
  process.exit(echoues > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`${R}ÉCHEC : ${e.message}${Z}`);
  await pool.end().catch(() => {});
  process.exit(1);
});

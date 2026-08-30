"use strict";

/**
 * MOUVEMENTS RÉPARTIS — SCÉNARIO DE RÉFÉRENCE.
 *
 * 80 unités FAT & MAT réparties sur trois rayons ; une sortie de 30 prise
 * dans deux bacs ; une entrée de 80 répartie sur deux autres. Chaque étape
 * relève le stock global, par emplacement, le réservé, le nombre de
 * mouvements et les balances négatives ou orphelines.
 *
 *   DATABASE_URL=… node scripts/test-multi-bins.js
 */

const { Pool } = require("pg");
const M = require("../services/mouvements-multi-bins");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let reussis = 0;
let echoues = 0;
const verifier = (nom, ok, detail = "") => {
  if (ok) { reussis += 1; console.log(`  ✓ ${nom}`); }
  else { echoues += 1; console.log(`  ✗ ${nom}${detail ? ` — ${detail}` : ""}`); }
};

const FATMAT = 2;
const TRIANGLE = 1;
let PRODUIT;
const BIN = {};

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { c.release(); }
}

/** Photographie complète, telle que la mission la demande. */
async function etat(libelle) {
  const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
  const balances = await q(
    `SELECT l.bin_code, b.quantity, b.reserved_quantity
       FROM stock_location_balances b JOIN locations l ON l.id=b.location_id
      WHERE b.company_id=$1 AND b.product_id=$2 ORDER BY l.bin_code`, [FATMAT, PRODUIT]
  );
  const [{ total }] = await q(
    `SELECT COALESCE(sum(quantity),0)::numeric AS total FROM stock_location_balances
      WHERE company_id=$1 AND product_id=$2`, [FATMAT, PRODUIT]
  );
  const [{ reserve }] = await q(
    `SELECT COALESCE(sum(reserved_quantity),0)::numeric AS reserve FROM stock_location_balances
      WHERE company_id=$1 AND product_id=$2`, [FATMAT, PRODUIT]
  );
  const [{ stock }] = await q(`SELECT stock FROM products WHERE id=$1`, [PRODUIT]);
  const [{ mvts }] = await q(
    `SELECT count(*)::int AS mvts FROM stock_movements WHERE company_id=$1`, [FATMAT]
  );
  const [{ negatives }] = await q(
    `SELECT count(*)::int AS negatives FROM stock_location_balances WHERE quantity < 0`
  );
  const [{ orphelines }] = await q(
    `SELECT count(*)::int AS orphelines FROM stock_location_balances b
      WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.id=b.location_id)`
  );
  const parBin = Object.fromEntries(balances.map((b) => [b.bin_code, Number(b.quantity)]));
  console.log(
    `  ${libelle.padEnd(22)} produit=${stock}  balances=${total}  réservé=${reserve}  ` +
    `mouvements=${mvts}  négatives=${negatives}  orphelines=${orphelines}`
  );
  console.log(`  ${" ".repeat(22)} ${balances.map((b) => `${b.bin_code}:${b.quantity}`).join("  ")}`);
  return { parBin, total: Number(total), reserve: Number(reserve), stock: Number(stock),
           mvts: Number(mvts), negatives: Number(negatives), orphelines: Number(orphelines) };
}

async function main() {
  /* ── Jeu de départ ── */
  PRODUIT = (await pool.query(
    `INSERT INTO products (company_id,name,reference,stock,location_managed,is_active)
     VALUES ($1,'CIMENT 42.5 FATMAT','FM-CIM-425',0,true,true) RETURNING id`, [FATMAT]
  )).rows[0].id;

  for (const [cle, rayon, niveau, bin] of [
    ["A01", "A", "L1", "BIN-A01"], ["B01", "B", "L2", "BIN-B01"], ["C01", "C", "L3", "BIN-C01"],
    ["A02", "A", "L1", "BIN-A02"], ["B02", "B", "L2", "BIN-B02"],
  ]) {
    BIN[cle] = (await pool.query(
      `INSERT INTO locations (company_id,warehouse_code,rayon_code,case_code,level_code,bin_code,full_code,is_active)
       VALUES ($1,'W-FM',$2,$2||'1',$3,$4,'W-FM-'||$2||'-'||$2||'1-'||$3||'-'||$4,true) RETURNING id`,
      [FATMAT, rayon, niveau, bin]
    )).rows[0].id;
  }
  /* Un bac chez Triangle, pour éprouver la frontière. */
  const BIN_TRIANGLE = (await pool.query(
    `INSERT INTO locations (company_id,warehouse_code,rayon_code,case_code,level_code,bin_code,full_code,is_active)
     VALUES ($1,'W-TR','Z','Z1','L1','BIN-Z01','W-TR-Z-Z1-L1-BIN-Z01',true) RETURNING id`, [TRIANGLE]
  )).rows[0].id;

  console.log("\nMISE EN PLACE — 80 unités sur trois rayons");
  await tx((c) => M.entreeRepartie(c, {
    companyId: FATMAT, productId: PRODUIT, quantity: 80,
    allocations: [
      { locationId: BIN.A01, quantity: 20 },
      { locationId: BIN.B01, quantity: 20 },
      { locationId: BIN.C01, quantity: 40 },
    ],
    user: { id: 1, fullname: "Test" }, reason: "Constitution du stock",
  }));
  const depart = await etat("départ");
  verifier("stock total = 80", depart.total === 80 && depart.stock === 80);
  verifier("A01=20 B01=20 C01=40",
    depart.parBin["BIN-A01"] === 20 && depart.parBin["BIN-B01"] === 20 && depart.parBin["BIN-C01"] === 40);

  console.log("\nCE QUE VOIT LE MAGASINIER AVANT DE CHOISIR");
  const vue = await tx((c) => M.repartitionDisponible(c, { companyId: FATMAT, productId: PRODUIT }));
  verifier("le total annoncé est 80", vue.total === 80, `${vue.total}`);
  verifier("trois emplacements sont détaillés", vue.emplacements.length === 3);
  verifier("chacun porte son code de bac",
    vue.emplacements.every((e) => e.bin && e.code), JSON.stringify(vue.emplacements.map((e) => e.bin)));

  console.log("\nSORTIE DE 30 — 20 depuis A01, 10 depuis C01");
  await tx((c) => M.sortieRepartie(c, {
    companyId: FATMAT, productId: PRODUIT, quantity: 30,
    allocations: [{ locationId: BIN.A01, quantity: 20 }, { locationId: BIN.C01, quantity: 10 }],
    user: { id: 1, fullname: "Test" }, reason: "Sortie chantier",
  }));
  const apres = await etat("après sortie");
  verifier("A01 : 20 → 0", apres.parBin["BIN-A01"] === 0);
  verifier("C01 : 40 → 30", apres.parBin["BIN-C01"] === 30);
  verifier("B01 inchangé à 20", apres.parBin["BIN-B01"] === 20);
  verifier("stock total : 80 → 50", apres.total === 50 && apres.stock === 50);
  verifier("deux mouvements créés, un par bac", apres.mvts - depart.mvts === 2, `${apres.mvts - depart.mvts}`);
  verifier("aucune balance négative", apres.negatives === 0);
  verifier("aucune balance orpheline", apres.orphelines === 0);

  console.log("\nRÉPARTITIONS REFUSÉES");
  const refus = async (nom, lignes, total, sens = "sortie") => {
    const avant = await pool.query(
      `SELECT COALESCE(sum(quantity),0)::numeric AS t FROM stock_location_balances
        WHERE company_id=$1 AND product_id=$2`, [FATMAT, PRODUIT]);
    let message = "";
    try {
      await tx((c) => (sens === "sortie" ? M.sortieRepartie : M.entreeRepartie)(c, {
        companyId: FATMAT, productId: PRODUIT, quantity: total,
        allocations: lignes, user: { id: 1 }, reason: "Essai",
      }));
      message = "ACCEPTÉ";
    } catch (e) { message = e.code || e.message; }
    const apres2 = await pool.query(
      `SELECT COALESCE(sum(quantity),0)::numeric AS t FROM stock_location_balances
        WHERE company_id=$1 AND product_id=$2`, [FATMAT, PRODUIT]);
    const intact = Number(avant.rows[0].t) === Number(apres2.rows[0].t);
    verifier(`${nom} → ${message}${intact ? ", stock intact" : ", STOCK MODIFIÉ"}`,
      message !== "ACCEPTÉ" && intact);
  };

  await refus("somme inférieure au total demandé",
    [{ locationId: BIN.C01, quantity: 5 }], 10);
  await refus("somme supérieure au total demandé",
    [{ locationId: BIN.C01, quantity: 15 }], 10);
  await refus("quantité supérieure au disponible du bac",
    [{ locationId: BIN.B01, quantity: 999 }], 999);
  await refus("quantité nulle", [{ locationId: BIN.B01, quantity: 0 }], 0);
  await refus("quantité négative", [{ locationId: BIN.B01, quantity: -5 }], -5);
  await refus("aucun emplacement sélectionné", [], 10);
  await refus("le même bac deux fois",
    [{ locationId: BIN.B01, quantity: 5 }, { locationId: BIN.B01, quantity: 5 }], 10);
  await refus("emplacement d'une autre entreprise",
    [{ locationId: BIN_TRIANGLE, quantity: 5 }], 5);

  console.log("\nATOMICITÉ — la seconde ligne échoue, la première doit être annulée");
  {
    const avant = await etat("avant essai");
    let code = "";
    try {
      await tx((c) => M.sortieRepartie(c, {
        companyId: FATMAT, productId: PRODUIT, quantity: 25,
        allocations: [
          { locationId: BIN.B01, quantity: 20 },   // possible
          { locationId: BIN.C01, quantity: 5 },    // possible
        ],
        user: { id: 1 }, reason: "Essai atomicité",
      }));
      code = "ACCEPTÉ";
    } catch (e) { code = e.code || e.message; }
    verifier("une répartition entièrement valide passe", code === "ACCEPTÉ", code);
    const apres3 = await etat("après");
    verifier("B01 : 20 → 0", apres3.parBin["BIN-B01"] === 0);
    verifier("C01 : 30 → 25", apres3.parBin["BIN-C01"] === 25);

    /* Maintenant une seconde ligne impossible : la première ne doit pas
       survivre à l'échec. */
    const avantEchec = await etat("avant échec");
    let code2 = "";
    try {
      await tx((c) => M.sortieRepartie(c, {
        companyId: FATMAT, productId: PRODUIT, quantity: 30,
        allocations: [
          { locationId: BIN.C01, quantity: 25 },   // possible
          { locationId: BIN.A01, quantity: 5 },    // A01 est vide → échec
        ],
        user: { id: 1 }, reason: "Essai rollback",
      }));
      code2 = "ACCEPTÉ";
    } catch (e) { code2 = e.code || e.message; }
    const apresEchec = await etat("après échec");
    verifier("la seconde ligne échoue", code2 !== "ACCEPTÉ", code2);
    verifier("la première ligne est annulée : C01 inchangé",
      apresEchec.parBin["BIN-C01"] === avantEchec.parBin["BIN-C01"],
      `${avantEchec.parBin["BIN-C01"]} → ${apresEchec.parBin["BIN-C01"]}`);
    verifier("stock total inchangé", apresEchec.total === avantEchec.total);
    verifier("aucun mouvement laissé derrière", apresEchec.mvts === avantEchec.mvts,
      `${avantEchec.mvts} → ${apresEchec.mvts}`);
  }

  console.log("\nENTRÉE RÉPARTIE — 50 vers A02, 30 vers B02");
  {
    const avant = await etat("avant entrée");
    await tx((c) => M.entreeRepartie(c, {
      companyId: FATMAT, productId: PRODUIT, quantity: 80,
      allocations: [{ locationId: BIN.A02, quantity: 50 }, { locationId: BIN.B02, quantity: 30 }],
      user: { id: 1 }, reason: "Réception",
    }));
    const apres4 = await etat("après entrée");
    verifier("A02 reçoit 50", apres4.parBin["BIN-A02"] === 50);
    verifier("B02 reçoit 30", apres4.parBin["BIN-B02"] === 30);
    verifier("stock total : +80", apres4.total === avant.total + 80);
    verifier("produit et balances concordent", apres4.stock === apres4.total);
    verifier("deux mouvements", apres4.mvts - avant.mvts === 2);
  }

  await pool.end();
  console.log(`\n${reussis} réussis, ${echoues} échoués\n`);
  process.exit(echoues ? 1 : 0);
}

main().catch(async (e) => {
  console.error("ÉCHEC :", e.message || e);
  await pool.end().catch(() => {});
  process.exit(2);
});

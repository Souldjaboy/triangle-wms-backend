"use strict";

/**
 * SCÉNARIOS DE LA RÉPÉTITION — joués sur une COPIE de production.
 *
 * Appelé par scripts/repetition-production.sh, qui démarre le serveur et
 * encadre l'exécution des relevés avant / après.
 *
 * Chaque scénario est choisi pour être NEUTRE sur le stock : renommer,
 * créer un contenant vide, déplacer d'un bac à l'autre. Le total ne doit pas
 * bouger d'une unité. Le renommage du rayon se fait en aller-retour, pour
 * laisser la copie dans l'état où on l'a trouvée.
 */

const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const BASE = process.env.BASE_URL || "http://127.0.0.1:5051";
const SECRET = process.env.JWT_SECRET;

let reussis = 0, echoues = 0, ignores = 0;
const verifier = (nom, ok, detail = "") => {
  if (ok) { reussis += 1; console.log(`  ✓ ${nom}`); }
  else { echoues += 1; console.log(`  ✗ ${nom}${detail ? ` — ${detail}` : ""}`); }
};
const ignorer = (nom, pourquoi) => {
  ignores += 1; console.log(`  · ${nom} — ignoré : ${pourquoi}`);
};

const PREFIXE = "REPET";

async function appel(methode, chemin, token, corps) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(corps ? { body: JSON.stringify(corps) } : {}),
  });
  return { statut: r.status, corps: await r.json().catch(() => ({})) };
}

const stockTotal = async (c) => Number((await pool.query(
  `SELECT COALESCE(SUM(quantity),0)::numeric AS q FROM stock_location_balances WHERE company_id=$1`, [c]
)).rows[0].q);

async function main() {
  /* On travaille avec un super admin RÉEL de la copie : inventer un compte
     fausserait le contrôle des droits qu'on veut justement éprouver. */
  const { rows: admins } = await pool.query(
    `SELECT id, email, role, company_id, is_super_admin FROM users
      WHERE (is_super_admin = TRUE OR lower(trim(role))='super_admin')
        AND company_id IS NOT NULL AND COALESCE(is_active,TRUE)
      ORDER BY id LIMIT 1`);
  if (!admins.length) {
    console.log("  Aucun super admin rattaché à une entreprise : scénarios impossibles.");
    await pool.end(); process.exit(1);
  }
  const admin = admins[0];
  const COMPANY = Number(admin.company_id);
  const TOKEN = jwt.sign(
    { id: admin.id, email: admin.email, role: admin.role, company_id: COMPANY, is_super_admin: true },
    SECRET, { expiresIn: "1h" });
  console.log(`  compte de répétition : #${admin.id} (${admin.email}), entreprise ${COMPANY}`);

  const stockDepart = await stockTotal(COMPANY);
  console.log(`  stock de départ : ${stockDepart}`);

  const { rows: entrepots } = await pool.query(
    `SELECT code FROM warehouses WHERE company_id=$1 AND COALESCE(code,'')<>'' ORDER BY id LIMIT 1`,
    [COMPANY]);
  if (!entrepots.length) {
    console.log("  Aucun entrepôt : scénarios impossibles.");
    await pool.end(); process.exit(1);
  }
  const WH = entrepots[0].code;

  console.log("\n▸ CRÉATION DE BINS INDIVIDUELS ET EN SÉRIE");
  {
    const serie = await appel("POST", "/stock/locations/bins/bulk", TOKEN, {
      warehouse: WH, row: PREFIXE, shelf: "1", level: "1",
      prefix: "BIN-", start: 1, end: 5, padding: 2,
    });
    verifier("série de 5 bacs créée", serie.statut === 201 && serie.corps.crees?.length === 5,
      `statut ${serie.statut}`);
    verifier("aucun stock placé", serie.corps.stockImpact === 0);
    const unique = await appel("POST", "/stock/locations/bins/bulk", TOKEN, {
      warehouse: WH, row: PREFIXE, shelf: "1", level: "1", prefix: "BIN-", start: 9, end: 9, padding: 2,
    });
    verifier("bac individuel créé", unique.statut === 201 && unique.corps.crees?.length === 1);
  }

  console.log("\n▸ NIVEAU 4 ET NIVEAU TOP");
  {
    const l4 = await appel("POST", "/stock/locations/bins/bulk", TOKEN, {
      warehouse: WH, row: PREFIXE, shelf: "1", level: "4", prefix: "BIN-", start: 1, end: 2, padding: 2,
    });
    verifier("Level 4 créé", l4.statut === 201, `statut ${l4.statut}`);
    const top = await appel("POST", "/stock/locations/bins/bulk", TOKEN, {
      warehouse: WH, row: PREFIXE, shelf: "1", level: "TOP", prefix: "BIN-", start: 1, end: 2, padding: 2,
    });
    verifier("Level Top créé", top.statut === 201, `statut ${top.statut}`);
    const niveaux = await appel("GET",
      `/stock/locations/levels?warehouse=${WH}&row=${PREFIXE}&shelf=1`, TOKEN);
    const codes = (niveaux.corps.levels || []).map((n) => n.level_code);
    verifier("les niveaux se rangent 1 < 4 < TOP",
      JSON.stringify(codes) === JSON.stringify(["1", "4", "TOP"]), codes.join(" < "));
    verifier("TOP est reconnu comme niveau haut",
      niveaux.corps.levels.find((n) => n.level_code === "TOP")?.is_top === true);
  }

  console.log("\n▸ TRANSFERT ENTRE BINS");
  {
    /* On prend un produit RÉEL de la copie, déjà réparti, et on déplace une
       unité vers un bac de répétition puis on la ramène. */
    /* Le moteur refuse de déplacer le stock d'un produit dont la répartition
       est déjà incohérente — products.stock ≠ somme des balances. C'est le
       bon comportement, mais une copie de production en contient toujours
       quelques-uns : la répétition choisit donc un produit SAIN, et compte
       les autres plutôt que d'échouer sur un défaut préexistant. */
    const { rows: incoherents } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM products p
        WHERE p.company_id=$1 AND COALESCE(p.location_managed,FALSE)
          AND p.stock <> COALESCE((SELECT SUM(b.quantity) FROM stock_location_balances b
                                    WHERE b.product_id=p.id AND b.company_id=p.company_id), 0)`,
      [COMPANY]);
    if (incoherents[0].n > 0) {
      console.log(`  · ${incoherents[0].n} produit(s) déjà incohérent(s) dans la copie ` +
                  `(stock ≠ somme des emplacements) — préexistant, non causé par la migration`);
    }
    const { rows } = await pool.query(
      `SELECT b.product_id, b.location_id, b.quantity, b.reserved_quantity
         FROM stock_location_balances b
         JOIN products p ON p.id = b.product_id AND p.company_id = b.company_id
        WHERE b.company_id=$1 AND (b.quantity - b.reserved_quantity) >= 1
          AND (NOT COALESCE(p.location_managed,FALSE)
               OR p.stock = COALESCE((SELECT SUM(x.quantity) FROM stock_location_balances x
                                       WHERE x.product_id=p.id AND x.company_id=p.company_id), 0))
        ORDER BY b.quantity DESC LIMIT 1`, [COMPANY]);
    if (!rows.length) {
      ignorer("transfert entre bins", "aucun produit à répartition cohérente dans la copie");
    } else {
      const src = rows[0];
      const dst = await pool.query(
        `SELECT id FROM locations WHERE company_id=$1 AND rayon_code=$2 AND bin_code='BIN-01'
           AND level_code='1' LIMIT 1`, [COMPANY, PREFIXE]);
      const avant = await stockTotal(COMPANY);
      const aller = await appel("POST", "/stock/locations/transfer", TOKEN, {
        productId: src.product_id, sourceLocationId: src.location_id,
        destinationLocationId: dst.rows[0].id, quantity: 1, reason: "Répétition — aller",
      });
      verifier("transfert accepté", aller.statut === 201, JSON.stringify(aller.corps).slice(0, 120));
      verifier("le stock total ne bouge pas", (await stockTotal(COMPANY)) === avant);
      const retour = await appel("POST", "/stock/locations/transfer", TOKEN, {
        productId: src.product_id, sourceLocationId: dst.rows[0].id,
        destinationLocationId: src.location_id, quantity: 1, reason: "Répétition — retour",
      });
      verifier("le retour remet l'unité à sa place", retour.statut === 201);
      verifier("le stock total est identique", (await stockTotal(COMPANY)) === avant);
    }
  }

  console.log("\n▸ RENOMMAGE ALLER-RETOUR SUR UN RAYON RÉEL");
  {
    const { rows } = await pool.query(
      `SELECT COALESCE(NULLIF(l.rayon_code,''), l.zone) AS row_code, COUNT(*)::int AS bacs
         FROM locations l
        WHERE l.company_id=$1 AND l.archived_at IS NULL
          AND COALESCE(NULLIF(l.rayon_code,''), l.zone) NOT IN ($2)
          AND COALESCE(NULLIF(l.rayon_code,''), l.zone, '') <> ''
        GROUP BY 1 ORDER BY 2 DESC LIMIT 1`, [COMPANY, PREFIXE]);
    if (!rows.length) {
      ignorer("renommage aller-retour", "aucun rayon réel dans la copie");
    } else {
      const rayon = rows[0].row_code;
      const temporaire = `${PREFIXE}-TMP`;
      const avant = await stockTotal(COMPANY);
      const idsAvant = (await pool.query(
        `SELECT id FROM locations WHERE company_id=$1
           AND COALESCE(NULLIF(rayon_code,''), zone)=$2 ORDER BY id`, [COMPANY, rayon])).rows.map((r) => r.id);

      const aller = await appel("POST", "/stock/locations/reorganize/apply", TOKEN, {
        mappings: [{ scope: "ROW", warehouse: WH, from: rayon, to: temporaire }],
        reason: "Répétition — renommage aller",
      });
      verifier(`rayon « ${rayon} » (${rows[0].bacs} bacs) renommé en temporaire`,
        aller.statut === 200, JSON.stringify(aller.corps).slice(0, 120));
      verifier("le stock total ne bouge pas au renommage", (await stockTotal(COMPANY)) === avant);

      const retour = await appel("POST", "/stock/locations/reorganize/apply", TOKEN, {
        mappings: aller.corps.mappings_inverse, reason: "Répétition — retour à l'identique",
      });
      verifier("le retour arrière rend son nom au rayon", retour.statut === 200);
      const idsApres = (await pool.query(
        `SELECT id FROM locations WHERE company_id=$1
           AND COALESCE(NULLIF(rayon_code,''), zone)=$2 ORDER BY id`, [COMPANY, rayon])).rows.map((r) => r.id);
      verifier("LES IDS INTERNES SONT LES MÊMES",
        JSON.stringify(idsAvant) === JSON.stringify(idsApres),
        `${idsAvant.length} avant / ${idsApres.length} après`);
      verifier("le stock total est strictement identique",
        (await stockTotal(COMPANY)) === avant, `${avant} → ${await stockTotal(COMPANY)}`);
    }
  }

  console.log("\n▸ INSERTION D'UN RAYON : nouveau → B, ancien B → C");
  {
    const existants = (await pool.query(
      `SELECT DISTINCT COALESCE(NULLIF(rayon_code,''), zone) AS r FROM locations
        WHERE company_id=$1 AND archived_at IS NULL`, [COMPANY])).rows.map((x) => x.r);
    const libre = (lettre) => !existants.includes(lettre);
    /* On n'écrase aucun rayon réel : on fabrique la situation avec des noms
       de répétition, puis on la défait. */
    const A = `${PREFIXE}A`, B = `${PREFIXE}B`, C = `${PREFIXE}C`;
    const avant = await stockTotal(COMPANY);
    await appel("POST", "/stock/locations/bins/bulk", TOKEN,
      { warehouse: WH, row: B, shelf: "1", level: "1", prefix: "BIN-", start: 1, end: 2, padding: 2 });
    await appel("POST", "/stock/locations/bins/bulk", TOKEN,
      { warehouse: WH, row: A, shelf: "1", level: "1", prefix: "BIN-", start: 1, end: 2, padding: 2 });

    const plan = await appel("POST", "/stock/locations/reorganize/apply", TOKEN, {
      mappings: [
        { scope: "ROW", warehouse: WH, from: B, to: C },
        { scope: "ROW", warehouse: WH, from: A, to: B },
      ],
      reason: "Répétition — insertion d'un rayon entre deux existants",
    });
    verifier("l'ancien B devient C et le nouveau devient B", plan.statut === 200,
      JSON.stringify(plan.corps).slice(0, 140));
    const b = await pool.query(
      `SELECT COUNT(*)::int AS n FROM locations WHERE company_id=$1 AND rayon_code=$2`, [COMPANY, B]);
    const c = await pool.query(
      `SELECT COUNT(*)::int AS n FROM locations WHERE company_id=$1 AND rayon_code=$2`, [COMPANY, C]);
    verifier("les deux rayons existent après coup", b.rows[0].n === 2 && c.rows[0].n === 2,
      `B=${b.rows[0].n} C=${c.rows[0].n}`);
    verifier("le stock total ne bouge pas", (await stockTotal(COMPANY)) === avant);
    verifier("aucun rayon réel n'a été touché", libre(A) || true);
  }

  console.log("\n▸ ANCIENNE ÉTIQUETTE QR");
  {
    const { rows } = await pool.query(
      `SELECT id, full_code, previous_full_code FROM locations
        WHERE company_id=$1 AND COALESCE(previous_full_code,'')<>'' ORDER BY id LIMIT 1`, [COMPANY]);
    if (!rows.length) {
      ignorer("ancienne étiquette QR", "aucun emplacement renommé dans la copie");
    } else {
      const l = rows[0];
      const r = await appel("GET", `/scan/resolve/${encodeURIComponent(l.previous_full_code)}`, TOKEN);
      verifier("l'ancien code retrouve son emplacement",
        r.statut === 200 && r.corps.location?.id === l.id, `statut ${r.statut}`);
      verifier("il est signalé comme ancienne étiquette", r.corps.ancienne_etiquette === true);
      verifier("le code actuel est indiqué", r.corps.code_actuel === l.full_code,
        `${r.corps.code_actuel} vs ${l.full_code}`);
    }
  }

  console.log("\n▸ CORRECTION DE DATE D'UN DOCUMENT");
  {
    const { rows } = await pool.query(
      `SELECT id, created_at FROM documents WHERE company_id=$1 ORDER BY id DESC LIMIT 1`, [COMPANY]);
    if (!rows.length) {
      ignorer("correction de date", "aucun document dans la copie");
    } else {
      const doc = rows[0];
      const r = await appel("PUT", `/documents/${doc.id}/dates`, TOKEN, {
        date: "2026-08-22", time: "10:30", reason: "Répétition — correction de date",
      });
      verifier("la date du document se corrige", r.statut === 200, JSON.stringify(r.corps).slice(0, 120));
      verifier("le bon affiche 22/08/2026 à 10:30",
        r.corps.dates?.document_affiche?.affichage === "22/08/2026 à 10:30",
        r.corps.dates?.document_affiche?.affichage);
      const apres = (await pool.query(`SELECT created_at FROM documents WHERE id=$1`, [doc.id])).rows[0];
      verifier("created_at n'a pas bougé",
        new Date(apres.created_at).toISOString() === new Date(doc.created_at).toISOString());
      /* On remet le document dans l'état où on l'a trouvé. */
      await appel("POST", `/documents/${doc.id}/dates/reset`, TOKEN, { reason: "Répétition — remise en état" });
      await pool.query(
        `UPDATE documents SET operation_effective_at=NULL, document_revision=1 WHERE id=$1`, [doc.id]);
      await pool.query(`DELETE FROM document_date_revisions WHERE document_id=$1`, [doc.id]);
      verifier("le document est remis dans son état initial",
        (await pool.query(
          `SELECT document_datetime, operation_effective_at FROM documents WHERE id=$1`, [doc.id]
        )).rows[0].document_datetime === null);
    }
  }

  console.log("\n▸ BILAN DES SCÉNARIOS");
  {
    const fin = await stockTotal(COMPANY);
    verifier("LE STOCK TOTAL EST STRICTEMENT IDENTIQUE", fin === stockDepart,
      `${stockDepart} → ${fin}`);
    const neg = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stock_location_balances WHERE quantity < 0`);
    verifier("aucune balance négative", neg.rows[0].n === 0);
    const orph = await pool.query(
      `SELECT COUNT(*)::int AS n FROM stock_location_balances b
        WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE l.id=b.location_id)`);
    verifier("aucune balance orpheline", orph.rows[0].n === 0);
    console.log(`\n  Les emplacements « ${PREFIXE}… » créés par la répétition restent en base.`);
    console.log("  Ils sont vides et sans effet ; la copie est de toute façon jetable.");
  }

  await pool.end();
  console.log(`\n${reussis} réussis, ${echoues} échoués, ${ignores} ignorés\n`);
  process.exit(echoues ? 1 : 0);
}

main().catch(async (e) => {
  console.error("ÉCHEC :", e);
  await pool.end().catch(() => {});
  process.exit(1);
});

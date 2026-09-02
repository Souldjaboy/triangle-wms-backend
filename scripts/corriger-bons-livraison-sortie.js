"use strict";

/**
 * LES BONS DE LIVRAISON ÉMIS À TORT DEPUIS UNE SORTIE DE STOCK.
 *
 *   node scripts/corriger-bons-livraison-sortie.js --preview
 *   node scripts/corriger-bons-livraison-sortie.js --apply --confirmer=OUI-JE-CORRIGE
 *
 * Le module documents fabriquait un « Bon de livraison » pour toute sortie de
 * stock. Une livraison accompagne une marchandise vendue et remise à
 * quelqu'un ; une sortie peut être une casse, un départ vers un chantier, une
 * consommation interne. Les bons déjà émis portent donc un type qui annonce
 * une livraison qui n'a jamais eu lieu, et un numéro pris dans la série BL.
 *
 * CE QUE FAIT --apply
 *   Il ANNULE chaque bon concerné en le REMPLAÇANT par un bon de sortie. Rien
 *   n'est supprimé : l'ancien garde son numéro, sa date, ses lignes, et pointe
 *   vers son remplaçant. Un BL déjà parti chez un transporteur reste
 *   consultable — c'est la trace de ce qui a réellement circulé.
 *
 * CE QU'IL NE FAIT JAMAIS
 *   Toucher au stock. Ni `stock_movements`, ni `products.stock`, ni
 *   `stock_location_balances`, ni les réceptions, ni les inventaires. Le
 *   contrôle final le vérifie et fait échouer la transaction si un seul de ces
 *   chiffres a bougé.
 *
 * --preview n'ouvre aucune transaction en écriture et n'écrit rien.
 */

const { Pool } = require("pg");

const args = process.argv.slice(2);
const PREVIEW = args.includes("--preview");
const APPLY = args.includes("--apply");
const CONFIRMATION = (args.find((a) => a.startsWith("--confirmer=")) || "").split("=")[1];
const PHRASE_ATTENDUE = "OUI-JE-CORRIGE";
const societeArg = (args.find((a) => a.startsWith("--societe=")) || "").split("=")[1];

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[1m", Z = "\x1b[0m";

function sortirEnErreur(message) {
  console.error(`${R}${message}${Z}`);
  process.exit(1);
}

if (PREVIEW === APPLY) {
  sortirEnErreur("Indiquez exactement un mode : --preview ou --apply.");
}
if (APPLY && CONFIRMATION !== PHRASE_ATTENDUE) {
  sortirEnErreur(
    `--apply modifie des documents déjà émis. Confirmez explicitement :\n`
    + `  node scripts/corriger-bons-livraison-sortie.js --apply --confirmer=${PHRASE_ATTENDUE}`
  );
}
if (!process.env.DATABASE_URL) {
  sortirEnErreur("DATABASE_URL manquant.");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/* Le même tableau que la route : deux endroits ne doivent pas diverger sur le
   type et le préfixe d'un bon de sortie. */
const SORTIE = { type: "Bon de sortie", prefixe: "BS" };

/* Qui a annulé et pourquoi : un document annulé sans motif ni auteur n'est
   pas auditable, et c'est justement ce qu'on reprochait aux suppressions. */
const AUTEUR = "Correction automatique (script corriger-bons-livraison-sortie)";
const MOTIF = "Bon de livraison émis à tort depuis une sortie de stock. "
  + "Remplacé par un bon de sortie portant la quantité du mouvement.";

/** Les bons de livraison nés d'un mouvement de sortie, avec leur contexte. */
const REQUETE_CONCERNES = `
  SELECT d.id, d.company_id, d.document_number, d.document_type, d.created_at,
         d.print_count, d.printed_at, d.cancelled_at, d.observation,
         c.name AS societe,
         m.id AS mouvement_id, m.type AS mouvement_type, m.quantity AS mouvement_quantite,
         m.product_name, m.product_reference, m.status AS mouvement_statut,
         m.import_id, m.operation_effective_at,
         i.file_name AS import_fichier,
         (SELECT count(*) FROM document_items di WHERE di.document_id = d.id) AS nb_lignes,
         (SELECT coalesce(sum(di.quantity), 0) FROM document_items di
           WHERE di.document_id = d.id) AS quantite_imprimee
    FROM documents d
    JOIN stock_movements m ON m.id = d.stock_movement_id
    LEFT JOIN companies c ON c.id = d.company_id
    LEFT JOIN inventory_imports i ON i.id = m.import_id
   WHERE d.document_type = 'Bon de livraison'
     AND d.stock_movement_id IS NOT NULL
     AND m.type = 'Sortie'
     AND d.cancelled_at IS NULL
     ${societeArg ? "AND d.company_id = $1" : ""}
   ORDER BY d.company_id, d.id`;

/** Photographie des chiffres de stock, pour prouver qu'ils n'ont pas bougé. */
async function empreinteStock(client) {
  const { rows } = await client.query(`
    SELECT (SELECT coalesce(sum(quantity), 0) FROM stock_movements)        AS mouvements,
           (SELECT count(*)                   FROM stock_movements)        AS nb_mouvements,
           (SELECT coalesce(sum(stock), 0)    FROM products)               AS produits,
           (SELECT coalesce(sum(quantity), 0) FROM stock_location_balances) AS balances,
           (SELECT count(*)                   FROM stock_location_balances) AS nb_balances`);
  return rows[0];
}

/* La MÊME série que l'application, pas une copie : une série parallèle
   distribuerait des numéros que l'application redonnerait ensuite. */
const { nextShortDocumentNumber } = require("../services/numerotation-documents");
const numeroSuivant = (client, companyId, prefixe) =>
  nextShortDocumentNumber(prefixe, companyId, client);

async function main() {
  const params = societeArg ? [Number(societeArg)] : [];
  const { rows: concernes } = await pool.query(REQUETE_CONCERNES, params);

  console.log(`\n${G}BONS DE LIVRAISON ÉMIS DEPUIS UNE SORTIE DE STOCK${Z}`);
  console.log(`Base   : ${String(process.env.DATABASE_URL).replace(/:\/\/[^@]*@/, "://***@")}`);
  console.log(`Mode   : ${PREVIEW ? "PRÉVISUALISATION — aucune écriture" : "APPLICATION"}`);
  if (societeArg) console.log(`Filtre : société ${societeArg}`);

  if (concernes.length === 0) {
    console.log(`\n${V}Aucun bon de livraison ne provient d'une sortie de stock. Rien à corriger.${Z}\n`);
    await pool.end();
    return;
  }

  const parSociete = new Map();
  for (const d of concernes) {
    if (!parSociete.has(d.company_id)) parSociete.set(d.company_id, []);
    parSociete.get(d.company_id).push(d);
  }

  console.log(`\n${J}${concernes.length} document(s) concerné(s), ${parSociete.size} société(s).${Z}`);

  for (const [companyId, docs] of parSociete) {
    console.log(`\n${G}Société ${companyId} — ${docs[0].societe || "sans nom"} : ${docs.length} document(s)${Z}`);
    for (const d of docs) {
      const ecarte = Number(d.quantite_imprimee) !== Number(d.mouvement_quantite);
      console.log(
        `  ${d.document_number.padEnd(18)} → ${SORTIE.prefixe}`
        + `  mouvement #${d.mouvement_id} ${d.mouvement_type} ${Number(d.mouvement_quantite)}`
        + `  « ${d.product_name || "?"} »`
      );
      console.log(
        `    ${" ".repeat(18)}   import ${d.import_fichier || (d.import_id ? `#${d.import_id}` : "aucun")}`
        + ` · statut mouvement ${d.mouvement_statut}`
        + ` · ${d.nb_lignes} ligne(s), ${Number(d.quantite_imprimee)} imprimée(s)`
        + (ecarte ? `  ${R}[écart avec le mouvement]${Z}` : "")
        + (Number(d.print_count) > 0 ? `  ${J}[déjà imprimé ${d.print_count}×]${Z}` : "")
      );
    }
  }

  if (PREVIEW) {
    const imprimes = concernes.filter((d) => Number(d.print_count) > 0).length;
    const ecarts = concernes.filter(
      (d) => Number(d.quantite_imprimee) !== Number(d.mouvement_quantite)).length;
    console.log(`\n${G}RÉSUMÉ${Z}`);
    console.log(`  documents à remplacer     : ${concernes.length}`);
    console.log(`  dont déjà imprimés        : ${imprimes}`);
    console.log(`  dont quantité imprimée ≠ mouvement : ${ecarts}`);
    console.log(`  mouvements touchés        : 0`);
    console.log(`  stock modifié             : 0`);
    console.log(`\n${V}Prévisualisation terminée. Rien n'a été écrit.${Z}`);
    console.log(`Pour appliquer : --apply --confirmer=${PHRASE_ATTENDUE}\n`);
    await pool.end();
    return;
  }

  /* ── APPLICATION ────────────────────────────────────────────────────────
     Tout ou rien : une seule transaction pour l'ensemble. Si un document
     résiste, aucun n'est corrigé et la production reste dans l'état où on
     l'a trouvée. */
  const client = await pool.connect();
  let remplaces = 0;
  try {
    await client.query("BEGIN");
    const avant = await empreinteStock(client);

    for (const d of concernes) {
      const { rows: verrou } = await client.query(
        `SELECT * FROM documents WHERE id = $1 AND cancelled_at IS NULL FOR UPDATE`, [d.id]);
      if (!verrou[0]) continue; // annulé entre-temps : on ne le touche pas

      const numero = await numeroSuivant(client, d.company_id, SORTIE.prefixe);

      /* L'ANNULATION VIENT D'ABORD. La base n'accepte qu'un seul document
         actif par mouvement : insérer le remplaçant avant d'annuler l'ancien
         fait deux actifs le temps d'une instruction, et l'index refuse. Cet
         ordre n'est donc pas une préférence de style — c'est ce qui rend
         l'opération possible. */
      await client.query(
        `UPDATE documents
            SET cancelled_at = now(), cancelled_by = $1, cancelled_by_name = $2,
                cancellation_reason = $3
          WHERE id = $4`,
        [null, AUTEUR, MOTIF, d.id]
      );

      const { rows: nouveau } = await client.query(
        `INSERT INTO documents
           (company_id, document_type, document_number, stock_movement_id, client_name,
            client_phone, client_address, total_amount, observation, created_by,
            document_datetime, replaces_document_id, created_at)
         SELECT company_id, $1, $2, stock_movement_id, client_name,
                client_phone, client_address, total_amount,
                coalesce(observation, '') || ' — remplace ' || document_number
                  || ' (bon de livraison émis à tort depuis une sortie de stock)',
                created_by, document_datetime, id, now()
           FROM documents WHERE id = $3
         RETURNING id, document_number`,
        [SORTIE.type, numero, d.id]
      );

      /* Les lignes du remplaçant viennent du MOUVEMENT, pas de l'ancien bon :
         c'est la quantité réellement sortie qui fait foi. C'est ici que le
         cumul disparaît — un bon qui portait 30 pour une sortie de 10 repart
         à 10. */
      await client.query(
        `INSERT INTO document_items
           (document_id, product_reference, product_name, quantity, unit_price, total_price)
         SELECT $1, m.product_reference, m.product_name, m.quantity, 0, 0
           FROM stock_movements m WHERE m.id = $2`,
        [nouveau[0].id, d.mouvement_id]
      );

      /* Le lien retour, une fois le remplaçant connu : on remonte la chaîne
         dans les deux sens. */
      await client.query(
        `UPDATE documents SET replaced_by_document_id = $1 WHERE id = $2`,
        [nouveau[0].id, d.id]
      );

      remplaces += 1;
      console.log(`  ${d.document_number} annulé → ${nouveau[0].document_number} créé`);
    }

    /* Le contrôle qui rend l'opération sûre : si un chiffre de stock a bougé,
       la transaction entière est annulée. */
    const apres = await empreinteStock(client);
    for (const cle of Object.keys(avant)) {
      if (String(avant[cle]) !== String(apres[cle])) {
        throw new Error(
          `Le stock a bougé (${cle} : ${avant[cle]} → ${apres[cle]}). `
          + "Cette correction ne doit toucher que des documents. Tout est annulé.");
      }
    }

    await client.query("COMMIT");
    console.log(`\n${V}${remplaces} document(s) remplacé(s). Stock inchangé, vérifié avant COMMIT.${Z}\n`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(`\n${R}ÉCHEC : ${e.message}${Z}`);
    console.error("Aucun document n'a été modifié.\n");
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(`${R}ÉCHEC : ${e.message}${Z}`);
  process.exit(1);
});

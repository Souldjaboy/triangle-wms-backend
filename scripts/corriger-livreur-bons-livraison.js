"use strict";

/**
 * CORRIGER LE NOM « LIVRÉ PAR » SUR LES BONS DÉJÀ ENREGISTRÉS.
 *
 *   node scripts/corriger-livreur-bons-livraison.js --preview \
 *        --societe="FAT & MAT" --livreur="Issa Diallo"
 *
 *   node scripts/corriger-livreur-bons-livraison.js --apply \
 *        --societe="FAT & MAT" --livreur="Issa Diallo" \
 *        --motif="Le nom imprimé était celui de la personne qui saisissait" \
 *        --confirmer="OUI JE CORRIGE LES BONS DE FAT & MAT"
 *
 * Options :
 *   --preview | --apply       obligatoire, l'un ou l'autre
 *   --societe="…"             fragment du NOM de la société, jamais un id
 *   --livreur="…"             le nom à écrire
 *   --ancien="…"              ne corriger que les bons portant ce nom-ci
 *                             (sans cette option, TOUS les bons de la société
 *                              sont alignés — à n'utiliser qu'en connaissance
 *                              de cause)
 *   --motif="…"               obligatoire pour --apply
 *   --confirmer="…"           phrase exacte, obligatoire pour --apply
 *   --regler-defaut=0         ne pas écrire le réglage de société
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POURQUOI LA SOCIÉTÉ SE RÉSOUT PAR SON NOM, ET JAMAIS PAR UN IDENTIFIANT
 *
 * L'identifiant de FAT & MAT n'est pas le même en base de test et en
 * production. Un script qui porterait « 2 » en dur corrigerait, le jour du
 * déploiement, les bons d'une tout autre société — et personne ne le verrait
 * avant qu'un client reçoive un bon signé d'un inconnu. Le script résout donc
 * la société au moment où il s'exécute, et REFUSE d'avancer si le nom fourni
 * en désigne plusieurs, ou aucune.
 *
 * Ce script ne supprime aucun bon et n'en réimprime aucun : il ne change que
 * le nom du livreur, et garde trace de ce qu'il a remplacé.
 */

const { Pool } = require("pg");

const V = "\x1b[32m", R = "\x1b[31m", J = "\x1b[33m", G = "\x1b[1m", GRIS = "\x1b[90m", Z = "\x1b[0m";

function options(argv) {
  const o = { preview: false, apply: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--preview") { o.preview = true; continue; }
    if (arg === "--apply") { o.apply = true; continue; }
    const m = /^--([a-z-]+)=(.*)$/s.exec(arg);
    if (m) o[m[1].replace(/-/g, "_")] = m[2];
  }
  return o;
}
const o = options(process.argv);

function refuser(message) { console.error(`${R}${message}${Z}`); process.exit(1); }

if (o.preview === o.apply) refuser("Indiquez exactement --preview OU --apply.");
if (!process.env.DATABASE_URL) refuser("DATABASE_URL manquant.");

const fragment = String(o.societe || "").trim();
if (fragment.length < 3) refuser('--societe="…" est obligatoire (au moins 3 caractères du nom).');

const livreur = String(o.livreur || "").trim();
if (livreur.length < 3) refuser('--livreur="…" est obligatoire : le nom à imprimer sous « Livré par ».');

const ancien = String(o.ancien || "").trim();
const motif = String(o.motif || "").trim();
const reglerDefaut = String(o.regler_defaut ?? "1") !== "0";

if (o.apply) {
  if (motif.length < 10) {
    refuser('--motif="…" est obligatoire pour --apply (au moins 10 caractères) : il sera lu des mois plus tard.');
  }
  if (/5432|prod|production/i.test(process.env.DATABASE_URL) && o.autoriser_production !== "1") {
    refuser("Cette URL ressemble à une base de production. Refus. (--autoriser-production=1 en connaissance de cause.)");
  }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/* Les trois tables qui portent un nom de livreur. Les traiter ensemble évite
   d'en corriger une et d'oublier les autres — ce qui donnerait des bons
   cohérents côté sable et faux côté ciment. */
const CIBLES = [
  { table: "sand_deliveries",   colonne: "delivered_by",      numero: "delivery_number", libelle: "Sable" },
  { table: "cement_deliveries", colonne: "delivered_by_name", numero: "delivery_number", libelle: "Ciment" },
  { table: "stock_documents",   colonne: "delivered_by_name", numero: "doc_number",      libelle: "Stock" },
];

const fr = (n) => Number(n).toLocaleString("fr-FR");

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    /* Verrou par société : deux exécutions simultanées ne doivent pas se
       croiser au milieu d'une correction. */
    await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [900_100, 1]);

    // ── LA SOCIÉTÉ, RÉSOLUE PAR SON NOM ──────────────────────────────
    /* La comparaison se fait côté Node, sans accents ni casse.
       Tenter d'abord `unaccent()` côté base semblait plus élégant, mais
       l'extension n'est pas garantie installée : la requête échouait, et
       PostgreSQL abandonne alors TOUTE la transaction — le repli arrivait
       trop tard, sur une transaction déjà morte. Mieux vaut ne pas dépendre
       de ce qui peut manquer. */
    const sansAccent = (t) =>
      String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

    const { rows: toutesSocietes } = await client.query(
      `SELECT id, name FROM companies
        WHERE COALESCE(status,'active') <> 'deleted' ORDER BY id`
    );
    const societes = toutesSocietes.filter(
      (c) => sansAccent(c.name).includes(sansAccent(fragment))
    );

    if (!societes.length) refuser(`Aucune société ne correspond à « ${fragment} ».`);
    if (societes.length > 1) {
      console.error(`${R}Plusieurs sociétés correspondent à « ${fragment} » :${Z}`);
      for (const s of societes) console.error(`  #${s.id}  ${s.name}`);
      refuser("Précisez le nom. Le script refuse de deviner laquelle corriger.");
    }
    const societe = societes[0];

    const PHRASE = `OUI JE CORRIGE LES BONS DE ${societe.name.toUpperCase()}`;
    if (o.apply && String(o.confirmer || "") !== PHRASE) {
      refuser(`Confirmation exacte requise :\n  --confirmer="${PHRASE}"`);
    }

    console.log(`\n${G}CORRECTION DU LIVREUR — ${o.apply ? "APPLICATION" : "PRÉVISUALISATION"}${Z}`);
    console.log(`  Société        : ${societe.name} (#${societe.id})`);
    console.log(`  Nom à écrire   : ${G}${livreur}${Z}`);
    console.log(`  Portée         : ${ancien ? `uniquement les bons portant « ${ancien} »` : "TOUS les bons de cette société"}`);
    console.log(`  Réglage société: ${reglerDefaut ? "oui — les futurs bons prendront ce nom" : "non"}`);

    // ── CE QUI SERA CHANGÉ ───────────────────────────────────────────
    let total = 0;
    const detail = [];

    for (const cible of CIBLES) {
      const { rows: existe } = await client.query(
        `SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name=$1`, [cible.table]);
      if (!existe[0]) continue;

      const conditions = [`company_id = $1`, `COALESCE(${cible.colonne}, '') <> $2`];
      const params = [societe.id, livreur];
      if (ancien) { conditions.push(`${cible.colonne} = $3`); params.push(ancien); }

      const { rows } = await client.query(
        `SELECT ${cible.numero} AS numero,
                COALESCE(${cible.colonne}, '') AS actuel,
                count(*) OVER () AS total
           FROM ${cible.table}
          WHERE ${conditions.join(" AND ")}
          ORDER BY id
          LIMIT 12`,
        params
      );

      const { rows: compte } = await client.query(
        `SELECT count(*)::int AS n FROM ${cible.table} WHERE ${conditions.join(" AND ")}`, params);

      const n = Number(compte[0].n);
      total += n;
      detail.push({ cible, n, exemples: rows });
    }

    console.log(`\n${G}CE QUI SERA CORRIGÉ${Z}`);
    for (const { cible, n, exemples } of detail) {
      console.log(`  ${cible.libelle.padEnd(8)} ${String(fr(n)).padStart(5)} bon(s)`);
      for (const ex of exemples.slice(0, 5)) {
        console.log(`    ${GRIS}${String(ex.numero || "—").padEnd(20)} « ${ex.actuel || "(vide)"} » → « ${livreur} »${Z}`);
      }
      if (n > 5) console.log(`    ${GRIS}… et ${fr(n - 5)} autre(s)${Z}`);
    }
    if (!total) console.log(`  ${GRIS}aucun bon à corriger : ils portent déjà le bon nom${Z}`);

    // ── LES NOMS ACTUELLEMENT PRÉSENTS, POUR CONTRÔLE HUMAIN ─────────
    console.log(`\n${G}NOMS ACTUELLEMENT IMPRIMÉS SOUS « LIVRÉ PAR »${Z}`);
    for (const cible of CIBLES) {
      const { rows: existe } = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
        [cible.table]);
      if (!existe[0]) continue;
      const { rows } = await client.query(
        `SELECT COALESCE(NULLIF(TRIM(${cible.colonne}), ''), '(vide)') AS nom, count(*)::int AS n
           FROM ${cible.table} WHERE company_id = $1
          GROUP BY 1 ORDER BY n DESC LIMIT 10`,
        [societe.id]);
      if (!rows.length) continue;
      console.log(`  ${cible.libelle} :`);
      for (const r of rows) console.log(`    ${String(fr(r.n)).padStart(5)} × ${r.nom}`);
    }

    console.log(`\n${G}TOTAUX${Z}`);
    console.log(`  bons à corriger : ${fr(total)}`);

    if (!o.apply) {
      await client.query("ROLLBACK");
      console.log(`\n${J}  Prévisualisation : aucune écriture n'a eu lieu.${Z}`);
      console.log(`  Pour appliquer :`);
      console.log(`    --apply --motif="…" --confirmer="${PHRASE}"\n`);
      return;
    }

    // ── L'APPLICATION ────────────────────────────────────────────────
    let corriges = 0;
    for (const { cible } of detail) {
      const conditions = [`company_id = $2`, `COALESCE(${cible.colonne}, '') <> $1`];
      const params = [livreur, societe.id];
      if (ancien) { conditions.push(`${cible.colonne} = $3`); params.push(ancien); }

      const { rowCount } = await client.query(
        `UPDATE ${cible.table} SET ${cible.colonne} = $1 WHERE ${conditions.join(" AND ")}`,
        params);
      corriges += rowCount;
    }

    if (reglerDefaut) {
      /* Pour que les FUTURS bons portent ce nom sans qu'on ait à relancer ce
         script. La ligne de réglages peut ne pas exister encore. */
      /* Mettre à jour, puis insérer si rien n'a bougé — plutôt qu'un
         `ON CONFLICT (company_id)`, qui exige une contrainte unique dont
         rien ne garantit l'existence. Quand elle manque, PostgreSQL ne se
         contente pas d'échouer : il abandonne TOUTE la transaction, et le
         repli écrit en JavaScript arrive alors trop tard. */
      const { rowCount } = await client.query(
        `UPDATE company_settings SET default_delivered_by = $2, updated_at = now()
          WHERE company_id = $1`,
        [societe.id, livreur]
      );
      if (!rowCount) {
        await client.query(
          `INSERT INTO company_settings (company_id, company_name, default_delivered_by)
           VALUES ($1, $2, $3)`,
          [societe.id, societe.name, livreur]
        );
      }
    }

    await client.query("COMMIT");
    console.log(`\n${V}  ${fr(corriges)} bon(s) corrigé(s).${Z}`);
    if (reglerDefaut) {
      console.log(`  ${V}Les futurs bons de ${societe.name} porteront « ${livreur} ».${Z}`);
    }
    console.log(`  ${GRIS}Motif enregistré : ${motif}${Z}\n`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`\n${R}ÉCHEC : ${e.message}${Z}`);
    console.error(`${GRIS}Rien n'a été écrit : la transaction entière est annulée.${Z}\n`);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();

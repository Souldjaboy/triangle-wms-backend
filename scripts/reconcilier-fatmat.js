"use strict";
/**
 * RÉCONCILIATION FAT & MAT — LECTURE SEULE PAR CONSTRUCTION.
 *
 *   DATABASE_URL=... node scripts/reconcilier-fatmat.js
 *   DATABASE_URL=... node scripts/reconcilier-fatmat.js --json > rapport.json
 *
 * Le script s'exécute dans une transaction PostgreSQL EN LECTURE SEULE : une
 * tentative d'écriture, même accidentelle, échouerait avec le code 25006
 * plutôt que de passer. Ce n'est pas une promesse, c'est le serveur qui le
 * tient.
 *
 * Il n'existe AUCUN mode « appliquer » dans ce fichier. Annuler des factures
 * réelles demande une liste nominative validée par la direction, et un autre
 * script qui reçoit cette liste — pas une option de ligne de commande.
 */
const { Pool } = require("pg");
const R = require("../services/reconciliation-fatmat");
const reference = require("./reference-fatmat-septembre-2026.json");

const JSON_SEUL = process.argv.includes("--json");
const f = (n) => Number(n || 0).toLocaleString("fr-FR");
const log = (...a) => { if (!JSON_SEUL) console.log(...a); };

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquant.");
  process.exit(1);
}
for (const interdit of ["--appliquer", "--apply", "--annuler", "--supprimer"]) {
  if (process.argv.includes(interdit)) {
    console.error(
      `« ${interdit} » n'existe pas ici. Ce script ne modifie rien.\n`
      + "Annuler des factures réelles demande une liste nominative validée."
    );
    process.exit(1);
  }
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    /* Le verrou, posé par PostgreSQL lui-même. */
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '60s'");

    const societes = (await client.query(
      `SELECT id, name FROM companies
        WHERE name ILIKE '%FAT%' AND name ILIKE '%MAT%' ORDER BY id`)).rows;
    if (societes.length !== 1) {
      throw new Error(`FAT & MAT doit correspondre à une seule société (trouvé : ${societes.length}).`);
    }
    const societe = societes[0];

    /* Les factures de sable de la période, avec ce qui a RÉELLEMENT été
       encaissé — pas ce que la colonne paid_amount affirme. */
    const { rows: factures } = await client.query(
      `SELECT i.*, c.name AS customer_name,
              d.id AS livraison_id,
              (s.cancelled_at IS NOT NULL) AS vente_annulee,
              COALESCE(p.encaisse, 0)::numeric AS encaisse_reel,
              COALESCE(p.nb, 0)::int AS nb_paiements
         FROM sand_invoices i
         LEFT JOIN sand_customers c ON c.id = i.customer_id AND c.company_id = i.company_id
         LEFT JOIN sand_sales s ON s.id = i.sale_id AND s.company_id = i.company_id
         LEFT JOIN sand_deliveries d ON d.sale_id = i.sale_id AND d.company_id = i.company_id
                                    AND d.cancelled_at IS NULL
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(sp.amount), 0) AS encaisse, count(*) AS nb
             FROM sand_payments sp
            WHERE sp.company_id = i.company_id AND sp.invoice_id = i.id
              /* Un encaissement contrepassé n'a plus rien encaissé. */
              AND NOT EXISTS (SELECT 1 FROM sand_payment_reversals r
                               WHERE r.company_id = sp.company_id
                                 AND r.original_payment_id = sp.id)
         ) p ON TRUE
        WHERE i.company_id = $1
          AND i.invoice_date BETWEEN $2::date AND $3::date
        ORDER BY i.invoice_date, i.id`,
      [societe.id, reference.periode.du, reference.periode.au]);

    const rapport = R.reconcilier(factures, reference);
    rapport.societe = { id: societe.id, nom: societe.name };
    rapport.genere_le = new Date().toISOString();

    if (JSON_SEUL) { console.log(JSON.stringify(rapport, null, 2)); return; }

    /* ─────────────────────────── LE RAPPORT ─────────────────────────── */
    log(`\n${"═".repeat(72)}`);
    log(`  RÉCONCILIATION ${societe.name} — ${reference.periode.du} au ${reference.periode.au}`);
    log("═".repeat(72));

    log(`\n§1. LES TROIS RELEVÉS DE LA DIRECTION\n`);
    for (const r of rapport.releves) {
      const etat = r.concorde ? "CONCORDE" : "ÉCART";
      log(`  ${r.libelle}`);
      log(`     attendu : ${String(r.attendu.nombre).padStart(3)} facture(s)  ${f(r.attendu.total).padStart(14)} FCFA`);
      log(`     trouvé  : ${String(r.trouve.nombre).padStart(3)} facture(s)  ${f(r.trouve.total).padStart(14)} FCFA`);
      if (!r.concorde) {
        log(`     écart   : ${r.ecart.nombre > 0 ? "+" : ""}${r.ecart.nombre} facture(s), `
          + `${r.ecart.total > 0 ? "+" : ""}${f(r.ecart.total)} FCFA`);
      }
      log(`     → ${etat}\n`);
    }

    const attendu = reference.totaux_attendus;
    log(`  TOTAL attendu : ${attendu.nombre} factures, ${f(attendu.montant)} FCFA`);
    log(`  TOTAL trouvé  : ${rapport.totaux.actives} factures actives, ${f(rapport.totaux.montant_actif)} FCFA`);

    log(`\n§2. LES ANOMALIES — ${rapport.totaux.anomalies} au total\n`);
    const parAnomalie = Object.entries(rapport.par_anomalie).sort((a, b) => b[1] - a[1]);
    if (!parAnomalie.length) log("  Aucune anomalie.");
    for (const [code, n] of parAnomalie) {
      log(`  ${String(n).padStart(3)} × ${code.padEnd(24)} ${R.ANOMALIES[code]}`);
    }

    log(`\n§3. LES FACTURES, UNE PAR LIGNE\n`);
    log(`  ${"Numéro".padEnd(16)} ${"Date".padEnd(11)} ${"Saisie".padEnd(11)} `
      + `${"Montant".padStart(12)} ${"Décision".padEnd(21)} Anomalies`);
    log(`  ${"-".repeat(110)}`);
    for (const x of rapport.factures) {
      log(`  ${String(x.numero || "—").padEnd(16)} ${String(x.date_facture || "—").padEnd(11)} `
        + `${String(x.date_saisie || "—").padEnd(11)} ${f(x.total).padStart(12)} `
        + `${x.decision.padEnd(21)} ${x.anomalies.map((a) => a.code).join(", ") || "—"}`);
    }

    log(`\n§4. À CONSERVER — ${rapport.a_conserver.length}\n`);
    log(`  ${rapport.a_conserver.join(", ") || "—"}`);

    log(`\n§5. À EXAMINER — ${rapport.a_examiner.length}\n`);
    log("  Ces factures portent une anomalie mais sont ancrées dans le réel");
    log("  (imprimées, encaissées ou livrées) : elles ne peuvent pas être");
    log("  annulées sans une décision explicite.\n");
    log(`  ${rapport.a_examiner.join(", ") || "—"}`);

    log(`\n§6. CANDIDATES À L'ANNULATION — ${rapport.candidates_annulation.length}\n`);
    if (!rapport.candidates_annulation.length) log("  Aucune.");
    for (const c of rapport.candidates_annulation) {
      log(`  ${String(c.numero).padEnd(16)} ${f(c.montant).padStart(12)} FCFA  `
        + `doublon de #${c.doublon_de}`);
      log(`     ${c.consequence}`);
    }

    log(`\n§7. CE QUE CE RAPPORT N'A PAS FAIT\n`);
    log(`  ${rapport.avertissement}`);
    log(`\n  Aucune écriture n'a été tentée : la transaction était en lecture`);
    log(`  seule, et PostgreSQL aurait refusé.\n`);
    log("═".repeat(72));
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error("Réconciliation impossible :", e.message); process.exit(1); });

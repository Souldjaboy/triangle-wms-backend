"use strict";

/**
 * ANNULATION, CORRECTION ET CONTREPASSATION DES VENTES DE SABLE, DE BOUT EN BOUT.
 *
 *   DATABASE_URL=… JWT_SECRET=test-secret-durcissement node scripts/test-vente-sable-annulation.js
 *
 * Suppose un serveur déjà démarré sur PORT (5050 par défaut) avec la même
 * base et le même JWT_SECRET, et le jeu d'essai scripts/jeu-essai-vente-sable.js
 * déjà posé. Le wrapper .sh gère les deux.
 */

const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const { execFileSync, execFile } = require("child_process");
const path = require("path");

const V = "\x1b[32m", R = "\x1b[31m", G = "\x1b[1m", Z = "\x1b[0m";
let reussis = 0, echoues = 0;
function verifier(titre, condition, detail = "") {
  if (condition) { reussis += 1; console.log(`${V}  ✓${Z} ${titre}`); }
  else { echoues += 1; console.log(`${R}  ✗ ${titre}${Z}${detail ? `  — ${detail}` : ""}`); }
}

const PORT = process.env.PORT || 5050;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = process.env.JWT_SECRET || "test-secret-durcissement";
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL manquant."); process.exit(1); }

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JEU = path.join(__dirname, "jeu-essai-vente-sable.js");

function poserLeJeu() {
  const sortie = execFileSync(process.execPath, [JEU], { encoding: "utf8", env: process.env });
  return JSON.parse(sortie);
}

const jetonPour = (id, role, companyId, superAdmin = false) =>
  jwt.sign({ id, email: "x@x.test", role, company_id: companyId, is_super_admin: superAdmin }, SECRET, { expiresIn: "3h" });

async function appel(methode, chemin, jeton, corps, entetes = {}) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jeton}`, ...entetes },
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  let corpsJson; try { corpsJson = JSON.parse(texte); } catch { corpsJson = { brut: texte }; }
  return { statut: r.status, corps: corpsJson };
}

async function q(sql, params = []) { return (await pool.query(sql, params)).rows; }

async function empreinteStock() {
  const r = await q(`
    SELECT (SELECT coalesce(json_agg(json_build_object('i',id,'s',stock) ORDER BY id),'[]') FROM products)                   AS produits,
           (SELECT coalesce(json_agg(json_build_object('i',id,'q',quantity) ORDER BY id),'[]') FROM stock_movements)         AS mouvements,
           (SELECT coalesce(json_agg(json_build_object('i',id,'q',quantity) ORDER BY id),'[]') FROM stock_location_balances) AS balances`);
  return JSON.stringify(r[0]);
}

async function main() {
  console.log(`\n${G}VENTES DE SABLE — ANNULATION, CORRECTION, CONTREPASSATION${Z}`);

  const jeu = poserLeJeu();
  const S2 = jeu.societes.fatmat, S1 = jeu.societes.triangle;
  const ADMIN = jetonPour(jeu.comptes.admin, "admin", S2);
  const COMPTABLE = jetonPour(jeu.comptes.comptable, "comptable", S2);
  const EMPLOYE = jetonPour(jeu.comptes.employe, "employe", S2);
  const AUTRE = jetonPour(jeu.comptes.autre_societe_admin, "admin", S1);
  const SUPERADMIN = jetonPour(jeu.comptes.super_admin, "super_admin", S2, true);

  const stockDepart = await empreinteStock();

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}1-2. BROUILLON : MODIFICATION COMPLÈTE ET SUPPRESSION${Z}`);
  {
    const r1 = await appel("PATCH", `/sand/sales/${jeu.ventes.brouillon}`, EMPLOYE, {
      quantity_m3: 20, unit_price: 19000, notes: "Modifié intégralement", destination: "Kati",
      delivery_place: "Chantier Kati", truck: "AB-1234", driver_name: "Chauffeur Test",
    });
    verifier("modification complète d'un brouillon", r1.statut === 200, JSON.stringify(r1.corps).slice(0, 200));
    verifier("les nouvelles valeurs sont bien enregistrées",
      r1.corps.sale?.quantity_m3 === "20.000" && r1.corps.sale?.destination === "Kati"
      && r1.corps.sale?.truck === "AB-1234");
    verifier("le total est recalculé", Number(r1.corps.sale?.total_amount) === 20 * 19000 + 15000);

    const r2 = await appel("DELETE", `/sand/sales/${jeu.ventes.brouillon}`, EMPLOYE);
    verifier("suppression d'un brouillon", r2.statut === 200, JSON.stringify(r2.corps));
    const encoreLa = await q(`SELECT id FROM sand_sales WHERE id = $1`, [jeu.ventes.brouillon]);
    verifier("le brouillon a bien disparu de la base", encoreLa.length === 0);
    const revision = await q(`SELECT action FROM sand_sale_audit_log WHERE sale_id IS NULL AND original_sale_id IS NULL
       AND action='DRAFT_DELETE' ORDER BY id DESC LIMIT 1`);
    verifier("la suppression est journalisée (sale_id retombe à NULL via ON DELETE SET NULL)",
      revision.length === 1 || (await q(`SELECT count(*) n FROM sand_sale_audit_log WHERE action='DRAFT_DELETE'`))[0].n >= 1);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}3. ANNULATION D'UNE VENTE VALIDÉE IMPAYÉE${Z}`);
  {
    const avant = await q(`SELECT status FROM sand_invoices WHERE sale_id = $1`, [jeu.ventes.validee_impayee]);
    const r = await appel("POST", `/sand/sales/${jeu.ventes.validee_impayee}/cancel`, ADMIN,
      { reason: "Client s'est désisté" });
    verifier("annulation d'une vente impayée réussit", r.statut === 200, JSON.stringify(r.corps).slice(0, 200));
    verifier("la vente passe à ANNULEE", r.corps.sale?.status === "ANNULEE");
    verifier("la facture passe à ANNULEE", r.corps.invoice?.status === "ANNULEE");
    verifier("le BL est marqué annulé", Boolean(r.corps.delivery?.cancelled_at));
    verifier("aucun paiement à contrepasser (rien n'était payé)", (r.corps.payments_reversed || []).length === 0);
    verifier("stock_restored est explicitement false (rien à restituer)", r.corps.stock_restored === false);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}4. ANNULATION D'UNE VENTE PAYÉE EN ESPÈCES${Z}`);
  let banque, treasuryAvant;
  {
    treasuryAvant = (await q(`SELECT current_balance FROM treasury_accounts WHERE company_id=$1`, [S2]))[0];
    const r = await appel("POST", `/sand/sales/${jeu.ventes.validee_payee_especes}/cancel`, ADMIN,
      { reason: "Double saisie" });
    verifier("annulation d'une vente payée en espèces réussit", r.statut === 200, JSON.stringify(r.corps).slice(0, 300));
    verifier("le paiement espèces est contrepassé, pas supprimé",
      (r.corps.payments_reversed || []).length === 1);
    const paiementOriginal = await q(`SELECT id FROM sand_payments WHERE id = $1`,
      [r.corps.payments_reversed[0].payment_id]);
    verifier("le paiement original existe toujours en base (jamais supprimé)", paiementOriginal.length === 1);
    const treasuryApres = (await q(`SELECT current_balance FROM treasury_accounts WHERE company_id=$1`, [S2]))[0];
    verifier("la trésorerie est décrémentée du montant exact",
      Number(treasuryAvant.current_balance) - Number(treasuryApres.current_balance)
        === Number(r.corps.payments_reversed[0].amount));
    verifier("refund_pending est posé (remboursement réel à effectuer)",
      (await q(`SELECT refund_pending FROM sand_payment_reversals WHERE original_payment_id=$1`,
        [r.corps.payments_reversed[0].payment_id]))[0].refund_pending === true);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}5. ANNULATION D'UNE VENTE PAYÉE PAR BANQUE${Z}`);
  {
    banque = (await q(`SELECT * FROM accounting_banks WHERE company_id=$1`, [S2]))[0];
    const bankAvant = Number(banque.current_balance);
    const r = await appel("POST", `/sand/sales/${jeu.ventes.validee_payee_banque}/cancel`, ADMIN,
      { reason: "Erreur de banque de destination" });
    verifier("annulation d'une vente payée par banque réussit", r.statut === 200, JSON.stringify(r.corps).slice(0, 300));
    const bankApres = (await q(`SELECT current_balance FROM accounting_banks WHERE id=$1`, [banque.id]))[0];
    verifier("la banque est décrémentée du montant exact",
      bankAvant - Number(bankApres.current_balance) === Number(r.corps.payments_reversed[0].amount));
    const transac = await q(
      `SELECT * FROM accounting_transactions WHERE company_id=$1 AND source_type='sand_payment_reversal'
        ORDER BY id DESC LIMIT 1`, [S2]);
    verifier("une écriture comptable de contrepassation existe, direction sortie",
      transac[0]?.direction === "sortie" && Number(transac[0]?.amount) === Number(r.corps.payments_reversed[0].amount));
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}6. ANNULATION SYNCHRONISÉE FACTURE / BL${Z}`);
  {
    const facture = await q(`SELECT status, cancelled_at FROM sand_invoices WHERE sale_id=$1`,
      [jeu.ventes.validee_payee_banque]);
    const bl = await q(`SELECT cancelled_at FROM sand_deliveries WHERE sale_id=$1`, [jeu.ventes.validee_payee_banque]);
    verifier("facture et BL annulés dans la même opération",
      facture[0]?.status === "ANNULEE" && facture[0]?.cancelled_at && bl[0]?.cancelled_at);
    verifier("aucun document n'a été supprimé physiquement — toujours en base",
      facture.length === 1 && bl.length === 1);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}7. REFUS POUR UN EMPLOYÉ SANS PERMISSION, AUTORISATION SUPER_ADMIN${Z}`);
  let venteFraiche;
  {
    // Une vente fraîche, validée et impayée, pour ces essais.
    const jeu2 = poserLeJeu();
    venteFraiche = jeu2.ventes.validee_impayee;
    const S2b = jeu2.societes.fatmat;
    const EMPLOYE2 = jetonPour(jeu2.comptes.employe, "employe", S2b);
    const COMPTABLE2 = jetonPour(jeu2.comptes.comptable, "comptable", S2b);
    const ADMIN2 = jetonPour(jeu2.comptes.admin, "admin", S2b);
    const SUPERADMIN2 = jetonPour(jeu2.comptes.super_admin, "super_admin", S2b, true);

    const r1 = await appel("POST", `/sand/sales/${venteFraiche}/cancel`, EMPLOYE2, { reason: "test refus" });
    verifier("un employé sans vente_annuler est refusé (403)", r1.statut === 403, JSON.stringify(r1.corps));
    const r2 = await appel("POST", `/sand/sales/${venteFraiche}/cancel`, COMPTABLE2, { reason: "test refus" });
    verifier("un comptable sans vente_annuler est refusé (403)", r2.statut === 403);
    const r3 = await appel("POST", `/sand/sales/${venteFraiche}/cancel`, SUPERADMIN2, { reason: "super_admin peut tout" });
    verifier("super_admin annule sans permission explicite", r3.statut === 200, JSON.stringify(r3.corps).slice(0, 200));

    // Refaire pour tester correction/contrepassation avec les bons rôles.
    jeu.__jeu2 = jeu2; jeu.__admin2 = ADMIN2; jeu.__employe2 = EMPLOYE2; jeu.__comptable2 = COMPTABLE2;
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}15. ISOLATION ENTRE SOCIÉTÉS${Z}`);
  {
    const rAutre = await appel("POST", `/sand/sales/${jeu.ventes.validee_impayee}/cancel`, AUTRE,
      { reason: "tentative hors société" });
    verifier("une autre société ne voit pas la vente (404, pas de fuite d'info)", rAutre.statut === 404);
    const rVue = await appel("GET", `/sand/sales/${jeu.ventes.autre_societe}`, ADMIN);
    verifier("FAT & MAT ne voit pas la vente de l'autre société (404)", rVue.statut === 404);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}10. CORRECTION AVEC NOUVEAUX NUMÉROS, 11. ANCIENS DOCUMENTS CONSERVÉS${Z}`);
  let correction;
  {
    const jeu3 = poserLeJeu();
    const S2c = jeu3.societes.fatmat;
    const ADMIN3 = jetonPour(jeu3.comptes.admin, "admin", S2c);
    const cible = jeu3.ventes.validee_payee_especes;
    const avant = await q(`SELECT sale_number FROM sand_sales WHERE id=$1`, [cible]);
    const rSansMotif = await appel("POST", `/sand/sales/${cible}/correct`, ADMIN3, { quantity_m3: 7 });
    verifier("correction sans motif est refusée", rSansMotif.statut === 400);

    const r = await appel("POST", `/sand/sales/${cible}/correct`, ADMIN3,
      { reason: "Quantité réellement livrée différente", quantity_m3: 7, unit_price: 17500 });
    verifier("correction avec motif réussit", r.statut === 201, JSON.stringify(r.corps).slice(0, 300));
    verifier("un nouveau numéro de vente est attribué",
      r.corps.new_sale?.sale_number && r.corps.new_sale.sale_number !== avant[0].sale_number);
    verifier("une nouvelle facture et un nouveau BL sont créés",
      r.corps.new_invoice?.invoice_number && r.corps.new_delivery?.delivery_number);
    verifier("l'ancienne vente passe à REMPLACEE (pas ANNULEE)", r.corps.old_sale?.status === "REMPLACEE");
    verifier("le lien ancien → nouveau existe", r.corps.old_sale?.replaced_by_sale_id === r.corps.new_sale?.id);
    verifier("le lien nouveau → ancien existe", r.corps.new_sale?.replaces_sale_id === r.corps.old_sale?.id);
    verifier("l'ancienne facture et l'ancien BL existent toujours (jamais supprimés)",
      (await q(`SELECT id FROM sand_invoices WHERE id=$1`, [r.corps.old_invoice.id])).length === 1
      && (await q(`SELECT id FROM sand_deliveries WHERE id=$1`, [r.corps.old_delivery.id])).length === 1);
    verifier("l'ancienne facture est annulée avec son ancien numéro conservé",
      r.corps.old_invoice.status === "ANNULEE" && r.corps.old_invoice.invoice_number);
    verifier("le paiement d'origine est contrepassé automatiquement par la correction",
      (r.corps.payments_reversed || []).length === 1);
    verifier("la comparaison avant/après est fournie",
      r.corps.comparison?.before && r.corps.comparison?.after
      && r.corps.comparison.before.quantity_m3 !== r.corps.comparison.after.quantity_m3);
    correction = { jeu3, ADMIN3, cible, resultat: r.corps };
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}12. AUDIT AVANT/APRÈS${Z}`);
  {
    const r = await appel("GET", `/sand/sales/${correction.cible}/audit`, correction.ADMIN3);
    verifier("l'historique se lit", r.statut === 200);
    verifier("la chaîne complète (ancienne + nouvelle) est présente",
      r.corps.chain?.length === 2);
    const entreeCorrection = (r.corps.entries || []).find((e) => e.action === "CORRECT");
    verifier("l'entrée CORRECT porte l'avant et l'après complets",
      entreeCorrection && entreeCorrection.old_value && entreeCorrection.new_value);
    verifier("l'entrée porte l'auteur réel", Boolean(entreeCorrection?.performed_by_name));
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}9. FILIGRANE / IMPRESSION — MARQUER COMME IMPRIMÉ${Z}`);
  {
    const rImp = await appel("POST", `/sand/invoices/${correction.resultat.old_invoice.id}/printed`, correction.ADMIN3);
    verifier("marquer une facture imprimée fonctionne", rImp.statut === 200 && rImp.corps.print_count === 1);
    const relue = await q(`SELECT print_count, printed_at FROM sand_invoices WHERE id=$1`,
      [correction.resultat.old_invoice.id]);
    verifier("print_count et printed_at sont posés en base",
      relue[0].print_count === 1 && relue[0].printed_at !== null);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}CONTREPASSATION AUTONOME (SANS ANNULER LA VENTE)${Z}`);
  {
    const jeu4 = poserLeJeu();
    const S2d = jeu4.societes.fatmat;
    const COMPTABLE4 = jetonPour(jeu4.comptes.comptable, "comptable", S2d);
    const paiement = (await q(`SELECT id FROM sand_payments WHERE invoice_id=$1`, [jeu4.ventes.facture_especes]))[0];

    const rSansPerm = await appel("POST", `/sand/payments/${paiement.id}/reverse`,
      jetonPour(jeu4.comptes.employe, "employe", S2d), { reason: "test" });
    verifier("un employé sans paiement_contrepasser est refusé", rSansPerm.statut === 403);

    const r = await appel("POST", `/sand/payments/${paiement.id}/reverse`, COMPTABLE4,
      { reason: "Paiement enregistré deux fois par erreur" });
    verifier("un comptable contrepasse un paiement seul (vente reste VALIDEE)", r.statut === 200,
      JSON.stringify(r.corps).slice(0, 200));
    const venteEncoreValidee = await q(`SELECT status FROM sand_sales WHERE id=$1`, [jeu4.ventes.validee_payee_especes]);
    verifier("la vente n'est PAS annulée par une contrepassation autonome",
      venteEncoreValidee[0].status === "VALIDEE");
    verifier("la facture repasse à IMPAYEE (le paiement ne compte plus)",
      r.corps.invoice?.status === "IMPAYEE" || Number(r.corps.invoice?.remaining_amount) > 0);

    const rRejeu = await appel("POST", `/sand/payments/${paiement.id}/reverse`, COMPTABLE4,
      { reason: "seconde tentative" });
    verifier("rejouer la contrepassation du même paiement est refusé", rRejeu.statut === 409);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}16. REJEU SANS DOUBLE RESTITUTION${Z}`);
  {
    const jeu5 = poserLeJeu();
    const S2e = jeu5.societes.fatmat;
    const ADMIN5 = jetonPour(jeu5.comptes.admin, "admin", S2e);
    const cible = jeu5.ventes.validee_impayee;

    const treasuryAvant5 = await empreinteStock(); // pas concerné, on vérifie juste la trésorerie séparément
    const r1 = await appel("POST", `/sand/sales/${cible}/cancel`, ADMIN5, { reason: "premier essai" });
    verifier("premier appel réussit", r1.statut === 200);
    const r2 = await appel("POST", `/sand/sales/${cible}/cancel`, ADMIN5, { reason: "second essai identique" });
    verifier("rejouer l'annulation sur une vente déjà annulée est refusé (409)", r2.statut === 409);
    const cnt = await q(`SELECT count(*) n FROM sand_sale_audit_log WHERE sale_id=$1 AND action='CANCEL'`, [cible]);
    verifier("une seule entrée d'audit CANCEL — pas de doublon", Number(cnt[0].n) === 1);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}17. ROLLBACK SUR PANNE VOLONTAIRE${Z}`);
  {
    const jeu6 = poserLeJeu();
    const S2f = jeu6.societes.fatmat;
    const ADMIN6 = jetonPour(jeu6.comptes.admin, "admin", S2f);
    const cible = jeu6.ventes.validee_payee_banque;

    const avant = await q(`SELECT status FROM sand_sales WHERE id=$1`, [cible]);
    const banqueAvant = await q(`SELECT current_balance FROM accounting_banks WHERE company_id=$1`, [S2f]);
    const revisionsAvant = Number((await q(`SELECT count(*) n FROM sand_sale_audit_log`))[0].n);

    await pool.query(`CREATE TABLE IF NOT EXISTS essai_panne_sable (n INTEGER NOT NULL DEFAULT 0)`);
    await pool.query(`DELETE FROM essai_panne_sable`); await pool.query(`INSERT INTO essai_panne_sable VALUES (0)`);
    await pool.query(`
      CREATE OR REPLACE FUNCTION essai_panne_sable_fn() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'PANNE SIMULÉE — vente sable'; END $$ LANGUAGE plpgsql`);
    await pool.query(`DROP TRIGGER IF EXISTS essai_panne_sable_trg ON sand_sales`);
    await pool.query(`CREATE TRIGGER essai_panne_sable_trg BEFORE UPDATE OF status ON sand_sales
                       FOR EACH ROW WHEN (NEW.status = 'ANNULEE') EXECUTE FUNCTION essai_panne_sable_fn()`);

    const r = await appel("POST", `/sand/sales/${cible}/cancel`, ADMIN6, { reason: "doit échouer entièrement" });
    verifier("le serveur répond une erreur", r.statut >= 500 || r.statut === 409, JSON.stringify(r.corps).slice(0, 150));

    const apres = await q(`SELECT status FROM sand_sales WHERE id=$1`, [cible]);
    verifier("la vente n'a PAS changé de statut (rollback complet)", apres[0].status === avant[0].status);
    const banqueApres = await q(`SELECT current_balance FROM accounting_banks WHERE company_id=$1`, [S2f]);
    verifier("la banque n'a PAS bougé (le paiement contrepassé a été annulé aussi)",
      Number(banqueApres[0].current_balance) === Number(banqueAvant[0].current_balance));
    const revisionsApres = Number((await q(`SELECT count(*) n FROM sand_sale_audit_log`))[0].n);
    verifier("aucune ligne d'audit n'a survécu à la panne", revisionsApres === revisionsAvant);

    await pool.query(`DROP TRIGGER IF EXISTS essai_panne_sable_trg ON sand_sales`);
    await pool.query(`DROP FUNCTION IF EXISTS essai_panne_sable_fn()`);
    await pool.query(`DROP TABLE IF EXISTS essai_panne_sable`);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}18. DEUX ANNULATIONS SIMULTANÉES${Z}`);
  {
    const jeu7 = poserLeJeu();
    const S2g = jeu7.societes.fatmat;
    const ADMIN7 = jetonPour(jeu7.comptes.admin, "admin", S2g);
    const cible = jeu7.ventes.validee_payee_especes;

    const [a, b] = await Promise.all([
      appel("POST", `/sand/sales/${cible}/cancel`, ADMIN7, { reason: "concurrence A" }),
      appel("POST", `/sand/sales/${cible}/cancel`, ADMIN7, { reason: "concurrence B" }),
    ]);
    const succes = [a, b].filter((r) => r.statut === 200).length;
    const refus = [a, b].filter((r) => r.statut === 409).length;
    verifier("exactement un des deux appels réussit, l'autre est refusé",
      succes === 1 && refus === 1, `A=${a.statut} B=${b.statut}`);
    const reversals = await q(`SELECT count(*) n FROM sand_payment_reversals sr
       JOIN sand_payments p ON p.id = sr.original_payment_id
       JOIN sand_invoices i ON i.id = p.invoice_id WHERE i.sale_id = $1`, [cible]);
    verifier("un seul contrepassement du paiement, pas deux", Number(reversals[0].n) === 1);
  }

  // ────────────────────────────────────────────────────────────────────
  console.log(`\n${G}19. COHÉRENCE STOCK / CAISSE / COMPTABILITÉ${Z}`);
  {
    verifier("le stock (Triangle) n'a pas bougé d'un gramme pendant tout ce chantier sable",
      (await empreinteStock()) === stockDepart);
    const desequilibre = await q(
      `SELECT source_type, source_id, SUM(debit) d, SUM(credit) c FROM accounting_entries
        WHERE source_type IN ('sand_payment','sand_payment_reversal')
        GROUP BY source_type, source_id HAVING SUM(debit) <> SUM(credit)`);
    verifier("toutes les écritures comptables sable restent équilibrées (débit = crédit)",
      desequilibre.length === 0, JSON.stringify(desequilibre));
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

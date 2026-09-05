"use strict";

/**
 * ACOMPTES ET DÉPÔTS CLIENTS (migration 084).
 *
 *   bash scripts/test-acomptes-clients.sh
 *
 * Les cas chiffrés exigés :
 *
 *   1. dépôt 5 000 000, facture 2 000 000 → facture payée, dépôt 3 000 000 ;
 *   2. dépôt 40 000 000, factures 45 000 000 → 40 000 000 utilisés, dépôt 0,
 *      impayé 5 000 000, statut partiellement payée ;
 *   3. un nouveau dépôt s'impute sur des factures antérieures impayées ;
 *   4. plusieurs dépôts, plusieurs factures, chaque allocation traçable.
 *
 * Et la règle qui compte le plus : imputer un dépôt sur une facture ne fait
 * SORTIR NI ENTRER aucun argent. Le solde bancaire ne bouge qu'au versement
 * et au remboursement.
 */

const { Pool } = require("pg");
const jwt = require("jsonwebtoken");

const BASE = `http://127.0.0.1:${process.env.PORT || 5050}`;
const SECRET = process.env.JWT_SECRET || "test-secret-durcissement";
const URL_BASE = process.env.DATABASE_URL ||
  "postgresql://postgres:triangle_test_password@127.0.0.1:5433/triangle_wms";
const V = "\x1b[32m", R = "\x1b[31m", G = "\x1b[1m", Z = "\x1b[0m";
let reussis = 0, echoues = 0;
function verifier(titre, condition, detail = "") {
  if (condition) { reussis += 1; console.log(`${V}  ✓${Z} ${titre}`); }
  else { echoues += 1; console.log(`${R}  ✗ ${titre}${Z}${detail ? `  — ${detail}` : ""}`); }
}

const pool = new Pool({ connectionString: URL_BASE });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const jeton = (id, role, companyId) =>
  jwt.sign({ id, fullname: `Compte ${id}`, email: `d${id}@essai.test`, role,
             company_id: companyId, is_super_admin: false }, SECRET, { expiresIn: "3h" });

async function appel(methode, chemin, token, corps) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  let json; try { json = JSON.parse(texte); } catch { json = { brut: texte }; }
  return { statut: r.status, corps: json };
}

const TRIANGLE = 1, FATMAT = 2;
let COMPTABLE = 0, DIRECTEUR = 0, COMPTABLE_F = 0;
let banqueId = 0, clientA = 0, clientB = 0, clientFatmat = 0;

const soldeBanque = async () =>
  Number((await q(`SELECT current_balance FROM accounting_banks WHERE id=$1`, [banqueId]))[0].current_balance);

/* Une facture de sable est adossée à une vente : `sale_id` est obligatoire.
   On crée donc la vente qui la porte, plutôt que de relâcher la contrainte —
   ce serait affaiblir le schéma pour la commodité d'un test. */
async function facture(companyId, customerId, numero, montant) {
  const { rows: ventes } = await pool.query(
    `INSERT INTO sand_sales
       (company_id, customer_id, sale_number, quantity_m3, unit_price, sand_subtotal,
        total_amount, paid_amount, remaining_amount, status)
     VALUES ($1,$2,$3,1,$4,$4,$4,0,$4,'VALIDEE') RETURNING id`,
    [companyId, customerId, `V${numero}`, montant]);
  const { rows } = await pool.query(
    `INSERT INTO sand_invoices
       (company_id, sale_id, customer_id, invoice_number, invoice_date, total_amount,
        paid_amount, remaining_amount, status)
     VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,0,$5,'IMPAYEE') RETURNING id, invoice_number`,
    [companyId, ventes[0].id, customerId, numero, montant]);
  return rows[0];
}

async function poserLeJeu() {
  await pool.query(`DELETE FROM client_deposit_refunds`);
  await pool.query(`DELETE FROM client_deposit_allocations`);
  await pool.query(`DELETE FROM client_deposits`);
  await pool.query(`DELETE FROM sand_invoices WHERE invoice_number LIKE 'F084-%'`);
  await pool.query(`DELETE FROM sand_sales WHERE sale_number LIKE 'VF084-%'`);
  await pool.query(`DELETE FROM sand_customers WHERE customer_code LIKE 'C084-%'`);
  await pool.query(`DELETE FROM accounting_banks WHERE bank_name LIKE 'Banque Essai 084%'`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'dep084-%@essai.test'`);

  const creer = async (email, nom, role, companyId) => (await pool.query(
    `INSERT INTO users (company_id, fullname, email, password, role, is_super_admin, is_active)
     VALUES ($1,$2,$3,'$non-utilisable$',$4,false,true) RETURNING id`,
    [companyId, nom, email, role])).rows[0].id;
  COMPTABLE   = await creer("dep084-comptable@essai.test", "Essai 084 Comptable", "comptable", TRIANGLE);
  DIRECTEUR   = await creer("dep084-directeur@essai.test", "Essai 084 Directeur", "direction", TRIANGLE);
  COMPTABLE_F = await creer("dep084-comptable-f@essai.test", "Essai 084 Comptable FAT", "comptable", FATMAT);

  banqueId = (await pool.query(
    `INSERT INTO accounting_banks (company_id, bank_name, account_number, currency,
       initial_balance, current_balance, is_active)
     VALUES ($1,'Banque Essai 084','B084','FCFA',0,0,true) RETURNING id`, [TRIANGLE])).rows[0].id;

  const clientSable = async (companyId, code, nom) => (await pool.query(
    `INSERT INTO sand_customers (company_id, customer_code, name, status)
     VALUES ($1,$2,$3,'ACTIF') RETURNING id`, [companyId, code, nom])).rows[0].id;
  clientA      = await clientSable(TRIANGLE, "C084-A", "Essai 084 Client A");
  clientB      = await clientSable(TRIANGLE, "C084-B", "Essai 084 Client B");
  clientFatmat = await clientSable(FATMAT,   "C084-F", "Essai 084 Client FAT & MAT");

  await pool.query(`DELETE FROM user_permission_overrides WHERE company_id=ANY($1::int[]) AND user_id=ANY($2::int[])`,
    [[TRIANGLE, FATMAT], [COMPTABLE, DIRECTEUR, COMPTABLE_F]]);
  const droit = (companyId, userId, action) => pool.query(
    `INSERT INTO user_permission_overrides (company_id, user_id, module_key, action, effect)
     VALUES ($1,$2,'acompte_client',$3,'ALLOW')
     ON CONFLICT (company_id, user_id, module_key, action) DO UPDATE SET effect='ALLOW'`,
    [companyId, userId, action]);
  for (const a of ["visible","view","create","update","print"]) {
    await droit(TRIANGLE, COMPTABLE, a); await droit(FATMAT, COMPTABLE_F, a);
  }
  for (const a of ["visible","view","cancel","print"]) await droit(TRIANGLE, DIRECTEUR, a);
}

async function main() {
  console.log(`\n${G}ACOMPTES ET DÉPÔTS CLIENTS (084)${Z}`);
  await poserLeJeu();
  const tC = jeton(COMPTABLE, "comptable", TRIANGLE);
  const tD = jeton(DIRECTEUR, "direction", TRIANGLE);
  const tF = jeton(COMPTABLE_F, "comptable", FATMAT);

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}CAS 1 — DÉPÔT 5 000 000, FACTURE 2 000 000${Z}`);
  let depot5M = 0;
  {
    const avant = await soldeBanque();
    const versement = await appel("POST", "/acomptes", tC, {
      activite: "sable", client_id: clientA, amount: 5000000,
      bank_id: banqueId, payment_method: "VIREMENT", external_reference: "VIR-084-1",
    });
    verifier("le dépôt de 5 000 000 est enregistré", versement.statut === 201,
      JSON.stringify(versement.corps).slice(0, 150));
    depot5M = versement.corps.acompte?.id;
    verifier("il porte une référence de la série DEP-SAB",
      /^DEP-SAB-\d{4}-\d{6}$/.test(versement.corps.acompte?.reference || ""),
      versement.corps.acompte?.reference);

    const apres = await soldeBanque();
    verifier("la banque a augmenté d'exactement 5 000 000", apres - avant === 5000000,
      `${avant} → ${apres}`);

    const ecritures = await q(
      `SELECT account_label, debit, credit FROM accounting_entries
        WHERE source_type='client_deposit' AND source_id=$1`, [depot5M]);
    verifier("l'acompte est comptabilisé en AVANCE REÇUE, pas en produit",
      ecritures.some((e) => /Avances reçues des clients/i.test(e.account_label))
      && !ecritures.some((e) => /vente|produit|chiffre/i.test(e.account_label)),
      JSON.stringify(ecritures.map((e) => e.account_label)));

    const f = await facture(TRIANGLE, clientA, "F084-001", 2000000);
    const banqueAvantImputation = await soldeBanque();

    const imputation = await appel("POST", "/acomptes/affectation", tC, {
      activite: "sable", invoice_id: f.id });
    verifier("l'imputation passe", imputation.statut === 200, JSON.stringify(imputation.corps).slice(0, 200));
    verifier("la facture est entièrement payée",
      imputation.corps.facture?.status === "PAYEE" && Number(imputation.corps.reste_impaye) === 0,
      JSON.stringify(imputation.corps.facture));

    const banqueApresImputation = await soldeBanque();
    verifier("AUCUN argent n'est entré ni sorti à l'imputation",
      banqueApresImputation === banqueAvantImputation,
      `${banqueAvantImputation} → ${banqueApresImputation}`);

    const [depot] = await q(`SELECT available_amount, status FROM client_deposits WHERE id=$1`, [depot5M]);
    verifier("il reste exactement 3 000 000 sur le dépôt",
      Number(depot.available_amount) === 3000000, `${depot.available_amount}`);
    verifier("le dépôt reste ACTIF", depot.status === "ACTIF", depot.status);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}CAS 2 — DÉPÔT 40 000 000, FACTURES 45 000 000${Z}`);
  {
    const versement = await appel("POST", "/acomptes", tC, {
      activite: "sable", client_id: clientB, amount: 40000000, bank_id: banqueId });
    const depot = versement.corps.acompte?.id;
    verifier("le dépôt de 40 000 000 est enregistré", versement.statut === 201);

    const f1 = await facture(TRIANGLE, clientB, "F084-010", 25000000);
    const f2 = await facture(TRIANGLE, clientB, "F084-011", 20000000);

    const i1 = await appel("POST", "/acomptes/affectation", tC, { activite: "sable", invoice_id: f1.id });
    verifier("la première facture (25 M) est entièrement payée",
      i1.corps.facture?.status === "PAYEE", JSON.stringify(i1.corps.facture));

    const i2 = await appel("POST", "/acomptes/affectation", tC, { activite: "sable", invoice_id: f2.id });
    verifier("la seconde (20 M) n'est que partiellement payée",
      i2.corps.facture?.status === "PARTIELLEMENT_PAYEE", JSON.stringify(i2.corps.facture));
    verifier("15 000 000 y ont été imputés", Number(i2.corps.total_impute) === 15000000,
      `${i2.corps.total_impute}`);
    verifier("il reste 5 000 000 impayés", Number(i2.corps.reste_impaye) === 5000000,
      `${i2.corps.reste_impaye}`);

    const [d] = await q(`SELECT available_amount, status FROM client_deposits WHERE id=$1`, [depot]);
    verifier("le dépôt est à zéro", Number(d.available_amount) === 0, `${d.available_amount}`);
    verifier("son statut passe à EPUISE", d.status === "EPUISE", d.status);

    const encore = await appel("POST", "/acomptes/affectation", tC, { activite: "sable", invoice_id: f2.id });
    verifier("imputer encore est refusé : plus rien de disponible",
      encore.statut === 409 && encore.corps.code === "NO_DEPOSIT_AVAILABLE",
      JSON.stringify(encore.corps));

    // ── Cas 3 : un nouveau dépôt solde la facture antérieure ──
    const nouveau = await appel("POST", "/acomptes", tC, {
      activite: "sable", client_id: clientB, amount: 5000000, bank_id: banqueId });
    verifier("un nouveau dépôt est enregistré", nouveau.statut === 201);

    const i3 = await appel("POST", "/acomptes/affectation", tC, { activite: "sable", invoice_id: f2.id });
    verifier("il s'impute sur la facture ANTÉRIEURE impayée",
      i3.statut === 200 && i3.corps.facture?.status === "PAYEE", JSON.stringify(i3.corps.facture));
    verifier("elle est soldée à l'unité près", Number(i3.corps.reste_impaye) === 0);

    const traces = await q(
      `SELECT a.amount, a.invoice_number, d.reference
         FROM client_deposit_allocations a JOIN client_deposits d ON d.id=a.deposit_id
        WHERE a.company_id=$1 AND a.invoice_id=$2 ORDER BY a.id`, [TRIANGLE, f2.id]);
    verifier("chaque allocation reste traçable, dépôt par dépôt",
      traces.length === 2 && Number(traces[0].amount) === 15000000 && Number(traces[1].amount) === 5000000
        && traces[0].reference !== traces[1].reference,
      JSON.stringify(traces));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}CAS 4 — PLUSIEURS DÉPÔTS, ORDRE FIFO${Z}`);
  {
    const [ancien] = await q(
      `INSERT INTO client_deposits
         (company_id, activity, customer_id, customer_name, reference, amount, available_amount, business_date)
       VALUES ($1,'sable',$2,'Essai 084 Client A','DEP-SAB-ANCIEN',1000000,1000000, CURRENT_DATE - 10)
       RETURNING id`, [TRIANGLE, clientA]);

    const f = await facture(TRIANGLE, clientA, "F084-020", 1500000);
    const r = await appel("POST", "/acomptes/affectation", tC, { activite: "sable", invoice_id: f.id });

    verifier("le dépôt le PLUS ANCIEN est consommé en premier",
      r.corps.imputations?.[0]?.depot === "DEP-SAB-ANCIEN",
      JSON.stringify(r.corps.imputations));
    verifier("puis le suivant complète",
      r.corps.imputations?.length === 2 && Number(r.corps.imputations[1].montant) === 500000,
      JSON.stringify(r.corps.imputations));

    const [ancienApres] = await q(`SELECT available_amount FROM client_deposits WHERE id=$1`, [ancien.id]);
    verifier("l'ancien dépôt est épuisé", Number(ancienApres.available_amount) === 0);
    const [recentApres] = await q(`SELECT available_amount FROM client_deposits WHERE id=$1`, [depot5M]);
    verifier("le plus récent conserve 2 500 000", Number(recentApres.available_amount) === 2500000,
      `${recentApres.available_amount}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}ANNULATION D'UNE IMPUTATION${Z}`);
  {
    const f = await facture(TRIANGLE, clientA, "F084-030", 500000);
    await appel("POST", "/acomptes/affectation", tC, { activite: "sable", invoice_id: f.id });
    const [alloc] = await q(
      `SELECT id, deposit_id, amount FROM client_deposit_allocations
        WHERE invoice_id=$1 AND reverses_allocation_id IS NULL`, [f.id]);
    const [avant] = await q(`SELECT available_amount FROM client_deposits WHERE id=$1`, [alloc.deposit_id]);

    const sansDroit = await appel("POST", `/acomptes/allocations/${alloc.id}/annuler`, tC,
      { reason: "tentative sans droit d'annulation" });
    verifier("le comptable n'annule pas une imputation",
      sansDroit.statut === 403 || sansDroit.statut === 404, `statut ${sansDroit.statut}`);

    const sansMotif = await appel("POST", `/acomptes/allocations/${alloc.id}/annuler`, tD, {});
    verifier("annuler sans motif est refusé",
      sansMotif.statut === 400 && sansMotif.corps.code === "REASON_REQUIRED", JSON.stringify(sansMotif.corps));

    const r = await appel("POST", `/acomptes/allocations/${alloc.id}/annuler`, tD,
      { reason: "Facture émise par erreur sur ce client." });
    verifier("l'annulation passe", r.statut === 200, JSON.stringify(r.corps));
    const [apres] = await q(`SELECT available_amount FROM client_deposits WHERE id=$1`, [alloc.deposit_id]);
    verifier("le dépôt récupère exactement ce qui avait été imputé",
      Number(apres.available_amount) - Number(avant.available_amount) === Number(alloc.amount),
      `${avant.available_amount} → ${apres.available_amount}`);

    const [facRetour] = await q(`SELECT status, remaining_amount FROM sand_invoices WHERE id=$1`, [f.id]);
    verifier("la facture redevient impayée",
      facRetour.status === "IMPAYEE" && Number(facRetour.remaining_amount) === 500000,
      JSON.stringify(facRetour));

    const [origine] = await q(`SELECT amount FROM client_deposit_allocations WHERE id=$1`, [alloc.id]);
    verifier("la ligne d'origine n'est pas effacée", Number(origine.amount) === Number(alloc.amount));

    const deuxFois = await appel("POST", `/acomptes/allocations/${alloc.id}/annuler`, tD,
      { reason: "seconde tentative d'annulation" });
    verifier("annuler deux fois est refusé",
      deuxFois.statut === 409 && deuxFois.corps.code === "ALREADY_REVERSED", JSON.stringify(deuxFois.corps));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}REMBOURSEMENT AU CLIENT${Z}`);
  {
    const [depot] = await q(
      `SELECT id, available_amount FROM client_deposits WHERE id=$1`, [depot5M]);
    const disponible = Number(depot.available_amount);
    const banqueAvant = await soldeBanque();

    const trop = await appel("POST", `/acomptes/${depot5M}/remboursement`, tD,
      { amount: disponible + 1, bank_id: banqueId, reason: "Le client réclame plus que son solde." });
    verifier("rembourser au-delà du disponible est refusé",
      trop.statut === 409 && trop.corps.code === "REFUND_ABOVE_AVAILABLE", JSON.stringify(trop.corps));

    const r = await appel("POST", `/acomptes/${depot5M}/remboursement`, tD,
      { amount: 1000000, bank_id: banqueId, reason: "Commande annulée à la demande du client." });
    verifier("le remboursement passe", r.statut === 200, JSON.stringify(r.corps).slice(0, 150));
    const banqueApres = await soldeBanque();
    verifier("l'argent RESSORT de la banque, une seule fois",
      banqueAvant - banqueApres === 1000000, `${banqueAvant} → ${banqueApres}`);
    verifier("le disponible diminue d'autant",
      Number(r.corps.disponible_apres) === disponible - 1000000, `${r.corps.disponible_apres}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}L'ÉTAT DU DÉPÔT${Z}`);
  {
    const etat = await appel("GET", `/acomptes/${depot5M}/etat`, tC);
    verifier("l'état s'établit", etat.statut === 200, JSON.stringify(etat.corps).slice(0, 120));
    verifier("il présente dépôt initial, imputations et remboursement",
      (etat.corps.lignes || []).length >= 4, `${(etat.corps.lignes || []).length} lignes`);
    verifier("chaque ligne porte un solde courant",
      (etat.corps.lignes || []).every((l) => typeof l.solde === "number"));
    verifier("le solde du détail correspond à celui de la fiche",
      etat.corps.coherent === true,
      `détail ${etat.corps.lignes?.at(-1)?.solde} / fiche ${etat.corps.depot?.solde}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}ISOLATION ENTRE SOCIÉTÉS${Z}`);
  {
    const croise = await appel("POST", "/acomptes", tF, {
      activite: "sable", client_id: clientA, amount: 100000 });
    verifier("FAT & MAT ne peut pas déposer sur un client Triangle",
      croise.statut === 404 && croise.corps.code === "CUSTOMER_NOT_FOUND", JSON.stringify(croise.corps));

    const liste = await appel("GET", "/acomptes", tF);
    verifier("elle ne voit aucun dépôt Triangle",
      (liste.corps.acomptes || []).length === 0, `${(liste.corps.acomptes || []).length}`);

    const etatCroise = await appel("GET", `/acomptes/${depot5M}/etat`, tF);
    verifier("elle ne peut pas lire l'état d'un dépôt Triangle",
      etatCroise.statut === 404, `statut ${etatCroise.statut}`);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LA SITUATION DU COMPTE CLIENT${Z}`);
  {
    const s = await appel("GET", `/acomptes/client/sable/${clientB}`, tC);
    verifier("la situation s'affiche", s.statut === 200, JSON.stringify(s.corps).slice(0, 120));
    verifier("elle totalise 45 000 000 déposés",
      Number(s.corps.total_depose) === 45000000, `${s.corps.total_depose}`);
    verifier("tout est utilisé, rien de disponible",
      Number(s.corps.total_disponible) === 0 && Number(s.corps.total_utilise) === 45000000,
      JSON.stringify({ d: s.corps.total_disponible, u: s.corps.total_utilise }));
    verifier("plus aucune facture impayée",
      Number(s.corps.total_impaye) === 0, `${s.corps.total_impaye}`);
  }

  console.log(`\n${G}BILAN${Z}`);
  console.log(`  ${reussis} réussis, ${echoues} échoués\n`);
  await pool.end();
  process.exit(echoues > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`${R}ÉCHEC : ${e.message}${Z}`); console.error(e.stack);
  await pool.end().catch(() => {});
  process.exit(1);
});

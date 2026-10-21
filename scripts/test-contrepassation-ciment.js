"use strict";
/**
 * ANNULER UN PAIEMENT DE FACTURE — CÔTÉ CIMENT.
 *
 * Le Sable savait défaire un encaissement ; le Ciment, non. Ces tests
 * éprouvent l'essentiel : la facture redevient due du montant exact, l'argent
 * ressort du compte QUI L'AVAIT REÇU (et pas d'un autre), le paiement
 * d'origine reste lisible, un second paiement de la même facture n'est pas
 * touché, et contrepasser n'est PAS rembourser — l'argent du client est
 * toujours dû tant que personne ne l'a constaté.
 */
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const BASE = "http://localhost:5050";
const SECRET = process.env.JWT_SECRET || "triangle_wms_secret_key";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let ok = 0, ko = 0;
const v = (n, c, d = "") => { if (c) { ok++; console.log(`  ✔ ${n}`); } else { ko++; console.log(`  ✘ ${n}${d ? `\n      → ${d}` : ""}`); } };
const jeton = (u) => jwt.sign({ ...u, tenant_id: "triangle" }, SECRET, { expiresIn: "1h" });
const q = async (s, p = []) => (await pool.query(s, p)).rows;
const un = async (s, p = []) => (await q(s, p))[0];

async function appel(m, chemin, { token, societe, corps } = {}) {
  const headers = { "x-tenant-id": "triangle" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (societe) headers["x-active-company-id"] = String(societe);
  if (corps !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(BASE + chemin, { method: m, headers,
    body: corps === undefined ? undefined : JSON.stringify(corps) });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

const SUPER  = { id: 900, fullname: "Super Triangle", role: "super_admin", company_id: 1, is_super_admin: true };
const SUPER_F= { id: 901, fullname: "Super Fatemat", role: "super_admin", company_id: 2, is_super_admin: true };
const COMPTA = { id: 903, fullname: "Comptable Triangle", role: "comptable", company_id: 1, is_super_admin: false };
const MAGA   = { id: 905, fullname: "Magasinier Triangle", role: "magasinier", company_id: 1, is_super_admin: false };

const F = (n) => Number(n).toLocaleString("fr-FR");
const facture = async (id) => un(`SELECT * FROM cement_invoices WHERE id=$1`, [id]);
const vente = async (id) => un(`SELECT * FROM cement_sales WHERE id=$1`, [id]);
const paiement = async (id) => un(`SELECT * FROM cement_payments WHERE id=$1`, [id]);
const soldeBanque = async (id) => Number((await un(`SELECT current_balance FROM accounting_banks WHERE id=$1`, [id]))?.current_balance || 0);
const soldeCaisse = async (id) => Number((await un(`SELECT solde_actuel FROM caisses WHERE id=$1`, [id]))?.solde_actuel || 0);
/* Les modules de vente créditent la trésorerie générale pour un encaissement
   en espèces : aucune caisse physique n'est touchée. */
const soldeTreso = async (cid = 1) => Number((await un(`SELECT current_balance FROM treasury_accounts WHERE company_id=$1`, [cid]))?.current_balance || 0);

(async () => {
  const tS = jeton(SUPER), tF = jeton(SUPER_F), tC = jeton(COMPTA), tM = jeton(MAGA);

  /* ══════════════════════════════════════════════════════════════════════
     1. L'ÉTAT DE DÉPART
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n1. Une facture de 3 000 000 réglée en deux fois");

  const f0 = await facture(1);
  v("il reste 1 000 000 dû", Number(f0.remaining_amount) === 1000000, `${F(f0.remaining_amount)}`);
  v("la facture est partiellement payée", f0.status === "PARTIELLEMENT_PAYEE");
  const bdm0 = await soldeBanque(1), caisse0 = await soldeCaisse(1), treso0 = await soldeTreso();
  v("la BDM porte les 2 200 000 encaissés", bdm0 === 22200000, `${F(bdm0)}`);
  v("la trésorerie porte les 800 000 reçus en espèces", treso0 === 800000, `${F(treso0)}`);

  /* ══════════════════════════════════════════════════════════════════════
     2. CONTREPASSER LE PAIEMENT BANCAIRE
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n2. Annuler le paiement de 1 200 000 reçu à la BDM");

  const sansMotif = await appel("POST", "/cement/payments/1/reverse", {
    token: tC, societe: 1, corps: { reason: "erreur" } });
  v("sans motif de 10 caractères, c'est refusé",
    sansMotif.status === 400 && sansMotif.data?.code === "REASON_REQUIRED", `${sansMotif.status}`);
  v("rien n'a bougé", (await soldeBanque(1)) === bdm0
    && Number((await facture(1)).remaining_amount) === 1000000);

  const r = await appel("POST", "/cement/payments/1/reverse", {
    token: tC, societe: 1,
    corps: { reason: "Virement rejeté par la banque du client, provision insuffisante" } });
  v("la contrepassation est acceptée", r.status === 200, `${r.status} ${JSON.stringify(r.data)}`);

  const f1 = await facture(1);
  v(`la facture redevient due de 2 200 000 (${F(f0.remaining_amount)} → ${F(f1.remaining_amount)})`,
    Number(f1.remaining_amount) === 2200000);
  v("le payé retombe à 800 000", Number(f1.paid_amount) === 800000, `${F(f1.paid_amount)}`);
  v("elle reste PARTIELLEMENT_PAYEE, pas IMPAYEE", f1.status === "PARTIELLEMENT_PAYEE", f1.status);

  v(`la BDM a rendu les 1 200 000 (${F(bdm0)} → ${F(await soldeBanque(1))})`,
    (await soldeBanque(1)) === bdm0 - 1200000);
  /* Le point que l'on rate : l'argent doit ressortir du compte QUI L'AVAIT
     REÇU. Le second paiement était en espèces — ni la trésorerie ni la caisse
     ne doivent bouger quand on contrepasse le paiement bancaire. */
  v("la trésorerie n'a PAS bougé", (await soldeTreso()) === treso0, `${F(await soldeTreso())}`);
  v("aucune caisse physique n'est touchée", (await soldeCaisse(1)) === caisse0, `${F(await soldeCaisse(1))}`);

  const p1 = await paiement(1);
  v("le paiement d'origine est conservé, inchangé",
    Number(p1.amount) === 1200000 && p1.payment_number === "PAY-CIM-001");
  const p2 = await paiement(2);
  v("le second paiement n'est pas touché", Number(p2.amount) === 800000);
  v("la vente suit sa facture",
    Number((await vente(1)).remaining_amount) === 2200000,
    `${F((await vente(1)).remaining_amount)}`);

  /* ══════════════════════════════════════════════════════════════════════
     3. LA TRACE
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n3. Ce que la contrepassation a écrit");

  const rev = await un(`SELECT * FROM cement_payment_reversals WHERE original_payment_id=1`);
  v("une ligne de contrepassation existe", !!rev);
  v("elle porte le montant exact", Number(rev?.amount) === 1200000);
  v("elle conserve le motif", /provision insuffisante/.test(rev?.reason || ""));
  v("elle nomme l'auteur", Number(rev?.created_by) === 903 && !!rev?.created_by_name);
  v("elle est reliée à sa transaction comptable",
    Number(rev?.reversal_accounting_transaction_id) > 0);
  /* L'essentiel de la distinction : l'écriture est défaite, l'argent non. */
  v("le remboursement est marqué EN ATTENTE", rev?.refund_pending === true);
  v("aucune date de remboursement", rev?.refunded_at === null);
  v("la réponse avertit que l'argent n'est pas revenu au client",
    /n'est pas revenu au client/.test(String(r.data?.remboursement?.avertissement)),
    String(r.data?.remboursement?.avertissement));
  v("elle précise qu'aucun virement n'a été demandé",
    /Aucun virement n'a été demandé/.test(String(r.data?.remboursement?.avertissement)));

  const mvt = await un(
    `SELECT * FROM accounting_transactions
      WHERE company_id=1 AND source_type='cement_payment_reversal' AND source_id=$1`, [rev.id]);
  v("un mouvement comptable inverse existe", !!mvt, JSON.stringify(mvt?.transaction_number));
  v("c'est une SORTIE du même montant",
    mvt?.direction === "sortie" && Number(mvt?.amount) === 1200000,
    `${mvt?.direction} ${F(mvt?.amount)}`);
  v("il vise la même banque", Number(mvt?.bank_id) === 1);

  const ecr = await q(
    `SELECT * FROM accounting_entries
      WHERE company_id=1 AND source_type='cement_payment_reversal' AND source_id=$1`, [rev.id]);
  const d = ecr.reduce((s, l) => s + Number(l.debit || 0), 0);
  const c = ecr.reduce((s, l) => s + Number(l.credit || 0), 0);
  v("les écritures inverses s'équilibrent",
    ecr.length === 2 && d === 1200000 && c === 1200000, `${ecr.length} lignes ${F(d)}/${F(c)}`);
  v("le compte de ventes ciment est débité",
    ecr.some((l) => Number(l.debit) === 1200000 && /Ventes ciment/i.test(String(l.account_label))),
    ecr.map((l) => `${l.account_label}:${l.debit}/${l.credit}`).join(" | "));

  const journal = await un(
    `SELECT * FROM cement_audit_logs WHERE action='PAYMENT_REVERSE' AND entity_id=1`);
  v("le journal d'audit a sa ligne", !!journal);
  v("il conserve l'avant et l'après",
    Number(journal?.old_value?.remaining_amount) === 1000000
    && Number(journal?.new_value?.remaining_amount) === 2200000,
    `${JSON.stringify(journal?.old_value)} → ${JSON.stringify(journal?.new_value)}`);

  /* ══════════════════════════════════════════════════════════════════════
     4. DEUX FOIS, JAMAIS
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n4. Un paiement ne se contrepasse qu'une fois");

  const bdmA = await soldeBanque(1);
  const double = await appel("POST", "/cement/payments/1/reverse", {
    token: tC, societe: 1, corps: { reason: "Tentative de seconde contrepassation du même paiement" } });
  v("la seconde est refusée",
    double.status === 409 && double.data?.code === "ALREADY_REVERSED",
    `${double.status} ${JSON.stringify(double.data)}`);
  v("la BDM n'a pas rendu l'argent deux fois", (await soldeBanque(1)) === bdmA);
  v("la facture n'a pas été recalculée deux fois",
    Number((await facture(1)).remaining_amount) === 2200000);

  /* Deux clics simultanés : c'est l'index unique qui tient, pas le contrôle. */
  const [a, b] = await Promise.all([
    appel("POST", "/cement/payments/2/reverse", { token: tC, societe: 1,
      corps: { reason: "Premier clic concurrent sur le paiement en espèces" } }),
    appel("POST", "/cement/payments/2/reverse", { token: tC, societe: 1,
      corps: { reason: "Second clic concurrent sur le paiement en espèces" } }),
  ]);
  v("un seul des deux clics simultanés passe",
    [a, b].filter((x) => x.status === 200).length === 1,
    `${a.status}/${b.status}`);
  v("la trésorerie n'a rendu l'argent qu'une fois",
    (await soldeTreso()) === treso0 - 800000, `${F(await soldeTreso())}`);
  v("et la caisse physique n'a toujours pas bougé", (await soldeCaisse(1)) === caisse0);
  v("la facture est maintenant entièrement due",
    Number((await facture(1)).remaining_amount) === 3000000
    && (await facture(1)).status === "IMPAYEE",
    `${F((await facture(1)).remaining_amount)} / ${(await facture(1)).status}`);
  v("le nombre de contrepassations est exactement 2",
    Number((await un(`SELECT count(*) c FROM cement_payment_reversals WHERE company_id=1`)).c) === 2);

  /* ══════════════════════════════════════════════════════════════════════
     5. UNE FACTURE SOLDÉE QUI REDEVIENT DUE
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n5. Une facture PAYEE redevient IMPAYEE");

  const avant2 = await facture(2);
  v("elle est payée au départ", avant2.status === "PAYEE" && Number(avant2.remaining_amount) === 0);
  const r2 = await appel("POST", "/cement/payments/3/reverse", {
    token: tC, societe: 1, corps: { reason: "Encaissement imputé à tort sur cette facture" } });
  v("la contrepassation passe", r2.status === 200, `${r2.status}`);
  const apres2 = await facture(2);
  v("la facture redevient IMPAYEE", apres2.status === "IMPAYEE", apres2.status);
  v("tout le montant redevient dû", Number(apres2.remaining_amount) === 1000000);
  /* La vente ne connaît pas « IMPAYEE » : une vente facturée dont plus rien
     n'est réglé retourne à « FACTUREE ». */
  v("la vente retourne à FACTUREE", (await vente(2)).status === "FACTUREE",
    (await vente(2)).status);

  /* ══════════════════════════════════════════════════════════════════════
     6. UN NOUVEAU PAIEMENT APRÈS CONTREPASSATION
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n6. Réencaisser après avoir contrepassé");

  /* Le piège : si le recalcul comptait encore le paiement contrepassé, la
     facture serait déclarée soldée avec un seul nouveau paiement. */
  const nouveau = await appel("POST", "/cement/invoices/2/payments", {
    token: tC, societe: 1,
    corps: { amount: 400000, payment_method: "banque", bank_id: 1, reference: "VIR-NEW" } });
  v("le nouveau paiement est accepté", nouveau.status === 201, `${nouveau.status} ${JSON.stringify(nouveau.data)}`);
  const apres3 = await facture(2);
  v("il reste 600 000 dû, pas zéro",
    Number(apres3.remaining_amount) === 600000, `${F(apres3.remaining_amount)}`);
  v("le payé est 400 000, pas 1 400 000",
    Number(apres3.paid_amount) === 400000, `${F(apres3.paid_amount)}`);

  const tropGrand = await appel("POST", "/cement/invoices/2/payments", {
    token: tC, societe: 1,
    corps: { amount: 900000, payment_method: "banque", bank_id: 1 } });
  v("un paiement supérieur au reste dû est refusé", tropGrand.status === 400, `${tropGrand.status}`);

  /* ══════════════════════════════════════════════════════════════════════
     7. CONSTATER LE REMBOURSEMENT
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n7. L'argent revient réellement au client");

  const attendus = await appel("GET", "/cement/remboursements-attendus", { token: tS, societe: 1 });
  v("la liste des remboursements dus répond", attendus.status === 200, `${attendus.status}`);
  v("elle contient les trois contrepassations",
    (attendus.data?.remboursements || []).length === 3,
    `${(attendus.data?.remboursements || []).length}`);
  v("le total dû est 3 000 000",
    Number(attendus.data?.total) === 3000000, `${F(attendus.data?.total)}`);

  const bdmB = await soldeBanque(1);
  const sansRef = await appel("POST", `/cement/reversals/${rev.id}/refunded`, {
    token: tC, societe: 1, corps: { reference: "" } });
  v("constater sans référence est refusé",
    sansRef.status === 400 && sansRef.data?.code === "REFERENCE_REQUIRED", `${sansRef.status}`);

  const constat = await appel("POST", `/cement/reversals/${rev.id}/refunded`, {
    token: tC, societe: 1, corps: { reference: "VIR-REMB-8842" } });
  v("le remboursement est constaté", constat.status === 200, `${constat.status} ${JSON.stringify(constat.data)}`);
  const revApres = await un(`SELECT * FROM cement_payment_reversals WHERE id=$1`, [rev.id]);
  v("il n'est plus en attente", revApres.refund_pending === false);
  v("la date et la référence sont conservées",
    !!revApres.refunded_at && revApres.refund_reference === "VIR-REMB-8842");
  /* LE POINT CRITIQUE : constater n'écrit AUCUN mouvement. L'argent était
     déjà sorti des comptes à la contrepassation — le refaire sortir une
     seconde fois creuserait la banque de 1 200 000 sans raison. */
  v("AUCUN nouveau mouvement d'argent n'a été écrit", (await soldeBanque(1)) === bdmB,
    `${F(bdmB)} → ${F(await soldeBanque(1))}`);
  v("la réponse le dit explicitement",
    /déjà sorti des comptes/.test(String(constat.data?.message)), String(constat.data?.message));

  const doubleConstat = await appel("POST", `/cement/reversals/${rev.id}/refunded`, {
    token: tC, societe: 1, corps: { reference: "VIR-REMB-8842" } });
  v("constater deux fois est refusé",
    doubleConstat.status === 409 && doubleConstat.data?.code === "ALREADY_REFUNDED",
    `${doubleConstat.status}`);

  const attendus2 = await appel("GET", "/cement/remboursements-attendus", { token: tS, societe: 1 });
  v("la liste n'en compte plus que deux",
    (attendus2.data?.remboursements || []).length === 2);

  /* ══════════════════════════════════════════════════════════════════════
     8. LA LECTURE D'UNE FACTURE
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n8. Relire les paiements d'une facture");

  const lecture = await appel("GET", "/cement/invoices/1/payments", { token: tS, societe: 1 });
  v("la lecture répond", lecture.status === 200, `${lecture.status}`);
  v("les deux paiements sont là, marqués contrepassés",
    (lecture.data?.paiements || []).length === 2
    && (lecture.data?.paiements || []).every((p) => p.contrepasse === true));
  v("le total encaissé est zéro", Number(lecture.data?.total_encaisse) === 0);
  v("le total contrepassé est 2 000 000",
    Number(lecture.data?.total_contrepasse) === 2000000, `${F(lecture.data?.total_contrepasse)}`);
  v("les remboursements encore dus sont 800 000 (1 200 000 déjà constaté)",
    Number(lecture.data?.remboursements_dus) === 800000, `${F(lecture.data?.remboursements_dus)}`);
  v("le motif de chaque contrepassation est lisible",
    (lecture.data?.paiements || []).every((p) => !!p.reversal_reason));

  /* ══════════════════════════════════════════════════════════════════════
     9. DROITS ET ÉTANCHÉITÉ
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n9. Qui peut défaire, et sur quelle société");

  const parMaga = await appel("POST", "/cement/payments/4/reverse", {
    token: tM, societe: 1, corps: { reason: "Tentative par un magasinier sans le droit" } });
  v("un magasinier ne peut pas contrepasser",
    parMaga.status === 403 || parMaga.status === 404, `${parMaga.status}`);

  const croise = await appel("POST", "/cement/payments/10/reverse", {
    token: tC, societe: 1, corps: { reason: "Tentative sur un paiement de l'autre société" } });
  v("on ne contrepasse pas le paiement d'une autre société",
    croise.status === 404 && croise.data?.code === "PAYMENT_NOT_FOUND",
    `${croise.status} ${JSON.stringify(croise.data)}`);
  v("la facture de FAT & MAT est intacte",
    Number((await facture(10)).remaining_amount) === 0);
  v("sa banque n'a pas bougé", (await soldeBanque(10)) === 8500000, `${F(await soldeBanque(10))}`);

  const attendusF = await appel("GET", "/cement/remboursements-attendus", { token: tF, societe: 2 });
  v("FAT & MAT ne voit pas les remboursements de Triangle",
    (attendusF.data?.remboursements || []).length === 0,
    JSON.stringify(attendusF.data?.total));

  const inconnu = await appel("POST", "/cement/payments/999999/reverse", {
    token: tC, societe: 1, corps: { reason: "Contrepassation d'un paiement inexistant" } });
  v("un paiement inexistant renvoie 404", inconnu.status === 404, `${inconnu.status}`);

  /* ══════════════════════════════════════════════════════════════════════
     10. COHÉRENCE D'ENSEMBLE
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n10. Vérification d'ensemble");

  v("aucune facture ne doit plus que son total",
    Number((await un(`SELECT count(*) c FROM cement_invoices
                       WHERE remaining_amount > total_amount`)).c) === 0);
  v("aucun payé négatif",
    Number((await un(`SELECT count(*) c FROM cement_invoices WHERE paid_amount < 0`)).c) === 0);
  v("payé + dû = total, pour chaque facture",
    Number((await un(`SELECT count(*) c FROM cement_invoices
                       WHERE ROUND(paid_amount + remaining_amount) <> ROUND(total_amount)`)).c) === 0);
  v("chaque contrepassation a sa transaction comptable",
    Number((await un(`SELECT count(*) c FROM cement_payment_reversals
                       WHERE reversal_accounting_transaction_id IS NULL`)).c) === 0);
  v("aucun paiement contrepassé deux fois",
    Number((await un(`SELECT count(*) c FROM (
                        SELECT original_payment_id FROM cement_payment_reversals
                         GROUP BY company_id, original_payment_id HAVING count(*) > 1) x`)).c) === 0);
  v("les écritures de contrepassation sont équilibrées",
    Number((await un(`SELECT COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) e
                        FROM accounting_entries
                       WHERE source_type='cement_payment_reversal'`)).e) === 0);
  v("aucun remboursement constaté sans date ni référence",
    Number((await un(`SELECT count(*) c FROM cement_payment_reversals
                       WHERE refund_pending = FALSE
                         AND (refunded_at IS NULL OR COALESCE(refund_reference,'') = '')`)).c) === 0);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${ok} réussis, ${ko} échoués`);
  console.log(ko === 0
    ? "  Un encaissement se défait, la facture redevient due, et rembourser reste à faire."
    : "  Des points restent à corriger.");
  await pool.end();
  process.exit(ko === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });

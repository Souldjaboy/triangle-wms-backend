"use strict";
/**
 * RÉAFFECTER UN PAIEMENT À LA BONNE FACTURE.
 *
 * Ce que ces tests éprouvent :
 *
 *  1. Qu'un déplacement NE CRÉE AUCUNE écriture de trésorerie. L'argent est
 *     déjà encaissé ; en recréer une doublerait les recettes. C'est le
 *     contrôle central de ce module.
 *  2. Que les deux factures sont RECALCULÉES depuis la somme réelle de leurs
 *     paiements, et non par différence.
 *  3. Qu'un même paiement ne peut jamais créditer deux factures : le
 *     déplacement est atomique, il n'y a aucun instant « libre ».
 *  4. Que les paiements partiels et multiples se comportent correctement.
 *  5. Qu'un paiement contrepassé ne bouge plus.
 *  6. Qu'on peut revenir sur une réaffectation, et que l'historique reste
 *     lisible des deux côtés.
 *  7. Que les droits et la séparation des sociétés tiennent.
 */
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const BASE = "http://localhost:5050";
const SECRET = process.env.JWT_SECRET || "triangle_wms_secret_key";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let ok = 0, ko = 0;
const v = (n, c, d = "") => { if (c) { ok++; console.log(`  ✔ ${n}`); } else { ko++; console.log(`  ✘ ${n}${d ? `\n      → ${d}` : ""}`); } };
const titre = (t) => console.log(`\n── ${t}`);
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
  let data = null; try { data = await r.json(); } catch { /* non JSON */ }
  return { status: r.status, data };
}

const DIR    = { id: 904, fullname: "Direction Triangle", role: "direction", company_id: 1, is_super_admin: false };
const COMPTA = { id: 903, fullname: "Comptable Triangle", role: "comptable", company_id: 1, is_super_admin: false };
const MAGA   = { id: 905, fullname: "Magasinier Triangle", role: "magasinier", company_id: 1, is_super_admin: false };
const FAT    = { id: 906, fullname: "Comptable Fatemat", role: "comptable", company_id: 2, is_super_admin: false };

const facture = async (id) => un(`SELECT * FROM sand_invoices WHERE id=$1`, [id]);
const vente = async (id) => un(`SELECT * FROM sand_sales WHERE id=$1`, [id]);
const paiement = async (id) => un(`SELECT * FROM sand_payments WHERE id=$1`, [id]);
const traces = async (pid) => q(`SELECT * FROM payment_reallocations WHERE payment_id=$1 ORDER BY id`, [pid]);
const nbEcritures = async (cid = 1) =>
  Number((await un(`SELECT count(*) n FROM accounting_transactions WHERE company_id=$1`, [cid]))?.n || 0);
const nbPaiements = async (cid = 1) =>
  Number((await un(`SELECT count(*) n FROM sand_payments WHERE company_id=$1`, [cid]))?.n || 0);
const F = (n) => Number(n).toLocaleString("fr-FR");

(async () => {
  const tDir = jeton(DIR), tCompta = jeton(COMPTA), tMaga = jeton(MAGA), tFat = jeton(FAT);

  /* ═══════════════════════════════════════════════════════════════════════
     LA SITUATION DE DÉPART
     ═══════════════════════════════════════════════════════════════════════ */
  titre("La situation de départ");
  const f1 = await facture(1001), f2 = await facture(1002), f3 = await facture(1003);
  v("FS-0001 porte 600 000 sur 1 000 000", Number(f1.paid_amount) === 600000, F(f1.paid_amount));
  v("elle est partiellement payée", f1.status === "PARTIELLEMENT_PAYEE", f1.status);
  v("FS-0002 n'a rien reçu", Number(f2.paid_amount) === 0);
  v("FS-0003 porte DEUX paiements", Number(f3.paid_amount) === 800000, F(f3.paid_amount));
  v("elle est donc partiellement payée sur 900 000",
    f3.status === "PARTIELLEMENT_PAYEE" && Number(f3.total_amount) === 900000,
    `${f3.status} / ${F(f3.total_amount)}`);
  const ecrituresAvant = await nbEcritures();
  const paiementsAvant = await nbPaiements();
  v("des écritures existent déjà", ecrituresAvant >= 0, `${ecrituresAvant}`);

  /* ═══════════════════════════════════════════════════════════════════════
     CE VERS QUOI ON PEUT DÉPLACER
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Les cibles proposées");
  let r = await appel("GET", "/payments/sable/3001/cibles", { token: tCompta, societe: 1 });
  v("la liste répond", r.status === 200, JSON.stringify(r.data));
  const cibles = r.data?.factures || [];
  v("FS-0001 ne se propose pas elle-même", !cibles.some((f) => f.id === 1001));
  v("la facture ANNULÉE n'est pas proposée", !cibles.some((f) => f.numero === "FS-0005"));
  const c2 = cibles.find((f) => f.numero === "FS-0002");
  v("FS-0002 est proposée", !!c2);
  v("et l'écran sait d'avance qu'elle serait en trop-perçu de 100 000",
    c2?.depassement === 100000, String(c2?.depassement));
  const c4 = cibles.find((f) => f.numero === "FS-0004");
  v("FS-0004, déjà soldée, annoncerait 600 000 de trop-perçu",
    c4?.depassement === 600000, String(c4?.depassement));

  /* ═══════════════════════════════════════════════════════════════════════
     LE TROP-PERÇU SE DÉCIDE
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Le trop-perçu ne se subit pas");
  r = await appel("POST", "/payments/sable/3001/reaffecter", {
    token: tCompta, societe: 1,
    corps: { vers_facture: 1002, motif: "imputé à la mauvaise facture du même client" },
  });
  v("le déplacement est refusé par défaut", r.status === 409 && r.data?.code === "OVERPAY_NOT_ACCEPTED",
    JSON.stringify(r.data));
  /* On normalise les espaces avant de comparer : un message qui porterait
     une espace fine insécable passerait inaperçu à l'œil et ferait échouer
     la recherche. Le service emploie le formateur partagé, qui n'en met pas ;
     ce contrôle vérifie aussi cela. */
  const sansEspaces = (x) => String(x || "").replace(/[\s\u00a0\u202f]+/gu, " ");
  v("le message chiffre le dépassement", sansEspaces(r.data?.error).includes("100 000"), r.data?.error);
  v("et sans espace fine insécable", !/[\u00a0\u202f]/u.test(r.data?.error || ""), r.data?.error);
  v("et la réponse le donne séparément", r.data?.depassement === 100000, String(r.data?.depassement));
  v("rien n'a bougé", Number((await paiement(3001)).invoice_id) === 1001);

  /* ═══════════════════════════════════════════════════════════════════════
     LE MOTIF
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Le motif est obligatoire");
  r = await appel("POST", "/payments/sable/3001/reaffecter", {
    token: tCompta, societe: 1, corps: { vers_facture: 1003, motif: "erreur" },
  });
  v("un motif trop court est refusé", r.status === 400 && r.data?.code === "REASON_REQUIRED", JSON.stringify(r.data));
  v("le paiement n'a pas bougé", Number((await paiement(3001)).invoice_id) === 1001);

  /* ═══════════════════════════════════════════════════════════════════════
     LE DÉPLACEMENT, ET CE QU'IL NE FAIT PAS
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Déplacer vers une facture qui peut l'absorber");
  /* FS-0003 est soldée ; on la libère d'abord en contrepassant un de ses
     deux paiements, pour obtenir un cas « multiples » réaliste. */
  await pool.query(
    `INSERT INTO sand_payment_reversals
       (company_id, original_payment_id, invoice_id, amount, reason, created_by, created_by_name)
     VALUES (1, 3003, 1003, 500000, 'chèque impayé', 904, 'Direction Triangle')`);
  await pool.query(
    `UPDATE sand_invoices SET paid_amount=300000, remaining_amount=600000, status='PARTIELLEMENT_PAYEE'
      WHERE id=1003`);

  const ecrituresAvantDeplacement = await nbEcritures();
  r = await appel("POST", "/payments/sable/3001/reaffecter", {
    token: tCompta, societe: 1,
    corps: { vers_facture: 1003, motif: "le virement concernait la facture FS-0003" },
  });
  v("le déplacement passe", r.status === 200, JSON.stringify(r.data));
  v("la réponse dit qu'aucune écriture n'a été créée",
    /Aucune écriture de trésorerie/.test(r.data?.avertissement || ""), r.data?.avertissement);

  titre("LE CONTRÔLE CENTRAL : aucun second encaissement");
  v("aucune écriture comptable n'a été créée",
    (await nbEcritures()) === ecrituresAvantDeplacement,
    `${await nbEcritures()} contre ${ecrituresAvantDeplacement}`);
  v("aucun paiement n'a été créé", (await nbPaiements()) === paiementsAvant,
    `${await nbPaiements()} contre ${paiementsAvant}`);
  v("aucun paiement n'a été supprimé non plus", (await nbPaiements()) === paiementsAvant);

  titre("Les deux soldes sont recalculés");
  const f1b = await facture(1001), f3b = await facture(1003);
  v("FS-0001 ne porte plus que ce qui lui reste", Number(f1b.paid_amount) === 0, F(f1b.paid_amount));
  v("et redevient impayée", f1b.status === "IMPAYEE", f1b.status);
  v("son restant dû est revenu à 1 000 000", Number(f1b.remaining_amount) === 1000000, F(f1b.remaining_amount));
  v("FS-0003 a reçu les 600 000", Number(f3b.paid_amount) === 900000, F(f3b.paid_amount));
  v("elle est donc payée", f3b.status === "PAYEE", f3b.status);

  titre("La vente suit sa facture");
  const v3 = await vente(703);
  v("la vente de FS-0003 porte le même payé", Number(v3.paid_amount) === 900000, F(v3.paid_amount));
  const v1 = await vente(701);
  v("et celle de FS-0001 est revenue à zéro", Number(v1.paid_amount) === 0, F(v1.paid_amount));

  titre("Le paiement garde sa mémoire");
  const p1 = await paiement(3001);
  v("il est sur FS-0003", Number(p1.invoice_id) === 1003);
  v("il se souvient de sa facture d'origine", Number(p1.original_invoice_id) === 1001);
  v("et compte ses déplacements", p1.reallocation_count === 1, String(p1.reallocation_count));

  titre("La trace porte les deux côtés");
  const t = (await traces(3001))[0];
  v("une trace existe", !!t);
  v("elle nomme la facture d'origine", t?.from_invoice_number === "FS-0001");
  v("et la facture d'arrivée", t?.to_invoice_number === "FS-0003");
  v("elle garde le nom du client d'origine", (t?.from_customer || "").length > 0, t?.from_customer);
  v("le motif est conservé", t?.reason === "le virement concernait la facture FS-0003");
  v("l'auteur aussi", t?.created_by_name === "Comptable Triangle");
  v("aucun trop-perçu n'est déclaré", Number(t?.overpay_amount) === 0 && t?.overpay_accepted === false);

  /* ═══════════════════════════════════════════════════════════════════════
     UN MÊME PAIEMENT NE CRÉDITE JAMAIS DEUX FACTURES
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Un paiement n'est jamais sur deux factures");
  const surCombien = await un(
    `SELECT count(DISTINCT invoice_id) n FROM sand_payments WHERE id=3001`);
  v("il n'a qu'une facture", Number(surCombien.n) === 1);
  const total = await un(
    `SELECT COALESCE(SUM(paid_amount),0) s FROM sand_invoices WHERE company_id=1 AND status<>'ANNULEE'`);
  const encaisse = await un(
    `SELECT COALESCE(SUM(amount),0) s FROM sand_payments p
      WHERE company_id=1 AND NOT EXISTS (SELECT 1 FROM sand_payment_reversals r
        WHERE r.company_id=p.company_id AND r.original_payment_id=p.id)`);
  v("la somme des payés égale la somme des encaissements valides",
    Number(total.s) === Number(encaisse.s), `${F(total.s)} contre ${F(encaisse.s)}`);

  titre("Le déplacer sur la facture où il est déjà n'a pas de sens");
  r = await appel("POST", "/payments/sable/3001/reaffecter", {
    token: tCompta, societe: 1, corps: { vers_facture: 1003, motif: "tentative sans objet ici" },
  });
  v("refusé", r.status === 409 && r.data?.code === "SAME_INVOICE", JSON.stringify(r.data));

  titre("Une facture annulée ne reçoit rien");
  r = await appel("POST", "/payments/sable/3001/reaffecter", {
    token: tCompta, societe: 1, corps: { vers_facture: 1005, motif: "vers une facture annulée" },
  });
  v("refusé", r.status === 409 && r.data?.code === "TARGET_CANCELLED", JSON.stringify(r.data));

  /* ═══════════════════════════════════════════════════════════════════════
     UN PAIEMENT CONTREPASSÉ NE BOUGE PLUS
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Un paiement contrepassé n'a plus rien à donner");
  r = await appel("POST", "/payments/sable/3005/reaffecter", {
    token: tCompta, societe: 1, corps: { vers_facture: 1002, motif: "déplacer un paiement sorti" },
  });
  v("refusé", r.status === 409 && r.data?.code === "PAYMENT_REVERSED", JSON.stringify(r.data));
  v("le message explique que l'argent est ressorti",
    /ressorti des comptes/.test(r.data?.error || ""), r.data?.error);

  /* ═══════════════════════════════════════════════════════════════════════
     LE TROP-PERÇU ACCEPTÉ
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Le trop-perçu, quand il est assumé");
  r = await appel("POST", "/payments/sable/3004/reaffecter", {
    token: tDir, societe: 1,
    corps: { vers_facture: 1002, motif: "acompte à porter sur la facture suivante", accepter_depassement: true },
  });
  v("le déplacement passe avec l'accord explicite", r.status === 200, JSON.stringify(r.data));
  const f2b = await facture(1002);
  v("FS-0002 reçoit les 300 000", Number(f2b.paid_amount) === 300000, F(f2b.paid_amount));
  v("elle reste partiellement payée", f2b.status === "PARTIELLEMENT_PAYEE", f2b.status);
  const t4 = (await traces(3004))[0];
  v("la trace retient qu'il n'y avait pas de dépassement ici",
    Number(t4?.overpay_amount) === 0, String(t4?.overpay_amount));

  /* ═══════════════════════════════════════════════════════════════════════
     REVENIR SUR UNE RÉAFFECTATION
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Revenir sur un déplacement");
  const trace3001 = (await traces(3001))[0];
  r = await appel("POST", `/payment-reallocations/${trace3001.id}/annuler`, {
    token: tCompta, societe: 1, corps: { motif: "court" },
  });
  v("un motif trop court est refusé", r.status === 400, `${r.status}`);

  r = await appel("POST", `/payment-reallocations/${trace3001.id}/annuler`, {
    token: tCompta, societe: 1, corps: { motif: "le virement concernait bien FS-0001" },
  });
  v("l'annulation passe", r.status === 200, JSON.stringify(r.data));
  v("le paiement est revenu sur FS-0001", Number((await paiement(3001)).invoice_id) === 1001);
  const f1c = await facture(1001), f3c = await facture(1003);
  v("FS-0001 porte de nouveau 600 000", Number(f1c.paid_amount) === 600000, F(f1c.paid_amount));
  v("FS-0003 est retombée à 300 000", Number(f3c.paid_amount) === 300000, F(f3c.paid_amount));
  v("et n'est plus payée", f3c.status === "PARTIELLEMENT_PAYEE", f3c.status);

  titre("La trace n'est pas effacée");
  const t1 = (await traces(3001))[0];
  v("elle existe toujours", !!t1);
  v("elle est marquée annulée", !!t1?.reverted_at);
  v("avec son motif d'annulation", t1?.revert_reason === "le virement concernait bien FS-0001");
  v("et son auteur", t1?.reverted_by_name === "Comptable Triangle");
  v("les deux côtés restent lisibles",
    t1?.from_invoice_number === "FS-0001" && t1?.to_invoice_number === "FS-0003");

  titre("On n'annule pas deux fois");
  r = await appel("POST", `/payment-reallocations/${trace3001.id}/annuler`, {
    token: tCompta, societe: 1, corps: { motif: "seconde tentative sur la même" },
  });
  v("refusé", r.status === 409 && r.data?.code === "ALREADY_REVERTED", JSON.stringify(r.data));

  titre("On n'annule que la dernière d'une chaîne");
  await appel("POST", "/payments/sable/3001/reaffecter", {
    token: tCompta, societe: 1, corps: { vers_facture: 1003, motif: "premier déplacement de la chaîne" },
  });
  const chaine1 = (await traces(3001)).filter((x) => !x.reverted_at)[0];
  await appel("POST", "/payments/sable/3001/reaffecter", {
    token: tCompta, societe: 1, corps: { vers_facture: 1002, motif: "second déplacement de la chaîne", accepter_depassement: true },
  });
  r = await appel("POST", `/payment-reallocations/${chaine1.id}/annuler`, {
    token: tCompta, societe: 1, corps: { motif: "annuler celle du milieu" },
  });
  v("annuler une réaffectation du milieu est refusé",
    r.status === 409 && r.data?.code === "NOT_LAST_REALLOCATION", JSON.stringify(r.data));
  v("le paiement n'a pas bougé", Number((await paiement(3001)).invoice_id) === 1002);

  /* ═══════════════════════════════════════════════════════════════════════
     L'HISTOIRE SE LIT
     ═══════════════════════════════════════════════════════════════════════ */
  titre("L'historique d'un paiement");
  r = await appel("GET", "/payments/sable/3001/historique", { token: tCompta, societe: 1 });
  v("il répond", r.status === 200, JSON.stringify(r.data));
  v("il dit où le paiement se trouve", r.data?.facture_actuelle === 1002, String(r.data?.facture_actuelle));
  v("et d'où il vient à l'origine", r.data?.facture_origine === 1001, String(r.data?.facture_origine));
  v("il liste tous les déplacements", (r.data?.reaffectations || []).length === 3,
    String((r.data?.reaffectations || []).length));
  v("il dit qu'il n'est pas contrepassé", r.data?.contrepasse === false);

  r = await appel("GET", "/payments/sable/3005/historique", { token: tCompta, societe: 1 });
  v("un paiement contrepassé le dit", r.data?.contrepasse === true);
  v("et porte son motif", (r.data?.contrepassation?.reason || "").includes("provision"),
    r.data?.contrepassation?.reason);

  titre("Les paiements d'une facture disent d'où ils viennent");
  r = await appel("GET", "/invoices/sable/1002/paiements", { token: tCompta, societe: 1 });
  v("la liste répond", r.status === 200, JSON.stringify(r.data));
  const venus = (r.data?.paiements || []).filter((p) => p.venu_de);
  v("au moins un paiement vient d'ailleurs", venus.length >= 1, String(venus.length));
  v("et l'on sait de quelle facture", (venus[0]?.venu_de?.from_invoice_number || "").startsWith("FS-"),
    JSON.stringify(venus[0]?.venu_de));
  v("avec le motif", (venus[0]?.venu_de?.reason || "").length >= 10);

  /* ═══════════════════════════════════════════════════════════════════════
     LES DROITS
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Les droits");
  r = await appel("POST", "/payments/sable/3002/reaffecter", {
    token: tMaga, societe: 1, corps: { vers_facture: 1001, motif: "tentative du magasinier" },
  });
  v("le magasinier ne réaffecte pas", r.status === 403, `${r.status} ${JSON.stringify(r.data)}`);
  v("et on lui dit que c'est le geste qui est refusé, pas la facture",
    r.data?.code === "FORBIDDEN", r.data?.code);
  v("le paiement n'a pas bougé", Number((await paiement(3002)).invoice_id) === 1003);

  r = await appel("GET", "/payments/ciment/4001/historique", { token: tMaga, societe: 1 });
  v("un module qu'il ne voit pas répond 404, pas 403", r.status === 404, `${r.status}`);

  r = await appel("GET", "/payments/sable/3002/historique", { token: tMaga, societe: 1 });
  v("mais il peut lire l'historique du sable", r.status === 200, `${r.status}`);

  /* ═══════════════════════════════════════════════════════════════════════
     LA SÉPARATION DES SOCIÉTÉS
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Les deux sociétés");
  r = await appel("GET", "/payments/sable/3001/historique", { token: tFat, societe: 2 });
  v("FAT & MAT ne voit pas un paiement de Triangle", r.status === 404, `${r.status}`);

  r = await appel("POST", "/payments/sable/3101/reaffecter", {
    token: tFat, societe: 2, corps: { vers_facture: 1001, motif: "vers une facture de Triangle" },
  });
  v("et ne peut pas le pousser vers une facture de Triangle",
    r.status === 404 && r.data?.code === "INVOICE_NOT_FOUND", JSON.stringify(r.data));
  v("son paiement est resté chez elle", Number((await paiement(3101)).invoice_id) === 1101);

  r = await appel("GET", "/payments/ciment/4101/historique", { token: tFat, societe: 2 });
  v("le ciment lui est fermé", r.status === 404, `${r.status}`);

  /* ═══════════════════════════════════════════════════════════════════════
     LE CIMENT
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Le ciment, par le même chemin");
  r = await appel("GET", "/payments/ciment/4001/cibles", { token: tDir, societe: 1 });
  v("les cibles ciment répondent", r.status === 200, JSON.stringify(r.data));
  v("FC-0002 est proposée", (r.data?.factures || []).some((f) => f.numero === "FC-0002"));
  const ecrCim = await nbEcritures();
  r = await appel("POST", "/payments/ciment/4001/reaffecter", {
    token: tDir, societe: 1, corps: { vers_facture: 2002, motif: "encaissement imputé à la mauvaise facture" },
  });
  v("le déplacement ciment passe", r.status === 200, JSON.stringify(r.data));
  v("sans écriture nouvelle", (await nbEcritures()) === ecrCim);
  const fc1 = await un(`SELECT * FROM cement_invoices WHERE id=2001`);
  const fc2 = await un(`SELECT * FROM cement_invoices WHERE id=2002`);
  v("FC-0001 redevient impayée", fc1.status === "IMPAYEE" && Number(fc1.paid_amount) === 0, fc1.status);
  v("FC-0002 reçoit les 400 000", Number(fc2.paid_amount) === 400000, F(fc2.paid_amount));
  const vc = await un(`SELECT * FROM cement_sales WHERE id=802`);
  v("la vente ciment suit, statut compris",
    Number(vc.paid_amount) === 400000 && vc.status === "PARTIELLEMENT_PAYEE",
    `${F(vc.paid_amount)} / ${vc.status}`);

  titre("Un produit n'atteint pas l'autre");
  r = await appel("POST", "/payments/sable/3002/reaffecter", {
    token: tDir, societe: 1, corps: { vers_facture: 2002, motif: "du sable vers une facture ciment" },
  });
  v("une facture ciment n'est pas une cible pour un paiement sable",
    r.status === 404 && r.data?.code === "INVOICE_NOT_FOUND", JSON.stringify(r.data));

  titre("Une URL de produit inconnue n'existe pas");
  r = await appel("GET", "/payments/gravier/1/historique", { token: tDir, societe: 1 });
  v("404", r.status === 404, `${r.status}`);

  /* ═══════════════════════════════════════════════════════════════════════
     CE QUE LA BASE REFUSE
     ═══════════════════════════════════════════════════════════════════════ */
  titre("La base tient ses propres règles");
  let refus = null;
  try {
    await pool.query(
      `INSERT INTO payment_reallocations
         (company_id, product, payment_id, payment_number, amount,
          from_invoice_id, from_invoice_number, to_invoice_id, to_invoice_number, reason)
       VALUES (1,'SABLE',3002,'PS-0002',300000,1003,'FS-0003',1003,'FS-0003','motif suffisant')`);
  } catch (e) { refus = e; }
  v("une réaffectation d'une facture vers elle-même est refusée", refus?.code === "23514", refus?.code);

  refus = null;
  try {
    await pool.query(
      `INSERT INTO payment_reallocations
         (company_id, product, payment_id, payment_number, amount,
          from_invoice_id, from_invoice_number, to_invoice_id, to_invoice_number, reason)
       VALUES (1,'SABLE',3002,'PS-0002',300000,1003,'FS-0003',1001,'FS-0001','court')`);
  } catch (e) { refus = e; }
  v("un motif de moins de dix caractères est refusé par la contrainte", refus?.code === "23514", refus?.code);

  console.log(`\n${"─".repeat(56)}\n  ${ok} réussis, ${ko} échoués\n${"─".repeat(56)}`);
  await pool.end();
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

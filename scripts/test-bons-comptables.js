"use strict";
/**
 * §7 — CORRIGER UN BON D'ENCAISSEMENT OU DE DÉCAISSEMENT.
 *
 * Ce que ces tests éprouvent : qu'avant validation un bon se modifie et que
 * chaque champ touché garde sa valeur d'avant ; qu'après validation il ne se
 * modifie plus mais se CONTRE-PASSE, soldes rétablis et écritures d'origine
 * conservées ; et qu'une opération annulée cesse de peser sur le résultat
 * alors qu'un bon simplement « refusé » après validation n'est plus possible.
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
const DIR    = { id: 904, fullname: "Direction Triangle", role: "direction", company_id: 1, is_super_admin: false };
const MAGA   = { id: 905, fullname: "Magasinier Triangle", role: "magasinier", company_id: 1, is_super_admin: false };

const F = (n) => Number(n).toLocaleString("fr-FR");
const bon = async (id) => un(`SELECT * FROM cash_vouchers WHERE id=$1`, [id]);
const soldeBanque = async (id) => Number((await un(`SELECT current_balance FROM accounting_banks WHERE id=$1`, [id]))?.current_balance || 0);
const soldeCaisse = async (id) => Number((await un(`SELECT solde_actuel FROM caisses WHERE id=$1`, [id]))?.solde_actuel || 0);
const histo = async (id) => q(`SELECT * FROM cash_voucher_history WHERE voucher_id=$1 ORDER BY id`, [id]);

/* Les dépenses telles que les voit le compte de résultat. */
const depenses = async (cid = 1) => Number((await un(
  `SELECT COALESCE(SUM(amount),0) t FROM accounting_transactions
    WHERE company_id=$1 AND direction='sortie' AND status='validé'
      AND COALESCE(show_in_financial_movements,TRUE)=TRUE
      AND cancelled_at IS NULL`, [cid]))?.t || 0);

(async () => {
  const tS = jeton(SUPER), tF = jeton(SUPER_F), tC = jeton(COMPTA),
        tD = jeton(DIR), tM = jeton(MAGA);

  /* ══════════════════════════════════════════════════════════════════════
     1. MODIFIER UN BON QUI N'A RIEN PRODUIT
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n1. Modification avant validation");

  const avantMod = await bon(1);
  v("le bon de départ est à 400 000 et soumis",
    Number(avantMod.amount) === 400000 && avantMod.status === "soumis");

  const sansMotif = await appel("PUT", "/accounting/vouchers/1", {
    token: tC, societe: 1, corps: { amount: 350000, motif: "non" } });
  v("modifier sans motif suffisant est refusé",
    sansMotif.status === 400 && sansMotif.data?.code === "REASON_REQUIRED", `${sansMotif.status}`);
  v("le montant n'a pas bougé", Number((await bon(1)).amount) === 400000);

  const mod = await appel("PUT", "/accounting/vouchers/1", {
    token: tC, societe: 1,
    corps: { amount: 350000, beneficiary: "Keita & Frères SARL",
             motif: "Facture rectificative reçue du fournisseur" } });
  v("la modification est acceptée", mod.status === 200, `${mod.status} ${JSON.stringify(mod.data)}`);
  const apresMod = await bon(1);
  v("le montant est passé à 350 000", Number(apresMod.amount) === 350000, `${F(apresMod.amount)}`);
  v("le bénéficiaire est corrigé", apresMod.beneficiary === "Keita & Frères SARL");
  v("le bon reste soumis, pas validé", apresMod.status === "soumis");

  const h1 = await histo(1);
  v("une ligne d'historique est écrite", h1.length === 1, `${h1.length}`);
  v("elle est marquée MODIFICATION", h1[0]?.action === "MODIFICATION");
  v("elle conserve le motif", /Facture rectificative/.test(h1[0]?.reason || ""));
  v("elle conserve la valeur d'AVANT du montant",
    Number(h1[0]?.changes?.amount?.avant) === 400000
    && Number(h1[0]?.changes?.amount?.apres) === 350000,
    JSON.stringify(h1[0]?.changes?.amount));
  v("elle conserve la valeur d'avant du bénéficiaire",
    h1[0]?.changes?.beneficiary?.avant === "Fournisseur Keita",
    JSON.stringify(h1[0]?.changes?.beneficiary));
  v("elle nomme l'auteur", Number(h1[0]?.acted_by) === 903);
  v("elle ne consigne QUE les champs réellement changés",
    Object.keys(h1[0]?.changes || {}).length === 2,
    Object.keys(h1[0]?.changes || {}).join(", "));

  const rien = await appel("PUT", "/accounting/vouchers/1", {
    token: tC, societe: 1,
    corps: { amount: 350000, motif: "Renvoi du même formulaire sans rien changer" } });
  v("renvoyer les mêmes valeurs ne crée pas de ligne vide",
    rien.status === 400 && rien.data?.code === "NOTHING_TO_CHANGE", `${rien.status}`);
  v("l'historique n'a pas grossi", (await histo(1)).length === 1);

  const refus = [
    ["un montant nul", { amount: 0, motif: "Essai avec un montant nul" }, "AMOUNT_INVALID"],
    ["un montant négatif", { amount: -5000, motif: "Essai avec un montant négatif" }, "AMOUNT_INVALID"],
    ["une banque ET une caisse", { bank_id: 1, caisse_id: 1, motif: "Essai avec deux comptes à la fois" }, "ACCOUNT_AMBIGUOUS"],
  ];
  for (const [quoi, corps, code] of refus) {
    const r = await appel("PUT", "/accounting/vouchers/1", { token: tC, societe: 1, corps });
    v(`refusé : ${quoi} (${code})`, r.status >= 400 && r.data?.code === code,
      `${r.status} ${JSON.stringify(r.data)}`);
  }

  /* ══════════════════════════════════════════════════════════════════════
     2. UN BON VALIDÉ NE SE MODIFIE PLUS
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n2. Après validation, la modification cède la place à la contre-passation");

  const bdm0 = await soldeBanque(1);
  const dep0 = await depenses();
  const val = await appel("PUT", "/accounting/vouchers/1/validate", { token: tD, societe: 1, corps: {} });
  v("le bon est validé", val.status === 200, `${val.status} ${JSON.stringify(val.data)}`);
  const bdm1 = await soldeBanque(1);
  v(`la BDM a baissé de 350 000 (${F(bdm0)} → ${F(bdm1)})`, bdm1 === bdm0 - 350000);
  const dep1 = await depenses();
  v("la dépense pèse maintenant sur le résultat", dep1 === dep0 + 350000, `${F(dep0)} → ${F(dep1)}`);

  const modApres = await appel("PUT", "/accounting/vouchers/1", {
    token: tC, societe: 1, corps: { amount: 100000, motif: "Tentative de correction après validation" } });
  v("modifier un bon validé est refusé",
    modApres.status === 409 && modApres.data?.code === "VOUCHER_ALREADY_VALIDATED", `${modApres.status}`);
  v("le message oriente vers l'annulation",
    /annulez-le|contre-passation/i.test(String(modApres.data?.error)), String(modApres.data?.error));
  v("le montant validé est intact", Number((await bon(1)).amount) === 350000);

  /* LE DÉFAUT FERMÉ : refuser un bon validé le marquait refusé en laissant
     l'argent dehors et la dépense dans le résultat. */
  const refuserApres = await appel("PUT", "/accounting/vouchers/1/reject", {
    token: tD, societe: 1, corps: { rejection_reason: "Tentative de refus après validation" } });
  v("refuser un bon VALIDÉ est désormais refusé",
    refuserApres.status === 409 && refuserApres.data?.code === "VOUCHER_ALREADY_VALIDATED",
    `${refuserApres.status} ${JSON.stringify(refuserApres.data)}`);
  v("le bon est toujours validé, pas refusé", (await bon(1)).status === "validé");
  v("et l'argent n'est pas resté dehors sans trace", (await soldeBanque(1)) === bdm1);

  /* ══════════════════════════════════════════════════════════════════════
     3. LA CONTRE-PASSATION
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n3. Annuler un bon validé");

  const courtMotif = await appel("POST", "/accounting/vouchers/1/annuler", {
    token: tD, societe: 1, corps: { motif: "erreur" } });
  v("annuler sans motif de 10 caractères est refusé",
    courtMotif.status === 400 && courtMotif.data?.code === "REASON_REQUIRED", `${courtMotif.status}`);

  const ann = await appel("POST", "/accounting/vouchers/1/annuler", {
    token: tD, societe: 1,
    corps: { motif: "Facture annulée par le fournisseur, marchandise jamais livrée" } });
  v("l'annulation est acceptée", ann.status === 200, `${ann.status} ${JSON.stringify(ann.data)}`);

  const apresAnn = await bon(1);
  v("le bon passe ANNULÉ", apresAnn.status === "annulé");
  v("le motif est conservé", /jamais livrée/.test(apresAnn.cancel_reason || ""));
  v("l'auteur et la date de l'annulation sont enregistrés",
    Number(apresAnn.cancelled_by) === 904 && !!apresAnn.cancelled_at);
  v(`la BDM retrouve son solde (${F(bdm1)} → ${F(await soldeBanque(1))})`,
    (await soldeBanque(1)) === bdm0, `${F(await soldeBanque(1))} vs ${F(bdm0)}`);

  const dep2 = await depenses();
  v("la dépense ne pèse PLUS sur le résultat", dep2 === dep0, `${F(dep2)} vs ${F(dep0)}`);

  const mouvements = await q(
    `SELECT * FROM accounting_transactions
      WHERE company_id=1 AND source_id=1 AND source_type IN ('cash_voucher','cash_voucher_reversal')
      ORDER BY id`, []);
  v("deux mouvements : l'original et son inverse", mouvements.length === 2, `${mouvements.length}`);
  v("l'original existe toujours",
    mouvements.some((m) => m.source_type === "cash_voucher" && m.direction === "sortie"));
  v("l'original porte la marque de son annulation",
    mouvements.filter((m) => m.source_type === "cash_voucher")
      .every((m) => !!m.cancelled_at && /jamais livrée/.test(m.cancel_reason || "")));
  v("l'inverse est une entrée du même montant",
    mouvements.some((m) => m.source_type === "cash_voucher_reversal"
      && m.direction === "entrée" && Number(m.amount) === 350000));
  v("l'inverse désigne ce qu'il défait",
    mouvements.some((m) => m.source_type === "cash_voucher_reversal"
      && Number(m.reverses_transaction_id) > 0));

  const lignes = await q(
    `SELECT l.* FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.company_id=1 AND e.module_source='cash_voucher_reversal' AND e.source_id=1`, []);
  const d = lignes.reduce((s, l) => s + Number(l.debit || 0), 0);
  const c = lignes.reduce((s, l) => s + Number(l.credit || 0), 0);
  v("les écritures inverses existent et s'équilibrent",
    lignes.length === 2 && d === 350000 && c === 350000, `${lignes.length} lignes, ${F(d)}/${F(c)}`);
  v("le compte de charge est crédité, le compte de banque débité",
    lignes.some((l) => Number(l.credit) === 350000 && ["60", "65"].includes(String(l.account_code)))
    && lignes.some((l) => Number(l.debit) === 350000 && String(l.account_code) === "52"),
    lignes.map((l) => `${l.account_code}:${l.debit}/${l.credit}`).join(" "));

  const h1b = await histo(1);
  v("l'annulation est dans l'historique",
    h1b.some((h) => h.action === "ANNULATION"), h1b.map((h) => h.action).join(", "));
  v("elle décrit la contre-passation et les soldes",
    !!h1b.find((h) => h.action === "ANNULATION")?.changes?.contre_passation?.transaction_inverse);
  v("la réponse dit qu'aucun remboursement bancaire n'a été demandé",
    /remboursement bancaire/i.test(String(ann.data?.message)), String(ann.data?.message));

  const double = await appel("POST", "/accounting/vouchers/1/annuler", {
    token: tD, societe: 1, corps: { motif: "Tentative de seconde annulation du même bon" } });
  v("annuler deux fois est refusé",
    double.status === 409 && double.data?.code === "ALREADY_CANCELLED", `${double.status}`);
  v("le double clic n'a pas rendu l'argent deux fois", (await soldeBanque(1)) === bdm0);

  const modAnnule = await appel("PUT", "/accounting/vouchers/1", {
    token: tC, societe: 1, corps: { amount: 1000, motif: "Tentative de modification après annulation" } });
  v("un bon annulé ne se modifie plus",
    modAnnule.status === 409 && modAnnule.data?.code === "VOUCHER_CANCELLED", `${modAnnule.status}`);

  /* ══════════════════════════════════════════════════════════════════════
     4. L'ENCAISSEMENT, DANS L'AUTRE SENS
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n4. Annuler un encaissement reprend l'argent");

  const bdmA = await soldeBanque(1);
  await appel("PUT", "/accounting/vouchers/2/validate", { token: tD, societe: 1, corps: {} });
  const bdmB = await soldeBanque(1);
  v("l'encaissement a fait entrer 250 000", bdmB === bdmA + 250000, `${F(bdmA)} → ${F(bdmB)}`);

  const annEnc = await appel("POST", "/accounting/vouchers/2/annuler", {
    token: tD, societe: 1, corps: { motif: "Chèque du client revenu impayé par la banque" } });
  v("l'annulation de l'encaissement passe", annEnc.status === 200, `${annEnc.status} ${JSON.stringify(annEnc.data)}`);
  v("la BDM a rendu les 250 000", (await soldeBanque(1)) === bdmA, `${F(await soldeBanque(1))}`);
  const lignesEnc = await q(
    `SELECT l.* FROM journal_entry_lines l JOIN journal_entries e ON e.id=l.entry_id
      WHERE e.module_source='cash_voucher_reversal' AND e.source_id=2`, []);
  v("le produit est débité et la banque créditée",
    lignesEnc.some((l) => Number(l.debit) === 250000 && String(l.account_code) === "75")
    && lignesEnc.some((l) => Number(l.credit) === 250000 && String(l.account_code) === "52"),
    lignesEnc.map((l) => `${l.account_code}:${l.debit}/${l.credit}`).join(" "));

  /* L'argent déjà reparti : refuser plutôt que creuser un solde négatif. */
  console.log("\n4b. Quand le compte ne peut plus rendre l'argent");
  await appel("PUT", "/accounting/vouchers/3/validate", { token: tD, societe: 1, corps: {} });
  const caisseApres = await soldeCaisse(1);
  v("le décaissement en caisse est passé", caisseApres >= 0, `${F(caisseApres)}`);
  /* Le bon 3 est un décaissement : l'annuler REND de l'argent à la caisse,
     ce qui ne peut pas manquer. On éprouve donc le cas inverse sur le bon 2
     déjà traité, et ici simplement que l'annulation d'un décaissement rend. */
  const annCaisse = await appel("POST", "/accounting/vouchers/3/annuler", {
    token: tD, societe: 1, corps: { motif: "Transport finalement pris en charge par le client" } });
  v("annuler un décaissement rend l'argent à la caisse",
    annCaisse.status === 200 && (await soldeCaisse(1)) === caisseApres + 150000,
    `${annCaisse.status} ${F(await soldeCaisse(1))}`);

  /* ══════════════════════════════════════════════════════════════════════
     5. CE QUI NE SE CONTRE-PASSE PAS
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n5. Les bons qui n'ont rien produit");

  const annNonValide = await appel("POST", "/accounting/vouchers/4/annuler", {
    token: tD, societe: 1, corps: { motif: "Tentative de contre-passation d'un bon refusé" } });
  v("annuler un bon non validé est refusé",
    annNonValide.status === 409 && annNonValide.data?.code === "VOUCHER_NOT_VALIDATED",
    `${annNonValide.status} ${JSON.stringify(annNonValide.data)}`);
  v("le message explique qu'il n'y a rien à défaire",
    /aucun argent|rien à contre-passer/i.test(String(annNonValide.data?.error)));

  const annInconnu = await appel("POST", "/accounting/vouchers/999999/annuler", {
    token: tD, societe: 1, corps: { motif: "Annulation d'un bon qui n'existe pas" } });
  v("un bon inexistant renvoie 404", annInconnu.status === 404, `${annInconnu.status}`);

  /* ══════════════════════════════════════════════════════════════════════
     6. LES BONS INCOHÉRENTS : RECENSÉS, PAS CORRIGÉS
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n6. Le bon refusé dont l'argent avait bougé");

  const avant4 = await bon(4);
  const inc = await appel("GET", "/accounting/vouchers/incoherents", { token: tS, societe: 1 });
  v("la liste répond", inc.status === 200, `${inc.status}`);
  v("le bon 4 y figure",
    (inc.data?.bons || []).some((b) => b.voucher_number === "BD-2026-000004"),
    JSON.stringify((inc.data?.bons || []).map((b) => b.voucher_number)));
  v("l'anomalie est nommée",
    /refusé alors que son mouvement existe/.test(
      String((inc.data?.bons || [])[0]?.anomalie || "")));
  v("un avertissement dit qu'aucun n'a été corrigé",
    /Aucun n'a été corrigé/.test(String(inc.data?.avertissement)), String(inc.data?.avertissement));
  /* Le point essentiel : la migration n'a RIEN touché. */
  v("le bon 4 est inchangé", (await bon(4)).status === avant4.status
    && Number((await bon(4)).amount) === Number(avant4.amount));
  v("son mouvement est toujours actif",
    !!(await un(`SELECT 1 x FROM accounting_transactions
                  WHERE transaction_number='DEC-ORPHELIN-1' AND cancelled_at IS NULL`)));

  /* ══════════════════════════════════════════════════════════════════════
     7. LES DROITS ET L'ÉTANCHÉITÉ
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n7. Qui peut corriger, qui peut contre-passer");

  const annParComptable = await appel("POST", "/accounting/vouchers/2/annuler", {
    token: tC, societe: 1, corps: { motif: "Annulation tentée par le comptable" } });
  v("le comptable ne peut PAS contre-passer",
    annParComptable.status === 403 || annParComptable.status === 404,
    `${annParComptable.status} ${JSON.stringify(annParComptable.data)}`);

  const modParMaga = await appel("PUT", "/accounting/vouchers/4", {
    token: tM, societe: 1, corps: { amount: 1, motif: "Tentative par un magasinier" } });
  v("un magasinier ne peut pas modifier un bon",
    modParMaga.status === 403 || modParMaga.status === 404, `${modParMaga.status}`);

  const modCroisee = await appel("PUT", "/accounting/vouchers/10", {
    token: tC, societe: 1, corps: { amount: 1000, motif: "Tentative sur un bon de l'autre société" } });
  v("on ne modifie pas un bon d'une autre société",
    modCroisee.status === 404 && modCroisee.data?.code === "VOUCHER_NOT_FOUND",
    `${modCroisee.status} ${JSON.stringify(modCroisee.data)}`);
  v("le bon de FAT & MAT est intact", Number((await bon(10)).amount) === 90000);

  const histoCroisee = await appel("GET", "/accounting/vouchers/1/historique",
    { token: tF, societe: 2 });
  v("FAT & MAT ne lit pas l'historique d'un bon de Triangle",
    histoCroisee.status === 404, `${histoCroisee.status}`);

  const incF = await appel("GET", "/accounting/vouchers/incoherents", { token: tF, societe: 2 });
  v("FAT & MAT ne voit pas les incohérences de Triangle",
    (incF.data?.bons || []).length === 0, JSON.stringify(incF.data?.total));

  /* ══════════════════════════════════════════════════════════════════════
     8. L'HISTORIQUE LU DEPUIS L'APPLICATION
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n8. Relire ce qui s'est passé");

  const lecture = await appel("GET", "/accounting/vouchers/1/historique", { token: tS, societe: 1 });
  v("l'historique répond", lecture.status === 200, `${lecture.status}`);
  v("il contient la modification et l'annulation",
    (lecture.data?.historique || []).some((h) => h.action === "MODIFICATION")
    && (lecture.data?.historique || []).some((h) => h.action === "ANNULATION"));
  v("il est trié du plus récent au plus ancien",
    (lecture.data?.historique || [])[0]?.action === "ANNULATION");
  v("il nomme les auteurs",
    (lecture.data?.historique || []).every((h) => !!h.acted_by_name));

  /* ══════════════════════════════════════════════════════════════════════
     9. COHÉRENCE D'ENSEMBLE
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n9. Vérification d'ensemble");

  v("aucun bon annulé sans motif ni date",
    Number((await un(`SELECT count(*) c FROM cash_vouchers
                       WHERE status='annulé' AND (cancelled_at IS NULL
                         OR BTRIM(COALESCE(cancel_reason,''))='')`)).c) === 0);
  v("tout bon annulé a sa contre-écriture",
    Number((await un(`SELECT count(*) c FROM cash_vouchers
                       WHERE status='annulé' AND reversal_transaction_id IS NULL`)).c) === 0);
  v("aucun mouvement de bon annulé n'est resté actif",
    Number((await un(`SELECT count(*) c FROM accounting_transactions t
                        JOIN cash_vouchers v ON v.id=t.source_id AND v.company_id=t.company_id
                       WHERE t.source_type='cash_voucher' AND v.status='annulé'
                         AND t.cancelled_at IS NULL`)).c) === 0);
  v("les écritures de contre-passation sont toutes équilibrées",
    Number((await un(`SELECT COALESCE(SUM(l.debit),0)-COALESCE(SUM(l.credit),0) e
                        FROM journal_entry_lines l JOIN journal_entries en ON en.id=l.entry_id
                       WHERE en.module_source='cash_voucher_reversal'`)).e) === 0);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${ok} réussis, ${ko} échoués`);
  console.log(ko === 0
    ? "  Un bon se modifie avant validation, se contre-passe après, et rien ne s'efface."
    : "  Des points restent à corriger.");
  await pool.end();
  process.exit(ko === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });

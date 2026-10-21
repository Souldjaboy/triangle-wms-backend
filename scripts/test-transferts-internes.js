"use strict";
/**
 * §8 — TRANSFERT INTERNE DE FONDS : DÉPLACER N'EST NI ENCAISSER NI DÉPENSER.
 *
 * Le cas du cahier des charges est joué tel quel : la BDM porte 20 000 000
 * FCFA, on en déplace 5 000 000 vers la trésorerie, et l'on vérifie les six
 * conséquences annoncées — BDM −5 000 000, trésorerie +5 000 000, total des
 * fonds inchangé, recettes inchangées, dépenses inchangées, bénéfice inchangé.
 *
 * Les tests suivants éprouvent ce qui casse d'habitude : l'atomicité quand la
 * seconde jambe échoue, deux transferts simultanés sur le même compte, le
 * sens inverse, l'annulation, et l'étanchéité entre Triangle et FAT & MAT.
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
  const r = await fetch(BASE + chemin, {
    method: m, headers, body: corps === undefined ? undefined : JSON.stringify(corps) });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

const SUPER   = { id: 900, fullname: "Super Triangle", role: "super_admin", company_id: 1, is_super_admin: true };
const SUPER_F = { id: 901, fullname: "Super Fatemat", role: "super_admin", company_id: 2, is_super_admin: true };
const COMPTA  = { id: 903, fullname: "Comptable Triangle", role: "comptable", company_id: 1, is_super_admin: false };
const DIR     = { id: 904, fullname: "Direction Triangle", role: "direction", company_id: 1, is_super_admin: false };
const MAGA    = { id: 905, fullname: "Magasinier Triangle", role: "magasinier", company_id: 1, is_super_admin: false };

const BDM = { kind: "BANQUE", id: 1 };
const BNDA = { kind: "BANQUE", id: 2 };
const BANQUE_FERMEE = { kind: "BANQUE", id: 3 };
const CAISSE = { kind: "CAISSE", id: 1 };
const CAISSE_FERMEE = { kind: "CAISSE", id: 2 };
const TRESO = { kind: "TRESORERIE" };

const F = (n) => Number(n).toLocaleString("fr-FR");

const soldeBanque = async (id) => Number((await un(`SELECT current_balance FROM accounting_banks WHERE id=$1`, [id]))?.current_balance || 0);
const soldeCaisse = async (id) => Number((await un(`SELECT solde_actuel FROM caisses WHERE id=$1`, [id]))?.solde_actuel || 0);
const soldeTreso  = async (cid = 1) => Number((await un(`SELECT current_balance FROM treasury_accounts WHERE company_id=$1`, [cid]))?.current_balance || 0);

const fonds = async (cid = 1) => Number((await un(
  `SELECT COALESCE((SELECT SUM(current_balance) FROM accounting_banks WHERE company_id=$1),0)
        + COALESCE((SELECT SUM(solde_actuel)    FROM caisses WHERE company_id=$1),0)
        + COALESCE((SELECT SUM(current_balance) FROM treasury_accounts WHERE company_id=$1),0) AS t`,
  [cid]))?.t || 0);

/* Les recettes et les dépenses TELLES QUE LES VOIENT LES ÉCRANS : la même
   requête que le compte de résultat, filtre compris. C'est la seule mesure qui
   prouve quelque chose — compter les transactions brutes ne dirait rien. */
const exploitation = async (cid = 1) => {
  const r = await un(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE direction='entrée'),0)  AS recettes,
            COALESCE(SUM(amount) FILTER (WHERE direction='sortie'),0)  AS depenses
       FROM accounting_transactions
      WHERE company_id=$1 AND status='validé'
        AND COALESCE(show_in_financial_movements,TRUE)=TRUE`, [cid]);
  const recettes = Number(r.recettes), depenses = Number(r.depenses);
  return { recettes, depenses, benefice: recettes - depenses };
};

const transfert = async (id) => un(`SELECT * FROM internal_fund_transfers WHERE id=$1`, [id]);
const jambes = async (id) => q(
  `SELECT * FROM accounting_transactions WHERE internal_transfer_id=$1 ORDER BY id`, [id]);
const ecritures = async (id) => q(
  `SELECT * FROM accounting_entries
    WHERE source_type IN ('internal_transfer','internal_transfer_reversal') AND source_id=$1
    ORDER BY id`, [id]);

(async () => {
  const tS = jeton(SUPER), tF = jeton(SUPER_F), tC = jeton(COMPTA),
        tD = jeton(DIR), tM = jeton(MAGA);

  /* ══════════════════════════════════════════════════════════════════════
     1. LE CAS DU CAHIER DES CHARGES, AU FRANC PRÈS
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n1. BDM 20 000 000 → 5 000 000 vers la trésorerie");

  const bdm0 = await soldeBanque(1), tre0 = await soldeTreso(), f0 = await fonds();
  const e0 = await exploitation();
  v("la BDM porte bien 20 000 000 FCFA au départ", bdm0 === 20000000, `${F(bdm0)}`);

  const r1 = await appel("POST", "/comptabilite/transferts-internes", {
    token: tS, societe: 1,
    corps: { source: BDM, destination: TRESO, montant: 5000000,
             motif: "Approvisionnement de la trésorerie pour les décaissements du mois" },
  });
  v("le transfert est accepté", r1.status === 201, `${r1.status} ${JSON.stringify(r1.data)}`);
  const id1 = r1.data?.transfert?.id;

  const bdm1 = await soldeBanque(1), tre1 = await soldeTreso(), f1 = await fonds();
  const e1 = await exploitation();

  v(`BDM : diminution de 5 000 000 (${F(bdm0)} → ${F(bdm1)})`, bdm1 === bdm0 - 5000000);
  v(`Trésorerie : augmentation de 5 000 000 (${F(tre0)} → ${F(tre1)})`, tre1 === tre0 + 5000000);
  v(`Total des fonds de l'entreprise : inchangé (${F(f1)})`, f1 === f0, `avant ${F(f0)}, après ${F(f1)}`);
  v(`Recettes : aucune augmentation (${F(e1.recettes)})`, e1.recettes === e0.recettes,
    `avant ${F(e0.recettes)}, après ${F(e1.recettes)}`);
  v(`Dépenses : aucune augmentation (${F(e1.depenses)})`, e1.depenses === e0.depenses,
    `avant ${F(e0.depenses)}, après ${F(e1.depenses)}`);
  v(`Bénéfice : aucun changement lié à ce transfert (${F(e1.benefice)})`, e1.benefice === e0.benefice);

  /* ══════════════════════════════════════════════════════════════════════
     2. LA TRACE : DEUX MOUVEMENTS, DEUX ÉCRITURES ÉQUILIBRÉES
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n2. Ce que le transfert a écrit");

  const t1 = await transfert(id1);
  v("le transfert est enregistré avec une référence", !!t1?.reference, JSON.stringify(t1?.reference));
  v("son statut est ACTIF", t1?.status === "ACTIF");
  v("le motif est conservé", String(t1?.reason || "").includes("Approvisionnement"));
  v("le compte source est nommé et son solde d'avant conservé",
    t1?.source_label === "BDM" && Number(t1?.source_balance_before) === bdm0);
  v("le solde d'après est conservé lui aussi",
    Number(t1?.source_balance_after) === bdm1 && Number(t1?.destination_balance_after) === tre1);
  v("l'auteur est enregistré", Number(t1?.created_by) === 900);

  const j1 = await jambes(id1);
  v("deux mouvements, un par compte", j1.length === 2, `${j1.length}`);
  v("une sortie et une entrée du même montant",
    j1.filter((m) => m.direction === "sortie").length === 1
    && j1.filter((m) => m.direction === "entrée").length === 1
    && j1.every((m) => Number(m.amount) === 5000000));
  v("LES DEUX sont marqués transfert interne",
    j1.length === 2 && j1.every((m) => m.is_internal_transfer === true));
  v("LES DEUX sont exclus des mouvements financiers",
    j1.length === 2 && j1.every((m) => m.show_in_financial_movements === false));
  v("chacun porte la référence du transfert dans sa description",
    j1.length === 2 && j1.every((m) => String(m.description || "").includes(t1?.reference)));
  v("les deux jambes sont reliées au transfert",
    Number(t1?.debit_transaction_id) > 0 && Number(t1?.credit_transaction_id) > 0);

  const ec1 = await ecritures(id1);
  const debit = ec1.reduce((s, l) => s + Number(l.debit || 0), 0);
  const credit = ec1.reduce((s, l) => s + Number(l.credit || 0), 0);
  v("deux écritures comptables", ec1.length === 2, `${ec1.length}`);
  v(`débit = crédit = 5 000 000 (${F(debit)} / ${F(credit)})`, debit === 5000000 && credit === 5000000);
  v("le compte d'arrivée est débité, le compte de départ crédité",
    ec1.some((l) => Number(l.debit) === 5000000 && String(l.account_label || "").includes("Trésorerie"))
    && ec1.some((l) => Number(l.credit) === 5000000 && String(l.account_label || "") === "BDM"));
  /* Aucun compte de charge ni de produit : c'est CE point qui fait que le
     résultat ne bouge pas, et c'est lui qu'une régression casserait. */
  v("aucune écriture sur un compte de charge ou de produit",
    ec1.length === 2
    && !ec1.some((l) => /charge|produit|vente|achat/i.test(String(l.account_label || ""))),
    ec1.map((l) => l.account_label).join(" | "));

  /* ══════════════════════════════════════════════════════════════════════
     3. LES ÉCRANS QUI ADDITIONNENT
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n3. Les écrans ne comptent pas le transfert comme une opération");

  const etats = await appel("GET", "/accounting/statements", { token: tS, societe: 1 });
  v("les états financiers répondent", etats.status === 200, `${etats.status}`);
  v("les produits n'incluent pas le transfert",
    Number(etats.data?.compte_resultat?.produits || 0) === e0.recettes,
    `${F(etats.data?.compte_resultat?.produits)} au lieu de ${F(e0.recettes)}`);
  v("les charges n'incluent pas le transfert",
    Number(etats.data?.compte_resultat?.charges || 0) === e0.depenses,
    `${F(etats.data?.compte_resultat?.charges)} au lieu de ${F(e0.depenses)}`);
  v("l'actif du bilan reste le total réel des fonds",
    Number(etats.data?.bilan?.actif || 0) === f1, `${F(etats.data?.bilan?.actif)} vs ${F(f1)}`);

  const tb = await appel("GET", "/accounting/dashboard", { token: tS, societe: 1 });
  v("le tableau de bord financier répond (la colonne manquante le faisait échouer)",
    tb.status === 200, `${tb.status} ${JSON.stringify(tb.data).slice(0, 160)}`);

  /* ══════════════════════════════════════════════════════════════════════
     4. LE SENS INVERSE
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n4. Trésorerie → banque, le même raisonnement en sens inverse");

  const f2a = await fonds(), e2a = await exploitation();
  const r2 = await appel("POST", "/comptabilite/transferts-internes", {
    token: tS, societe: 1,
    corps: { source: TRESO, destination: BNDA, montant: 1200000,
             motif: "Reversement du reliquat de trésorerie sur le compte BNDA" },
  });
  v("le transfert inverse est accepté", r2.status === 201, `${r2.status} ${JSON.stringify(r2.data)}`);
  const tre2 = await soldeTreso(), bnda2 = await soldeBanque(2);
  v(`Trésorerie : diminution de 1 200 000 (${F(tre1)} → ${F(tre2)})`, tre2 === tre1 - 1200000);
  v("BNDA : augmentation de 1 200 000", bnda2 === 3000000 + 1200000);
  v("total des fonds toujours inchangé", (await fonds()) === f2a);
  const e2b = await exploitation();
  v("recettes et dépenses toujours inchangées",
    e2b.recettes === e2a.recettes && e2b.depenses === e2a.depenses);

  const r2b = await appel("POST", "/comptabilite/transferts-internes", {
    token: tS, societe: 1,
    corps: { source: CAISSE, destination: BDM, montant: 300000,
             motif: "Dépôt de l'encaisse du jour à la banque" },
  });
  v("caisse → banque fonctionne aussi", r2b.status === 201, `${r2b.status}`);
  v("la caisse a baissé de 300 000", (await soldeCaisse(1)) === 500000 - 300000);

  /* ══════════════════════════════════════════════════════════════════════
     5. CE QUI DOIT ÊTRE REFUSÉ
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n5. Les transferts incohérents");

  const refus = [
    ["un montant nul", { source: BDM, destination: TRESO, montant: 0, motif: "Essai de montant nul" }, "AMOUNT_INVALID"],
    ["un montant négatif", { source: BDM, destination: TRESO, montant: -500000, motif: "Essai de montant négatif" }, "AMOUNT_INVALID"],
    ["la source et la destination identiques", { source: BDM, destination: BDM, montant: 100000, motif: "Essai de transfert vers soi-même" }, "SAME_ACCOUNT"],
    ["un montant supérieur au solde", { source: CAISSE, destination: BDM, montant: 99000000, motif: "Essai de dépassement de solde" }, "INSUFFICIENT_FUNDS"],
    ["une nature de compte inventée", { source: { kind: "COFFRE", id: 1 }, destination: TRESO, montant: 100000, motif: "Essai de nature inconnue" }, "ACCOUNT_KIND_INVALID"],
    ["une banque d'un autre dossier", { source: { kind: "BANQUE", id: 10 }, destination: TRESO, montant: 100000, motif: "Essai sur une banque hors société" }, "BANK_NOT_FOUND"],
    ["une banque inexistante", { source: { kind: "BANQUE", id: 9999 }, destination: TRESO, montant: 100000, motif: "Essai sur une banque inexistante" }, "BANK_NOT_FOUND"],
    ["une banque désactivée", { source: BANQUE_FERMEE, destination: TRESO, montant: 100000, motif: "Essai depuis une banque désactivée" }, "BANK_INACTIVE"],
    ["une caisse fermée", { source: CAISSE_FERMEE, destination: BDM, montant: 100000, motif: "Essai depuis une caisse fermée" }, "CASHBOX_INACTIVE"],
    ["un identifiant de banque absent", { source: { kind: "BANQUE" }, destination: TRESO, montant: 100000, motif: "Essai sans identifiant de compte" }, "ACCOUNT_ID_REQUIRED"],
    ["aucun motif", { source: BDM, destination: TRESO, montant: 100000, motif: "" }, "REASON_REQUIRED"],
    ["un motif de deux lettres", { source: BDM, destination: TRESO, montant: 100000, motif: "ok" }, "REASON_REQUIRED"],
  ];
  const avantRefus = await fonds();
  for (const [quoi, corps, code] of refus) {
    const r = await appel("POST", "/comptabilite/transferts-internes", { token: tS, societe: 1, corps });
    v(`refusé : ${quoi} (${code})`, r.status >= 400 && r.data?.code === code,
      `${r.status} ${JSON.stringify(r.data)}`);
  }
  v("aucun refus n'a bougé un solde", (await fonds()) === avantRefus);
  v("aucun refus n'a laissé de transfert derrière lui",
    Number((await un(`SELECT count(*) c FROM internal_fund_transfers WHERE company_id=1`)).c) === 3);

  /* ══════════════════════════════════════════════════════════════════════
     6. L'ATOMICITÉ : LES DEUX MOUVEMENTS OU AUCUN
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n6. Atomicité — une panne au milieu ne laisse pas la moitié");

  const TI = require("../services/transferts-internes");
  const nextNum = async (client, table, col, prefixe, cid) => {
    const { rows } = await client.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(${col}, '^.*-', ''), '')::int),0)+1 AS n
         FROM ${table} WHERE company_id=$1 AND ${col} LIKE $2`, [cid, `${prefixe}-%`]);
    return `${prefixe}-${rows[0].n}`;
  };
  const faireEcriture = async (client, p) => client.query(
    `INSERT INTO accounting_entries
       (company_id, entry_number, entry_date, source_type, source_id, account_label,
        debit, credit, description, created_by)
     VALUES ($1, 'ECR-T-'||nextval(pg_get_serial_sequence('accounting_entries','id')),
             CURRENT_DATE, $2,$3,$4,$5,$6,$7,$8)`,
    [p.companyId, p.sourceType, p.sourceId, p.accountLabel, p.debit, p.credit, p.description, p.createdBy]);

  const avantPanne = { bdm: await soldeBanque(1), treso: await soldeTreso(), fonds: await fonds() };
  const nbAvant = Number((await un(`SELECT count(*) c FROM internal_fund_transfers WHERE company_id=1`)).c);

  const client = await pool.connect();
  let erreurAttendue = null;
  try {
    await client.query("BEGIN");
    await TI.transferer(client, {
      companyId: 1, source: BDM, destination: TRESO, montant: 2000000,
      motif: "Transfert interrompu volontairement pour éprouver l'atomicité",
      utilisateur: { id: 900, name: "Super Triangle" },
      nextAccountingNumber: nextNum,
      /* La seconde écriture échoue : tout ce qui précède doit disparaître. */
      createAccountingEntry: async (c, p) => {
        if (p.credit > 0) throw new Error("panne simulée sur la seconde écriture");
        return faireEcriture(c, p);
      },
    });
    await client.query("COMMIT");
  } catch (e) {
    erreurAttendue = e.message;
    await client.query("ROLLBACK").catch(() => {});
  } finally { client.release(); }

  v("la panne a bien interrompu l'opération", /panne simulée/.test(String(erreurAttendue)), String(erreurAttendue));
  v("la BDM n'a pas bougé", (await soldeBanque(1)) === avantPanne.bdm);
  v("la trésorerie n'a pas bougé", (await soldeTreso()) === avantPanne.treso);
  v("le total des fonds n'a pas bougé", (await fonds()) === avantPanne.fonds);
  v("aucun transfert n'a été laissé en base",
    Number((await un(`SELECT count(*) c FROM internal_fund_transfers WHERE company_id=1`)).c) === nbAvant);
  v("aucun mouvement orphelin",
    Number((await un(`SELECT count(*) c FROM accounting_transactions
                       WHERE company_id=1 AND is_internal_transfer=TRUE
                         AND internal_transfer_id NOT IN (SELECT id FROM internal_fund_transfers)`)).c) === 0);

  /* ══════════════════════════════════════════════════════════════════════
     7. L'ANNULATION : CONTRE-PASSER, JAMAIS EFFACER
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n7. Annulation d'un transfert");

  /* On n'annule PAS le transfert de la section 1 : sa destination a servi
     depuis (section 4 a sorti 1 200 000 de la trésorerie), et la règle est
     justement de refuser dans ce cas. On le vérifie, puis on annule un
     transfert dont les fonds sont encore là. */
  const refusCarDepense = await appel("POST", `/comptabilite/transferts-internes/${id1}/annuler`, {
    token: tS, societe: 1,
    corps: { motif: "Annulation du transfert initial dont la trésorerie a déjà servi" } });
  v("annuler un transfert dont la destination a servi est refusé, et dit pourquoi",
    refusCarDepense.status === 409
    && refusCarDepense.data?.code === "INSUFFICIENT_FUNDS_FOR_REVERSAL"
    && /utilisés depuis le transfert/.test(String(refusCarDepense.data?.error)),
    `${refusCarDepense.status} ${JSON.stringify(refusCarDepense.data)}`);
  v("ce refus laisse le transfert ACTIF et les soldes intacts",
    (await transfert(id1))?.status === "ACTIF");

  /* Le transfert qui sera réellement annulé : rien n'a touché sa destination. */
  const rA = await appel("POST", "/comptabilite/transferts-internes", {
    token: tS, societe: 1,
    corps: { source: BDM, destination: BNDA, montant: 5000000,
             motif: "Transfert à annuler : saisi sur le mauvais compte de destination" } });
  v("le transfert à annuler est créé", rA.status === 201, `${rA.status} ${JSON.stringify(rA.data)}`);
  const idA = rA.data?.transfert?.id;
  const tA = await transfert(idA);

  const avantAnn = { bdm: await soldeBanque(1), bnda: await soldeBanque(2),
                     fonds: await fonds(), ...(await exploitation()) };

  const sansMotif = await appel("POST", `/comptabilite/transferts-internes/${idA}/annuler`, {
    token: tS, societe: 1, corps: { motif: "erreur" } });
  v("l'annulation sans motif suffisant est refusée (6 caractères)",
    sansMotif.status === 400 && sansMotif.data?.code === "REASON_REQUIRED",
    `${sansMotif.status} ${JSON.stringify(sansMotif.data)}`);
  v("le transfert est toujours ACTIF", (await transfert(idA))?.status === "ACTIF");

  const ann = await appel("POST", `/comptabilite/transferts-internes/${idA}/annuler`, {
    token: tS, societe: 1,
    corps: { motif: "Transfert saisi par erreur sur le mauvais compte de destination" } });
  v("l'annulation est acceptée", ann.status === 200, `${ann.status} ${JSON.stringify(ann.data)}`);

  const t1b = await transfert(idA);
  v("le statut passe à ANNULE", t1b?.status === "ANNULE");
  v("le motif d'annulation est conservé", String(t1b?.cancel_reason || "").includes("mauvais compte"));
  v("l'auteur et la date de l'annulation sont enregistrés",
    Number(t1b?.cancelled_by) === 900 && !!t1b?.cancelled_at);
  v(`la BDM retrouve ses fonds (${F(avantAnn.bdm)} → ${F(await soldeBanque(1))})`,
    (await soldeBanque(1)) === avantAnn.bdm + 5000000);
  v("la BNDA rend les fonds", (await soldeBanque(2)) === avantAnn.bnda - 5000000);
  v("le total des fonds est inchangé par l'annulation", (await fonds()) === avantAnn.fonds);
  const eAnn = await exploitation();
  v("l'annulation n'a créé ni recette ni dépense",
    eAnn.recettes === avantAnn.recettes && eAnn.depenses === avantAnn.depenses,
    `recettes ${F(eAnn.recettes)} vs ${F(avantAnn.recettes)}, dépenses ${F(eAnn.depenses)} vs ${F(avantAnn.depenses)}`);

  const j1b = await jambes(idA);
  v("quatre mouvements désormais : les deux d'origine et leurs deux inverses",
    j1b.length === 4, `${j1b.length}`);
  v("les deux mouvements d'origine existent toujours",
    j1b.some((m) => Number(m.id) === Number(tA?.debit_transaction_id))
    && j1b.some((m) => Number(m.id) === Number(tA?.credit_transaction_id)));
  const origines = j1b.filter((m) => [Number(tA?.debit_transaction_id), Number(tA?.credit_transaction_id)]
    .includes(Number(m.id)));
  v("les mouvements d'origine portent la marque de leur annulation",
    origines.length === 2 && origines.every((m) => !!m.cancelled_at && !!m.cancel_reason));
  v("les deux contre-écritures désignent ce qu'elles défont",
    j1b.filter((m) => m.reverses_transaction_id).length === 2);
  v("les quatre restent hors des mouvements financiers",
    j1b.length === 4 && j1b.every((m) => m.show_in_financial_movements === false));

  const doubleAnn = await appel("POST", `/comptabilite/transferts-internes/${idA}/annuler`, {
    token: tS, societe: 1, corps: { motif: "Tentative de seconde annulation du même transfert" } });
  v("annuler deux fois est refusé",
    doubleAnn.status === 409 && doubleAnn.data?.code === "ALREADY_CANCELLED", `${doubleAnn.status}`);
  v("le double clic n'a pas rendu les fonds deux fois",
    (await soldeBanque(1)) === avantAnn.bdm + 5000000);

  const inconnu = await appel("POST", "/comptabilite/transferts-internes/999999/annuler", {
    token: tS, societe: 1, corps: { motif: "Annulation d'un transfert qui n'existe pas" } });
  v("annuler un transfert inexistant renvoie 404", inconnu.status === 404, `${inconnu.status}`);

  /* L'argent déjà reparti : l'annulation doit refuser plutôt que creuser un
     solde négatif en silence. */
  console.log("\n7b. Annulation impossible quand les fonds sont repartis");
  const rT = await appel("POST", "/comptabilite/transferts-internes", {
    token: tS, societe: 1,
    corps: { source: BDM, destination: CAISSE, montant: 400000,
             motif: "Alimentation de la caisse principale pour la journée" } });
  const idT = rT.data?.transfert?.id;
  await pool.query(`UPDATE caisses SET solde_actuel = 1000 WHERE id = 1`);
  const annImpossible = await appel("POST", `/comptabilite/transferts-internes/${idT}/annuler`, {
    token: tS, societe: 1, corps: { motif: "Annulation demandée alors que la caisse a été vidée" } });
  v("l'annulation est refusée faute de fonds à rendre",
    annImpossible.status === 409 && annImpossible.data?.code === "INSUFFICIENT_FUNDS_FOR_REVERSAL",
    `${annImpossible.status} ${JSON.stringify(annImpossible.data)}`);
  v("la caisse n'est pas devenue négative", (await soldeCaisse(1)) === 1000);
  v("le transfert reste ACTIF, pas à moitié annulé", (await transfert(idT))?.status === "ACTIF");

  /* ══════════════════════════════════════════════════════════════════════
     8. DEUX TRANSFERTS EN MÊME TEMPS
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n8. Simultanéité");

  await pool.query(`UPDATE accounting_banks SET current_balance = 1000000 WHERE id = 2`);
  const fondsAvantConc = await fonds();

  /* Le même compte, deux fois 700 000 sur un solde de 1 000 000 : le verrou
     doit en laisser passer un seul. Sans lui, les deux liraient 1 000 000. */
  const [a, b] = await Promise.all([
    appel("POST", "/comptabilite/transferts-internes", { token: tS, societe: 1,
      corps: { source: BNDA, destination: TRESO, montant: 700000,
               motif: "Premier transfert concurrent depuis la BNDA" } }),
    appel("POST", "/comptabilite/transferts-internes", { token: tS, societe: 1,
      corps: { source: BNDA, destination: TRESO, montant: 700000,
               motif: "Second transfert concurrent depuis la BNDA" } }),
  ]);
  const reussis = [a, b].filter((r) => r.status === 201).length;
  v("un seul des deux transferts concurrents passe", reussis === 1,
    `${reussis} réussi(s) : ${a.status}/${b.status}`);
  v("l'autre est refusé pour solde insuffisant",
    [a, b].some((r) => r.data?.code === "INSUFFICIENT_FUNDS"),
    JSON.stringify([a.data?.code, b.data?.code]));
  v("la BNDA n'est pas négative", (await soldeBanque(2)) >= 0, `${F(await soldeBanque(2))}`);
  v("le total des fonds est resté constant malgré la concurrence",
    (await fonds()) === fondsAvantConc);

  /* Deux sens opposés en même temps : c'est le cas qui bloquerait les deux
     transactions l'une contre l'autre si l'ordre des verrous suivait le sens. */
  await pool.query(`UPDATE accounting_banks SET current_balance = 5000000 WHERE id = 2`);
  await pool.query(`UPDATE treasury_accounts SET current_balance = 5000000 WHERE company_id = 1`);
  const croises = await Promise.all([
    appel("POST", "/comptabilite/transferts-internes", { token: tS, societe: 1,
      corps: { source: BNDA, destination: TRESO, montant: 100000,
               motif: "Transfert croisé, sens banque vers trésorerie" } }),
    appel("POST", "/comptabilite/transferts-internes", { token: tS, societe: 1,
      corps: { source: TRESO, destination: BNDA, montant: 100000,
               motif: "Transfert croisé, sens trésorerie vers banque" } }),
  ]);
  v("deux transferts de sens opposés passent tous les deux sans interblocage",
    croises.every((r) => r.status === 201),
    croises.map((r) => `${r.status} ${r.data?.code || ""}`).join(" | "));

  /* ══════════════════════════════════════════════════════════════════════
     9. L'ÉTANCHÉITÉ ENTRE LES DEUX SOCIÉTÉS
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n9. Triangle et FAT & MAT");

  const fondsF = await fonds(2);
  const croise = await appel("POST", "/comptabilite/transferts-internes", {
    token: tS, societe: 1,
    corps: { source: BDM, destination: { kind: "CAISSE", id: 10 }, montant: 100000,
             motif: "Tentative de transfert vers la caisse de l'autre société" } });
  v("on ne peut pas déplacer des fonds vers une autre société",
    croise.status >= 400 && croise.data?.code === "CASHBOX_NOT_FOUND",
    `${croise.status} ${JSON.stringify(croise.data)}`);
  v("les fonds de FAT & MAT sont intacts", (await fonds(2)) === fondsF);

  const listeT = await appel("GET", "/comptabilite/transferts-internes", { token: tS, societe: 1 });
  const listeF = await appel("GET", "/comptabilite/transferts-internes", { token: tF, societe: 2 });
  v("la liste de Triangle ne montre que ses transferts",
    (listeT.data?.transferts || []).length > 0
    && listeT.data.transferts.every((t) => Number(t.company_id) === 1), `${listeT.status}`);
  v("FAT & MAT ne voit aucun transfert de Triangle",
    (listeF.data?.transferts || []).length === 0, JSON.stringify(listeF.data?.totaux));

  const ficheCroisee = await appel("GET", `/comptabilite/transferts-internes/${idA}`,
    { token: tF, societe: 2 });
  v("FAT & MAT ne peut pas ouvrir la fiche d'un transfert de Triangle",
    ficheCroisee.status === 404, `${ficheCroisee.status}`);

  const comptesF = await appel("GET", "/comptabilite/transferts-internes/comptes",
    { token: tF, societe: 2 });
  v("FAT & MAT ne voit que ses propres comptes",
    (comptesF.data?.comptes || []).length > 0
    && !(comptesF.data?.comptes || []).some((c) => c.libelle === "BDM"),
    (comptesF.data?.comptes || []).map((c) => c.libelle).join(", "));

  /* ══════════════════════════════════════════════════════════════════════
     10. LES DROITS
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n10. Qui peut déplacer, qui peut annuler");

  const rC = await appel("POST", "/comptabilite/transferts-internes", {
    token: tC, societe: 1,
    corps: { source: BDM, destination: CAISSE, montant: 50000,
             motif: "Transfert effectué par le comptable dans le cadre de ses fonctions" } });
  v("le comptable peut déplacer des fonds", rC.status === 201, `${rC.status} ${JSON.stringify(rC.data)}`);
  const idC = rC.data?.transfert?.id;

  const annC = await appel("POST", `/comptabilite/transferts-internes/${idC}/annuler`, {
    token: tC, societe: 1, corps: { motif: "Annulation tentée par le comptable sans le droit requis" } });
  v("le comptable ne peut PAS annuler (contre-passation réservée)",
    annC.status === 403 || annC.status === 404, `${annC.status} ${JSON.stringify(annC.data)}`);
  v("le transfert du comptable est resté ACTIF", (await transfert(idC))?.status === "ACTIF");

  const annD = await appel("POST", `/comptabilite/transferts-internes/${idC}/annuler`, {
    token: tD, societe: 1, corps: { motif: "Annulation décidée par la direction après vérification" } });
  v("la direction peut annuler", annD.status === 200, `${annD.status} ${JSON.stringify(annD.data)}`);

  const rM = await appel("POST", "/comptabilite/transferts-internes", {
    token: tM, societe: 1,
    corps: { source: BDM, destination: CAISSE, montant: 50000,
             motif: "Transfert tenté par un magasinier sans droit comptable" } });
  v("un magasinier ne peut pas déplacer de fonds", rM.status === 403 || rM.status === 404,
    `${rM.status} ${JSON.stringify(rM.data)}`);

  const sansJeton = await appel("POST", "/comptabilite/transferts-internes", {
    societe: 1, corps: { source: BDM, destination: CAISSE, montant: 50000, motif: "Sans authentification" } });
  v("sans authentification, rien ne passe", sansJeton.status === 401 || sansJeton.status === 403,
    `${sansJeton.status}`);

  /* ══════════════════════════════════════════════════════════════════════
     11. LES ANCIENS MOUVEMENTS : RECENSÉS, PAS RECLASSÉS
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n11. Les anciens dépôts caisse → banque");

  const ancien = await un(
    `SELECT * FROM accounting_transactions WHERE transaction_number='ANC-TRF-1'`);
  const cand = await appel("GET", "/comptabilite/transferts-internes/candidats",
    { token: tS, societe: 1 });
  v("la liste des candidats répond", cand.status === 200, `${cand.status}`);
  v("l'ancien dépôt caisse → banque y figure",
    (cand.data?.candidats || []).some((c) => c.transaction_number === "ANC-TRF-1"),
    JSON.stringify((cand.data?.candidats || []).map((c) => c.transaction_number)));
  v("son indice est nommé",
    (cand.data?.candidats || []).find((c) => c.transaction_number === "ANC-TRF-1")?.indice
      === "dépôt caisse → banque");
  v("un avertissement dit qu'aucun n'a été modifié",
    /Aucun n'a été modifié/.test(String(cand.data?.avertissement || "")),
    String(cand.data?.avertissement));
  /* Le point le plus important de cette section : la migration et la liste
     n'ont RIEN changé. Reclasser en masse modifierait des totaux déjà remis. */
  v("l'ancien mouvement n'a pas été reclassé par la migration",
    ancien.is_internal_transfer === false && ancien.show_in_financial_movements === true);
  v("il pèse donc toujours dans les recettes, et c'est visible",
    (await exploitation()).recettes >= 750000);
  v("les transferts créés par l'application ne sont pas dans les candidats",
    !(cand.data?.candidats || []).some((c) => c.is_internal_transfer === true));

  /* ══════════════════════════════════════════════════════════════════════
     12. LA CONSULTATION
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n12. Lire l'historique");

  const fiche = await appel("GET", `/comptabilite/transferts-internes/${idA}`,
    { token: tS, societe: 1 });
  v("la fiche répond", fiche.status === 200, `${fiche.status}`);
  v("elle montre les quatre mouvements du transfert annulé",
    (fiche.data?.mouvements || []).length === 4, `${(fiche.data?.mouvements || []).length}`);
  v("elle nomme l'auteur et l'annulateur",
    !!fiche.data?.transfert?.auteur && !!fiche.data?.transfert?.annulateur,
    `${fiche.data?.transfert?.auteur} / ${fiche.data?.transfert?.annulateur}`);

  const liste = await appel("GET", "/comptabilite/transferts-internes?statut=ANNULE",
    { token: tS, societe: 1 });
  v("le filtre par statut fonctionne",
    (liste.data?.transferts || []).length > 0
    && liste.data.transferts.every((t) => t.status === "ANNULE"));
  v("la liste dit explicitement que ce ne sont ni des recettes ni des dépenses",
    /ni recettes, ni dépenses/i.test(String(listeT.data?.nature || "")),
    String(listeT.data?.nature));
  v("les totaux ne comptent que les transferts actifs",
    Number(listeT.data?.totaux?.actifs) >= 0
    && Number(listeT.data?.totaux?.annules) >= 1);

  const comptes = await appel("GET", "/comptabilite/transferts-internes/comptes",
    { token: tS, societe: 1 });
  v("les comptes et leurs soldes sont lisibles",
    (comptes.data?.comptes || []).length >= 6, `${(comptes.data?.comptes || []).length}`);
  v("les comptes fermés sont signalés, pas cachés",
    (comptes.data?.comptes || []).some((c) => c.actif === false));
  v("le total des fonds est annoncé avec les comptes",
    Number(comptes.data?.fonds_totaux) === (await fonds()),
    `${F(comptes.data?.fonds_totaux)} vs ${F(await fonds())}`);

  /* ══════════════════════════════════════════════════════════════════════
     13. LA COHÉRENCE DE FOND, APRÈS TOUT CE QUI PRÉCÈDE
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n13. Vérification d'ensemble");

  const somme = await un(
    `SELECT COALESCE(SUM(CASE WHEN direction='sortie' THEN amount ELSE -amount END),0) AS net
       FROM accounting_transactions WHERE company_id=1 AND is_internal_transfer=TRUE`);
  v("les mouvements de transfert s'annulent exactement deux à deux",
    Number(somme.net) === 0, `net = ${F(somme.net)}`);

  const desequilibre = await un(
    `SELECT COALESCE(SUM(debit),0)-COALESCE(SUM(credit),0) AS ecart
       FROM accounting_entries
      WHERE company_id=1 AND source_type IN ('internal_transfer','internal_transfer_reversal')`);
  v("le journal des transferts est équilibré au franc",
    Number(desequilibre.ecart) === 0, `écart = ${F(desequilibre.ecart)}`);

  v("aucun transfert ne pointe vers un compte inexistant",
    Number((await un(
      `SELECT count(*) c FROM internal_fund_transfers t
        WHERE t.company_id=1
          AND ((t.source_kind='BANQUE' AND NOT EXISTS (SELECT 1 FROM accounting_banks b WHERE b.id=t.source_id))
            OR (t.destination_kind='CAISSE' AND NOT EXISTS (SELECT 1 FROM caisses c2 WHERE c2.id=t.destination_id)))`)).c) === 0);

  v("aucun transfert annulé sans motif ni date",
    Number((await un(
      `SELECT count(*) c FROM internal_fund_transfers
        WHERE status='ANNULE' AND (cancelled_at IS NULL OR BTRIM(COALESCE(cancel_reason,''))='')`)).c) === 0);

  v("tout transfert actif a bien ses deux jambes",
    Number((await un(
      `SELECT count(*) c FROM internal_fund_transfers t
        WHERE t.status='ACTIF'
          AND (t.debit_transaction_id IS NULL OR t.credit_transaction_id IS NULL)`)).c) === 0);

  const ecartFonds = await un(
    `SELECT (SELECT COALESCE(SUM(current_balance),0) FROM accounting_banks WHERE company_id=1)
          + (SELECT COALESCE(SUM(solde_actuel),0) FROM caisses WHERE company_id=1)
          + (SELECT COALESCE(SUM(current_balance),0) FROM treasury_accounts WHERE company_id=1) AS t`);
  v("le total des fonds reste un nombre positif et cohérent",
    Number(ecartFonds.t) > 0, `${F(ecartFonds.t)}`);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${ok} réussis, ${ko} échoués`);
  console.log(ko === 0
    ? "  Déplacer des fonds ne crée ni recette ni dépense, et le total ne bouge pas."
    : "  Des points restent à corriger.");
  await pool.end();
  process.exit(ko === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });

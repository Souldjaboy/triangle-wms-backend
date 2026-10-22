"use strict";
/**
 * LES FACTURES QUI SE RESSEMBLENT.
 *
 * Ce que ces tests éprouvent, et dans cet ordre de priorité :
 *
 *  1. Qu'un RENOUVELLEMENT n'est pas pris pour un doublon. C'est le risque
 *     qui coûte le plus cher : annuler onze créances réelles.
 *  2. Qu'un doublon TECHNIQUE — deux factures pour une seule vente — est
 *     reconnu.
 *  3. Qu'AUCUNE facture n'est neutralisée sans un verdict rendu par une
 *     personne, avec son motif.
 *  4. Que neutraliser DÉPLACE les encaissements légitimes vers la facture qui
 *     fait foi, sans créer la moindre écriture de trésorerie.
 *  5. Que le cas où LES DEUX factures ont été réglées s'arrête net : le
 *     client a payé deux fois, et cela se rembourse, cela ne se déplace pas
 *     en silence.
 *  6. Que la facture neutralisée reste en base, désignant celle qui fait foi.
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
const paiement = async (id) => un(`SELECT * FROM sand_payments WHERE id=$1`, [id]);
const nbEcritures = async (cid = 1) =>
  Number((await un(`SELECT count(*) n FROM accounting_transactions WHERE company_id=$1`, [cid]))?.n || 0);
const nbPaiements = async (cid = 1) =>
  Number((await un(`SELECT count(*) n FROM sand_payments WHERE company_id=$1`, [cid]))?.n || 0);
const F = (n) => Number(n).toLocaleString("fr-FR");
const paire = (l, a, b) => (l || []).find((x) =>
  (x.a.numero === a && x.b.numero === b) || (x.a.numero === b && x.b.numero === a));

(async () => {
  const tDir = jeton(DIR), tCompta = jeton(COMPTA), tMaga = jeton(MAGA), tFat = jeton(FAT);

  /* ═══════════════════════════════════════════════════════════════════════
     1. CE QUE LE DÉTECTEUR PROPOSE
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Les paires qui se ressemblent");
  let r = await appel("GET", "/invoice-duplicates/sable", { token: tCompta, societe: 1 });
  v("la liste répond", r.status === 200, JSON.stringify(r.data)?.slice(0, 200));
  const paires = r.data?.paires || [];
  v("des paires sont proposées", paires.length >= 5, String(paires.length));
  v("l'avertissement dit que ressembler n'est pas être un doublon",
    /ne sont pas un doublon/.test(r.data?.avertissement || ""), r.data?.avertissement);
  v("et nomme les cas légitimes",
    /abonnement, une location ou une prestation répétée/.test(r.data?.avertissement || ""));

  titre("LE RISQUE PRINCIPAL : un renouvellement n'est pas un doublon");
  const renouv = paire(paires, "FS-1010", "FS-1011");
  v("la paire de la série est présente", !!renouv);
  v("elle est suggérée RENOUVELLEMENT", renouv?.suggestion === "RENOUVELLEMENT", renouv?.suggestion);
  v("parce qu'une série régulière a été repérée",
    (renouv?.signaux || []).includes("SERIE_REGULIERE"), (renouv?.signaux || []).join(","));
  v("et un écart d'environ un mois", (renouv?.signaux || []).includes("ECART_UN_MOIS"));

  titre("Une série de quatre ne produit pas six paires");
  const serie = paires.filter((x) => (x.signaux || []).includes("SERIE_REGULIERE"));
  v("seules les factures consécutives sont comparées", serie.length === 3, String(serie.length));

  titre("Le doublon technique est reconnu");
  const tech = paire(paires, "FS-1001", "FS-1002");
  v("la paire est présente", !!tech);
  v("elle est suggérée DOUBLON_CONFIRME", tech?.suggestion === "DOUBLON_CONFIRME", tech?.suggestion);
  v("parce que c'est la MÊME VENTE", (tech?.signaux || []).includes("MEME_VENTE"),
    (tech?.signaux || []).join(","));
  v("et le même jour", (tech?.signaux || []).includes("MEME_JOUR"));
  v("l'une seulement a été réglée", (tech?.signaux || []).includes("UNE_SEULE_PAYEE"));

  titre("Deux prestations distinctes ne sont pas un doublon");
  const distinctes = paire(paires, "FS-1020", "FS-1021");
  v("la paire est présente", !!distinctes);
  v("elle est suggérée FACTURES_DISTINCTES", distinctes?.suggestion === "FACTURES_DISTINCTES",
    distinctes?.suggestion);
  v("parce que les livraisons diffèrent",
    (distinctes?.signaux || []).includes("LIVRAISONS_DISTINCTES"));

  titre("Le cas sans signal reste à examiner");
  r = await appel("GET", "/invoice-duplicates/ciment", { token: tCompta, societe: 1 });
  v("le ciment répond", r.status === 200, `${r.status}`);
  const ambigu = paire(r.data?.paires || [], "FC-2001", "FC-2002");
  v("la paire ciment est présente", !!ambigu);
  v("elle n'est pas tranchée", ambigu?.suggestion === "A_EXAMINER", ambigu?.suggestion);

  titre("Le cas dangereux est signalé comme tel");
  const dangereux = paire(paires, "FS-1040", "FS-1041");
  v("la paire est présente", !!dangereux);
  v("les deux ont été réglées",
    (dangereux?.signaux || []).includes("PAIEMENTS_DES_DEUX_COTES"),
    (dangereux?.signaux || []).join(","));

  /* ═══════════════════════════════════════════════════════════════════════
     2. RIEN N'EST FAIT SANS DÉCISION
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Le détecteur n'a RIEN modifié");
  v("aucune facture n'est annulée",
    (await q(`SELECT id FROM sand_invoices WHERE company_id=1 AND status='ANNULEE'`)).length === 0);
  v("aucune facture n'est neutralisée",
    (await q(`SELECT id FROM sand_invoices WHERE neutralized_at IS NOT NULL`)).length === 0);
  v("aucun examen n'a été enregistré",
    (await q(`SELECT id FROM invoice_duplicate_reviews`)).length === 0);

  titre("Il n'existe aucun chemin « tout nettoyer »");
  for (const chemin of ["/invoice-duplicates/sable/nettoyer", "/invoice-duplicates/sable/supprimer",
                        "/invoice-duplicates/sable/tout-neutraliser"]) {
    const x = await appel("POST", chemin, { token: tDir, societe: 1, corps: {} });
    v(`${chemin} n'existe pas`, x.status === 404, `${x.status}`);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     3. TRANCHER
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Rendre un verdict");
  r = await appel("POST", "/invoice-duplicates/sable/trancher", {
    token: tCompta, societe: 1,
    corps: { facture_a: tech.a.id, facture_b: tech.b.id, verdict: "DOUBLON_CONFIRME", motif: "court" },
  });
  v("un motif trop court est refusé", r.status === 400 && r.data?.code === "REASON_REQUIRED",
    JSON.stringify(r.data));

  r = await appel("POST", "/invoice-duplicates/sable/trancher", {
    token: tCompta, societe: 1,
    corps: { facture_a: tech.a.id, facture_b: tech.b.id, verdict: "PEUT_ETRE", motif: "un motif bien assez long" },
  });
  v("un verdict inconnu est refusé", r.status === 400 && r.data?.code === "VERDICT_INVALIDE",
    JSON.stringify(r.data));

  r = await appel("POST", "/invoice-duplicates/sable/trancher", {
    token: tMaga, societe: 1,
    corps: { facture_a: tech.a.id, facture_b: tech.b.id, verdict: "DOUBLON_CONFIRME",
             motif: "deux factures pour la même vente VS-0001" },
  });
  v("le magasinier ne tranche pas", r.status === 403, `${r.status} ${JSON.stringify(r.data)}`);

  r = await appel("POST", "/invoice-duplicates/sable/trancher", {
    token: tCompta, societe: 1,
    corps: { facture_a: tech.a.id, facture_b: tech.b.id, verdict: "DOUBLON_CONFIRME",
             motif: "deux factures pour la même vente VS-0001" },
  });
  v("le comptable tranche", r.status === 201, JSON.stringify(r.data)?.slice(0, 200));
  const examen = r.data?.examen;
  v("l'examen est enregistré", !!examen);
  v("le verdict y figure", examen?.verdict === "DOUBLON_CONFIRME");
  v("le motif aussi", examen?.verdict_reason === "deux factures pour la même vente VS-0001");
  v("et le nom de qui a tranché", examen?.decided_by_name === "Comptable Triangle");
  v("la réponse dit que RIEN n'a été modifié",
    /Aucune facture n'a été modifiée/.test(r.data?.message || ""), r.data?.message);
  v("et de fait, aucune ne l'est",
    (await facture(tech.a.id)).status !== "ANNULEE" && (await facture(tech.b.id)).status !== "ANNULEE");

  titre("Une paire tranchée ne revient plus dans la liste");
  r = await appel("GET", "/invoice-duplicates/sable", { token: tCompta, societe: 1 });
  v("elle a disparu des suspects", !paire(r.data?.paires || [], "FS-1001", "FS-1002"));
  r = await appel("GET", "/invoice-duplicates/sable?inclure_tranchees=1", { token: tCompta, societe: 1 });
  const revue = paire(r.data?.paires || [], "FS-1001", "FS-1002");
  v("mais on peut la revoir à la demande", !!revue);
  v("avec son verdict", revue?.verdict_rendu?.verdict === "DOUBLON_CONFIRME");

  titre("Le renouvellement est déclaré légitime, une fois pour toutes");
  r = await appel("POST", "/invoice-duplicates/sable/trancher", {
    token: tCompta, societe: 1,
    corps: { facture_a: renouv.a.id, facture_b: renouv.b.id, verdict: "RENOUVELLEMENT",
             motif: "location mensuelle du camion, contrat signé en juin" },
  });
  v("le verdict passe", r.status === 201, JSON.stringify(r.data)?.slice(0, 160));
  v("la réponse dit qu'elle ne reviendra plus",
    /ne reviendra plus dans la liste/.test(r.data?.message || ""), r.data?.message);
  r = await appel("GET", "/invoice-duplicates/sable", { token: tCompta, societe: 1 });
  v("et elle a bien disparu", !paire(r.data?.paires || [], "FS-1010", "FS-1011"));

  /* ═══════════════════════════════════════════════════════════════════════
     4. NEUTRALISER
     ═══════════════════════════════════════════════════════════════════════ */
  titre("On ne neutralise que ce qui a été confirmé doublon");
  const examenRenouv = await un(
    `SELECT * FROM invoice_duplicate_reviews WHERE verdict='RENOUVELLEMENT' LIMIT 1`);
  r = await appel("POST", `/invoice-duplicates/${examenRenouv.id}/neutraliser`, {
    token: tDir, societe: 1, corps: { conserver: examenRenouv.invoice_a_id, motif: "tentative sur un renouvellement" },
  });
  v("un renouvellement ne se neutralise pas",
    r.status === 409 && r.data?.code === "VERDICT_NON_DOUBLON", JSON.stringify(r.data));

  titre("Les droits");
  r = await appel("POST", `/invoice-duplicates/${examen.id}/neutraliser`, {
    token: tCompta, societe: 1, corps: { conserver: tech.a.id, motif: "neutralisation par le comptable" },
  });
  v("le comptable ne neutralise pas", r.status === 403, `${r.status} ${JSON.stringify(r.data)}`);
  v("on lui dit que c'est le geste qui est refusé", r.data?.code === "FORBIDDEN");

  titre("La neutralisation : ce qu'elle fait, et ce qu'elle ne fait pas");
  const ecrituresAvant = await nbEcritures();
  const paiementsAvant = await nbPaiements();
  const avantConservee = await facture(tech.a.id);
  v("FS-1001 ne porte rien encore", Number(avantConservee.paid_amount) === 0, F(avantConservee.paid_amount));
  v("FS-1002 porte les 400 000", Number((await facture(tech.b.id)).paid_amount) === 400000);

  r = await appel("POST", `/invoice-duplicates/${examen.id}/neutraliser`, {
    token: tDir, societe: 1,
    corps: { conserver: tech.a.id, motif: "FS-1002 est la saisie en double de FS-1001" },
  });
  v("la direction neutralise", r.status === 200, JSON.stringify(r.data)?.slice(0, 250));
  v("un encaissement a été déplacé", r.data?.paiements_deplaces === 1, String(r.data?.paiements_deplaces));
  v("pour 400 000", Number(r.data?.montant_deplace) === 400000, String(r.data?.montant_deplace));
  v("la réponse dit qu'aucune écriture n'a été créée",
    /Aucune écriture de trésorerie n'a été créée/.test(r.data?.avertissement || ""), r.data?.avertissement);

  titre("LE CONTRÔLE CENTRAL : aucun second encaissement");
  v("aucune écriture comptable n'a été créée", (await nbEcritures()) === ecrituresAvant,
    `${await nbEcritures()} contre ${ecrituresAvant}`);
  v("aucun paiement n'a été créé ni supprimé", (await nbPaiements()) === paiementsAvant,
    `${await nbPaiements()} contre ${paiementsAvant}`);
  v("le paiement est passé sur la facture conservée",
    Number((await paiement(3001)).invoice_id) === Number(tech.a.id));

  titre("Les deux factures, après");
  const conservee = await facture(tech.a.id);
  const neutralisee = await facture(tech.b.id);
  v("FS-1001 porte maintenant les 400 000", Number(conservee.paid_amount) === 400000, F(conservee.paid_amount));
  v("FS-1002 est annulée", neutralisee.status === "ANNULEE", neutralisee.status);
  v("elle n'est PAS supprimée", !!neutralisee);
  v("elle désigne celle qui fait foi",
    Number(neutralisee.duplicate_of_invoice_id) === Number(tech.a.id));
  v("elle porte la date de neutralisation", !!neutralisee.neutralized_at);
  v("et son motif", neutralisee.neutralize_reason === "FS-1002 est la saisie en double de FS-1001");
  v("elle ne porte plus d'encaissement", Number(neutralisee.paid_amount) === 0, F(neutralisee.paid_amount));

  titre("La trace du déplacement existe des deux côtés");
  const trace = await un(
    `SELECT * FROM payment_reallocations WHERE payment_id=3001 ORDER BY id DESC LIMIT 1`);
  v("une réaffectation a été enregistrée", !!trace);
  v("elle vient de FS-1002", trace?.from_invoice_number === "FS-1002");
  v("elle va vers FS-1001", trace?.to_invoice_number === "FS-1001");
  v("son motif rappelle la neutralisation",
    /doublon FS-1002 neutralisé/.test(trace?.reason || ""), trace?.reason);

  titre("On ne neutralise pas deux fois");
  r = await appel("POST", `/invoice-duplicates/${examen.id}/neutraliser`, {
    token: tDir, societe: 1, corps: { conserver: tech.a.id, motif: "seconde tentative sur la même paire" },
  });
  v("refusé", r.status === 409 && r.data?.code === "ALREADY_NEUTRALIZED", JSON.stringify(r.data));

  /* ═══════════════════════════════════════════════════════════════════════
     5. LE CAS OÙ LE CLIENT A PAYÉ DEUX FOIS
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Deux factures réglées : la neutralisation s'arrête");
  r = await appel("POST", "/invoice-duplicates/sable/trancher", {
    token: tCompta, societe: 1,
    corps: { facture_a: dangereux.a.id, facture_b: dangereux.b.id, verdict: "DOUBLON_CONFIRME",
             motif: "double saisie de la vente VS-0010" },
  });
  v("le verdict est rendu", r.status === 201, JSON.stringify(r.data)?.slice(0, 160));
  const examen2 = r.data?.examen;

  r = await appel("POST", `/invoice-duplicates/${examen2.id}/neutraliser`, {
    token: tDir, societe: 1,
    corps: { conserver: dangereux.a.id, motif: "neutraliser le doublon de VS-0010" },
  });
  v("la neutralisation est refusée", r.status === 409 && r.data?.code === "PAIEMENTS_DES_DEUX_COTES",
    JSON.stringify(r.data)?.slice(0, 250));
  v("le message dit que le client a payé deux fois",
    /le client a payé deux fois/.test(r.data?.error || ""), r.data?.error);
  v("et qu'il faut le rembourser", /rembourser/.test(r.data?.error || ""));
  v("les montants des deux côtés sont donnés",
    Number(r.data?.paye_conservee) === 700000 && Number(r.data?.paye_doublon) === 700000,
    JSON.stringify({ a: r.data?.paye_conservee, b: r.data?.paye_doublon }));
  v("rien n'a bougé", (await facture(dangereux.b.id)).status !== "ANNULEE");

  r = await appel("POST", `/invoice-duplicates/${examen2.id}/neutraliser`, {
    token: tDir, societe: 1,
    corps: { conserver: dangereux.a.id, motif: "doublon confirmé, remboursement engagé auprès du client",
             accepter_paiements_des_deux_cotes: true },
  });
  v("avec l'accord explicite, elle passe", r.status === 200, JSON.stringify(r.data)?.slice(0, 250));
  const apresDanger = await facture(dangereux.a.id);
  v("la facture conservée se trouve en trop-perçu",
    Number(apresDanger.paid_amount) === 1400000, F(apresDanger.paid_amount));
  v("ce qui rend le trop-payé VISIBLE au lieu de le dissimuler",
    Number(apresDanger.paid_amount) > Number(apresDanger.total_amount));
  v("toujours aucune écriture nouvelle", (await nbEcritures()) === ecrituresAvant);

  /* ═══════════════════════════════════════════════════════════════════════
     6. LES SOCIÉTÉS
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Les deux sociétés");
  r = await appel("GET", "/invoice-duplicates/sable", { token: tFat, societe: 2 });
  v("FAT & MAT voit ses propres paires", r.status === 200, `${r.status}`);
  const sienne = paire(r.data?.paires || [], "FS-1101", "FS-1102");
  v("les siennes, pas celles de Triangle", !!sienne);
  v("aucune facture de Triangle n'apparaît",
    !(r.data?.paires || []).some((x) => /FS-10/.test(x.a.numero) || /FS-10/.test(x.b.numero)));

  r = await appel("POST", `/invoice-duplicates/${examen.id}/neutraliser`, {
    token: tFat, societe: 2, corps: { conserver: tech.a.id, motif: "tentative depuis l'autre société" },
  });
  v("elle n'atteint pas un examen de Triangle", r.status === 404, `${r.status}`);

  r = await appel("POST", "/invoice-duplicates/sable/trancher", {
    token: tFat, societe: 2,
    corps: { facture_a: tech.a.id, facture_b: tech.b.id, verdict: "DOUBLON_CONFIRME",
             motif: "tentative sur des factures de Triangle" },
  });
  v("ni des factures de Triangle", r.status === 404, `${r.status} ${JSON.stringify(r.data)}`);

  /* ═══════════════════════════════════════════════════════════════════════
     7. CE QUE LA BASE REFUSE
     ═══════════════════════════════════════════════════════════════════════ */
  titre("La base tient ses propres règles");
  let refus = null;
  try {
    await pool.query(
      `INSERT INTO invoice_duplicate_reviews
         (company_id, product, invoice_a_id, invoice_a_number, invoice_b_id, invoice_b_number,
          verdict, verdict_reason, decided_at)
       VALUES (1,'SABLE',1020,'FS-1020',1021,'FS-1021','DOUBLON_CONFIRME','court',now())`);
  } catch (e) { refus = e; }
  v("un motif de moins de dix caractères est refusé", refus?.code === "23514", refus?.code);

  refus = null;
  try {
    await pool.query(
      `INSERT INTO invoice_duplicate_reviews
         (company_id, product, invoice_a_id, invoice_a_number, invoice_b_id, invoice_b_number,
          verdict, verdict_reason, decided_at)
       VALUES (1,'SABLE',1021,'FS-1021',1020,'FS-1020','DOUBLON_CONFIRME','un motif assez long',now())`);
  } catch (e) { refus = e; }
  v("une paire à l'envers est refusée (ordre fixe)", refus?.code === "23514", refus?.code);

  refus = null;
  try {
    await pool.query(
      `INSERT INTO invoice_duplicate_reviews
         (company_id, product, invoice_a_id, invoice_a_number, invoice_b_id, invoice_b_number,
          verdict, verdict_reason, decided_at, kept_invoice_id, neutralized_invoice_id, neutralized_at)
       VALUES (1,'SABLE',1030,'FS-1030',1031,'FS-1031','RENOUVELLEMENT','un motif assez long',now(),1030,1031,now())`);
  } catch (e) { refus = e; }
  v("neutraliser sans verdict de doublon est refusé", refus?.code === "23514", refus?.code);

  console.log(`\n${"─".repeat(56)}\n  ${ok} réussis, ${ko} échoués\n${"─".repeat(56)}`);
  await pool.end();
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

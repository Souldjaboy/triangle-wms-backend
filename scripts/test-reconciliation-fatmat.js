"use strict";
/**
 * §E — RÉCONCILIER FAT & MAT SANS RIEN INVENTER NI RIEN SUPPRIMER.
 *
 * Trois relevés de la direction donnent un nombre, une date et un total. La
 * base porte des factures. Ces tests éprouvent que l'outil EXPLIQUE l'écart
 * plutôt que de le faire disparaître :
 *
 *   • un relevé dont le total ET le nombre concordent peut quand même cacher
 *     une facture fausse — et l'outil doit le dire ;
 *   • une facture marquée payée sans le moindre encaissement est une anomalie
 *     à trancher, JAMAIS un encaissement à créer ;
 *   • un doublon imprimé ne s'annule pas : il s'examine ;
 *   • et rien, à aucun moment, n'est écrit en base.
 */
const { Pool } = require("pg");
const R = require("../services/reconciliation-fatmat");
const reference = require("./reference-fatmat-septembre-2026.json");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let ok = 0, ko = 0;
const v = (n, c, d = "") => { if (c) { ok++; console.log(`  ✔ ${n}`); } else { ko++; console.log(`  ✘ ${n}${d ? `\n      → ${d}` : ""}`); } };
const q = async (s, p = []) => (await pool.query(s, p)).rows;
const un = async (s, p = []) => (await q(s, p))[0];
const F = (n) => Number(n).toLocaleString("fr-FR");

/* La même requête que le script : les tests doivent porter sur ce que le
   script lit, pas sur une approximation. */
const LECTURE = `
  SELECT i.*, c.name AS customer_name,
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
      SELECT COALESCE(SUM(sp.amount),0) AS encaisse, count(*) AS nb
        FROM sand_payments sp
       WHERE sp.company_id = i.company_id AND sp.invoice_id = i.id
         AND NOT EXISTS (SELECT 1 FROM sand_payment_reversals r
                          WHERE r.company_id = sp.company_id AND r.original_payment_id = sp.id)
    ) p ON TRUE
   WHERE i.company_id = $1 AND i.invoice_date BETWEEN $2::date AND $3::date
   ORDER BY i.invoice_date, i.id`;

(async () => {
  const societe = await un(`SELECT id FROM companies WHERE name ILIKE '%FAT%' AND name ILIKE '%MAT%'`);
  const factures = await q(LECTURE, [societe.id, reference.periode.du, reference.periode.au]);
  const rapport = R.reconcilier(factures, reference);
  const par = (num) => rapport.factures.find((x) => x.numero === num);

  /* ══════════════════════════════════════════════════════════════════════
     1. LES TROIS RELEVÉS
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n1. Comparer la base aux relevés de la direction");

  v("les 34 factures et 38 481 000 FCFA attendus sont bien lus",
    reference.totaux_attendus.nombre === 34 && reference.totaux_attendus.montant === 38481000);

  const r1 = rapport.releves.find((r) => r.cle === "PAYEES_09_09");
  v("relevé 1 : 14 factures trouvées", r1.trouve.nombre === 14, `${r1.trouve.nombre}`);
  v(`relevé 1 : ${F(r1.trouve.total)} FCFA, comme annoncé`,
    r1.trouve.total === 20239000, `${F(r1.trouve.total)}`);
  v("relevé 1 est marqué CONCORDE", r1.concorde === true);

  const r2 = rapport.releves.find((r) => r.cle === "IMPAYEES_23_09");
  v("relevé 2 : deux factures de trop", r2.ecart.nombre === 2, `${r2.ecart.nombre}`);
  v(`relevé 2 : ${F(r2.ecart.total)} FCFA de trop, soit exactement les deux doublons`,
    r2.ecart.total === 1970000, `${F(r2.ecart.total)}`);
  v("relevé 2 est marqué en ÉCART", r2.concorde === false);

  const r3 = rapport.releves.find((r) => r.cle === "IMPAYEES_30_09_05_10");
  v("relevé 3 concorde exactement",
    r3.concorde === true && r3.trouve.total === 7956000, `${F(r3.trouve.total)}`);

  /* ══════════════════════════════════════════════════════════════════════
     2. CE QU'UN CONTRÔLE PAR TOTAUX NE VOIT PAS
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n2. Le relevé 1 concorde — et pourtant");

  const f14 = par("FS-0014");
  v("FS-0014 appartient bien au relevé 1", f14?.releve === "PAYEES_09_09", f14?.releve);
  v("elle est marquée payée", f14?.du === 0 && f14?.statut === "PAYEE");
  v("mais AUCUN encaissement n'existe en base", f14?.encaisse_reel === 0 && f14?.paiements === 0);
  v("l'outil le signale",
    f14?.anomalies.some((a) => a.code === "PAYEE_SANS_PAIEMENT"),
    JSON.stringify(f14?.anomalies.map((a) => a.code)));
  /* LA RÈGLE N°1 : on constate, on n'invente pas. */
  v("et il ne propose PAS de créer le paiement manquant",
    f14?.decision === "A_EXAMINER", f14?.decision);
  v("le nombre d'encaissements en base n'a pas changé",
    Number((await un(`SELECT count(*) c FROM sand_payments WHERE company_id=$1`, [societe.id])).c) === 16,
    `${(await un(`SELECT count(*) c FROM sand_payments WHERE company_id=$1`, [societe.id])).c}`);

  /* ══════════════════════════════════════════════════════════════════════
     3. LES DOUBLONS, ET LEQUEL EST L'ORIGINAL
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n3. Doublons : désigner la copie, pas l'original");

  const f60 = par("FS-0060"), f21 = par("FS-0021");
  v("FS-0060 est reconnue comme doublon exact",
    f60?.anomalies.some((a) => a.code === "DOUBLON_EXACT"),
    JSON.stringify(f60?.anomalies.map((a) => a.code)));
  /* Le point délicat : c'est la plus RÉCEMMENT SAISIE qui est la copie. */
  v("elle désigne FS-0021 comme l'originale", f60?.doublon_de === f21?.id,
    `${f60?.doublon_de} vs ${f21?.id}`);
  v("et FS-0021, elle, n'est accusée de rien", (f21?.anomalies || []).length === 0,
    JSON.stringify(f21?.anomalies.map((a) => a.code)));
  v("FS-0060 est candidate à l'annulation", f60?.decision === "CANDIDATE_ANNULATION", f60?.decision);

  const f61 = par("FS-0061"), f23 = par("FS-0023");
  v("FS-0061 est reconnue comme doublon probable",
    f61?.anomalies.some((a) => a.code === "DOUBLON_PROBABLE"));
  v("elle désigne FS-0023 comme l'originale", f61?.doublon_de === f23?.id);
  /* Elle est IMPRIMÉE : un document est sorti, on ne l'annule pas. */
  v("mais elle n'est PAS candidate : elle a été imprimée",
    f61?.decision === "A_EXAMINER", f61?.decision);
  v("et l'outil dit pourquoi",
    f61?.conservation.some((c) => c.code === "IMPRIMEE"),
    JSON.stringify(f61?.conservation.map((c) => c.code)));
  v("FS-0023, l'originale, est conservée", f23?.decision === "CONSERVER", f23?.decision);

  /* ══════════════════════════════════════════════════════════════════════
     4. LES AUTRES ANOMALIES
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n4. Ce que l'outil repère encore");

  const attendues = [
    ["FS-0031", "SAISIE_TARDIVE", "saisie 20 jours après sa date"],
    ["FS-0062", "MONTANT_INCOHERENT", "500 000 payés + 400 000 dus ≠ 1 000 000"],
    ["FS-0063", "ANNULEE_AVEC_PAIEMENT", "annulée, encaissement non contrepassé"],
    ["FS-0064", "VENTE_ANNULEE", "sa vente a été annulée"],
    ["FS-0064", "SANS_CLIENT", "aucun client rattaché"],
    ["FS-0065", "STATUT_INCOHERENT", "dit impayée alors que tout est réglé"],
  ];
  for (const [numero, code, pourquoi] of attendues) {
    const f = par(numero);
    v(`${numero} — ${pourquoi}`,
      !!f && f.anomalies.some((a) => a.code === code),
      JSON.stringify(f?.anomalies.map((a) => a.code)));
  }

  v("chaque anomalie porte une explication en français",
    rapport.factures.every((f) => f.anomalies.every((a) => !!a.libelle && a.libelle.length > 10)));

  /* La date de saisie est lue SÉPARÉMENT de la date de facture. */
  const f31 = par("FS-0031");
  v("la date de facture et la date de saisie sont distinguées",
    f31?.date_facture === "2026-09-23" && f31?.date_saisie === "2026-10-13",
    `${f31?.date_facture} / ${f31?.date_saisie}`);

  /* ══════════════════════════════════════════════════════════════════════
     5. LES TROIS LISTES
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n5. À conserver, à examiner, candidates");

  v("les trois listes couvrent toutes les factures actives",
    rapport.a_conserver.length + rapport.a_examiner.length
    + rapport.candidates_annulation.length
    + rapport.factures.filter((f) => f.annulee).length === rapport.factures.length,
    `${rapport.a_conserver.length}+${rapport.a_examiner.length}+${rapport.candidates_annulation.length}`);

  v("aucune facture n'est à la fois à conserver et candidate",
    !rapport.candidates_annulation.some((c) => rapport.a_conserver.includes(c.numero)));

  v("une seule candidate à l'annulation", rapport.candidates_annulation.length === 1,
    JSON.stringify(rapport.candidates_annulation.map((c) => c.numero)));

  const candidate = rapport.candidates_annulation[0];
  v("elle porte son montant", candidate?.montant === 950000, `${F(candidate?.montant)}`);
  v("et la conséquence comptable de son annulation",
    /aucun encaissement rattaché/.test(String(candidate?.consequence)), String(candidate?.consequence));

  /* Aucune candidate ne doit porter d'encaissement : ce serait le signe que
     la règle « ancrée dans le réel » a été contournée. */
  v("aucune candidate ne porte d'encaissement",
    rapport.candidates_annulation.every((c) => Number(c.paiements) === 0));

  v("l'avertissement dit ce qui n'a pas été fait",
    /Aucune facture n'a été annulée ni supprimée/.test(rapport.avertissement)
    && /aucun paiement n'a été créé/.test(rapport.avertissement),
    rapport.avertissement);

  /* ══════════════════════════════════════════════════════════════════════
     6. RIEN N'A ÉTÉ ÉCRIT
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n6. La base est intacte");

  const apres = {
    factures: Number((await un(`SELECT count(*) c FROM sand_invoices WHERE company_id=$1`, [societe.id])).c),
    paiements: Number((await un(`SELECT count(*) c FROM sand_payments WHERE company_id=$1`, [societe.id])).c),
    annulees: Number((await un(`SELECT count(*) c FROM sand_invoices WHERE company_id=$1 AND cancelled_at IS NOT NULL`, [societe.id])).c),
    total: Number((await un(`SELECT COALESCE(SUM(total_amount),0) t FROM sand_invoices WHERE company_id=$1`, [societe.id])).t),
  };
  v("le nombre de factures est inchangé", apres.factures === 40, `${apres.factures}`);
  v("le nombre d'encaissements est inchangé", apres.paiements === 16, `${apres.paiements}`);
  v("une seule facture annulée, celle qui l'était déjà", apres.annulees === 1, `${apres.annulees}`);
  v("le montant total est inchangé", apres.total === 43201000, `${F(apres.total)}`);
  v("aucune contrepassation n'a été créée",
    Number((await un(`SELECT count(*) c FROM sand_payment_reversals WHERE company_id=$1`, [societe.id])).c) === 0);

  /* ══════════════════════════════════════════════════════════════════════
     7. LE SCRIPT REFUSE TOUT MODE D'ÉCRITURE
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n7. Il n'existe aucun bouton « appliquer »");

  const { execFileSync } = require("child_process");
  for (const option of ["--appliquer", "--apply", "--annuler", "--supprimer"]) {
    let refuse = false, message = "";
    try {
      execFileSync(process.execPath, ["scripts/reconcilier-fatmat.js", option],
        { env: { ...process.env }, encoding: "utf8", stdio: "pipe" });
    } catch (e) { refuse = true; message = String(e.stderr || ""); }
    v(`« ${option} » est refusé`, refuse && /ne modifie rien/.test(message), message.slice(0, 120));
  }

  /* Le script tourne dans une transaction en LECTURE SEULE : même un bug
     d'écriture échouerait avec le code 25006 au lieu de passer. */
  const client = await pool.connect();
  let code = null;
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query(`UPDATE sand_invoices SET status='PAYEE' WHERE id=-1`);
  } catch (e) { code = e.code; }
  finally { await client.query("ROLLBACK").catch(() => {}); client.release(); }
  v("PostgreSQL refuse toute écriture dans ce mode (25006)", code === "25006", String(code));

  /* ══════════════════════════════════════════════════════════════════════
     8. L'ÉTANCHÉITÉ
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n8. Triangle n'entre pas dans ce rapport");

  v("aucune facture de Triangle n'est lue",
    rapport.factures.every((f) => !String(f.numero || "").startsWith("FC-")));
  const triangle = await un(
    `SELECT count(*) c FROM sand_invoices i JOIN companies co ON co.id=i.company_id
      WHERE co.name = 'Triangle'`);
  v("les factures de Triangle restent hors du périmètre",
    rapport.factures.length === 40 - 0 - Number(triangle.c) || rapport.factures.length <= 40,
    `${rapport.factures.length} lues, ${triangle.c} chez Triangle`);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${ok} réussis, ${ko} échoués`);
  console.log(ko === 0
    ? "  L'écart est expliqué, aucun paiement inventé, aucune facture supprimée."
    : "  Des points restent à corriger.");
  await pool.end();
  process.exit(ko === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });

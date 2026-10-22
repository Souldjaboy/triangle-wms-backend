"use strict";
/**
 * LES ÉTATS DE FACTURES.
 *
 * Ce que ces tests éprouvent, dans l'ordre où cela compte :
 *
 *  1. Qu'une facture portée sur un état VALIDÉ cesse d'être disponible, et
 *     que la règle tient même quand deux validations se croisent — c'est la
 *     raison d'être de l'index unique, et un contrôle applicatif seul aurait
 *     laissé passer.
 *  2. Qu'annuler l'état LIBÈRE ses factures, et que corriger ne les perd pas.
 *  3. Qu'un état validé ne se réécrit plus, et que le corriger produit un
 *     nouvel état qui désigne l'ancien, lequel reste lisible.
 *  4. Que les deux sociétés ne se voient pas, même avec des numéros de
 *     facture identiques — et que le droit sur les états ne donne pas accès
 *     à un produit qu'on n'a pas.
 *  5. Qu'un état repris de l'historique protège ses numéros, y compris ceux
 *     qu'aucune facture enregistrée ne porte encore.
 *  6. Que l'écran est averti tant que les états antérieurs n'ont pas été
 *     repris, au lieu de laisser croire qu'une facture absente est libre.
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

async function appel(m, chemin, { token, societe, corps, brut } = {}) {
  const headers = { "x-tenant-id": "triangle" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (societe) headers["x-active-company-id"] = String(societe);
  if (corps !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(BASE + chemin, { method: m, headers,
    body: corps === undefined ? undefined : JSON.stringify(corps) });
  if (brut) return { status: r.status, buffer: Buffer.from(await r.arrayBuffer()), type: r.headers.get("content-type") };
  let data = null; try { data = await r.json(); } catch { /* corps non JSON */ }
  return { status: r.status, data };
}

const DIR    = { id: 904, fullname: "Direction Triangle", role: "direction", company_id: 1, is_super_admin: false };
const COMPTA = { id: 903, fullname: "Comptable Triangle", role: "comptable", company_id: 1, is_super_admin: false };
const MAGA   = { id: 905, fullname: "Magasinier Triangle", role: "magasinier", company_id: 1, is_super_admin: false };
const COMPTA_F = { id: 906, fullname: "Comptable Fatemat", role: "comptable", company_id: 2, is_super_admin: false };

const etat = async (id) => un(`SELECT * FROM invoice_statements WHERE id=$1`, [id]);
const lignes = async (id) => q(`SELECT * FROM invoice_statement_lines WHERE statement_id=$1 ORDER BY sort_order,id`, [id]);
const histo = async (id) => q(`SELECT * FROM invoice_statement_history WHERE statement_id=$1 ORDER BY id`, [id]);

(async () => {
  const tDir = jeton(DIR), tCompta = jeton(COMPTA), tMaga = jeton(MAGA), tFat = jeton(COMPTA_F);

  /* ═══════════════════════════════════════════════════════════════════════
     1. LA SÉLECTION
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Ce qu'on peut porter sur un état");
  let r = await appel("GET", "/invoice-statements/selection?product=SABLE", { token: tDir, societe: 1 });
  v("la sélection répond", r.status === 200, JSON.stringify(r.data));
  const dispo = r.data?.factures || [];
  v("les trois factures vivantes sont proposées", dispo.length === 3,
    `${dispo.length} : ${dispo.map((f) => f.numero).join(", ")}`);
  v("la facture ANNULÉE n'est pas proposée", !dispo.some((f) => f.numero === "FS-0004"));
  v("la facture REMPLACÉE n'est pas proposée", !dispo.some((f) => f.numero === "FS-0005"));
  v("les montants sont ceux de la facture", dispo.find((f) => f.numero === "FS-0002")?.montant === 600000);
  v("le restant dû est repris", dispo.find((f) => f.numero === "FS-0002")?.restant === 400000);
  v("aucune n'est déjà prise", dispo.every((f) => f.deja_sur_etat === null));

  titre("L'avertissement sur les états antérieurs");
  const av = r.data?.avertissement_historique;
  v("l'historique est déclaré INCOMPLET par défaut", av?.historique_complet === false);
  v("et le message le dit en toutes lettres",
    /peut déjà figurer sur un état papier/.test(av?.message || ""), av?.message);
  v("aucun état antérieur n'a encore été repris", av?.etats_repris === 0);

  /* ═══════════════════════════════════════════════════════════════════════
     2. CRÉER, VALIDER, ET CE QUE CELA FERME
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Créer un état");
  r = await appel("POST", "/invoice-statements", {
    token: tCompta, societe: 1,
    corps: { product: "SABLE", factures: [1001, 1002], titre: "Septembre 2026", du: "2026-09-01", au: "2026-09-30" },
  });
  v("l'état est créé", r.status === 201, JSON.stringify(r.data));
  const e1 = r.data?.etat;
  v("il porte un numéro de la série ETS", /^ETS-\d{6}-\d{3}$/.test(e1?.statement_number || ""), e1?.statement_number);
  v("il est en BROUILLON", e1?.status === "BROUILLON");
  v("ses totaux sont calculés", Number(e1?.total_invoiced) === 1050000, String(e1?.total_invoiced));
  v("le restant dû total aussi", Number(e1?.total_remaining) === 850000, String(e1?.total_remaining));
  v("il compte deux factures", e1?.invoices_count === 2);

  titre("Un brouillon ne bloque rien");
  r = await appel("GET", "/invoice-statements/selection?product=SABLE", { token: tDir, societe: 1 });
  v("les factures du brouillon restent disponibles", (r.data?.factures || []).length === 3,
    `${(r.data?.factures || []).length}`);
  const l1 = await lignes(e1.id);
  v("aucune ligne ne bloque encore", l1.every((l) => l.blocks_reuse === false));

  titre("Un second brouillon peut viser les mêmes factures");
  r = await appel("POST", "/invoice-statements", {
    token: tCompta, societe: 1, corps: { product: "SABLE", factures: [1001] },
  });
  v("le second brouillon est accepté", r.status === 201, JSON.stringify(r.data));
  const e2 = r.data?.etat;
  v("les deux brouillons existent", e1.id !== e2.id);

  titre("Valider arrête l'état");
  r = await appel("POST", `/invoice-statements/${e1.id}/valider`, { token: tCompta, societe: 1 });
  v("la validation passe", r.status === 200, JSON.stringify(r.data));
  v("l'état est VALIDE", r.data?.etat?.status === "VALIDE");
  v("il porte qui l'a validé", r.data?.etat?.validated_by_name === "Comptable Triangle");
  v("et quand", !!r.data?.etat?.validated_at);
  const l1b = await lignes(e1.id);
  v("ses lignes bloquent désormais", l1b.every((l) => l.blocks_reuse === true));

  titre("Les factures de l'état validé ne sont plus disponibles");
  r = await appel("GET", "/invoice-statements/selection?product=SABLE", { token: tDir, societe: 1 });
  const restantes = r.data?.factures || [];
  v("il n'en reste qu'une", restantes.length === 1, restantes.map((f) => f.numero).join(", "));
  v("c'est FS-0003", restantes[0]?.numero === "FS-0003");

  titre("Mais on peut DEMANDER à voir celles qui sont prises");
  r = await appel("GET", "/invoice-statements/selection?product=SABLE&inclure_prises=1", { token: tDir, societe: 1 });
  const toutes = r.data?.factures || [];
  v("les trois reviennent", toutes.length === 3, `${toutes.length}`);
  const prise = toutes.find((f) => f.numero === "FS-0001");
  v("FS-0001 est marquée comme prise", prise?.deja_sur_etat !== null);
  v("et l'écran sait PAR QUEL état", prise?.deja_sur_etat?.numero === e1.statement_number,
    JSON.stringify(prise?.deja_sur_etat));

  titre("Le second brouillon ne peut plus être validé");
  r = await appel("POST", `/invoice-statements/${e2.id}/valider`, { token: tCompta, societe: 1 });
  v("la validation est refusée", r.status === 409, `${r.status} ${JSON.stringify(r.data)}`);
  v("et c'est l'unicité qui a parlé", r.data?.code === "CONCURRENT_STATEMENT", r.data?.code);
  v("le second brouillon est resté BROUILLON", (await etat(e2.id))?.status === "BROUILLON");

  titre("Ajouter une facture déjà prise est refusé, et l'on dit par qui");
  r = await appel("POST", `/invoice-statements/${e2.id}/lignes`, {
    token: tCompta, societe: 1, corps: { factures: [1002] },
  });
  v("l'ajout est refusé", r.status === 409, `${r.status}`);
  v("le message nomme l'état qui la détient",
    (r.data?.error || "").includes(e1.statement_number), r.data?.error);

  /* ═══════════════════════════════════════════════════════════════════════
     3. CE QU'UN ÉTAT VALIDÉ N'ACCEPTE PLUS
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Un état validé ne se modifie plus");
  r = await appel("POST", `/invoice-statements/${e1.id}/lignes`, {
    token: tCompta, societe: 1, corps: { factures: [1003] },
  });
  v("l'ajout est refusé", r.status === 409 && r.data?.code === "STATEMENT_NOT_DRAFT", JSON.stringify(r.data));
  const uneLigne = (await lignes(e1.id))[0];
  r = await appel("DELETE", `/invoice-statements/${e1.id}/lignes/${uneLigne.id}`, { token: tCompta, societe: 1 });
  v("le retrait est refusé aussi", r.status === 409, `${r.status}`);
  v("la ligne est toujours là", (await lignes(e1.id)).length === 2);

  titre("Le valider deux fois ne passe pas");
  r = await appel("POST", `/invoice-statements/${e1.id}/valider`, { token: tCompta, societe: 1 });
  v("refusé", r.status === 409 && r.data?.code === "ALREADY_VALIDATED", JSON.stringify(r.data));

  /* ═══════════════════════════════════════════════════════════════════════
     4. LES DROITS
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Les droits");
  r = await appel("POST", `/invoice-statements/${e1.id}/annuler`, {
    token: tCompta, societe: 1, corps: { motif: "erreur de période sur cet état" },
  });
  v("le comptable ne peut pas annuler", r.status === 404 || r.status === 403, `${r.status}`);
  v("l'état n'a pas bougé", (await etat(e1.id))?.status === "VALIDE");

  r = await appel("GET", "/invoice-statements?product=SABLE", { token: tMaga, societe: 1 });
  v("le magasinier ne voit pas le module", r.status === 404, `${r.status}`);

  r = await appel("POST", "/invoice-statements", {
    token: tMaga, societe: 1, corps: { product: "SABLE", factures: [1003] },
  });
  v("et ne peut pas créer d'état", r.status === 404, `${r.status}`);

  titre("Le droit sur les états ne donne pas accès à un produit qu'on n'a pas");
  r = await appel("GET", "/invoice-statements/selection?product=CIMENT", { token: tFat, societe: 2 });
  v("le comptable de FAT & MAT n'atteint pas le ciment", r.status === 404, `${r.status} ${JSON.stringify(r.data)}`);
  r = await appel("GET", "/invoice-statements/selection?product=SABLE", { token: tFat, societe: 2 });
  v("mais atteint bien le sable", r.status === 200, `${r.status}`);

  /* ═══════════════════════════════════════════════════════════════════════
     5. LA SÉPARATION DES SOCIÉTÉS
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Deux sociétés, les mêmes numéros de facture");
  const memeNumero = await q(
    `SELECT company_id FROM sand_invoices WHERE invoice_number='FS-0001' ORDER BY company_id`);
  v("FS-0001 existe dans les deux sociétés", memeNumero.length === 2,
    memeNumero.map((x) => x.company_id).join("/"));

  r = await appel("POST", "/invoice-statements", {
    token: tFat, societe: 2, corps: { product: "SABLE", factures: [1101] },
  });
  v("FAT & MAT crée son propre état sur SON FS-0001", r.status === 201, JSON.stringify(r.data));
  const eFat = r.data?.etat;
  r = await appel("POST", `/invoice-statements/${eFat.id}/valider`, { token: tFat, societe: 2 });
  v("et le valide, bien que Triangle ait validé le sien", r.status === 200,
    `${r.status} ${JSON.stringify(r.data)}`);

  titre("Aucune des deux ne voit l'état de l'autre");
  r = await appel("GET", `/invoice-statements/${eFat.id}`, { token: tDir, societe: 1 });
  v("Triangle ne lit pas l'état de FAT & MAT", r.status === 404, `${r.status}`);
  r = await appel("GET", `/invoice-statements/${e1.id}`, { token: tFat, societe: 2 });
  v("et réciproquement", r.status === 404, `${r.status}`);

  titre("Une facture d'une autre société ne se porte pas sur un état");
  r = await appel("POST", "/invoice-statements", {
    token: tDir, societe: 1, corps: { product: "SABLE", factures: [1101] },
  });
  v("refusé", r.status === 404 && r.data?.code === "INVOICE_NOT_FOUND", JSON.stringify(r.data));

  /* ═══════════════════════════════════════════════════════════════════════
     6. ANNULER, ET LIBÉRER
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Annuler demande un motif");
  r = await appel("POST", `/invoice-statements/${e1.id}/annuler`, {
    /* « trop court » fait exactement dix caractères, donc passerait le
       minimum : c'est le piège exact dans lequel un essai précédent était
       tombé. On en prend un vraiment court. */
    token: tDir, societe: 1, corps: { motif: "erreur" },
  });
  v("un motif de moins de dix caractères est refusé", r.status === 400 && r.data?.code === "REASON_REQUIRED",
    JSON.stringify(r.data));

  r = await appel("POST", `/invoice-statements/${e1.id}/annuler`, {
    token: tDir, societe: 1, corps: { motif: "la période retenue était fausse" },
  });
  v("avec motif, la direction annule", r.status === 200, JSON.stringify(r.data));
  v("l'état est ANNULE", r.data?.etat?.status === "ANNULE");
  v("le motif est conservé", r.data?.etat?.cancel_reason === "la période retenue était fausse");
  v("ses lignes ne bloquent plus", (await lignes(e1.id)).every((l) => l.blocks_reuse === false));

  titre("Les factures sont redevenues disponibles");
  r = await appel("GET", "/invoice-statements/selection?product=SABLE", { token: tDir, societe: 1 });
  v("les trois reviennent", (r.data?.factures || []).length === 3, `${(r.data?.factures || []).length}`);

  titre("Et le brouillon mis en attente peut enfin être validé");
  r = await appel("POST", `/invoice-statements/${e2.id}/valider`, { token: tCompta, societe: 1 });
  v("validé", r.status === 200, JSON.stringify(r.data));

  /* ═══════════════════════════════════════════════════════════════════════
     7. CORRIGER
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Corriger un état validé");
  r = await appel("POST", `/invoice-statements/${e2.id}/corriger`, {
    token: tCompta, societe: 1, corps: { motif: "il manquait la facture FS-0003" },
  });
  v("le comptable ne corrige pas", r.status === 404 || r.status === 403, `${r.status}`);

  r = await appel("POST", `/invoice-statements/${e2.id}/corriger`, {
    token: tDir, societe: 1, corps: { motif: "oubli" },
  });
  v("un motif trop court est refusé", r.status === 400, `${r.status}`);

  r = await appel("POST", `/invoice-statements/${e2.id}/corriger`, {
    token: tDir, societe: 1, corps: { motif: "il manquait la facture FS-0003", factures: [1001, 1003] },
  });
  v("la direction corrige", r.status === 201, JSON.stringify(r.data));
  const e3 = r.data?.etat;
  v("un NOUVEL état est né", e3 && e3.id !== e2.id);
  v("il désigne celui qu'il remplace", Number(e3?.replaces_statement_id) === Number(e2.id));
  v("et porte le motif", e3?.replace_reason === "il manquait la facture FS-0003");
  v("il reprend FS-0001, que l'ancien détenait", (await lignes(e3.id)).some((l) => l.invoice_number === "FS-0001"));
  v("et ajoute FS-0003", (await lignes(e3.id)).some((l) => l.invoice_number === "FS-0003"));

  const ancien = await etat(e2.id);
  v("l'ancien état est REMPLACE, pas effacé", ancien?.status === "REMPLACE", ancien?.status);
  v("il reste lisible", (await appel("GET", `/invoice-statements/${e2.id}`, { token: tDir, societe: 1 })).status === 200);
  v("ses lignes sont toujours là", (await lignes(e2.id)).length === 1);
  v("mais ne réclament plus rien", (await lignes(e2.id)).every((l) => l.blocks_reuse === false));

  titre("Le nouvel état se valide, et reprend le blocage");
  r = await appel("POST", `/invoice-statements/${e3.id}/valider`, { token: tDir, societe: 1 });
  v("validé", r.status === 200, JSON.stringify(r.data));
  v("ses lignes bloquent", (await lignes(e3.id)).every((l) => l.blocks_reuse === true));
  r = await appel("GET", "/invoice-statements/selection?product=SABLE", { token: tDir, societe: 1 });
  v("il ne reste que FS-0002", (r.data?.factures || []).map((f) => f.numero).join(",") === "FS-0002",
    (r.data?.factures || []).map((f) => f.numero).join(","));

  titre("Un état remplacé ne s'annule pas : c'est son successeur qu'il faut viser");
  r = await appel("POST", `/invoice-statements/${e2.id}/annuler`, {
    token: tDir, societe: 1, corps: { motif: "tentative sur un état remplacé" },
  });
  v("refusé", r.status === 409 && r.data?.code === "STATEMENT_REPLACED", JSON.stringify(r.data));

  /* ═══════════════════════════════════════════════════════════════════════
     8. L'HISTORIQUE DES ÉTATS ANTÉRIEURS
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Reprendre un état papier antérieur");
  r = await appel("POST", "/invoice-statements/historique", {
    token: tDir, societe: 1,
    corps: {
      product: "SABLE", reference: "ÉTAT PAPIER N° 14 — AOÛT 2026",
      numeros: ["FS-0002", "FS-7777", "FS-8888"],
      titre: "Août 2026 (repris)",
    },
  });
  v("la reprise passe", r.status === 201, JSON.stringify(r.data));
  v("une facture existante est rapprochée", r.data?.rapprochees === 1, String(r.data?.rapprochees));
  v("deux numéros inconnus restent orphelins", r.data?.orphelines === 2, String(r.data?.orphelines));
  const eh = r.data?.etat;
  v("l'état repris est VALIDE d'emblée", eh?.status === "VALIDE");
  v("et marqué HISTORIQUE", eh?.origin === "HISTORIQUE");
  v("il garde la référence du document papier", eh?.historical_reference === "ÉTAT PAPIER N° 14 — AOÛT 2026");

  titre("Ce que la reprise protège");
  r = await appel("GET", "/invoice-statements/selection?product=SABLE", { token: tDir, societe: 1 });
  v("FS-0002 n'est plus disponible", !(r.data?.factures || []).some((f) => f.numero === "FS-0002"),
    (r.data?.factures || []).map((f) => f.numero).join(","));

  const orphelines = await q(
    `SELECT * FROM invoice_statement_lines WHERE statement_id=$1 AND reconciled=FALSE`, [eh.id]);
  v("les lignes orphelines sont conservées", orphelines.length === 2);
  v("et bloquent quand même leur numéro", orphelines.every((l) => l.blocks_reuse === true));
  v("elles ne désignent aucune facture", orphelines.every((l) => l.invoice_id === null));

  titre("Une facture saisie plus tard se rapproche de sa ligne");
  await pool.query(
    `INSERT INTO sand_invoices (id,company_id,sale_id,customer_id,invoice_number,invoice_date,
       total_amount,paid_amount,remaining_amount,status)
     VALUES (1200,1,701,501,'FS-7777','2026-08-11',350000,0,350000,'IMPAYEE')
     ON CONFLICT (id) DO NOTHING`);
  r = await appel("POST", "/invoice-statements/rapprocher", {
    token: tDir, societe: 1, corps: { product: "SABLE" },
  });
  v("le rapprochement répond", r.status === 200, JSON.stringify(r.data));
  v("une ligne a été reliée", r.data?.rapprochees === 1, String(r.data?.rapprochees));
  const apres = await q(
    `SELECT * FROM invoice_statement_lines WHERE statement_id=$1 AND invoice_number='FS-7777'`, [eh.id]);
  v("la ligne désigne maintenant la facture", Number(apres[0]?.invoice_id) === 1200);
  v("et a repris son montant", Number(apres[0]?.total_amount) === 350000, String(apres[0]?.total_amount));
  v("la facture n'est pas proposée à la sélection",
    !((await appel("GET", "/invoice-statements/selection?product=SABLE", { token: tDir, societe: 1 }))
      .data?.factures || []).some((f) => f.numero === "FS-7777"));

  titre("Déclarer la reprise achevée");
  r = await appel("POST", "/invoice-statements/historique/declarer", {
    token: tDir, societe: 1, corps: { product: "SABLE", complet: true, note: "oubli" },
  });
  v("une note trop courte est refusée", r.status === 400 && r.data?.code === "NOTE_REQUIRED", JSON.stringify(r.data));

  r = await appel("POST", "/invoice-statements/historique/declarer", {
    token: tDir, societe: 1,
    corps: { product: "SABLE", complet: true, note: "les 14 états papier du classeur 2026 ont été saisis" },
  });
  v("avec une note, la déclaration passe", r.status === 200, JSON.stringify(r.data));
  r = await appel("GET", "/invoice-statements/selection?product=SABLE", { token: tDir, societe: 1 });
  v("l'avertissement change de sens", r.data?.avertissement_historique?.historique_complet === true);
  v("et le message aussi",
    /signifie qu'elle est libre/.test(r.data?.avertissement_historique?.message || ""),
    r.data?.avertissement_historique?.message);

  /* ═══════════════════════════════════════════════════════════════════════
     9. LE PDF
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Imprimer");
  r = await appel("GET", `/invoice-statements/${e3.id}/pdf`, { token: tCompta, societe: 1, brut: true });
  v("le PDF sort", r.status === 200, `${r.status}`);
  v("c'est bien un PDF", r.type === "application/pdf", r.type);
  v("et il n'est pas vide", (r.buffer?.length || 0) > 1500, `${r.buffer?.length} octets`);
  v("l'impression est comptée", (await etat(e3.id))?.printed_count === 1);
  v("et journalisée", (await histo(e3.id)).some((h) => h.action === "IMPRESSION"));

  titre("Réimprimer demande un droit distinct");
  r = await appel("GET", `/invoice-statements/${e3.id}/pdf`, { token: tCompta, societe: 1, brut: true });
  v("le comptable, sans « reprint », est refusé", r.status === 403, `${r.status}`);
  v("le compteur n'a pas bougé", (await etat(e3.id))?.printed_count === 1);

  r = await appel("GET", `/invoice-statements/${e3.id}/pdf`, { token: tDir, societe: 1, brut: true });
  v("la direction réimprime", r.status === 200, `${r.status}`);
  v("le compteur avance", (await etat(e3.id))?.printed_count === 2);
  v("et la réimpression est distinguée dans l'historique",
    (await histo(e3.id)).some((h) => h.action === "REIMPRESSION"));

  /* ═══════════════════════════════════════════════════════════════════════
     10. L'HISTOIRE SE LIT
     ═══════════════════════════════════════════════════════════════════════ */
  titre("L'historique de l'état");
  const h3 = await histo(e3.id);
  v("la création y figure", h3.some((h) => h.action === "CREATION"));
  v("la validation aussi", h3.some((h) => h.action === "VALIDATION"));
  v("chaque ligne porte son auteur", h3.every((h) => (h.acted_by_name || "").length > 0));
  const h2 = await histo(e2.id);
  v("l'état remplacé garde la trace du remplacement", h2.some((h) => h.action === "REMPLACEMENT"));
  v("avec son motif", h2.find((h) => h.action === "REMPLACEMENT")?.reason === "il manquait la facture FS-0003");

  titre("Le détail renvoie tout d'un coup");
  r = await appel("GET", `/invoice-statements/${e3.id}`, { token: tDir, societe: 1 });
  v("l'état", !!r.data?.etat);
  v("ses lignes", (r.data?.lignes || []).length === 2);
  v("son historique", (r.data?.historique || []).length >= 3);

  /* ═══════════════════════════════════════════════════════════════════════
     11. CE QU'ON NE PEUT PAS FAIRE
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Les refus de bon sens");
  r = await appel("POST", "/invoice-statements", { token: tDir, societe: 1, corps: { product: "SABLE", factures: [] } });
  v("un état vide est refusé", r.status === 400 && r.data?.code === "NO_INVOICE_SELECTED", JSON.stringify(r.data));

  r = await appel("POST", "/invoice-statements", { token: tDir, societe: 1, corps: { product: "GRAVIER", factures: [1] } });
  v("un produit inconnu est refusé", r.status === 400 && r.data?.code === "PRODUCT_UNKNOWN", JSON.stringify(r.data));

  r = await appel("POST", "/invoice-statements", { token: tDir, societe: 1, corps: { product: "SABLE", factures: [1004] } });
  v("une facture annulée est refusée", r.status === 409 && r.data?.code === "INVOICE_STATUS_EXCLUDED", JSON.stringify(r.data));

  r = await appel("GET", "/invoice-statements/999999", { token: tDir, societe: 1 });
  v("un état inexistant répond 404", r.status === 404);

  /* ═══════════════════════════════════════════════════════════════════════
     12. LE CIMENT, PAR LE MÊME CHEMIN
     ═══════════════════════════════════════════════════════════════════════ */
  titre("Le ciment");
  r = await appel("GET", "/invoice-statements/selection?product=CIMENT", { token: tDir, societe: 1 });
  v("la sélection ciment répond", r.status === 200, `${r.status}`);
  v("les deux factures ciment sont proposées", (r.data?.factures || []).length === 2,
    (r.data?.factures || []).map((f) => f.numero).join(","));

  r = await appel("POST", "/invoice-statements", {
    token: tDir, societe: 1, corps: { product: "CIMENT", factures: [2001, 2002] },
  });
  v("l'état ciment est créé", r.status === 201, JSON.stringify(r.data));
  const ec = r.data?.etat;
  v("son numéro est de la série ETC", /^ETC-\d{6}-\d{3}$/.test(ec?.statement_number || ""), ec?.statement_number);
  v("les séries sable et ciment sont distinctes",
    ec.statement_number.slice(0, 3) !== e3.statement_number.slice(0, 3));

  r = await appel("POST", `/invoice-statements/${ec.id}/valider`, { token: tDir, societe: 1 });
  v("il se valide", r.status === 200, JSON.stringify(r.data));

  titre("Un numéro de facture ciment identique à un numéro sable ne se gêne pas");
  const fcEtFs = await q(
    `SELECT product, invoice_number FROM invoice_statement_lines
      WHERE company_id=1 AND blocks_reuse ORDER BY product, invoice_number`);
  v("les deux produits cohabitent", new Set(fcEtFs.map((x) => x.product)).size === 2,
    JSON.stringify(fcEtFs.map((x) => `${x.product}/${x.invoice_number}`)));

  titre("La liste ne montre que les produits autorisés");
  r = await appel("GET", "/invoice-statements", { token: tFat, societe: 2 });
  v("la liste répond", r.status === 200, `${r.status}`);
  v("FAT & MAT ne voit que le sable", (r.data?.produits_autorises || []).join(",") === "SABLE",
    (r.data?.produits_autorises || []).join(","));
  v("et aucun état ciment n'apparaît", (r.data?.etats || []).every((e) => e.product === "SABLE"));

  /* ═══════════════════════════════════════════════════════════════════════
     13. LA CONTRAINTE TIENT MÊME SI L'APPLICATION SE TROMPE
     ═══════════════════════════════════════════════════════════════════════ */
  titre("La base refuse ce que le code aurait pu laisser passer");
  let refus = null;
  try {
    /* On contourne volontairement le service : insertion directe d'une ligne
       bloquante sur une facture déjà réclamée. Si l'index n'existait pas, la
       base accepterait, et deux états réclameraient la même facture. */
    const cible = await un(
      `SELECT invoice_id, product, company_id FROM invoice_statement_lines WHERE blocks_reuse LIMIT 1`);
    await pool.query(
      `INSERT INTO invoice_statement_lines
         (statement_id, company_id, product, invoice_id, invoice_number, reconciled, blocks_reuse)
       VALUES ($1,$2,$3,$4,'DOUBLON',TRUE,TRUE)`,
      [eh.id, cible.company_id, cible.product, cible.invoice_id]);
  } catch (e) { refus = e; }
  v("l'insertion directe est refusée par l'index", refus?.code === "23505", refus?.code || "acceptée !");

  console.log(`\n${"─".repeat(56)}\n  ${ok} réussis, ${ko} échoués\n${"─".repeat(56)}`);
  await pool.end();
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

"use strict";
/**
 * §C — UNE DEMANDE VALIDÉE NE DOIT PAS DEVENIR DÉFINITIVEMENT INCORRIGIBLE.
 *
 * Avant : une demande RECUE ne pouvait plus rien devenir. L'annulation la
 * refusait, et la seule issue connue était de créer une demande inverse « à
 * la main » — sans lien avec l'originale, sans motif, et sans que personne
 * puisse plus tard relier les deux.
 *
 * Ces tests éprouvent les trois gestes et surtout ce qu'ils ne font PAS :
 * aucun stock n'est réécrit directement, aucun mouvement n'est effacé, et le
 * droit de défaire n'est pas celui de faire.
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
const DIR    = { id: 904, fullname: "Direction Triangle", role: "direction", company_id: 1, is_super_admin: false };
const ZERBO  = { id: 906, fullname: "Zerbo Magasinier", role: "magasinier", company_id: 1, is_super_admin: false };

const demande = async (id) => un(`SELECT * FROM stock_requests WHERE id=$1`, [id]);
const lignes = async (id) => q(`SELECT * FROM stock_request_lines WHERE request_id=$1 ORDER BY line_no`, [id]);
const stock = async (id) => Number((await un(`SELECT stock FROM products WHERE id=$1`, [id]))?.stock || 0);
const mouvement = async (id) => un(`SELECT * FROM stock_movements WHERE id=$1`, [id]);
const corrections = async (id) => q(`SELECT * FROM stock_request_corrections WHERE request_id=$1 ORDER BY id`, [id]);

(async () => {
  const tS = jeton(SUPER), tF = jeton(SUPER_F), tD = jeton(DIR), tZ = jeton(ZERBO);

  /* ══════════════════════════════════════════════════════════════════════
     1. MODIFIER UNE DEMANDE QUI N'A RIEN PRODUIT
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n1. DE-001, en attente");

  const sansMotif = await appel("POST", "/stock-requests/1/modifier", {
    token: tZ, societe: 1, corps: { modifications: { motif: "Autre raison" }, motif: "non" } });
  v("modifier sans motif suffisant est refusé",
    sansMotif.status === 400 && sansMotif.data?.code === "REASON_REQUIRED", `${sansMotif.status}`);

  const mod = await appel("POST", "/stock-requests/1/modifier", {
    token: tZ, societe: 1,
    corps: { modifications: { motif: "Réapprovisionnement urgent chantier Kati",
                              supplier_name: "Fournisseur Keita" },
             motif: "Le chantier a changé, le besoin aussi" } });
  v("la modification est acceptée", mod.status === 200, `${mod.status} ${JSON.stringify(mod.data)}`);
  const d1 = await demande(1);
  v("le motif est à jour", /chantier Kati/.test(d1.motif || ""), d1.motif);
  v("le fournisseur aussi", d1.supplier_name === "Fournisseur Keita");
  v("la demande reste EN_ATTENTE", d1.status === "EN_ATTENTE");

  const h1 = await corrections(1);
  v("une ligne d'historique est écrite", h1.length === 1, `${h1.length}`);
  v("elle est marquée MODIFICATION", h1[0]?.action === "MODIFICATION");
  v("elle garde la valeur d'AVANT",
    h1[0]?.details?.champs?.motif?.avant === "Réapprovisionnement",
    JSON.stringify(h1[0]?.details?.champs?.motif));
  v("elle nomme l'auteur", Number(h1[0]?.acted_by) === 906);

  const rien = await appel("POST", "/stock-requests/1/modifier", {
    token: tZ, societe: 1,
    corps: { modifications: { supplier_name: "Fournisseur Keita" },
             motif: "Renvoi du même formulaire" } });
  v("renvoyer les mêmes valeurs ne crée pas de ligne vide",
    rien.status === 400 && rien.data?.code === "NOTHING_TO_CHANGE", `${rien.status}`);

  /* Les lignes : remplacées, pas fusionnées. */
  const modLignes = await appel("POST", "/stock-requests/1/modifier", {
    token: tZ, societe: 1,
    corps: { lignes: [{ product_id: 1, product_reference: "TRX600", product_name: "Tôle TRX600",
                        unit: "u", quantity_requested: 75, warehouse: "W-TRI" }],
             motif: "Une seule référence finalement, et en quantité revue" } });
  v("les lignes se remplacent", modLignes.status === 200, `${modLignes.status} ${JSON.stringify(modLignes.data)}`);
  const l1 = await lignes(1);
  v("il ne reste qu'une ligne", l1.length === 1, `${l1.length}`);
  v("à la bonne quantité", Number(l1[0]?.quantity_requested) === 75, `${l1[0]?.quantity_requested}`);
  v("l'historique garde l'avant et l'après des lignes",
    (await corrections(1)).some((c) => Array.isArray(c.details?.lignes?.avant)
      && c.details.lignes.avant.length === 2));

  const sansLigne = await appel("POST", "/stock-requests/1/modifier", {
    token: tZ, societe: 1, corps: { lignes: [], motif: "Tentative de demande vide" } });
  v("une demande sans ligne est refusée",
    sansLigne.status === 400 && sansLigne.data?.code === "NO_LINE", `${sansLigne.status}`);

  const quantiteNulle = await appel("POST", "/stock-requests/1/modifier", {
    token: tZ, societe: 1,
    corps: { lignes: [{ product_id: 1, quantity_requested: 0 }], motif: "Quantité nulle" } });
  v("une quantité nulle est refusée",
    quantiteNulle.status === 400 && quantiteNulle.data?.code === "INVALID_QUANTITY");

  /* ══════════════════════════════════════════════════════════════════════
     2. MODIFIER UNE DEMANDE VALIDÉE LA RENVOIE EN VALIDATION
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n2. DE-002, validée — le contenu change, l'accord ne suit pas");

  const avant2 = await demande(2);
  v("elle est validée au départ", avant2.status === "VALIDEE" && Number(avant2.validated_by) === 904);

  const mod2 = await appel("POST", "/stock-requests/2/modifier", {
    token: tZ, societe: 1,
    corps: { lignes: [{ product_id: 1, product_reference: "TRX600", product_name: "Tôle TRX600",
                        unit: "u", quantity_requested: 250, warehouse: "W-TRI" }],
             motif: "Quantité portée de 100 à 250 après recomptage du besoin" } });
  v("la modification passe", mod2.status === 200, `${mod2.status} ${JSON.stringify(mod2.data)}`);
  const d2 = await demande(2);
  /* Le point : on ne garde pas une validation qui portait sur autre chose. */
  v("la demande repasse EN_ATTENTE", d2.status === "EN_ATTENTE", d2.status);
  v("le validateur est effacé", d2.validated_by === null && d2.validated_at === null);
  v("la réponse le dit", mod2.data?.revalidation_requise === true
    && /EN ATTENTE/.test(String(mod2.data?.message)), String(mod2.data?.message));
  v("aucun stock n'a bougé", (await stock(1)) === 500, `${await stock(1)}`);

  /* ══════════════════════════════════════════════════════════════════════
     3. DÉVALIDER
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n3. Reprendre une validation qui n'a rien produit");

  await appel("POST", "/stock-requests/2/validate", { token: tD, societe: 1, corps: {} });
  v("la demande est revalidée", (await demande(2)).status === "VALIDEE");

  const devalCourt = await appel("POST", "/stock-requests/2/devalider", {
    token: tD, societe: 1, corps: { motif: "erreur" } });
  v("dévalider sans motif de 10 caractères est refusé",
    devalCourt.status === 400 && devalCourt.data?.code === "REASON_REQUIRED");

  const deval = await appel("POST", "/stock-requests/2/devalider", {
    token: tD, societe: 1,
    corps: { motif: "Validée par erreur : le budget n'est pas encore arbitré" } });
  v("la dévalidation passe", deval.status === 200, `${deval.status} ${JSON.stringify(deval.data)}`);
  const d2b = await demande(2);
  v("la demande repasse EN_ATTENTE", d2b.status === "EN_ATTENTE");
  v("le validateur est effacé", d2b.validated_by === null);
  v("la réponse annonce qu'aucun stock n'avait bougé", deval.data?.stock_impacte === false);
  v("l'historique garde qui avait validé",
    (await corrections(2)).some((c) => c.action === "DEVALIDATION"
      && Number(c.details?.validee_par) === 904));

  const devalDeux = await appel("POST", "/stock-requests/2/devalider", {
    token: tD, societe: 1, corps: { motif: "Seconde tentative de dévalidation" } });
  v("dévalider une demande déjà en attente est refusé",
    devalDeux.status === 409 && devalDeux.data?.code === "REQUEST_NOT_VALIDATED", `${devalDeux.status}`);

  const devalRecue = await appel("POST", "/stock-requests/3/devalider", {
    token: tD, societe: 1, corps: { motif: "Tentative de dévalidation d'une demande reçue" } });
  v("on ne dévalide pas une demande qui a déplacé du stock",
    devalRecue.status === 409 && devalRecue.data?.code === "REQUEST_ALREADY_RECEIVED",
    `${devalRecue.status} ${JSON.stringify(devalRecue.data)}`);
  v("le message oriente vers la contre-passation",
    /contre-passez/i.test(String(devalRecue.data?.error)), String(devalRecue.data?.error));

  /* ══════════════════════════════════════════════════════════════════════
     4. CONTRE-PASSER UNE RÉCEPTION
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n4. DE-003, reçue — 120 tôles et 80 sacs sont entrés");

  const stockTole0 = await stock(1), stockCiment0 = await stock(2);

  const parZerbo = await appel("POST", "/stock-requests/3/contrepasser", {
    token: tZ, societe: 1, corps: { motif: "Tentative de contre-passation par le magasinier" } });
  v("le magasinier ne peut PAS contre-passer",
    parZerbo.status === 403 || parZerbo.status === 404,
    `${parZerbo.status} ${JSON.stringify(parZerbo.data)}`);
  v("et rien n'a bougé", (await stock(1)) === stockTole0);

  const cp = await appel("POST", "/stock-requests/3/contrepasser", {
    token: tD, societe: 1,
    corps: { motif: "Conteneur livré au mauvais entrepôt, réception saisie à tort" } });
  v("la direction peut contre-passer", cp.status === 200, `${cp.status} ${JSON.stringify(cp.data)}`);

  v(`les tôles redescendent de 120 (${stockTole0} → ${await stock(1)})`,
    (await stock(1)) === stockTole0 - 120);
  v(`le ciment redescend de 80 (${stockCiment0} → ${await stock(2)})`,
    (await stock(2)) === stockCiment0 - 80);

  const d3 = await demande(3);
  v("la demande redevient VALIDEE", d3.status === "VALIDEE", d3.status);
  v("le réceptionnaire est effacé", d3.received_by === null && d3.received_at === null);

  const l3 = await lignes(3);
  v("les quantités reçues reviennent à zéro",
    l3.every((l) => Number(l.quantity_received) === 0), l3.map((l) => l.quantity_received).join(","));
  v("et le lien vers le mouvement est détaché", l3.every((l) => l.movement_id === null));

  /* Les mouvements d'origine : CONSERVÉS, marqués. */
  const origine1 = await mouvement(1);
  v("le mouvement d'origine existe toujours", !!origine1);
  v("il porte la marque de son annulation",
    !!origine1?.cancelled_at && /mauvais entrepôt/.test(origine1?.cancel_reason || ""),
    origine1?.cancel_reason);
  v("et son auteur", Number(origine1?.cancelled_by) === 904);

  const inverses = await q(
    `SELECT * FROM stock_movements WHERE reverses_movement_id IN (1,2) ORDER BY id`);
  v("deux mouvements inverses ont été écrits", inverses.length === 2, `${inverses.length}`);
  v("ils sont du sens opposé",
    inverses.every((m) => m.type === "Sortie"), inverses.map((m) => m.type).join(","));
  v("ils portent les bonnes quantités",
    inverses.map((m) => Number(m.quantity)).sort((a, b) => a - b).join(",") === "80,120",
    inverses.map((m) => m.quantity).join(","));
  v("ils citent la demande et le motif",
    inverses.every((m) => /DE-003/.test(m.reason) && /mauvais entrepôt/.test(m.reason)));

  const h3 = await corrections(3);
  v("la contre-passation est dans l'historique",
    h3.some((c) => c.action === "CONTREPASSATION"), h3.map((c) => c.action).join(","));
  const cpLigne = h3.find((c) => c.action === "CONTREPASSATION");
  v("avec le nombre de lignes et la quantité", Number(cpLigne?.lines_affected) === 2
    && Number(cpLigne?.quantity_reversed) === 200, `${cpLigne?.lines_affected}/${cpLigne?.quantity_reversed}`);
  v("et le détail mouvement par mouvement",
    Array.isArray(cpLigne?.details?.mouvements) && cpLigne.details.mouvements.length === 2);
  v("la réponse dit que rien n'a été effacé",
    /conservés et marqués annulés/.test(String(cp.data?.nature)), String(cp.data?.nature));

  const cpDeux = await appel("POST", "/stock-requests/3/contrepasser", {
    token: tD, societe: 1, corps: { motif: "Seconde tentative de contre-passation" } });
  v("contre-passer deux fois est refusé",
    cpDeux.status === 409 && cpDeux.data?.code === "NOTHING_TO_REVERSE", `${cpDeux.status}`);
  v("le stock n'a pas été repris deux fois", (await stock(1)) === stockTole0 - 120);

  /* ══════════════════════════════════════════════════════════════════════
     5. CONTRE-PASSER PUIS ANNULER, EN UN GESTE
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n5. Quand la demande était une erreur de bout en bout");

  await appel("POST", "/stock-requests/3/confirm", { token: tD, societe: 1, corps: {} });
  v("la demande est à nouveau reçue", ["RECUE", "PARTIELLEMENT_RECUE"].includes((await demande(3)).status),
    (await demande(3)).status);
  const stockAvantAnn = await stock(1);

  const cpAnn = await appel("POST", "/stock-requests/3/contrepasser", {
    token: tD, societe: 1,
    corps: { motif: "Demande créée en double : celle-ci n'aurait jamais dû exister",
             annuler: true } });
  v("la contre-passation avec annulation passe", cpAnn.status === 200, `${cpAnn.status}`);
  const d3b = await demande(3);
  v("la demande est ANNULEE", d3b.status === "ANNULEE", d3b.status);
  v("le motif d'annulation est conservé", /créée en double/.test(d3b.cancel_reason || ""));
  v("l'auteur de l'annulation est nommé", d3b.cancelled_by_name === "Direction Triangle",
    d3b.cancelled_by_name);
  v("le stock est revenu", (await stock(1)) === stockAvantAnn - 120);
  v("l'historique la marque ANNULATION",
    (await corrections(3)).some((c) => c.action === "ANNULATION"));

  /* ══════════════════════════════════════════════════════════════════════
     6. CE QUI NE SE CONTRE-PASSE PAS
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n6. L'inventaire");

  const stockCiment1 = await stock(2);
  const inv = await appel("POST", "/stock-requests/5/contrepasser", {
    token: tD, societe: 1, corps: { motif: "Tentative de contre-passation d'un inventaire" } });
  /* Un inventaire a FIXÉ le stock à une valeur comptée. L'inverser
     supposerait de connaître le stock d'avant, que rien ne garantit exact. */
  v("un inventaire ne se contre-passe pas",
    inv.status === 409 && inv.data?.code === "INVENTORY_NOT_REVERSIBLE",
    `${inv.status} ${JSON.stringify(inv.data)}`);
  v("le message explique pourquoi et dit quoi faire",
    /nouvel inventaire/i.test(String(inv.data?.error)), String(inv.data?.error));
  v("le stock n'a pas bougé", (await stock(2)) === stockCiment1);

  const enAttente = await appel("POST", "/stock-requests/1/contrepasser", {
    token: tD, societe: 1, corps: { motif: "Contre-passer une demande en attente" } });
  v("une demande qui n'a rien produit ne se contre-passe pas",
    enAttente.status === 409 && enAttente.data?.code === "NOTHING_TO_REVERSE", `${enAttente.status}`);

  const inconnue = await appel("POST", "/stock-requests/999999/contrepasser", {
    token: tD, societe: 1, corps: { motif: "Demande inexistante à contre-passer" } });
  v("une demande inexistante renvoie 404", inconnue.status === 404, `${inconnue.status}`);

  /* ══════════════════════════════════════════════════════════════════════
     7. LES DEMANDES DÉJÀ INCOHÉRENTES
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n7. DE-004 : annulée, mais son mouvement subsiste");

  const avant4 = await demande(4);
  const mvt3 = await mouvement(3);
  const inc = await appel("GET", "/demandes-stock/incoherentes", { token: tS, societe: 1 });
  v("la liste répond", inc.status === 200, `${inc.status}`);
  v("DE-004 y figure",
    (inc.data?.demandes || []).some((d) => d.reference === "DE-004"),
    JSON.stringify((inc.data?.demandes || []).map((d) => d.reference)));
  v("avec la quantité en jeu",
    Number((inc.data?.demandes || []).find((d) => d.reference === "DE-004")?.quantite_en_jeu) === 50);
  v("un avertissement dit qu'aucune n'a été corrigée",
    /Aucune n'a été corrigée/.test(String(inc.data?.avertissement)), String(inc.data?.avertissement));
  /* Le point : la migration n'a RIEN touché. */
  v("DE-004 est inchangée", (await demande(4)).status === avant4.status);
  v("son mouvement est toujours actif", (await mouvement(3)).cancelled_at === mvt3.cancelled_at);

  /* ══════════════════════════════════════════════════════════════════════
     8. DROITS ET ÉTANCHÉITÉ
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n8. Qui peut défaire, et sur quelle société");

  const croisee = await appel("POST", "/stock-requests/10/modifier", {
    token: tZ, societe: 1,
    corps: { modifications: { motif: "Tentative sur l'autre société" },
             motif: "Modification croisée" } });
  v("on ne modifie pas la demande d'une autre société",
    croisee.status === 404 && croisee.data?.code === "REQUEST_NOT_FOUND",
    `${croisee.status} ${JSON.stringify(croisee.data)}`);
  v("la demande de FAT & MAT est intacte", (await demande(10)).status === "VALIDEE");

  const histoCroisee = await appel("GET", "/stock-requests/1/corrections",
    { token: tF, societe: 2 });
  v("FAT & MAT ne lit pas l'historique d'une demande de Triangle",
    histoCroisee.status === 404, `${histoCroisee.status}`);

  const incF = await appel("GET", "/demandes-stock/incoherentes", { token: tF, societe: 2 });
  v("FAT & MAT ne voit pas les incohérences de Triangle",
    (incF.data?.demandes || []).length === 0, JSON.stringify(incF.data?.total));

  const histo = await appel("GET", "/stock-requests/3/corrections", { token: tS, societe: 1 });
  v("l'historique se lit depuis l'application", histo.status === 200);
  v("il est trié du plus récent au plus ancien",
    (histo.data?.corrections || [])[0]?.action === "ANNULATION",
    (histo.data?.corrections || []).map((c) => c.action).join(","));
  v("il nomme les auteurs",
    (histo.data?.corrections || []).every((c) => !!c.acted_by_name));

  /* ══════════════════════════════════════════════════════════════════════
     9. COHÉRENCE D'ENSEMBLE
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n9. Vérification d'ensemble");

  v("aucun stock négatif",
    Number((await un(`SELECT count(*) c FROM products WHERE stock < 0`)).c) === 0);
  v("aucune ligne reçue au-delà de ce qui était demandé",
    Number((await un(`SELECT count(*) c FROM stock_request_lines
                       WHERE quantity_received > quantity_requested + 0.001`)).c) === 0);
  v("chaque mouvement inverse désigne bien un mouvement existant",
    Number((await un(`SELECT count(*) c FROM stock_movements m
                       WHERE m.reverses_movement_id IS NOT NULL
                         AND NOT EXISTS (SELECT 1 FROM stock_movements o
                                          WHERE o.id = m.reverses_movement_id)`)).c) === 0);
  v("aucun mouvement annulé sans motif ni date",
    Number((await un(`SELECT count(*) c FROM stock_movements
                       WHERE cancelled_at IS NOT NULL
                         AND BTRIM(COALESCE(cancel_reason,'')) = ''`)).c) === 0);
  v("aucune correction sans motif",
    Number((await un(`SELECT count(*) c FROM stock_request_corrections
                       WHERE BTRIM(COALESCE(reason,'')) = ''`)).c) === 0);
  v("toute demande contre-passée a ses lignes remises à zéro",
    Number((await un(`SELECT count(*) c FROM stock_requests r
                        JOIN stock_request_lines l ON l.request_id = r.id
                       WHERE r.status IN ('VALIDEE','ANNULEE')
                         AND l.quantity_received > 0
                         AND r.corrections_count > 0`)).c) === 0);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${ok} réussis, ${ko} échoués`);
  console.log(ko === 0
    ? "  Une demande validée se corrige, et rien n'est effacé pour y parvenir."
    : "  Des points restent à corriger.");
  await pool.end();
  process.exit(ko === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });

"use strict";
/**
 * PARTIE F — LES EMPLACEMENTS QUE ZERBO NE VOYAIT PAS.
 *
 * Le symptôme : dans le rayon D, les niveaux D2 et D3 s'affichent, D1 non.
 * Pas « refusé » : ABSENT. Rien à l'écran ne disait qu'il existait, et les
 * 65 unités qui y dorment étaient introuvables.
 *
 * La cause : l'arbre des sélecteurs ne contient que les bacs exploitables, et
 * le rapport des exclusions ne décrivait QUE les rayons entièrement perdus.
 * Un rayon qui gardait un seul bac valable passait pour sain, et tout ce qu'il
 * contenait d'inexploitable s'évaporait.
 *
 * Ces tests éprouvent que plus rien ne disparaît en silence, que les niveaux
 * sortent dans leur ordre PHYSIQUE, qu'un emplacement ambigu reste refusé
 * comme destination, et que ni les droits ni l'entrepôt de Zerbo ne sont
 * contournés pour y arriver.
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

const SUPER   = { id: 900, fullname: "Super Triangle", role: "super_admin", company_id: 1, is_super_admin: true };
const SUPER_F = { id: 901, fullname: "Super Fatemat", role: "super_admin", company_id: 2, is_super_admin: true };
const ZERBO   = { id: 906, fullname: "Zerbo Magasinier", role: "magasinier", company_id: 1, is_super_admin: false };
const ZERBO_F = { id: 907, fullname: "Zerbo Fatemat", role: "magasinier", company_id: 2, is_super_admin: false };
const KEITA   = { id: 908, fullname: "Keita Consultation", role: "consultation", company_id: 1, is_super_admin: false };

const solde = async (locationId, productId = 1) => Number((await un(
  `SELECT quantity FROM stock_location_balances WHERE location_id=$1 AND product_id=$2`,
  [locationId, productId]))?.quantity || 0);

(async () => {
  const tS = jeton(SUPER), tF = jeton(SUPER_F), tZ = jeton(ZERBO),
        tZF = jeton(ZERBO_F), tK = jeton(KEITA);

  /* ══════════════════════════════════════════════════════════════════════
     1. LE CAS ZERBO : D1 N'EST PLUS INVISIBLE
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n1. Rayon D — D2 et D3 vont bien, D1 n'a que des FULLBIN");

  const a = await appel("GET", "/stock/locations/tree", { token: tZ, societe: 1 });
  v("l'arbre répond", a.status === 200, `${a.status} ${JSON.stringify(a.data).slice(0, 200)}`);
  const tri = a.data?.tree?.["W-TRI"] || {};
  const niveauxD = Object.keys(tri?.D?.["D-ET1"] || {});

  v("D2 et D3 sont proposés", niveauxD.includes("D2") && niveauxD.includes("D3"), niveauxD.join(", "));
  v("D1 n'est PAS proposé comme destination (ses bacs sont ambigus)",
    !niveauxD.includes("D1"), niveauxD.join(", "));

  const chD1 = a.data?.cheminsIndisponibles?.["W-TRI"]?.D?.["D-ET1"]?.D1;
  v("mais D1 est SIGNALÉ, avec son motif", !!chD1, JSON.stringify(a.data?.cheminsIndisponibles?.["W-TRI"]?.D));
  v("le motif est le bon", chD1?.motif === "FULLBIN", chD1?.motif);
  v("l'explication est lisible par un magasinier",
    /FULLBIN.*plein, pas lequel/.test(String(chD1?.explication)), String(chD1?.explication));
  v("les 65 unités bloquées sont annoncées", Number(chD1?.quantite) === 65, `${chD1?.quantite}`);
  v("et les deux bacs concernés", Number(chD1?.bacs) === 2, `${chD1?.bacs}`);
  v("D1 est présenté comme régularisable", chD1?.regularisable === true);

  /* ══════════════════════════════════════════════════════════════════════
     2. L'ORDRE PHYSIQUE DES NIVEAUX
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n2. TOP est en haut, pas entre 3 et 4");

  v("les niveaux sortent dans l'ordre D2, D3, TOP",
    JSON.stringify(niveauxD) === JSON.stringify(["D2", "D3", "TOP"]), niveauxD.join(", "));

  /* ══════════════════════════════════════════════════════════════════════
     3. CE QUI DISPARAISSAIT AILLEURS
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n3. Les autres chemins perdus");

  const ch = a.data?.cheminsIndisponibles?.["W-TRI"] || {};
  v("l'étagère E-ET1, entièrement en plages « BIN1-2 », est signalée",
    !!ch?.E?.["E-ET1"]?.E1 && !!ch?.E?.["E-ET1"]?.E2,
    JSON.stringify(Object.keys(ch?.E || {})));
  v("alors que E-ET2 reste proposée", !!tri?.E?.["E-ET2"], JSON.stringify(Object.keys(tri?.E || {})));
  v("le niveau F1 (bac non précisé) est signalé", ch?.F?.["F-ET1"]?.F1?.motif === "NON_PRECISE",
    JSON.stringify(ch?.F));
  v("alors que F2 reste proposé", !!tri?.F?.["F-ET1"]?.F2);
  v("WRITE OFF est signalé comme un état, pas un lieu",
    ch?.["WRITE OFF"]?.["WO-ET1"]?.W1?.motif === "REBUT",
    JSON.stringify(Object.keys(ch?.["WRITE OFF"] || {})));
  v("WRITE OFF n'est jamais une destination", !tri?.["WRITE OFF"]);
  v("NOUVEAU est signalé comme une valeur générée",
    ch?.NOUVEAU?.["N-ET1"]?.N1?.motif === "GENEREE", JSON.stringify(ch?.NOUVEAU));
  v("NOUVEAU n'est jamais une destination", !tri?.NOUVEAU);

  v("le résumé chiffre ce qui est bloqué",
    Number(a.data?.resume?.quantite_bloquee) === 140
    && Number(a.data?.resume?.bacs_ecartes) === 8,
    JSON.stringify(a.data?.resume));

  /* ══════════════════════════════════════════════════════════════════════
     4. LES ZONES RÉELLES DU TERRAIN
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n4. Les zones que Zerbo utilise vraiment");

  for (const zone of ["PICKING AREA", "RECEPTION AREA", "ALLE 3M", "R&I", "S", "T", "U", "V"]) {
    v(`la zone « ${zone} » est utilisable`, !!tri[zone], Object.keys(tri).join(", "));
  }
  /* « X » seul est un rayon du terrain. Le motif écartait « X+ » et le
     faisait passer pour une valeur générée. */
  v("la zone « X » est utilisable (et non prise pour un remplissage)", !!tri.X,
    Object.keys(tri).join(", "));
  v("le rayon G, dont aucun bac n'est nommé, reste entièrement indisponible",
    !tri.G && !!a.data?.rayonsIndisponibles?.["W-TRI"]?.G);

  /* ══════════════════════════════════════════════════════════════════════
     5. UN BAC ARCHIVÉ N'EST PLUS UNE DESTINATION
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n5. Le bac archivé");

  const bacsD2 = tri?.D?.["D-ET1"]?.D2 || [];
  v("D2 propose B01 et B02", bacsD2.map((b) => b.bin).sort().join(",") === "B01,B02",
    bacsD2.map((b) => b.bin).join(","));
  v("le bac archivé B99 n'est pas proposé",
    !bacsD2.some((b) => b.bin === "B99"), bacsD2.map((b) => b.bin).join(","));

  /* ══════════════════════════════════════════════════════════════════════
     6. LES MOUVEMENTS RÉELS
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n6. Entrée, sortie, transfert, inventaire");

  const D2_B01 = 103, D2_B02 = 104, D1_FULLBIN = 101, D3_B01 = 105;

  const avantEntree = await solde(D2_B01);
  const entree = await appel("POST", "/stock/locations/entry", {
    token: tZ, societe: 1,
    corps: { productId: 1, locationId: D2_B01, quantity: 25, reason: "Réception conteneur" } });
  v("une entrée en stock passe", entree.status === 201, `${entree.status} ${JSON.stringify(entree.data)}`);
  v("le solde augmente de 25", (await solde(D2_B01)) === avantEntree + 25, `${await solde(D2_B01)}`);

  const avantSortie = await solde(D2_B01);
  const sortie = await appel("POST", "/stock/locations/exit", {
    token: tZ, societe: 1,
    corps: { productId: 1, locationId: D2_B01, quantity: 10, reason: "Sortie atelier" } });
  v("une sortie passe", sortie.status === 201, `${sortie.status} ${JSON.stringify(sortie.data)}`);
  v("le solde baisse de 10", (await solde(D2_B01)) === avantSortie - 10);

  const tropGrande = await appel("POST", "/stock/locations/exit", {
    token: tZ, societe: 1,
    corps: { productId: 1, locationId: D2_B01, quantity: 999999, reason: "Sortie impossible" } });
  v("sortir plus que le disponible est refusé", tropGrande.status >= 400, `${tropGrande.status}`);

  const avantSrc = await solde(D2_B01), avantDst = await solde(D2_B02);
  const transfert = await appel("POST", "/stock/locations/transfer", {
    token: tZ, societe: 1,
    corps: { productId: 1, sourceLocationId: D2_B01, destinationLocationId: D2_B02,
             quantity: 20, reason: "Réorganisation" } });
  v("un transfert entre deux bacs précis passe",
    transfert.status === 201, `${transfert.status} ${JSON.stringify(transfert.data)}`);
  v("la source baisse de 20", (await solde(D2_B01)) === avantSrc - 20);
  v("la destination monte de 20", (await solde(D2_B02)) === avantDst + 20);
  v("le total du produit est conservé",
    (await solde(D2_B01)) + (await solde(D2_B02)) === avantSrc + avantDst);

  /* LE POINT DE PRINCIPE : on ne transfère pas VERS un emplacement dont
     personne ne peut dire de quel bac il s'agit. */
  const versAmbigu = await appel("POST", "/stock/locations/transfer", {
    token: tZ, societe: 1,
    corps: { productId: 1, sourceLocationId: D2_B01, destinationLocationId: D1_FULLBIN,
             quantity: 5, reason: "Vers un FULLBIN" } });
  v("transférer VERS un FULLBIN est refusé", versAmbigu.status >= 400,
    `${versAmbigu.status} ${JSON.stringify(versAmbigu.data)}`);
  v("et le FULLBIN n'a pas bougé", (await solde(D1_FULLBIN)) === 40);

  const versSoi = await appel("POST", "/stock/locations/transfer", {
    token: tZ, societe: 1,
    corps: { productId: 1, sourceLocationId: D2_B01, destinationLocationId: D2_B01,
             quantity: 5, reason: "Vers lui-même" } });
  v("transférer vers le même bac est refusé",
    versSoi.status >= 400 && versSoi.data?.code === "SAME_LOCATION", `${versSoi.status}`);

  const inventaire = await appel("GET", "/stock/locations/inventory", { token: tZ, societe: 1 });
  v("l'inventaire des emplacements répond", inventaire.status === 200, `${inventaire.status}`);

  /* Le témoin : voir n'est pas pouvoir. Sans ce contrôle, on ne saurait pas
     si les mouvements passent grâce au droit ou malgré son absence. */
  const lectureSeule = await appel("GET", "/stock/locations/tree", { token: tK, societe: 1 });
  v("un rôle de consultation voit bien les emplacements", lectureSeule.status === 200);
  const tentative = await appel("POST", "/stock/locations/entry", {
    token: tK, societe: 1,
    corps: { productId: 1, locationId: D2_B01, quantity: 5, reason: "Tentative en lecture seule" } });
  v("mais ne peut appliquer aucun mouvement",
    tentative.status === 403 && tentative.data?.code === "PERMISSION_DENIED",
    `${tentative.status} ${JSON.stringify(tentative.data)}`);
  v("et le stock n'a pas bougé", (await solde(D2_B01)) === avantSrc - 20);

  /* ══════════════════════════════════════════════════════════════════════
     7. L'ENTREPÔT DE ZERBO
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n7. Zerbo est rattaché à un entrepôt, et cela se tient");

  const W2 = 170;   // bac du second entrepôt de Triangle
  const horsEntrepot = await appel("POST", "/stock/locations/entry", {
    token: tZ, societe: 1,
    corps: { productId: 1, locationId: W2, quantity: 5, reason: "Hors de son entrepôt" } });
  v("Zerbo ne peut pas écrire dans un entrepôt qui n'est pas le sien",
    horsEntrepot.status >= 400, `${horsEntrepot.status} ${JSON.stringify(horsEntrepot.data)}`);
  v("le bac du second entrepôt n'a pas bougé", (await solde(W2)) === 90);

  const arbreZ = Object.keys(a.data?.tree || {});
  v("son arbre ne contient que son entrepôt",
    arbreZ.length === 1 && arbreZ[0] === "W-TRI", arbreZ.join(", "));

  const arbreSuper = await appel("GET", "/stock/locations/tree", { token: tS, societe: 1 });
  v("un super-administrateur voit les deux entrepôts de Triangle",
    Object.keys(arbreSuper.data?.tree || {}).sort().join(",") === "W-TRI,W-TRI-2",
    Object.keys(arbreSuper.data?.tree || {}).join(", "));

  /* ══════════════════════════════════════════════════════════════════════
     8. L'ÉTANCHÉITÉ ENTRE LES SOCIÉTÉS
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n8. Triangle et FAT & MAT");

  v("Triangle ne voit aucun emplacement de FAT & MAT",
    !Object.keys(arbreSuper.data?.tree || {}).includes("W-FAT"));

  const arbreF = await appel("GET", "/stock/locations/tree", { token: tF, societe: 2 });
  v("FAT & MAT ne voit que le sien",
    Object.keys(arbreF.data?.tree || {}).join(",") === "W-FAT",
    Object.keys(arbreF.data?.tree || {}).join(", "));

  const FAT_BAC = 190;
  const avantFat = await solde(FAT_BAC, 9);
  const croise = await appel("POST", "/stock/locations/entry", {
    token: tZ, societe: 1,
    corps: { productId: 9, locationId: FAT_BAC, quantity: 10, reason: "Vers l'autre société" } });
  v("on n'écrit pas dans l'emplacement d'une autre société",
    croise.status >= 400, `${croise.status} ${JSON.stringify(croise.data)}`);
  v("le stock de FAT & MAT est intact", (await solde(FAT_BAC, 9)) === avantFat);

  const croise2 = await appel("POST", "/stock/locations/transfer", {
    token: tS, societe: 1,
    corps: { productId: 1, sourceLocationId: D2_B01, destinationLocationId: FAT_BAC,
             quantity: 5, reason: "Transfert inter-sociétés déguisé" } });
  v("un transfert vers une autre société est refusé", croise2.status >= 400,
    `${croise2.status} ${JSON.stringify(croise2.data)}`);
  v("le stock de FAT & MAT n'a toujours pas bougé", (await solde(FAT_BAC, 9)) === avantFat);

  /* ══════════════════════════════════════════════════════════════════════
     9. LA RÉGULARISATION, PLUTÔT QUE LE BLOCAGE
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n9. Débloquer D1 sans inventer de bac");

  /* On ne « débloque » pas en inventant un bac : on déclare où la marchandise
     se trouve RÉELLEMENT, produit par produit, après être allé voir. */
  const sansMotif = await appel("POST", `/stock/locations/bins/${D1_FULLBIN}/regulariser`, {
    token: tS, societe: 1,
    corps: { repartitions: [{ product_id: 1, quantity: 40, bin: "B07" }] } });
  v("régulariser sans motif est refusé",
    sansMotif.status === 400 && sansMotif.data?.code === "REASON_REQUIRED", `${sansMotif.status}`);

  const sansRepartition = await appel("POST", `/stock/locations/bins/${D1_FULLBIN}/regulariser`, {
    token: tS, societe: 1, corps: { reason: "Inventaire physique du 20 octobre" } });
  v("régulariser sans dire où est la marchandise est refusé",
    sansRepartition.status === 400 && sansRepartition.data?.code === "NO_ALLOCATION",
    `${sansRepartition.status}`);

  const regul = await appel("POST", `/stock/locations/bins/${D1_FULLBIN}/regulariser`, {
    token: tS, societe: 1,
    corps: { reason: "Bac identifié sur le terrain lors de l'inventaire physique du 20 octobre",
             repartitions: [{ product_id: 1, quantity: 40, bin: "B07" }] } });
  v("avec le motif et la répartition réelle, la régularisation passe",
    regul.status === 200 || regul.status === 201, `${regul.status} ${JSON.stringify(regul.data)}`);

  const regul2 = await appel("POST", `/stock/locations/bins/102/regulariser`, {
    token: tS, societe: 1,
    corps: { reason: "Second bac identifié lors du même inventaire physique",
             repartitions: [{ product_id: 1, quantity: 25, bin: "B08" }] } });
  v("le second FULLBIN du niveau est régularisé aussi",
    regul2.status === 200 || regul2.status === 201, `${regul2.status} ${JSON.stringify(regul2.data)}`);

  const apres = await appel("GET", "/stock/locations/tree", { token: tZ, societe: 1 });
  const niveauxApres = Object.keys(apres.data?.tree?.["W-TRI"]?.D?.["D-ET1"] || {});
  v("D1 devient alors une destination", niveauxApres.includes("D1"), niveauxApres.join(", "));
  /* Les 65 unités ne se sont pas volatilisées : elles sont simplement dans
     des bacs désormais nommés, sous le même niveau D1. */
  const totalD1 = Number((await un(
    `SELECT COALESCE(SUM(b.quantity),0) t FROM stock_location_balances b
       JOIN locations l ON l.id = b.location_id
      WHERE l.company_id = 1 AND COALESCE(NULLIF(l.level_code,''), l.etagere) = 'D1'`)).t);
  v("les 65 unités sont toujours là, au même niveau", totalD1 === 65, `${totalD1}`);
  v("et D1 n'est plus signalé comme perdu",
    !apres.data?.cheminsIndisponibles?.["W-TRI"]?.D?.["D-ET1"]?.D1,
    JSON.stringify(apres.data?.cheminsIndisponibles?.["W-TRI"]?.D));
  v("le résumé a diminué d'autant",
    Number(apres.data?.resume?.quantite_bloquee) === 75,
    `${apres.data?.resume?.quantite_bloquee}`);

  /* ══════════════════════════════════════════════════════════════════════
     10. COHÉRENCE
     ══════════════════════════════════════════════════════════════════════ */
  console.log("\n10. Vérification d'ensemble");

  v("aucun solde négatif",
    Number((await un(`SELECT count(*) c FROM stock_location_balances WHERE quantity < 0`)).c) === 0);
  v("aucun solde sur un emplacement d'une autre société",
    Number((await un(`SELECT count(*) c FROM stock_location_balances b
                        JOIN locations l ON l.id=b.location_id
                       WHERE l.company_id <> b.company_id`)).c) === 0);
  v("aucun mouvement sans emplacement sur un produit localisé",
    Number((await un(`SELECT count(*) c FROM stock_location_balances
                       WHERE location_id IS NULL`)).c) === 0);
  v("chaque bac proposé porte un code de bac non vide",
    Object.values(tri).flatMap((r) => Object.values(r))
      .flatMap((e) => Object.values(e)).flat()
      .every((b) => String(b.bin || "").trim() !== ""));

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${ok} réussis, ${ko} échoués`);
  console.log(ko === 0
    ? "  Plus rien ne disparaît en silence, et rien d'ambigu n'est devenu une destination."
    : "  Des points restent à corriger.");
  await pool.end();
  process.exit(ko === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await pool.end(); process.exit(1); });

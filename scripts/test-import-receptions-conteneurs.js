"use strict";
/**
 * IMPORT DES RÉCEPTIONS DE CONTENEURS — ce qui ne doit jamais arriver.
 *
 * Le test central est le septième : importer DEUX FOIS le même fichier ne doit
 * rien doubler. Tout le reste protège un stock réel.
 *
 * Aucune donnée de production : la base de test est reconstruite à chaque
 * exécution par le script `.sh` qui lance celui-ci.
 */
const fs = require("fs");
const { Pool } = require("pg");
const IMP = require("../services/import-receptions-conteneurs");
const P = require("../services/import-em2s");
const R = require("../services/receptions");
const LS = require("../services/lecture-seule");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const FICHIER = process.env.CLASSEUR;
let ok = 0, ko = 0;
const v = (n, c, d = "") => { if (c) { ok++; console.log(`  ✔ ${n}`); } else { ko++; console.log(`  ✘ ${n}${d ? `\n      → ${d}` : ""}`); } };
const q = async (s, p = []) => (await pool.query(s, p)).rows;
const PLAN = { "WAREHOUSE-E": "W-EM2S-E", "WAREHOUSE-C": "W-EM2S-C" };
const UTIL = { id: 900, fullname: "Testeur" };

const planifier = async (societe = 1, plan = PLAN) => {
  const client = await pool.connect();
  try {
    return await IMP.planifier(client, {
      companyId: societe, buffer: fs.readFileSync(FICHIER),
      nomFichier: "CONTENEUR RECEPTIONNER.xlsx", plan,
    });
  } finally { client.release(); }
};
/* L'état du stock, en un chiffre : s'il bouge, l'import a fait ce qu'il ne doit
   jamais faire. */
const empreinteStock = async () => (await q(
  `SELECT (SELECT COALESCE(sum(stock),0) FROM products WHERE company_id=1) AS stock,
          (SELECT count(*)::int FROM stock_movements WHERE company_id=1) AS mouvements,
          (SELECT count(*)::int FROM stock_putaways WHERE company_id=1) AS putaways,
          (SELECT count(*)::int FROM products WHERE company_id=1) AS produits`))[0];
const compte = async () => (await q(
  `SELECT (SELECT count(*)::int FROM stock_receptions WHERE company_id=1) AS receptions,
          (SELECT count(*)::int FROM stock_reception_lines WHERE company_id=1) AS lignes,
          (SELECT COALESCE(sum(quantity_received),0) FROM stock_reception_lines WHERE company_id=1) AS recu,
          (SELECT count(*)::int FROM stock_import_operations WHERE company_id=1) AS operations,
          (SELECT count(*)::int FROM warehouses WHERE company_id=1) AS entrepots`))[0];

(async () => {
  if (!FICHIER || !fs.existsSync(FICHIER)) {
    console.error("CLASSEUR=<chemin du .xlsx> est requis."); process.exit(1);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n① LE CLASSEUR EST LU TEL QU'IL EST");
  const lecture = P.lireClasseur(fs.readFileSync(FICHIER),
    { nomFichier: "CONTENEUR RECEPTIONNER.xlsx", plan: PLAN });
  v("les deux feuilles sont reconnues comme datées",
    lecture.dispositions["WAREHOUSE-E"] === "DATEE" && lecture.dispositions["WAREHOUSE-C"] === "DATEE",
    JSON.stringify(lecture.dispositions));
  v("27 réceptions", lecture.receptions.physiques === 27, String(lecture.receptions.physiques));
  const lignes = lecture.receptions.liste.reduce((s, r) => s + r.totalLignes, 0);
  v("71 lignes d'articles", lignes === 71, String(lignes));
  const qte = lecture.receptions.liste.reduce((s, r) => s + r.totalQuantite, 0);
  v("64 820 unités", qte === 64820, String(qte));
  v("une seule ligne sans quantité",
    lecture.receptions.liste.reduce((s, r) => s + r.lignesSansQuantite, 0) === 1);
  v("22 plaques de véhicule lues",
    lecture.receptions.liste.filter((r) => r.vehicule).length === 22,
    String(lecture.receptions.liste.filter((r) => r.vehicule).length));
  const trx = lecture.receptions.liste.flatMap((r) => r.lignes).find((l) => /TRX/.test(l.libelle));
  v("« TRX600 » reste intact dans la désignation d'origine",
    trx.libelle === "TRX600 SCREW JACK WITH BASE PLATE", trx.libelle);
  v("et la forme normalisée ne l'abîme pas non plus",
    trx.libelleNorm === "TRX600 SCREW JACK WITH BASE PLATE", trx.libelleNorm);
  const steel = lecture.receptions.liste.flatMap((r) => r.lignes)
    .filter((l) => /STEEL PROP/.test(l.libelle));
  v("les écritures d'origine de STEEL PROP sont toutes conservées",
    new Set(steel.map((l) => l.libelle)).size === 4,
    [...new Set(steel.map((l) => l.libelle))].join(" | "));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n② UN ENTREPÔT N'EST JAMAIS CRÉÉ");
  const avantEntrepots = (await compte()).entrepots;
  const client = await pool.connect();
  let erreur = null;
  try {
    await R.ensureWarehouse(client, 1, "WAREHOUSE-E");
  } catch (e) { erreur = e; } finally { client.release(); }
  v("ensureWarehouse refuse un code inconnu", erreur?.code === "WAREHOUSE_NOT_FOUND", String(erreur?.code));
  v("et il NOMME les entrepôts proches", /W-EM2S-E/.test(erreur?.message || ""), erreur?.message);
  v("aucun entrepôt n'a été créé", (await compte()).entrepots === avantEntrepots);

  const planFaux = await planifier(1, { "WAREHOUSE-E": "ENTREPOT-INEXISTANT" });
  v("un plan vers un entrepôt inexistant bloque la feuille entière",
    planFaux.receptions.every((r) => r.etat === IMP.ETAT.BLOQUEE || r.feuille !== "WAREHOUSE-E"));
  v("et ouvre une anomalie ENTREPOT_INCONNU",
    planFaux.anomalies.some((a) => a.type === "ENTREPOT_INCONNU"));
  v("toujours aucun entrepôt créé", (await compte()).entrepots === avantEntrepots);

  const clientA = await pool.connect();
  try {
    /* Un alias confirmé par une personne, lui, résout — c'est tout son objet. */
    await clientA.query(
      `INSERT INTO warehouse_import_aliases (company_id, alias, alias_norm, warehouse_id,
                                             confirmed_by_name, reason)
       SELECT 1, 'WAREHOUSE-E', 'WAREHOUSEE', id, 'Testeur', 'Correspondance confirmée par le test'
         FROM warehouses WHERE company_id=1 AND code='W-EM2S-E'
       ON CONFLICT (company_id, alias_norm) DO NOTHING`);
    const r = await R.ensureWarehouse(clientA, 1, "WAREHOUSE-E");
    v("avec un alias, le même code résout vers le vrai entrepôt",
      r.warehouse.code === "W-EM2S-E" && r.source === "alias" && r.created === false,
      JSON.stringify({ code: r.warehouse.code, source: r.source, created: r.created }));
    await clientA.query(`DELETE FROM warehouse_import_aliases WHERE company_id=1`);
  } finally { clientA.release(); }

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n③ LE CAS DÉJÀ IDENTIQUE — NE RIEN FAIRE");
  let plan = await planifier();
  const beau = plan.receptions.find((r) => r.conteneur === "BEAU 466863/3");
  v("BEAU 466863/3 est reconnu IDENTIQUE", beau?.etat === IMP.ETAT.IDENTIQUE, beau?.etat);
  v("aucune ligne à créer pour lui", beau.lignes.every((l) => l.action === "DEJA_PRESENTE"));
  v("son état en base est bien « non rangé »", beau.existante.range === 0 && beau.existante.recu === 1016,
    JSON.stringify(beau.existante));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n④ UNE RÉCEPTION INCOMPLÈTE SE COMPLÈTE, ELLE NE SE REFAIT PAS");
  const dryu = plan.receptions.find((r) => r.conteneur === "DRYU 923752/6");
  v("DRYU 923752/6 est INCOMPLETE", dryu?.etat === IMP.ETAT.INCOMPLETE, dryu?.etat);
  v("ses 2 lignes déjà là sont reconnues",
    dryu.lignes.filter((l) => l.action === "DEJA_PRESENTE").length === 2);
  v("et seules les 2 manquantes sont à créer",
    dryu.lignes.filter((l) => l.action === "A_CREER").length === 2);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑤ UNE RÉCEPTION DÉJÀ RANGÉE QUI DIVERGE N'EST JAMAIS ÉCRITE");
  const tghu = plan.receptions.find((r) => r.conteneur === "TGHU 632434/4");
  v("TGHU 632434/4 est DIVERGENTE", tghu?.etat === IMP.ETAT.DIVERGENTE, tghu?.etat);
  v("la divergence est nommée", /FAUX PLAFOND/.test(tghu.motifs.join(" ")), tghu.motifs.join(" "));
  v("son stock est déjà impacté, et le plan le dit", tghu.existante.range === 900,
    JSON.stringify(tghu.existante));
  const simDiv = await IMP.appliquer(pool, { companyId: 1, plan, dryRun: true });
  v("l'application la saute",
    simDiv.sautees.some((s) => s.conteneur === "TGHU 632434/4" && s.etat === IMP.ETAT.DIVERGENTE));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑥ LE DRY-RUN N'ÉCRIT RIEN");
  const avantDry = await compte(); const stockAvantDry = await empreinteStock();
  await IMP.appliquer(pool, { companyId: 1, plan, dryRun: true, utilisateur: UTIL });
  v("aucune réception créée", (await compte()).receptions === avantDry.receptions);
  v("aucune ligne créée", (await compte()).lignes === avantDry.lignes);
  v("aucune opération tracée", (await compte()).operations === avantDry.operations);
  v("stock inchangé", JSON.stringify(await empreinteStock()) === JSON.stringify(stockAvantDry));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑥bis UN ÉTAT QUI CHANGE ENTRE L'ANALYSE ET L'ÉCRITURE ARRÊTE TOUT");
  /* Le plan dit que DRYU 923752/6 est incomplète. Quelqu'un range une de ses
     lignes avant l'écriture : compléter à l'aveugle pourrait ajouter une ligne
     qu'on vient de ranger. */
  const ligneDryu = (await q(
    `SELECT l.id FROM stock_reception_lines l JOIN stock_receptions r ON r.id=l.reception_id
      WHERE r.company_id=1 AND r.container_number='DRYU 923752/6' ORDER BY l.line_no LIMIT 1`))[0];
  await q(`UPDATE stock_reception_lines SET quantity_putaway = quantity_received WHERE id=$1`,
    [ligneDryu.id]);
  /* Le plan réduit à CETTE réception : appliquer le plan entier écrirait les
     dix-neuf autres et le test suivant n'aurait plus rien à prouver. */
  const planDryu = { ...plan, receptions: plan.receptions.filter((r) => r.conteneur === "DRYU 923752/6") };
  const sortieChangee = await IMP.appliquer(pool, { companyId: 1, plan: planDryu, dryRun: false, utilisateur: UTIL });
  v("l'écriture de DRYU est refusée avec ETAT_CHANGE",
    sortieChangee.sautees.some((x) => x.conteneur === "DRYU 923752/6" && x.etat === "ETAT_CHANGE"),
    JSON.stringify(sortieChangee.sautees.filter((x) => x.conteneur === "DRYU 923752/6")));
  v("DRYU n'a pas été complétée à l'aveugle",
    (await q(`SELECT count(*)::int AS n FROM stock_reception_lines l
                JOIN stock_receptions r ON r.id=l.reception_id
               WHERE r.company_id=1 AND r.container_number='DRYU 923752/6'`))[0].n === 2);
  /* On remet l'état d'avant pour que la suite éprouve le cas normal. */
  await q(`UPDATE stock_reception_lines SET quantity_putaway = 0 WHERE id=$1`, [ligneDryu.id]);
  /* Les clés consommées par cette tentative sont libérées par l'applicateur
     seulement en cas d'erreur ; ici rien n'a été réservé puisqu'on a sauté
     avant la réservation. On le vérifie. */
  v("aucune clé n'a été consommée par la tentative refusée",
    (await q(`SELECT count(*)::int AS n FROM stock_import_operations WHERE company_id=1`))[0].n === 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑦ IMPORTER DEUX FOIS NE DOUBLE RIEN — le test qui compte");
  const stockAvant = await empreinteStock();
  const premier = await IMP.appliquer(pool, { companyId: 1, plan, dryRun: false, utilisateur: UTIL });
  const apres1 = await compte();
  v("le premier import crée des réceptions", premier.creees.length > 0, String(premier.creees.length));
  v("et complète les incomplètes", premier.completees.length > 0, String(premier.completees.length));
  v("il saute l'identique et la divergente",
    premier.sautees.some((s) => s.conteneur === "BEAU 466863/3")
    && premier.sautees.some((s) => s.conteneur === "TGHU 632434/4"));

  /* Rejouer EXACTEMENT le même fichier : on replanifie, comme le ferait une
     seconde exécution du script. */
  const plan2 = await planifier();
  const second = await IMP.appliquer(pool, { companyId: 1, plan: plan2, dryRun: false, utilisateur: UTIL });
  const apres2 = await compte();
  v("le second import ne crée AUCUNE réception", second.creees.length === 0,
    JSON.stringify(second.creees));
  v("le second import ne complète AUCUNE ligne", second.completees.length === 0,
    JSON.stringify(second.completees));
  v("le nombre de réceptions est identique", apres2.receptions === apres1.receptions,
    `${apres1.receptions} → ${apres2.receptions}`);
  v("le nombre de lignes est identique", apres2.lignes === apres1.lignes,
    `${apres1.lignes} → ${apres2.lignes}`);
  v("la quantité reçue totale est identique", String(apres2.recu) === String(apres1.recu),
    `${apres1.recu} → ${apres2.recu}`);
  v("aucune clé d'idempotence en double",
    (await q(`SELECT count(*)::int AS n FROM (
                SELECT idempotency_key FROM stock_import_operations WHERE company_id=1
                 GROUP BY idempotency_key HAVING count(*) > 1) d`))[0].n === 0);
  v("toutes les réceptions du document sont désormais présentes une seule fois",
    (await q(`SELECT count(*)::int AS n FROM (
                SELECT container_number, reception_date FROM stock_receptions
                 WHERE company_id=1 GROUP BY container_number, reception_date
                 HAVING count(*) > 1) d`))[0].n === 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑧ IMPORTER N'EST PAS METTRE EN STOCK");
  const stockApres = await empreinteStock();
  v("aucun stock produit n'a bougé", String(stockApres.stock) === String(stockAvant.stock),
    `${stockAvant.stock} → ${stockApres.stock}`);
  v("aucun mouvement de stock créé", stockApres.mouvements === stockAvant.mouvements,
    `${stockAvant.mouvements} → ${stockApres.mouvements}`);
  v("aucune mise en stock créée", stockApres.putaways === stockAvant.putaways,
    `${stockAvant.putaways} → ${stockApres.putaways}`);
  v("AUCUN produit créé automatiquement", stockApres.produits === stockAvant.produits,
    `${stockAvant.produits} → ${stockApres.produits}`);
  v("les lignes sans produit certain attendent une confirmation",
    (await q(`SELECT count(*)::int AS n FROM stock_reception_lines
               WHERE company_id=1 AND match_status='TO_REVIEW'`))[0].n > 0);
  v("aucune ligne n'est rangée par l'import",
    (await q(`SELECT COALESCE(sum(quantity_putaway),0) AS s FROM stock_reception_lines
               WHERE company_id=1 AND reception_id IN (
                 SELECT id FROM stock_receptions WHERE source='EXCEL_IMPORT'
                   AND source_file='CONTENEUR RECEPTIONNER.xlsx')`))[0].s === "0");

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑨ LA PLAQUE EST ENREGISTRÉE, JAMAIS DEVINÉE");
  const avecPlaque = await q(
    `SELECT container_number, vehicle_plate FROM stock_receptions
      WHERE company_id=1 AND vehicle_plate IS NOT NULL ORDER BY container_number`);
  v("les plaques du document sont enregistrées", avecPlaque.length > 0, String(avecPlaque.length));
  v("AA 330 GQ est sur DRYU 923752/6",
    avecPlaque.some((r) => r.container_number === "DRYU 923752/6" && r.vehicle_plate === "AA 330 GQ"),
    JSON.stringify(avecPlaque.slice(0, 3)));
  v("les réceptions sans plaque au document n'en ont pas inventé",
    (await q(`SELECT count(*)::int AS n FROM stock_receptions
               WHERE company_id=1 AND container_number IN
                 ('DFSU 762250/3','FSCU 719532/5','MSDU 500987/0','MSBU 753187/1','CAIU 882284/4')
                 AND vehicle_plate IS NOT NULL`))[0].n === 0);
  v("et une anomalie VEHICULE_ABSENT a été levée pour chacune",
    plan.anomalies.filter((a) => a.type === "VEHICULE_ABSENT").length === 5,
    String(plan.anomalies.filter((a) => a.type === "VEHICULE_ABSENT").length));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑩ LA QUANTITÉ ABSENTE N'EST PAS INVENTÉE");
  const tgbu = plan.receptions.find((r) => r.conteneur === "TGBU 686373/0");
  v("sa ligne est BLOQUÉE", tgbu.lignes.every((l) => l.action === "BLOQUEE"),
    JSON.stringify(tgbu.lignes.map((l) => l.action)));
  v("une anomalie QUANTITE_ABSENTE la décrit",
    plan.anomalies.some((a) => a.type === "QUANTITE_ABSENTE" && /ÉTÉS DE FER/.test(a.message)),
    JSON.stringify(plan.anomalies.filter((a) => a.type === "QUANTITE_ABSENTE").map((a) => a.message)));
  v("aucune ligne « ÉTÉS DE FER » n'a été écrite",
    (await q(`SELECT count(*)::int AS n FROM stock_reception_lines
               WHERE company_id=1 AND received_label ILIKE '%DE FER%'`))[0].n === 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑫ ISOLEMENT DES SOCIÉTÉS");
  v("aucune réception créée chez FAT & MAT",
    (await q(`SELECT count(*)::int AS n FROM stock_receptions WHERE company_id=2`))[0].n === 0);
  v("aucune ligne chez FAT & MAT",
    (await q(`SELECT count(*)::int AS n FROM stock_reception_lines WHERE company_id=2`))[0].n === 0);
  const planFat = await planifier(2);
  v("le même plan sur FAT & MAT ne résout aucun entrepôt Triangle",
    Object.values(planFat.entrepots).every((e) => !e.ok),
    JSON.stringify(planFat.entrepots));
  v("et tout y est bloqué", planFat.receptions.every((r) => r.etat === IMP.ETAT.BLOQUEE));
  v("toujours aucune réception chez FAT & MAT",
    (await q(`SELECT count(*)::int AS n FROM stock_receptions WHERE company_id=2`))[0].n === 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑬ LES DÉCISIONS SUR LES ARTICLES NE SE PRENNENT PAS SEULES");
  const d = (dec) => plan.produits.filter((p) => p.decision === dec);
  /* TROIS COMPTES, et ils ne disent pas la même chose :
       39  écritures distinctes DANS LE DOCUMENT, telles quelles ;
       37  clés après normalisation — c'est le nombre de DÉCISIONS à prendre ;
       38  était le compte d'un audit antérieur, dont la normalisation gardait
           le séparateur de dimensions. Aucun des trois n'est faux : ils
           mesurent trois choses. On vérifie les deux que ce module produit. */
  v("39 écritures distinctes dans le document",
    plan.totaux.libellesEcrits === 39, String(plan.totaux.libellesEcrits));
  v("37 clés normalisées — donc 37 décisions à prendre",
    plan.produits.length === 37, String(plan.produits.length));
  const fusionnees = plan.produits.filter((p) => p.ecritures.length > 1);
  v("les clés qui regroupent plusieurs écritures les montrent TOUTES",
    fusionnees.length > 0 && fusionnees.every((p) => p.ecritures.length >= 2),
    fusionnees.map((p) => p.ecritures.join(" | ")).join(" ;; "));
  v("le compte annoncé des regroupements correspond",
    plan.totaux.libellesPlusieursEcritures === fusionnees.length,
    `${plan.totaux.libellesPlusieursEcritures} vs ${fusionnees.length}`);
  v("ce regroupement ne concerne que des dimensions identiques",
    fusionnees.every((p) => new Set(p.ecritures.map((e) =>
      (e.match(/\d+/g) || []).sort().join(","))).size === 1),
    fusionnees.map((p) => p.ecritures.join(" | ")).join(" ;; "));
  const standard = plan.produits.find((p) => /^3000 STANDARD POST$/.test(p.libelle));
  v("« 3000 STANDARD POST » n'est pas tranché sur l'orthographe",
    standard && standard.decision !== IMP.DECISION.EXACT, JSON.stringify(standard?.decision));
  v("et la preuve dit pourquoi",
    standard?.preuves?.some((x) => /orthographe/.test(x)), JSON.stringify(standard?.preuves));
  const ledge = plan.produits.find((p) => /^1200 LEDGE$/.test(p.libelle));
  v("« 1200 LEDGE » n'est pas assimilé à « 1200 LEDGER » tout seul",
    ledge && ledge.decision !== IMP.DECISION.EXACT, JSON.stringify(ledge?.decision));
  v("aucun libellé n'est EXACT sans preuve nommée",
    d(IMP.DECISION.EXACT).every((p) => (p.preuves || []).length > 0));
  const fauxPlafond = plan.produits.filter((p) => /FAUX PLAFOND/.test(p.libelle));
  v("les trois FAUX PLAFOND restent trois libellés distincts", fauxPlafond.length === 3,
    fauxPlafond.map((p) => p.libelle).join(" | "));
  v("aucun d'eux n'est fusionné d'office avec un autre",
    new Set(fauxPlafond.map((p) => (p.produit || p.propose)?.id).filter(Boolean)).size
      <= fauxPlafond.filter((p) => p.decision === IMP.DECISION.EXACT).length,
    fauxPlafond.map((p) => `${p.libelle}→${p.decision}`).join(" | "));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑭ LA LECTURE SEULE EST IMPOSÉE PAR POSTGRESQL, PAS PROMISE");
  const preuve = await LS.prouverLeVerrou(pool);
  v("PostgreSQL refuse une écriture dans la transaction (code 25006)",
    preuve.refuseParPostgres === true, JSON.stringify(preuve));
  v("le garde refuse même de l'envoyer", preuve.refuseParLeGarde === true);
  v("les deux barrières tiennent", preuve.solide === true);
  for (const [sql, attendu] of [
    ["SELECT 1", true],
    ["WITH a AS (SELECT 1) SELECT * FROM a", true],
    ["INSERT INTO products(name) VALUES ('x')", false],
    ["WITH a AS (INSERT INTO products(name) VALUES ('x') RETURNING *) SELECT * FROM a", false],
    ["UPDATE products SET stock = 0", false],
    ["DELETE FROM stock_receptions", false],
    ["TRUNCATE products", false],
    ["DROP TABLE products", false],
    ["ALTER TABLE products ADD COLUMN z int", false],
    ["CREATE TABLE z (x int)", false],
    ["SET default_transaction_read_only = off", false],
    ["SELECT 1; DROP TABLE products", false],
  ]) {
    let passe = true;
    try { LS.examiner(sql); } catch { passe = false; }
    v(`${attendu ? "accepté" : "refusé"} : ${sql.slice(0, 54)}`, passe === attendu);
  }
  /* Le plan complet, établi DANS la transaction en lecture seule. */
  const avantLS = await compte();
  const sortieLS = await LS.dansUneTransactionLectureSeule(pool, (clientRO) =>
    IMP.planifier(clientRO, {
      companyId: 1, buffer: fs.readFileSync(FICHIER),
      nomFichier: "CONTENEUR RECEPTIONNER.xlsx", plan: PLAN,
    }));
  v("le diagnostic complet s'exécute en lecture seule",
    sortieLS.resultat.receptions.length === 27, String(sortieLS.resultat.receptions.length));
  v("et n'a envoyé que des lectures",
    sortieLS.journal.every((r) => /^\s*(SELECT|WITH)\b/i.test(r)),
    sortieLS.journal.filter((r) => !/^\s*(SELECT|WITH)\b/i.test(r)).join(" | "));
  v("rien n'a été écrit", JSON.stringify(await compte()) === JSON.stringify(avantLS));

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑮ LE DIAGNOSTIC N'EXIGE PAS LA MIGRATION 102");
  const clientS = await pool.connect();
  let schema;
  try { schema = await IMP.colonnesDisponibles(clientS); } finally { clientS.release(); }
  v("le schéma de test porte bien la 102", schema.migration102 === true, JSON.stringify(schema));
  v("le plan annonce l'état du schéma", plan.schema && plan.schema.migration102 === true);
  /* On simule un schéma d'avant la 102 : l'écriture doit être refusée d'un bloc,
     et non échouer au milieu en laissant un import partiel. */
  const planVieux = { ...plan, schema: { ...plan.schema, migration102: false } };
  let refus = null;
  try {
    await IMP.appliquer(pool, { companyId: 1, plan: planVieux, dryRun: false, utilisateur: UTIL });
  } catch (e) { refus = e; }
  v("sans la 102, l'écriture est refusée AVANT de commencer",
    refus?.code === "MIGRATION_102_REQUISE", String(refus?.code));
  v("et l'analyse, elle, reste possible",
    (await IMP.simuler(planVieux)).impactStock === 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑯ UNE RÉCEPTION SANS AUCUNE LIGNE ÉCRIVABLE EST BLOQUÉE");
  const tgbu2 = plan.receptions.find((r) => /TGBU\s*686373/.test(r.conteneur || ""));
  v("TGBU 686373/0 est BLOQUEE, pas « à créer »", tgbu2?.etat === IMP.ETAT.BLOQUEE, tgbu2?.etat);
  v("son action est BLOCKED", tgbu2?.action === IMP.ACTION.BLOCKED, tgbu2?.action);
  v("le motif nomme la quantité absente",
    /quantité absente/.test(tgbu2.motifs.join(" ")), tgbu2.motifs.join(" "));
  /* Deux conteneurs commencent par TGBU : 686373/0 est bloqué, 786252/7 est à
     créer. On vise donc le numéro complet, pas le préfixe. */
  v("la simulation ne créerait pas TGBU 686373/0",
    !IMP.simuler(plan).creerait.some((c) => c.conteneur === tgbu2.conteneur),
    IMP.simuler(plan).creerait.filter((c) => /TGBU/.test(c.conteneur))
      .map((c) => c.conteneur).join(", "));
  v("mais elle créerait bien TGBU 786252/7, qui n'a rien de bloquant",
    IMP.simuler(plan).creerait.some((c) => /TGBU\s*786252/.test(c.conteneur)));
  v("aucune réception vide n'a été créée en base",
    (await q(`SELECT count(*)::int AS n FROM stock_receptions r
               WHERE r.company_id=1 AND r.container_number LIKE 'TGBU 686373%'`))[0].n === 0);

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n⑰ LES ACTIONS PORTENT LES CODES ATTENDUS");
  const codes = new Set(plan.receptions.map((r) => r.action));
  v("aucun code d'action inattendu",
    [...codes].every((c) => Object.values(IMP.ACTION).includes(c)), [...codes].join(", "));
  const decisions = new Set(plan.produits.map((p) => p.decision));
  v("aucun code de décision inattendu",
    [...decisions].every((d) => Object.values(IMP.DECISION).includes(d)), [...decisions].join(", "));
  v("les codes de décision sont ceux du cahier des charges",
    IMP.DECISION.PROBABLE === "PROBABLE_A_CONFIRMER" && IMP.DECISION.A_CREER === "A_CREER"
    && IMP.DECISION.BLOQUE === "BLOQUE");

  console.log(`\n${ko === 0 ? "✅" : "❌"} ${ok} réussis, ${ko} échoués\n`);
  await pool.end();
  process.exit(ko === 0 ? 0 : 1);
})().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1); });

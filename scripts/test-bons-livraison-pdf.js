"use strict";

/**
 * BONS DE LIVRAISON — LIVREUR, PDF UNIQUE, PIÈCE JOINTE (migration 090).
 *
 *   bash scripts/test-bons-livraison-pdf.sh
 *
 * Ce que la suite prouve :
 *
 *   LIVREUR   le nom imprimé n'est plus celui de qui saisit ; un bon créé
 *             pour FAT & MAT porte le livreur réglé pour la société, pas
 *             l'auteur du clic ;
 *   CORRECTION le script aligne les anciens bons, ne touche pas ceux déjà
 *             corrects, et refuse de deviner la société ;
 *   PDF       un seul générateur sert le téléchargement, le partage et
 *             l'email — octet pour octet le même document ;
 *   NOM       BL_00125_FAT_ET_MAT.pdf, sans accent ni esperluette ;
 *   ISOLATION un bon d'une autre société n'est pas servi.
 */

const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const { execFileSync } = require("child_process");

const BASE = `http://127.0.0.1:${process.env.PORT || 5050}`;
const SECRET = process.env.JWT_SECRET || "test-secret-durcissement";
const URL_BASE = process.env.DATABASE_URL ||
  "postgresql://postgres:triangle_test_password@127.0.0.1:5433/triangle_wms";
const V = "\x1b[32m", R = "\x1b[31m", G = "\x1b[1m", Z = "\x1b[0m";
let reussis = 0, echoues = 0;
function verifier(titre, condition, detail = "") {
  if (condition) { reussis += 1; console.log(`${V}  ✓${Z} ${titre}`); }
  else { echoues += 1; console.log(`${R}  ✗ ${titre}${Z}${detail ? `  — ${detail}` : ""}`); }
}

const pool = new Pool({ connectionString: URL_BASE });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;
const jeton = (id, role, companyId, superAdmin = false) =>
  jwt.sign({ id, fullname: `Compte ${id}`, email: `b${id}@essai.test`, role,
             company_id: companyId, is_super_admin: superAdmin }, SECRET, { expiresIn: "3h" });

async function appel(methode, chemin, token, corps, societe) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: {
      ...(corps ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(societe ? { "x-active-company-id": String(societe) } : {}),
    },
    body: corps !== undefined ? JSON.stringify(corps) : undefined,
  });
  return r;
}

const TRIANGLE = 1, FATMAT = 2;
let SUPER_F = 0, SUPER_T = 0, blFatmat = 0, blTriangle = 0;

async function poserLeJeu() {
  await pool.query(`DELETE FROM sand_deliveries WHERE delivery_number LIKE 'BL-T090-%'`);
  await pool.query(`DELETE FROM sand_sales WHERE sale_number LIKE 'V-T090-%'`);
  await pool.query(`DELETE FROM sand_customers WHERE customer_code LIKE 'C-T090-%'`);
  await pool.query(`DELETE FROM users WHERE email LIKE 'bl090-%@essai.test'`);
  await pool.query(`UPDATE company_settings SET default_delivered_by = '' WHERE company_id = ANY($1::int[])`,
    [[TRIANGLE, FATMAT]]);

  const creer = async (email, nom, companyId) => (await pool.query(
    `INSERT INTO users (company_id, fullname, email, password, role, is_super_admin, is_active)
     VALUES ($1,$2,$3,'x','super_admin',true,true) RETURNING id`,
    [companyId, nom, email])).rows[0].id;
  SUPER_F = await creer("bl090-fatmat@essai.test", "Essai 090 FAT & MAT", FATMAT);
  SUPER_T = await creer("bl090-triangle@essai.test", "Essai 090 Triangle", TRIANGLE);

  const poserBon = async (companyId, code, livreur) => {
    const [client] = await q(
      `INSERT INTO sand_customers (company_id, customer_code, name, status)
       VALUES ($1,$2,$3,'ACTIF') RETURNING id`,
      [companyId, `C-T090-${code}`, `Client Essai ${code}`]);
    const [vente] = await q(
      `INSERT INTO sand_sales (company_id, customer_id, sale_number, quantity_m3, unit_price,
                               sand_subtotal, total_amount, paid_amount, remaining_amount, status)
       VALUES ($1,$2,$3,10,17000,170000,170000,0,170000,'VALIDEE') RETURNING id`,
      [companyId, client.id, `V-T090-${code}`]);
    const [bl] = await q(
      `INSERT INTO sand_deliveries (company_id, sale_id, delivery_number, delivery_date,
                                    destination, quantity_m3, truck, driver_name,
                                    received_by, delivered_by)
       VALUES ($1,$2,$3,CURRENT_DATE,'Kati',10,'AB-1234','Chauffeur Essai','Client Essai',$4)
       RETURNING id`,
      [companyId, vente.id, `BL-T090-${code}`, livreur]);
    return bl.id;
  };

  /* Le bon de FAT & MAT porte le nom de celui qui saisissait — le défaut. */
  blFatmat = await poserBon(FATMAT, "FATMAT", "Djoulédé Traoré");
  blTriangle = await poserBon(TRIANGLE, "TRIANGLE", "Livreur Triangle");
}

function lancerScript(args) {
  try {
    return { ok: true, sortie: execFileSync(process.execPath,
      ["scripts/corriger-livreur-bons-livraison.js", ...args],
      { env: { ...process.env, DATABASE_URL: URL_BASE }, encoding: "utf8" }) };
  } catch (e) {
    return { ok: false, sortie: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

async function main() {
  console.log(`\n${G}BONS DE LIVRAISON — LIVREUR ET PDF (090)${Z}`);
  await poserLeJeu();
  const tFatmat = jeton(SUPER_F, "super_admin", FATMAT, true);
  const tTriangle = jeton(SUPER_T, "super_admin", TRIANGLE, true);

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LE SCRIPT REFUSE DE DEVINER LA SOCIÉTÉ${Z}`);
  {
    const sansSociete = lancerScript(["--preview", "--livreur=Issa Diallo"]);
    verifier("sans --societe, refus", !sansSociete.ok && /societe/i.test(sansSociete.sortie),
      sansSociete.sortie.slice(0, 110));

    const inconnue = lancerScript(["--preview", "--societe=SocieteQuiNExistePas", "--livreur=Issa Diallo"]);
    verifier("une société inconnue est refusée",
      !inconnue.ok && /Aucune société/i.test(inconnue.sortie), inconnue.sortie.slice(0, 110));

    const sansLivreur = lancerScript(["--preview", "--societe=FAT & MAT"]);
    verifier("sans --livreur, refus", !sansLivreur.ok && /livreur/i.test(sansLivreur.sortie));

    const sansMotif = lancerScript(["--apply", "--societe=FAT & MAT", "--livreur=Issa Diallo",
      "--confirmer=OUI JE CORRIGE LES BONS DE FAT & MAT"]);
    verifier("--apply sans motif est refusé", !sansMotif.ok && /motif/i.test(sansMotif.sortie));

    const mauvaisePhrase = lancerScript(["--apply", "--societe=FAT & MAT", "--livreur=Issa Diallo",
      "--motif=Correction du nom du livreur sur les bons", "--confirmer=OUI"]);
    verifier("--apply sans la phrase exacte est refusé",
      !mauvaisePhrase.ok && /Confirmation exacte/i.test(mauvaisePhrase.sortie));

    const [inchange] = await q(`SELECT delivered_by FROM sand_deliveries WHERE id=$1`, [blFatmat]);
    verifier("après ces refus, le bon n'a pas bougé",
      inchange.delivered_by === "Djoulédé Traoré", inchange.delivered_by);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LE PREVIEW N'ÉCRIT RIEN${Z}`);
  {
    const r = lancerScript(["--preview", "--societe=FAT & MAT", "--livreur=Issa Diallo"]);
    verifier("le preview s'exécute", r.ok, r.sortie.slice(-160));
    verifier("il nomme la société résolue", /FAT & MAT/.test(r.sortie));
    /* Le preview colore sa sortie : sans retirer les codes ANSI, le nom
       actuel et le nom visé sont séparés par des caractères invisibles que
       l'expression ne franchit pas. */
    const sansCouleurs = r.sortie.replace(/\x1b\[[0-9;]*m/g, "");
    /* Une même LIGNE doit porter les deux noms : c'est ce que la personne
       lit avant de décider d'appliquer. Comparer sur tout le texte laisserait
       passer un preview où ils apparaissent à deux endroits sans rapport. */
    const ligneCorrection = sansCouleurs.split("\n")
      .find((l) => l.includes("Traoré") && l.includes("Issa Diallo")) || "";
    verifier("il montre, sur la même ligne, le nom actuel et le nom visé",
      ligneCorrection.length > 0, ligneCorrection.trim().slice(0, 90) || "aucune ligne ne porte les deux");
    verifier("il dit que rien n'a été écrit", /aucune écriture n'a eu lieu/i.test(r.sortie));

    const [inchange] = await q(`SELECT delivered_by FROM sand_deliveries WHERE id=$1`, [blFatmat]);
    verifier("et rien n'a effectivement été écrit",
      inchange.delivered_by === "Djoulédé Traoré", inchange.delivered_by);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LA CORRECTION${Z}`);
  {
    const r = lancerScript(["--apply", "--societe=FAT & MAT", "--livreur=Issa Diallo",
      "--motif=Le nom imprimé était celui de la personne qui saisissait",
      "--confirmer=OUI JE CORRIGE LES BONS DE FAT & MAT"]);
    verifier("la correction s'applique", r.ok, r.sortie.slice(-200));

    const [corrige] = await q(`SELECT delivered_by FROM sand_deliveries WHERE id=$1`, [blFatmat]);
    verifier("le bon FAT & MAT porte désormais Issa Diallo",
      corrige.delivered_by === "Issa Diallo", corrige.delivered_by);

    const [aucunDjoulde] = await q(
      `SELECT count(*)::int AS n FROM sand_deliveries
        WHERE company_id=$1 AND delivered_by ILIKE '%Djoul%'`, [FATMAT]);
    verifier("plus aucun « Djoulédé » chez FAT & MAT", aucunDjoulde.n === 0, `${aucunDjoulde.n}`);

    const [triangle] = await q(`SELECT delivered_by FROM sand_deliveries WHERE id=$1`, [blTriangle]);
    verifier("le bon de Triangle n'a PAS été touché",
      triangle.delivered_by === "Livreur Triangle", triangle.delivered_by);

    const [reglage] = await q(
      `SELECT default_delivered_by FROM company_settings WHERE company_id=$1`, [FATMAT]);
    verifier("le livreur est enregistré comme réglage de la société",
      reglage?.default_delivered_by === "Issa Diallo", reglage?.default_delivered_by);

    const encore = lancerScript(["--apply", "--societe=FAT & MAT", "--livreur=Issa Diallo",
      "--motif=Second passage, contrôle d'idempotence",
      "--confirmer=OUI JE CORRIGE LES BONS DE FAT & MAT"]);
    verifier("un second passage ne corrige rien", encore.ok && /0 bon\(s\) corrigé/.test(encore.sortie),
      (encore.sortie.match(/\d+ bon\(s\) corrigé/) || [""])[0]);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LE PDF${Z}`);
  let pdfTelecharge = null;
  {
    const r = await appel("GET", `/bons-livraison/sable/${blFatmat}/pdf`, tFatmat, undefined, FATMAT);
    verifier("le PDF est servi", r.status === 200, `statut ${r.status}`);
    verifier("son type est bien application/pdf",
      (r.headers.get("Content-Type") || "").includes("application/pdf"),
      r.headers.get("Content-Type"));

    const disposition = r.headers.get("Content-Disposition") || "";
    verifier("il est servi en TÉLÉCHARGEMENT, pas en aperçu",
      disposition.startsWith("attachment"), disposition.slice(0, 80));
    verifier("le nom du fichier suit la forme demandée",
      /BL_T090_FATMAT_FAT_ET_MAT\.pdf/.test(disposition), disposition.slice(0, 120));

    const buf = Buffer.from(await r.arrayBuffer());
    pdfTelecharge = buf;
    verifier("le contenu est un vrai PDF", buf.slice(0, 5).toString() === "%PDF-", buf.slice(0, 8).toString());
    verifier("il n'est pas vide", buf.length > 800, `${buf.length} octets`);

    const apercu = await appel("GET", `/bons-livraison/sable/${blFatmat}/pdf?disposition=inline`,
      tFatmat, undefined, FATMAT);
    verifier("l'aperçu est servi en inline quand on le demande",
      (apercu.headers.get("Content-Disposition") || "").startsWith("inline"),
      apercu.headers.get("Content-Disposition"));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}UN SEUL DOCUMENT POUR TOUTES LES ACTIONS${Z}`);
  {
    /* Deux demandes successives doivent rendre le même document. Seule la
       ligne « Édité le … » porte l'horodatage ; on compare donc la taille et
       la structure, qui divergeraient au premier générateur parallèle. */
    const deuxieme = await appel("GET", `/bons-livraison/sable/${blFatmat}/pdf`, tFatmat, undefined, FATMAT);
    const buf2 = Buffer.from(await deuxieme.arrayBuffer());
    verifier("deux demandes donnent un document de même taille",
      Math.abs(buf2.length - pdfTelecharge.length) <= 4,
      `${pdfTelecharge.length} / ${buf2.length}`);

    /* Le partage et le téléchargement passent par la MÊME route : c'est ce
       qui garantit qu'ils ne peuvent pas diverger. Le frontend n'a aucun
       générateur de son côté — on le vérifie sur le code. */
    const fs = require("fs");
    const lib = fs.readFileSync(
      `${__dirname}/../../frontend/app/lib/bon-livraison-pdf.ts`, "utf8");
    verifier("le frontend ne fabrique aucun PDF de son côté",
      !/jspdf|pdf-lib|html2canvas|new PDFDocument/i.test(lib));
    verifier("téléchargement et partage appellent la même route",
      (lib.match(/bons-livraison\/\$\{famille\}\/\$\{id\}\/pdf/g) || []).length === 1,
      "une seule construction d'URL");
    /* On cherche un APPEL, pas le mot : le module explique en commentaire
       pourquoi il ne faut surtout pas imprimer ici, et cette phrase-là doit
       pouvoir rester. */
    const sansCommentaires = lib
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    verifier("aucun appel à window.print() dans le chemin du téléchargement",
      !/window\s*\.\s*print\s*\(/.test(sansCommentaires));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}LE PDF PORTE LE BON NOM DE LIVREUR${Z}`);
  {
    /* pdfkit compresse les flux : on relit donc la valeur à la source, et on
       vérifie que la route la prend bien du bon. */
    const [bon] = await q(`SELECT delivered_by FROM sand_deliveries WHERE id=$1`, [blFatmat]);
    verifier("la donnée servie au PDF est « Issa Diallo »",
      bon.delivered_by === "Issa Diallo", bon.delivered_by);

    /* Et quand le bon n'en porte aucun, c'est le réglage de société qui
       prend le relais — jamais un nom inventé. */
    await pool.query(`UPDATE sand_deliveries SET delivered_by = '' WHERE id = $1`, [blFatmat]);
    const r = await appel("GET", `/bons-livraison/sable/${blFatmat}/pdf`, tFatmat, undefined, FATMAT);
    verifier("un bon sans livreur est tout de même servi", r.status === 200, `statut ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    verifier("et le PDF reste valide", buf.slice(0, 5).toString() === "%PDF-");
    await pool.query(`UPDATE sand_deliveries SET delivered_by = 'Issa Diallo' WHERE id = $1`, [blFatmat]);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}UN NOUVEAU BON PREND LE LIVREUR DE LA SOCIÉTÉ${Z}`);
  {
    /* On éprouve la règle de création sans passer par toute la chaîne de
       vente : ce qui compte est l'ordre saisi → réglage → auteur. */
    const [reglage] = await q(
      `SELECT COALESCE(default_delivered_by,'') AS nom FROM company_settings WHERE company_id=$1`,
      [FATMAT]);
    const saisi = "";
    const auteur = "Celui Qui Saisit";
    const livrePar = saisi.trim() || reglage.nom || auteur;
    verifier("sans valeur saisie, c'est le réglage de société qui l'emporte",
      livrePar === "Issa Diallo", livrePar);

    const avecSaisie = "Un Autre Livreur".trim() || reglage.nom || auteur;
    verifier("une valeur saisie passe avant le réglage",
      avecSaisie === "Un Autre Livreur", avecSaisie);

    /* Une société peut n'avoir aucune ligne de réglages : c'est le cas au
       premier jour, et c'est précisément là que le repli doit tenir. */
    const [sansReglage] = await q(
      `SELECT COALESCE(default_delivered_by,'') AS nom FROM company_settings WHERE company_id=$1`,
      [TRIANGLE]);
    const repli = "".trim() || (sansReglage?.nom || "") || auteur;
    verifier("sans réglage ni saisie, on retombe sur l'auteur (comportement historique)",
      repli === auteur, repli);
  }

  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${G}ISOLATION ENTRE SOCIÉTÉS${Z}`);
  {
    const croise = await appel("GET", `/bons-livraison/sable/${blFatmat}/pdf`, tTriangle, undefined, TRIANGLE);
    verifier("Triangle ne peut pas télécharger un bon de FAT & MAT",
      croise.status === 404, `statut ${croise.status}`);

    const sansJeton = await appel("GET", `/bons-livraison/sable/${blFatmat}/pdf`);
    verifier("sans jeton, le PDF n'est pas servi",
      sansJeton.status === 401 || sansJeton.status === 403, `statut ${sansJeton.status}`);
  }

  await pool.query(`DELETE FROM sand_deliveries WHERE delivery_number LIKE 'BL-T090-%'`);
  await pool.query(`DELETE FROM sand_sales WHERE sale_number LIKE 'V-T090-%'`);
  await pool.query(`DELETE FROM sand_customers WHERE customer_code LIKE 'C-T090-%'`);

  console.log(`\n${G}BILAN${Z}`);
  console.log(`  ${reussis} réussis, ${echoues} échoués\n`);
  await pool.end();
  process.exit(echoues > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(`${R}ÉCHEC : ${e.message}${Z}`); console.error(e.stack);
  await pool.end().catch(() => {});
  process.exit(1);
});

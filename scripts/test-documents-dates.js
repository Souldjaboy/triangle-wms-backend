"use strict";

/**
 * TESTS DES DATES MÉTIER DES DOCUMENTS.
 *
 *   DATABASE_URL=… node scripts/test-documents-dates.js
 *
 * Le cas de référence, celui qui a motivé tout le chantier :
 *   opération réellement faite le 22/08/2026 à 10:30 ;
 *   saisie dans le logiciel le 25 ;
 *   bon imprimé le 27.
 * Le document doit afficher « 22/08/2026 à 10:30 », et la base doit continuer
 * de savoir que la ligne a été créée le 25.
 */

/* Les attendus de ce fichier sont écrits à l'heure de Bamako, celle du VPS et
   celle du client. Sur une machine réglée ailleurs — un poste en Europe est à
   +2 l'été — les mêmes horodatages s'affichaient deux heures plus tôt et six
   contrôles viraient au rouge sans qu'aucun code n'ait changé. Le fuseau est
   donc fixé ici, avant toute manipulation de date. */
process.env.TZ = "Africa/Bamako";

const express = require("express");
const { Pool } = require("pg");
const creerRouteur = require("../routes/documents-dates");
const permissions = require("../services/permissions");
const D = require("../services/document-dates");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = 5402;

let reussis = 0, echoues = 0;
const verifier = (nom, ok, detail = "") => {
  if (ok) { reussis += 1; console.log(`  ✓ ${nom}`); }
  else { echoues += 1; console.log(`  ✗ ${nom}${detail ? ` — ${detail}` : ""}`); }
};

const SUPER = 1, AGENT = 2, MAGASINIER = 3, ETRANGER = 9;

async function authenticateToken(req, res, next) {
  const id = Number(String(req.headers.authorization || "").replace("Bearer ", "")) || 0;
  if (!id) return res.status(401).json({ error: "Non authentifié." });
  const { rows } = await pool.query(
    `SELECT id, company_id, fullname, email, role, is_super_admin FROM users WHERE id=$1`, [id]);
  if (!rows[0]) return res.status(401).json({ error: "Non authentifié." });
  req.user = rows[0]; next();
}
const getEffectiveCompanyId = (req, f) => req.user?.company_id || f || null;
const requirePermission = permissions.creerRequirePermission(pool);

const app = express();
app.use(express.json());
app.use("/", creerRouteur({ pool, authenticateToken, getEffectiveCompanyId, requirePermission }));
const serveur = app.listen(PORT);

const BASE = `http://127.0.0.1:${PORT}`;
async function appel(methode, chemin, jeton, corps) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}) },
    ...(corps ? { body: JSON.stringify(corps) } : {}),
  });
  return { statut: r.status, corps: await r.json().catch(() => ({})) };
}

/* La saisie technique a eu lieu le 25 août ; l'opération, le 22 à 10 h 30. */
const CREATION_TECHNIQUE = "2026-08-25T14:07:33Z";
const TYPES = ["Bon d'entrée", "Bon de sortie", "Bon de transfert", "Bon d'inventaire"];

async function semer() {
  await pool.query(`TRUNCATE document_date_revisions RESTART IDENTITY`);
  await pool.query(`DELETE FROM documents`);
  await pool.query(`DELETE FROM stock_movements`);
  await pool.query(`DELETE FROM role_permissions`);
  await pool.query(`DELETE FROM users`);
  await pool.query(`DELETE FROM companies`);

  await pool.query(
    `INSERT INTO companies (id,name,status) VALUES (1,'Triangle','active'),(2,'FAT & MAT','active')`);
  await pool.query(`SELECT setval('companies_id_seq',2,true)`);
  await pool.query(
    `INSERT INTO users (id,fullname,email,password,role,company_id,is_super_admin,is_active) VALUES
       (1,'Super Admin','super@triangle.test','x','super_admin',1,true,true),
       (2,'Agent','agent@triangle.test','x','agent',1,false,true),
       (3,'Magasinier','maga@triangle.test','x','magasinier',1,false,true),
       (9,'Admin FAT','admin@fatmat.test','x','super_admin',2,true,true)`);
  await pool.query(`SELECT setval('users_id_seq',9,true)`);

  /* Un mouvement et un document par famille : entrée, sortie, transfert,
     inventaire. Tous passent par le même moteur de date. */
  for (let i = 0; i < TYPES.length; i += 1) {
    const id = i + 1;
    await pool.query(
      `INSERT INTO stock_movements (id, type, product_reference, product_name, quantity,
                                    company_id, created_at, status)
       VALUES ($1,$2,'REF-A','Faux plafond',10,1,$3,'Validé')`,
      [id, TYPES[i].replace("Bon d'", "").replace("Bon de ", ""), CREATION_TECHNIQUE]);
    await pool.query(
      `INSERT INTO documents (id, document_type, document_number, company_id,
                              created_at, stock_movement_id, created_by)
       VALUES ($1,$2,$3,1,$4,$1,'Administrateur')`,
      [id, TYPES[i], `DOC-00${id}`, CREATION_TECHNIQUE]);
  }
  await pool.query(`SELECT setval('documents_id_seq',4,true)`);
  await pool.query(`SELECT setval('stock_movements_id_seq',4,true)`);
  /* Un document de FAT & MAT : Triangle ne doit jamais y toucher. */
  await pool.query(
    `INSERT INTO documents (id, document_type, document_number, company_id, created_at)
     VALUES (90,'Bon de sortie','FAT-001',2,$1)`, [CREATION_TECHNIQUE]);

  await pool.query(
    `INSERT INTO role_permissions (company_id, role, module_key, action, allowed)
     SELECT c.id, r.role, m.module_key, a.action,
            r.role IN ('super_admin','admin','direction')
       FROM companies c
       JOIN (SELECT DISTINCT company_id, lower(trim(role)) AS role FROM users) r ON r.company_id=c.id
       CROSS JOIN permission_modules m
       CROSS JOIN LATERAL unnest(m.actions) AS a(action)
     ON CONFLICT DO NOTHING`);

  /* L'agent voit, modifie et imprime — mais ne RÉIMPRIME pas. C'est ce droit
     qui sépare « corriger un brouillon » de « corriger un bon qui circule ». */
  for (const [action, autorise] of [
    ["visible", true], ["view", true], ["update", true], ["print", true],
    ["audit", true], ["reprint", false],
  ]) {
    await pool.query(
      `INSERT INTO role_permissions (company_id, role, module_key, action, allowed)
       VALUES (1,'agent','document',$1,$2)
       ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed=EXCLUDED.allowed`,
      [action, autorise]);
  }
}

const docEnBase = async (id) =>
  (await pool.query(`SELECT * FROM documents WHERE id=$1`, [id])).rows[0];

async function main() {
  await semer();

  console.log("\nLE CAS DE RÉFÉRENCE — saisi le 25, fait le 22 à 10:30, imprimé le 27");
  {
    const avant = await docEnBase(1);
    const lecture = await appel("GET", "/documents/1/dates", SUPER);
    verifier("les dates du document se lisent", lecture.statut === 200);
    verifier("le fuseau annoncé est Africa/Bamako", lecture.corps.fuseau === "Africa/Bamako");
    verifier("faute de date métier, le bon affiche sa date de création",
      lecture.corps.source_date_affichee === "creation");
    verifier("et l'écran le dit au lieu de le laisser croire",
      lecture.corps.date_metier_confirmee === false);

    const r = await appel("PUT", "/documents/1/dates", SUPER, {
      date: "2026-08-22", time: "10:30", reason: "Impression différée",
    });
    verifier("la date se corrige", r.statut === 200, JSON.stringify(r.corps).slice(0, 150));
    verifier("le document affiche 22/08/2026 à 10:30",
      r.corps.dates.document_affiche.affichage === "22/08/2026 à 10:30",
      r.corps.dates.document_affiche.affichage);
    verifier("la date affichée vient bien du métier", r.corps.source_date_affichee === "document");

    const apres = await docEnBase(1);
    verifier("CREATED_AT N'A PAS BOUGÉ",
      new Date(apres.created_at).toISOString() === new Date(avant.created_at).toISOString(),
      `${avant.created_at} → ${apres.created_at}`);
    verifier("la date de création reste affichée en lecture seule",
      r.corps.dates.creation_technique.affichage === "25/08/2026 à 14:07",
      r.corps.dates.creation_technique.affichage);
    verifier("la date effective de l'opération est posée",
      r.corps.dates.operation_effective.affichage === "22/08/2026 à 10:30");
    verifier("le mouvement porte la même réalité de terrain",
      r.corps.mouvement.operation_effective.affichage === "22/08/2026 à 10:30",
      r.corps.mouvement?.operation_effective?.affichage);
    verifier("une révision a été créée", r.corps.revision === 2, `${r.corps.revision}`);
  }

  console.log("\nFUSEAU HORAIRE");
  {
    /* Africa/Bamako est à UTC+0 : 10:30 saisi doit valoir 10:30 UTC. Le test
       vérifie la conversion, pas la constante — si la règle changeait, c'est
       ici qu'on le verrait. */
    const instant = D.versInstant({ date: "2026-08-22", time: "10:30" });
    verifier("10:30 à Bamako = 10:30 UTC", instant.toISOString() === "2026-08-22T10:30:00.000Z",
      instant.toISOString());
    const retour = D.versLocal(instant);
    verifier("l'aller-retour est exact", retour.date === "2026-08-22" && retour.time === "10:30",
      `${retour.date} ${retour.time}`);
    verifier("l'affichage est au format français", retour.affichage === "22/08/2026 à 10:30");
    verifier("minuit ne bascule pas de jour",
      D.versLocal(D.versInstant({ date: "2026-01-01", time: "00:00" })).date === "2026-01-01");
  }

  console.log("\nGARDE-FOUS DE SAISIE");
  {
    const futur = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const r1 = await appel("PUT", "/documents/2/dates", SUPER, { date: futur, time: "08:00" });
    verifier("une date future est refusée", r1.statut === 400 && r1.corps.code === "DATE_IN_FUTURE",
      `statut ${r1.statut}`);
    const r2 = await appel("PUT", "/documents/2/dates", SUPER, { date: "1998-01-01", time: "08:00" });
    verifier("une date d'avant 2000 est refusée", r2.statut === 400 && r2.corps.code === "DATE_TOO_OLD");
    const r3 = await appel("PUT", "/documents/2/dates", SUPER, { date: "22/08/2026", time: "10:30" });
    verifier("un format de date invalide est refusé", r3.statut === 400 && r3.corps.code === "INVALID_DATE");
    const r4 = await appel("PUT", "/documents/2/dates", SUPER, { date: "2026-08-22", time: "25h" });
    verifier("un format d'heure invalide est refusé", r4.statut === 400 && r4.corps.code === "INVALID_TIME");
    const inchange = await docEnBase(2);
    verifier("aucune de ces tentatives n'a écrit quoi que ce soit",
      inchange.document_datetime === null && Number(inchange.document_revision) === 1);
  }

  console.log("\nENTRÉE, SORTIE, TRANSFERT, INVENTAIRE — même moteur");
  {
    for (let id = 1; id <= 4; id += 1) {
      const r = await appel("PUT", `/documents/${id}/dates`, SUPER, {
        date: "2026-08-22", time: "09:15", reason: "Régularisation d'un document Excel",
      });
      const doc = await docEnBase(id);
      verifier(`${TYPES[id - 1]} : date corrigée et création intacte`,
        r.statut === 200
        && r.corps.dates.document_affiche.affichage === "22/08/2026 à 09:15"
        && new Date(doc.created_at).toISOString() === new Date(CREATION_TECHNIQUE).toISOString(),
        `statut ${r.statut}`);
    }
  }

  console.log("\nAPRÈS UNE PREMIÈRE IMPRESSION");
  {
    const impression = await appel("POST", "/documents/3/printed", SUPER, {});
    verifier("l'impression est enregistrée", impression.statut === 200 && impression.corps.print_count === 1);
    verifier("printed_at est distinct de la date du document",
      impression.corps.dates.derniere_impression.iso !== impression.corps.dates.document_affiche.iso);

    const sansMotif = await appel("PUT", "/documents/3/dates", SUPER, { date: "2026-08-21", time: "16:00" });
    verifier("corriger un document imprimé sans motif est refusé",
      sansMotif.statut === 400 && sansMotif.corps.code === "REASON_REQUIRED", `statut ${sansMotif.statut}`);

    const avecMotif = await appel("PUT", "/documents/3/dates", SUPER, {
      date: "2026-08-21", time: "16:00", reason: "Correction de date de mouvement",
    });
    verifier("avec motif, la correction passe", avecMotif.statut === 200);
    /* Le document 3 en est à sa troisième version : créé (1), corrigé par la
       boucle des quatre familles (2), corrigé après impression (3). La
       tentative sans motif n'en a créé aucune — un refus ne compte pas. */
    verifier("une nouvelle révision est créée", avecMotif.corps.revision === 3, `${avecMotif.corps.revision}`);

    const agent = await appel("PUT", "/documents/3/dates", AGENT, {
      date: "2026-08-20", time: "10:00", reason: "tentative",
    });
    verifier("sans le droit « réimprimer », un document déjà imprimé est protégé",
      agent.statut === 403, `statut ${agent.statut}`);

    const brouillon = await appel("PUT", "/documents/4/dates", AGENT, {
      date: "2026-08-20", time: "10:00", reason: "correction avant impression",
    });
    verifier("mais le même agent corrige un document non imprimé",
      brouillon.statut === 200, `statut ${brouillon.statut}`);
  }

  console.log("\nHISTORIQUE DES RÉVISIONS");
  {
    const r = await appel("GET", "/documents/3/revisions", SUPER);
    verifier("l'historique se lit", r.statut === 200);
    verifier("il contient les deux corrections effectives, pas la tentative refusée",
      r.corps.entries.length === 2, `${r.corps.entries.length}`);
    verifier("les révisions se suivent sans trou",
      JSON.stringify(r.corps.entries.map((e) => e.revision)) === JSON.stringify([3, 2]),
      JSON.stringify(r.corps.entries.map((e) => e.revision)));
    const derniere = r.corps.entries[0];
    verifier("il porte l'ancienne et la nouvelle valeur",
      Boolean(derniere.ancienne) && Boolean(derniere.nouvelle));
    verifier("il nomme l'auteur", derniere.changed_by_name === "Super Admin", derniere.changed_by_name);
    verifier("il porte le motif", derniere.reason === "Correction de date de mouvement", derniere.reason);
    verifier("il indique que le document était déjà imprimé", derniere.was_printed === true);
    verifier("aucune révision n'a été écrasée",
      new Set(r.corps.entries.map((e) => e.revision)).size === r.corps.entries.length);
  }

  console.log("\nRÉTABLIR LA DATE D'ORIGINE");
  {
    const avant = await docEnBase(1);
    const r = await appel("POST", "/documents/1/dates/reset", SUPER, { reason: "Erreur de saisie" });
    verifier("le rétablissement répond", r.statut === 200, JSON.stringify(r.corps).slice(0, 120));
    verifier("le bon retombe sur la date de l'opération",
      r.corps.source_date_affichee === "operation", r.corps.source_date_affichee);
    const apres = await docEnBase(1);
    verifier("created_at n'a toujours pas bougé",
      new Date(apres.created_at).toISOString() === new Date(avant.created_at).toISOString());
    verifier("le rétablissement est lui aussi journalisé",
      (await appel("GET", "/documents/1/revisions", SUPER)).corps.entries
        .some((e) => e.context === "reset"));
  }

  console.log("\nDATE DE TERRAIN D'UN MOUVEMENT");
  {
    const r = await appel("PUT", "/stock-movements/2/operation-date", SUPER, {
      date: "2026-08-19", time: "07:45", reason: "Opération faite avant la saisie",
    });
    verifier("la date du mouvement se corrige", r.statut === 200, JSON.stringify(r.corps).slice(0, 120));
    verifier("elle s'affiche à l'heure de Bamako",
      r.corps.operation_effective.affichage === "19/08/2026 à 07:45",
      r.corps.operation_effective?.affichage);
    const mvt = (await pool.query(`SELECT created_at FROM stock_movements WHERE id=2`)).rows[0];
    verifier("la date technique du mouvement est intacte",
      new Date(mvt.created_at).toISOString() === new Date(CREATION_TECHNIQUE).toISOString());
    const absent = await appel("PUT", "/stock-movements/9999/operation-date", SUPER,
      { date: "2026-08-19", time: "07:45" });
    verifier("un mouvement inexistant répond 404", absent.statut === 404);
  }

  console.log("\nDROITS ET CLOISONNEMENT");
  {
    const sansDroit = await appel("PUT", "/documents/1/dates", MAGASINIER, { date: "2026-08-18", time: "10:00" });
    verifier("un magasinier ne peut pas modifier une date",
      sansDroit.statut === 403 || sansDroit.statut === 404, `statut ${sansDroit.statut}`);
    const lecture = await appel("GET", "/documents/1/dates", MAGASINIER);
    verifier("ni même la lire", lecture.statut === 403 || lecture.statut === 404);

    const etranger = await appel("PUT", "/documents/1/dates", ETRANGER, {
      date: "2026-08-18", time: "10:00", reason: "intrusion",
    });
    verifier("FAT & MAT ne touche pas un document Triangle", etranger.statut === 404, `statut ${etranger.statut}`);
    const triangleVersFat = await appel("GET", "/documents/90/dates", SUPER);
    verifier("et Triangle ne lit pas un document FAT & MAT", triangleVersFat.statut === 404);

    const sansJeton = await appel("GET", "/documents/1/dates");
    verifier("sans jeton : 401", sansJeton.statut === 401);
  }

  console.log("\nAUCUNE QUANTITÉ TOUCHÉE");
  {
    const mvts = await pool.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(quantity),0)::int AS q FROM stock_movements WHERE company_id=1`);
    verifier("les mouvements sont tous là avec leurs quantités",
      mvts.rows[0].n === 4 && mvts.rows[0].q === 40, JSON.stringify(mvts.rows[0]));
  }

  serveur.close();
  await pool.end();
  console.log(`\n${reussis} réussis, ${echoues} échoués\n`);
  process.exit(echoues ? 1 : 0);
}

main().catch(async (e) => {
  console.error("ÉCHEC :", e);
  serveur.close();
  await pool.end().catch(() => {});
  process.exit(1);
});

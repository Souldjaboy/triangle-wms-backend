"use strict";
/**
 * LES PIÈCES JOINTES DU CHAT — LE CORRECTIF P0.
 *
 * Ce que ces tests éprouvent, dans l'ordre où cela compte :
 *
 *  1. Que l'expéditeur et le destinataire peuvent RÉELLEMENT ouvrir le
 *     fichier — c'était le défaut : 404 au clic sur un classeur Excel.
 *  2. Qu'un tiers de la même société, hors de la conversation, ne le peut
 *     pas. Et qu'une personne d'une AUTRE société ne le peut pas davantage.
 *  3. Que le refus ne dit pas s'il s'agit d'un fichier inexistant ou d'un
 *     fichier interdit : distinguer les deux apprendrait quels noms existent.
 *  4. Que l'ancienne adresse « /uploads/chat/… » fonctionne encore — sans
 *     quoi tout l'historique du chat serait cassé — mais qu'elle est
 *     désormais GARDÉE, alors qu'elle était servie à quiconque.
 *  5. Que les six formats demandés passent : XLSX, XLS, PDF, DOCX, PNG, JPEG.
 *  6. Qu'aucun chemin ne permet de sortir du dossier des pièces jointes.
 *  7. Que chaque accès, servi ou refusé, laisse une trace.
 */
const jwt = require("jsonwebtoken");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const BASE = "http://localhost:5050";
const SECRET = process.env.JWT_SECRET || "test_chat404";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let ok = 0, ko = 0;
const v = (n, c, d = "") => { if (c) { ok++; console.log(`  ✔ ${n}`); } else { ko++; console.log(`  ✘ ${n}${d ? `\n      → ${d}` : ""}`); } };
const titre = (t) => console.log(`\n── ${t}`);
const jeton = (u) => jwt.sign({ ...u, tenant_id: "triangle" }, SECRET, { expiresIn: "1h" });
const q = async (s, p = []) => (await pool.query(s, p)).rows;
const un = async (s, p = []) => (await q(s, p))[0];

const EXP   = { id: 900, fullname: "Expediteur", role: "direction", company_id: 1, is_super_admin: true };
const DEST  = { id: 901, fullname: "Destinataire", role: "comptable", company_id: 1, is_super_admin: false };
const TIERS = { id: 902, fullname: "Tiers Triangle", role: "magasinier", company_id: 1, is_super_admin: false };
const ETR   = { id: 903, fullname: "Etranger Fatemat", role: "direction", company_id: 2, is_super_admin: true };

const entetes = (u, societe) => ({
  Authorization: `Bearer ${jeton(u)}`,
  "x-tenant-id": "triangle",
  "x-active-company-id": String(societe ?? u.company_id),
});

async function appel(m, chemin, { user, societe, corps, json } = {}) {
  const h = user ? entetes(user, societe) : { "x-tenant-id": "triangle" };
  if (corps !== undefined) h["Content-Type"] = "application/json";
  const r = await fetch(BASE + chemin, { method: m, headers: h,
    body: corps === undefined ? undefined : JSON.stringify(corps) });
  if (json === false) {
    return { status: r.status, type: r.headers.get("content-type"),
             disposition: r.headers.get("content-disposition"),
             nosniff: r.headers.get("x-content-type-options"),
             cache: r.headers.get("cache-control"),
             buffer: Buffer.from(await r.arrayBuffer()) };
  }
  let data = null; try { data = await r.json(); } catch { /* non JSON */ }
  return { status: r.status, data };
}

async function televerser(user, conversationId, nom, mime, contenu) {
  const f = path.join("/tmp", nom);
  fs.writeFileSync(f, contenu);
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(f)], { type: mime }), nom);
  form.append("conversation_id", String(conversationId));
  const r = await fetch(`${BASE}/chat/upload-file`, {
    method: "POST", headers: entetes(user), body: form });
  let d = null; try { d = await r.json(); } catch { /* non JSON */ }
  return { status: r.status, data: d };
}

(async () => {
  titre("Une conversation entre l'expéditeur et le destinataire");
  let r = await appel("POST", "/chat/conversations", {
    user: EXP, corps: { type: "private", participants: [901], title: "Essai P0" },
  });
  const conv = r.data?.conversation?.id || r.data?.id;
  v("la conversation est créée", !!conv, JSON.stringify(r.data)?.slice(0, 200));

  /* La colonne `role` manquait à conversation_participants : sans la
     migration 159, cette lecture échouait et tout le reste avec. */
  const roles = await q(
    `SELECT user_id, role FROM conversation_participants WHERE conversation_id=$1 ORDER BY user_id`, [conv]);
  v("les participants portent un rôle", roles.length === 2 && roles.every((x) => x.role), JSON.stringify(roles));
  v("le créateur est administrateur de la conversation",
    roles.find((x) => Number(x.user_id) === 900)?.role === "admin", JSON.stringify(roles));

  titre("L'expéditeur envoie un classeur Excel");
  const xlsx = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.from("bilan-septembre-triangle")]);
  let up = await televerser(EXP, conv, "Bilan septembre.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsx);
  v("le téléversement aboutit", up.status === 201, JSON.stringify(up.data)?.slice(0, 250));
  const url = up.data?.file_url;
  v("l'adresse renvoyée passe par le point d'accès gardé",
    /^\/chat\/attachments\//.test(url || ""), url);
  v("elle ne pointe plus vers le dossier statique", !/^\/uploads\//.test(url || ""), url);

  /* Le message qui porte le fichier — c'est lui qui rattache la pièce à une
     conversation, et donc qui rend le contrôle d'accès possible. */
  r = await appel("POST", "/chat/messages", {
    user: EXP, corps: {
      conversation_id: conv, content: "Voici le bilan.", message_type: "file",
      file_url: url, file_name: up.data.file_name,
      file_size: up.data.file_size, file_mime: up.data.file_mime,
    },
  });
  v("le message est enregistré", r.status === 201 || r.status === 200, JSON.stringify(r.data)?.slice(0, 200));

  titre("LE DÉFAUT D'ORIGINE : le destinataire peut-il ouvrir le fichier ?");
  let f = await appel("GET", url, { user: DEST, json: false });
  v("il reçoit le fichier", f.status === 200, `${f.status}`);
  v("et c'est bien le bon contenu", f.buffer?.toString() === xlsx.toString(),
    `${f.buffer?.length} octets`);
  v("le type annoncé est celui du tableur",
    (f.type || "").includes("spreadsheetml"), f.type);
  v("le nom d'origine est restitué, accents compris",
    (f.disposition || "").includes("Bilan") && (f.disposition || "").includes("filename*=UTF-8"),
    f.disposition);
  /* On ne contrôle l'en-tête que si le fichier a bien été servi : sur une
     réponse d'erreur, « nosniff » serait vrai sans rien prouver. */
  v("le navigateur ne devinera pas un autre type",
    f.status === 200 && f.nosniff === "nosniff", `${f.status} / ${f.nosniff}`);
  v("aucun cache partagé ne garde la pièce", /private/.test(f.cache || ""), f.cache);

  f = await appel("GET", url, { user: EXP, json: false });
  v("l'expéditeur aussi", f.status === 200, `${f.status}`);

  titre("Et ceux qui n'y ont pas droit ?");
  f = await appel("GET", url, { user: TIERS, json: false });
  v("un tiers de la même société est refusé", f.status === 404, `${f.status}`);
  f = await appel("GET", url, { user: ETR, societe: 2, json: false });
  v("une personne de FAT & MAT est refusée", f.status === 404, `${f.status}`);
  r = await appel("GET", url, {});
  v("sans jeton, c'est refusé", r.status === 401 || r.status === 403, `${r.status}`);

  titre("Le refus ne renseigne pas le curieux");
  const refusExistant = await appel("GET", url, { user: TIERS });
  const refusInexistant = await appel("GET", "/chat/attachments/1700000000-abcdef0123456789-inconnu.xlsx",
    { user: DEST });
  v("même code pour un fichier interdit et un fichier inexistant",
    refusExistant.status === refusInexistant.status, `${refusExistant.status} / ${refusInexistant.status}`);
  v("même message", refusExistant.data?.error === refusInexistant.data?.error,
    `${refusExistant.data?.error} / ${refusInexistant.data?.error}`);

  titre("L'ANCIENNE ADRESSE : l'historique doit continuer de fonctionner");
  const nomFichier = decodeURIComponent(String(url).replace("/chat/attachments/", ""));
  /* On simule un message ancien, tel qu'il existe déjà en base. */
  await pool.query(
    `INSERT INTO messages (conversation_id, sender_id, content, message_type, company_id,
                           file_url, file_name, file_size, file_mime)
     VALUES ($1,900,'Ancien message','file',1,$2,'Ancien bilan.xlsx',$3,$4)`,
    [conv, `/uploads/chat/${nomFichier}`, xlsx.length,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]);
  f = await appel("GET", `/uploads/chat/${encodeURIComponent(nomFichier)}`, { user: DEST, json: false });
  v("l'ancienne adresse sert encore le fichier", f.status === 200, `${f.status}`);
  v("avec le bon contenu", f.buffer?.toString() === xlsx.toString());

  titre("Mais elle n'est plus publique");
  r = await appel("GET", `/uploads/chat/${encodeURIComponent(nomFichier)}`, {});
  v("sans jeton, refusée", r.status === 401 || r.status === 403, `${r.status}`);
  f = await appel("GET", `/uploads/chat/${encodeURIComponent(nomFichier)}`, { user: ETR, societe: 2, json: false });
  v("depuis l'autre société, refusée", f.status === 404, `${f.status}`);
  f = await appel("GET", `/uploads/chat/${encodeURIComponent(nomFichier)}`, { user: TIERS, json: false });
  v("par un tiers, refusée", f.status === 404, `${f.status}`);

  titre("Les six formats demandés");
  const formats = [
    ["classeur.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "PK\x03\x04xlsx"],
    ["ancien.xls", "application/vnd.ms-excel", "\xD0\xCF\x11\xE0xls"],
    ["contrat.pdf", "application/pdf", "%PDF-1.4 essai"],
    ["note.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "PK\x03\x04docx"],
    ["photo.png", "image/png", "\x89PNG\r\n\x1a\n"],
    ["scan.jpeg", "image/jpeg", "\xFF\xD8\xFFjpeg"],
  ];
  for (const [nom, mime, contenu] of formats) {
    const u = await televerser(EXP, conv, nom, mime, Buffer.from(contenu, "binary"));
    if (u.status !== 201) { v(`${nom} : téléversement`, false, JSON.stringify(u.data)?.slice(0, 160)); continue; }
    await appel("POST", "/chat/messages", {
      user: EXP, corps: { conversation_id: conv, content: nom, message_type: "file",
        file_url: u.data.file_url, file_name: nom, file_size: u.data.file_size, file_mime: mime },
    });
    const g = await appel("GET", u.data.file_url, { user: DEST, json: false });
    v(`${nom} : le destinataire l'ouvre`, g.status === 200, `${g.status}`);
  }

  titre("On ne sort pas du dossier des pièces jointes");
  for (const tentative of [
    "..%2F..%2F..%2Fetc%2Fpasswd",
    "....//....//etc/passwd",
    "%2e%2e%2f%2e%2e%2fserver.js",
    ".env",
    "..%5C..%5Cserver.js",
  ]) {
    const x = await appel("GET", `/chat/attachments/${tentative}`, { user: DEST });
    v(`« ${tentative.slice(0, 28)} » est refusé`, x.status === 404 || x.status === 400, `${x.status}`);
  }

  titre("Un fichier dont le message n'existe pas");
  /* Un fichier posé sur le disque mais que nul message ne désigne : laissé
     par un téléversement interrompu. Il ne doit pas être servi. */
  const P = require(path.join(process.cwd(), "services/pieces-jointes-chat"));
  const orphelin = "1700000000-deadbeefdeadbeef-orphelin.xlsx";
  fs.mkdirSync(P.DOSSIER, { recursive: true });
  fs.writeFileSync(path.join(P.DOSSIER, orphelin), "contenu orphelin");
  r = await appel("GET", `/chat/attachments/${orphelin}`, { user: DEST });
  v("un fichier orphelin n'est pas servi", r.status === 404, `${r.status}`);
  v("alors qu'il existe bien sur le disque",
    fs.existsSync(path.join(P.DOSSIER, orphelin)));

  titre("Le journal des accès");
  const journal = await q(`SELECT outcome, count(*)::int n FROM chat_attachment_access GROUP BY 1 ORDER BY 1`);
  const parType = Object.fromEntries(journal.map((x) => [x.outcome, x.n]));
  v("les téléchargements servis sont tracés", (parType.SERVI || 0) >= 8, JSON.stringify(parType));
  v("les refus hors conversation aussi", (parType.REFUSE_HORS_CONVERSATION || 0) >= 2, JSON.stringify(parType));
  v("les refus inter-sociétés aussi", (parType.REFUSE_AUTRE_SOCIETE || 0) >= 2, JSON.stringify(parType));
  v("et les introuvables", (parType.INTROUVABLE || 0) >= 5, JSON.stringify(parType));
  const trace = await un(
    `SELECT * FROM chat_attachment_access WHERE outcome='SERVI' ORDER BY id DESC LIMIT 1`);
  v("chaque trace porte le nom de qui a ouvert", (trace?.user_name || "").length > 0, trace?.user_name);
  v("et la conversation concernée", !!trace?.conversation_id);

  r = await appel("GET", "/chat/attachments-journal?refus=1", { user: EXP });
  v("le journal se lit depuis l'API", r.status === 200, `${r.status}`);
  v("et ne montre que les refus demandés",
    (r.data?.acces || []).every((a) => a.outcome !== "SERVI"),
    JSON.stringify((r.data?.acces || []).slice(0, 2)));

  titre("Le dossier n'est plus servi en aveugle");
  /* Les AUTRES sous-dossiers de uploads restent servis en statique : les
     modules existants en dépendent. Seul « chat » est gardé. On le vérifie,
     pour ne pas croire qu'on a fermé plus que ce qu'on a fermé. */
  fs.mkdirSync(path.join(P.DOSSIER, "..", "essai-public"), { recursive: true });
  fs.writeFileSync(path.join(P.DOSSIER, "..", "essai-public", "lisible.txt"), "ceci reste public");
  r = await appel("GET", "/uploads/essai-public/lisible.txt", {});
  v("les autres dossiers d'uploads restent statiques (non régression)",
    r.status === 200 || r.status === 304, `${r.status}`);
  console.log("      → c'est voulu : d'autres modules y renvoient. Seul « chat » est gardé.");

  console.log(`\n${"─".repeat(56)}\n  ${ok} réussis, ${ko} échoués\n${"─".repeat(56)}`);
  await pool.end();
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

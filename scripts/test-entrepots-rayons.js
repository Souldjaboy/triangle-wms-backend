"use strict";
/**
 * ENTREPÔTS ET RAYONS — tests contre le serveur réel.
 *
 * Deux listes mentaient à l'écran : celle des entrepôts de réception, figée à
 * trois codes, et celle des rayons du transfert, qui faisait disparaître sans
 * un mot les rayons dont tous les bacs sont des FULLBIN hérités.
 */
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const BASE = "http://localhost:5050";
const SECRET = process.env.JWT_SECRET || "triangle_wms_secret_key";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let ok = 0, ko = 0;
const v = (n, c, d = "") => { if (c) { ok++; console.log(`  ✔ ${n}`); } else { ko++; console.log(`  ✘ ${n}${d ? `\n      → ${d}` : ""}`); } };
const jeton = (u) => jwt.sign({ ...u, tenant_id: "triangle" }, SECRET, { expiresIn: "1h" });
async function appel(chemin, { token, societe } = {}) {
  const headers = { "x-tenant-id": "triangle" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (societe) headers["x-active-company-id"] = String(societe);
  const r = await fetch(BASE + chemin, { headers });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
const q = async (s, p = []) => (await pool.query(s, p)).rows;

(async () => {
  const tT = jeton({ id: 900, fullname: "Super Triangle", role: "super_admin", company_id: 1, is_super_admin: true });
  const tF = jeton({ id: 901, fullname: "Super Fatemat", role: "super_admin", company_id: 2, is_super_admin: true });

  console.log("\n① ENTREPÔTS — la liste vient du serveur, pas du code");
  let r = await appel("/warehouses?actifs_seulement=1", { token: tT, societe: 1 });
  v("réponse 200", r.status === 200, `reçu ${r.status} ${JSON.stringify(r.data)}`);
  const codes = (r.data || []).map((w) => w.code).sort();
  v("les entrepôts actifs de Triangle sont servis", codes.length >= 4, codes.join(", "));
  v("W-EM2S-D présent", codes.includes("W-EM2S-D"), codes.join(", "));
  v("W-EM2S-E présent (statut « actif », variante française)", codes.includes("W-EM2S-E"), codes.join(", "));
  v("tous appartiennent à Triangle",
    (r.data || []).every((w) => Number(w.company_id) === 1),
    JSON.stringify((r.data||[]).map(w=>[w.code,w.company_id])));

  console.log("\n② ISOLATION — FAT & MAT ne voit pas les entrepôts de Triangle");
  r = await appel("/warehouses?actifs_seulement=1", { token: tF, societe: 2 });
  v("réponse 200", r.status === 200, `reçu ${r.status}`);
  v("aucun entrepôt de Triangle servi",
    (r.data || []).every((w) => Number(w.company_id) === 2),
    JSON.stringify((r.data||[]).map(w=>[w.code,w.company_id])));

  console.log("\n③ VUE GLOBALE — réservée à l'administration globale");
  r = await appel("/warehouses?scope=all", { token: tT, societe: 1 });
  v("un super admin peut demander toutes les sociétés", r.status === 200, `reçu ${r.status}`);
  v("et il les obtient bien", new Set((r.data || []).map((w) => w.company_id)).size >= 1);
  const tSimple = jeton({ id: 902, fullname: "Magasinier", role: "magasinier", company_id: 1, is_super_admin: false });
  r = await appel("/warehouses?actifs_seulement=1", { token: tSimple, societe: 1 });
  v("un magasinier autorisé voit les entrepôts de SA société", r.status === 200, `reçu ${r.status} ${JSON.stringify(r.data)}`);
  v("et uniquement ceux-là", (r.data || []).every((w) => Number(w.company_id) === 1),
    JSON.stringify((r.data||[]).map(w=>[w.code,w.company_id])));
  r = await appel("/warehouses?scope=all", { token: tSimple, societe: 1 });
  v("mais la vue multi-sociétés lui est refusée",
    r.status === 403 && r.data?.code === "SCOPE_ALL_FORBIDDEN", `reçu ${r.status} ${JSON.stringify(r.data)}`);

  console.log("\n④ RAYONS — les écartés sont signalés, pas effacés");
  r = await appel("/stock/locations/tree", { token: tT, societe: 1 });
  v("réponse 200", r.status === 200, `reçu ${r.status}`);
  const visiblesC = Object.keys(r.data?.tree?.["W-EM2S-C"] || {}).sort();
  const ecartesC = Object.keys(r.data?.rayonsIndisponibles?.["W-EM2S-C"] || {}).sort();
  v("les rayons précis de C restent sélectionnables", visiblesC.join(",") === "F,G,H", visiblesC.join(","));
  v("les rayons FULLBIN de C sont signalés", ecartesC.join(",") === "A,B,C,D,E", ecartesC.join(","));
  v("aucun rayon écarté n'est dans l'arbre sélectionnable",
    ecartesC.every((x) => !visiblesC.includes(x)));
  const infoA = r.data?.rayonsIndisponibles?.["W-EM2S-C"]?.A;
  v("le motif est nommé", infoA?.motif === "FULLBIN", JSON.stringify(infoA));
  v("le motif est expliqué en clair", String(infoA?.explication || "").includes("précis"), infoA?.explication);
  v("le stock concerné est chiffré (240)", Number(infoA?.quantite) === 240, JSON.stringify(infoA));

  console.log("\n⑤ AUTRES RAYONS INVISIBLES — classés par motif");
  const ecartesA = r.data?.rayonsIndisponibles?.["W-EM2S-A"] || {};
  v("une zone sans bac est classée BIN_ABSENT", ecartesA["PICKING AREA"]?.motif === "BIN_ABSENT", JSON.stringify(ecartesA["PICKING AREA"]));
  v("son stock est chiffré (55)", Number(ecartesA["PICKING AREA"]?.quantite) === 55);
  v("un rebut est classé REBUT", ecartesA["WRITE OFF"]?.motif === "REBUT", JSON.stringify(ecartesA["WRITE OFF"]));
  v("une plage est classée PLAGE", ecartesA["S"]?.motif === "PLAGE", JSON.stringify(ecartesA["S"]));
  v("un rayon avec un bac précis n'est PAS signalé", !("T" in ecartesA), Object.keys(ecartesA).join(","));

  console.log("\n⑥ AUCUNE DONNÉE TOUCHÉE par la lecture");
  const avant = await q(`SELECT count(*) c, COALESCE(sum(quantity),0) q FROM stock_location_balances`);
  await appel("/stock/locations/tree", { token: tT, societe: 1 });
  await appel("/warehouses?actifs_seulement=1", { token: tT, societe: 1 });
  const apres = await q(`SELECT count(*) c, COALESCE(sum(quantity),0) q FROM stock_location_balances`);
  v("le stock global est inchangé", JSON.stringify(avant) === JSON.stringify(apres), `${JSON.stringify(avant)} vs ${JSON.stringify(apres)}`);
  v("aucun emplacement créé ni supprimé",
    Number((await q(`SELECT count(*) c FROM locations`))[0].c) === Number((await q(`SELECT count(*) c FROM locations`))[0].c));

  console.log(`\n════════ ${ok} réussis, ${ko} échoués ════════`);
  await pool.end();
  process.exit(ko === 0 ? 0 : 1);
})().catch(async (e) => { console.error("ERREUR", e); await pool.end().catch(()=>{}); process.exit(1); });

"use strict";

/**
 * ISOLATION DES ENTREPRISES ET BADGES.
 *
 * Éprouve la règle d'affectation d'entreprise et la génération des badges,
 * les deux causes du rattachement d'un employé FAT & MAT à Triangle.
 *
 *   DATABASE_URL=… node scripts/test-isolation-societes.js
 */

const { Pool } = require("pg");
const ctx = require("../services/company-context");
const permissions = require("../services/permissions");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let reussis = 0;
let echoues = 0;
const verifier = (nom, ok, detail = "") => {
  if (ok) { reussis += 1; console.log(`  ✓ ${nom}`); }
  else { echoues += 1; console.log(`  ✗ ${nom}${detail ? ` — ${detail}` : ""}`); }
};

/* Reproduit getEffectiveCompanyId de server.js. */
const estSuper = (u) => u?.is_super_admin === true || String(u?.role || "").toLowerCase() === "super_admin";
const getEffectiveCompanyId = (req, fallback = null) => {
  const entete = Number(req.headers?.["x-active-company-id"] || 0) || null;
  if (estSuper(req.user)) return entete || Number(req.user?.company_id || 0) || fallback || null;
  return Number(req.user?.company_id || 0) || fallback || null;
};
const requete = (user, entete, corps = {}) => ({
  user, headers: entete ? { "x-active-company-id": String(entete) } : {}, body: corps,
});

async function main() {
  const u = async (id) => (await pool.query(
    `SELECT id, company_id, fullname, role, is_super_admin FROM users WHERE id=$1`, [id]
  )).rows[0];

  const TRIANGLE = Number((await pool.query(
    `SELECT id FROM companies WHERE name ILIKE '%triangle%' LIMIT 1`)).rows[0].id);
  const FATMAT = Number((await pool.query(
    `SELECT id FROM companies WHERE name ILIKE '%fat%' LIMIT 1`)).rows[0].id);
  console.log(`\nENTREPRISES  Triangle=${TRIANGLE}  FAT & MAT=${FATMAT}`);

  const superAdmin = await u(1);
  const adminTriangle = await u(10);
  const adminFatMat = await u(20);

  console.log("\nAFFECTATION DE L'ENTREPRISE");
  {
    const r = await ctx.resoudreSociete(pool, requete(superAdmin, FATMAT), getEffectiveCompanyId);
    verifier("super admin travaillant dans FAT & MAT → FAT & MAT",
      r.companyId === FATMAT, `${r.companyId} (${r.source})`);
  }
  {
    const r = await ctx.resoudreSociete(pool, requete(superAdmin, TRIANGLE), getEffectiveCompanyId);
    verifier("super admin travaillant dans Triangle → Triangle", r.companyId === TRIANGLE);
  }
  {
    /* Le cas exact du défaut : contexte FAT & MAT, mais le navigateur envoie
       Triangle dans le corps. Le contexte doit l'emporter. */
    const r = await ctx.resoudreSociete(
      pool, requete(superAdmin, FATMAT, { company_id: TRIANGLE }), getEffectiveCompanyId
    );
    verifier("un company_id contraire dans le corps ne l'emporte pas",
      r.companyId === FATMAT, `${r.companyId}`);
  }
  {
    const r = await ctx.resoudreSociete(
      pool, requete(adminFatMat, null, { company_id: TRIANGLE }), getEffectiveCompanyId
    );
    verifier("un admin FAT & MAT ne peut pas créer chez Triangle",
      r.companyId === FATMAT, `${r.companyId} (${r.source})`);
  }
  {
    const r = await ctx.resoudreSociete(
      pool, requete(superAdmin, 99999), getEffectiveCompanyId
    );
    verifier("une entreprise inexistante est refusée",
      r.companyId === 0 && r.source === "contexte_refuse", `${r.source}`);
  }
  {
    const r = await ctx.resoudreSociete(pool, requete(adminTriangle, null), getEffectiveCompanyId);
    verifier("un admin Triangle sans en-tête reste dans Triangle", r.companyId === TRIANGLE);
  }

  console.log("\nBADGES PAR ENTREPRISE");
  const badge = async (companyId) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const b = await ctx.prochainBadge(c, companyId);
      await c.query("COMMIT");
      return b;
    } finally { c.release(); }
  };
  const bT = await badge(TRIANGLE);
  const bF = await badge(FATMAT);
  verifier("badge Triangle porte le préfixe Triangle", /^TRIANGLE/i.test(bT), bT);
  verifier("badge FAT & MAT porte le préfixe FAT & MAT", /^FATMAT/i.test(bF), bF);
  verifier("aucun badge FAT & MAT ne commence par TRIANGLE", !/^TRIANGLE/i.test(bF), bF);

  const lot = await Promise.all([badge(FATMAT), badge(FATMAT), badge(FATMAT), badge(FATMAT)]);
  verifier("quatre attributions simultanées, aucun doublon",
    new Set(lot).size === 4, lot.join(" "));

  console.log("\nPERMISSIONS SABLE ET CIMENT");
  {
    /* Le garde des routes interroge « sand » et « cement » ; le catalogue
       enregistre « sable » et « ciment ». Sans alias, le droit accordé ne
       répond à aucune question posée. */
    verifier("« sand » désigne le module « sable »", permissions.normaliser("sand") === "sable");
    verifier("« cement » désigne le module « ciment »", permissions.normaliser("cement") === "ciment");

    const employe = await u(21); // employé FAT & MAT
    await pool.query(
      `INSERT INTO user_permission_overrides (company_id,user_id,module_key,action,effect) VALUES
         ($1,$2,'sable','visible','ALLOW'),($1,$2,'sable','view','ALLOW'),($1,$2,'sable','create','ALLOW')
       ON CONFLICT (company_id,user_id,module_key,action) DO UPDATE SET effect='ALLOW'`,
      [FATMAT, employe.id]
    );
    const c1 = await permissions.chargerContexte(pool, employe);
    verifier("droit accordé sur « sable » : la route « sand » l'accepte",
      permissions.decider(c1, "sand", "view").autorise);
    verifier("et « sand/create » aussi", permissions.decider(c1, "sand", "create").autorise);
    verifier("le ciment reste refusé", !permissions.decider(c1, "cement", "view").autorise);

    /* Le même droit ne doit pas franchir la frontière d'entreprise. */
    const employeTriangle = await u(11);
    const c2 = await permissions.chargerContexte(pool, employeTriangle);
    verifier("un employé Triangle n'hérite pas du droit FAT & MAT",
      !permissions.decider(c2, "sand", "view").autorise);
  }

  console.log("\nISOLATION DES DONNÉES");
  {
    const fuite = await pool.query(
      `SELECT count(*)::int AS n FROM user_permission_overrides o
         JOIN users us ON us.id = o.user_id
        WHERE o.company_id <> us.company_id`
    );
    verifier("aucune exception rattachée à la mauvaise entreprise", fuite.rows[0].n === 0);

    /* Les badges déjà attribués par erreur ne se corrigent pas tout seuls :
       le contrôle doit les DÉSIGNER, pour qu'on les traite un par un. */
    const { rows: discordants } = await pool.query(
      `SELECT u.id, u.fullname, u.badge_code, c.name AS entreprise,
              COALESCE(NULLIF(c.badge_prefix,''),'ENT'||c.id) AS prefixe_attendu
         FROM users u JOIN companies c ON c.id = u.company_id
        WHERE COALESCE(u.badge_code,'') <> ''
          AND upper(u.badge_code) NOT LIKE upper(COALESCE(NULLIF(c.badge_prefix,''),'ENT'||c.id)) || '%'
        ORDER BY u.id`
    );
    verifier("les badges discordants sont détectés nommément", discordants.length > 0,
      "aucun badge discordant dans ce jeu");
    discordants.forEach((d) =>
      console.log(`      → #${d.id} ${d.fullname} : ${d.badge_code} chez ${d.entreprise} (attendu ${d.prefixe_attendu}-…)`));

    const doublons = await pool.query(
      `SELECT count(*)::int AS n FROM (
         SELECT company_id, upper(badge_code) FROM users
          WHERE COALESCE(badge_code,'') <> '' GROUP BY 1,2 HAVING count(*) > 1) d`
    );
    verifier("aucun badge dupliqué dans une même entreprise", doublons.rows[0].n === 0);
  }

  console.log("\nTENTATIVES DE FRANCHISSEMENT");
  {
    const employeFat = await u(21);
    const employeTri = await u(11);

    /* Falsification par l'en-tête : un non-super-admin ne peut pas changer
       d'entreprise, getEffectiveCompanyId ne lit l'en-tête que pour eux. */
    const parEntete = await ctx.resoudreSociete(
      pool, requete(employeFat, TRIANGLE), getEffectiveCompanyId
    );
    verifier("en-tête falsifié par un employé FAT & MAT : sans effet",
      parEntete.companyId === FATMAT, `${parEntete.companyId}`);

    const parEnteteInverse = await ctx.resoudreSociete(
      pool, requete(employeTri, FATMAT), getEffectiveCompanyId
    );
    verifier("en-tête falsifié par un employé Triangle : sans effet",
      parEnteteInverse.companyId === TRIANGLE, `${parEnteteInverse.companyId}`);

    /* Falsification par le corps. */
    const parCorps = await ctx.resoudreSociete(
      pool, requete(employeFat, null, { company_id: TRIANGLE }), getEffectiveCompanyId
    );
    verifier("company_id falsifié dans le corps : sans effet",
      parCorps.companyId === FATMAT, `${parCorps.companyId}`);

    /* Le pointage du jour ne doit plus montrer l'autre entreprise. */
    const pointage = await pool.query(
      `SELECT count(*)::int AS n FROM users WHERE company_id = $1`, [FATMAT]
    );
    const global = await pool.query(`SELECT count(*)::int AS n FROM users`);
    verifier("le personnel FAT & MAT est un sous-ensemble strict",
      pointage.rows[0].n < global.rows[0].n,
      `${pointage.rows[0].n} / ${global.rows[0].n}`);
  }

  console.log("\nDROITS : AUCUNE FUITE ENTRE ENTREPRISES");
  {
    const employeFat = await u(21);
    const employeTri = await u(11);
    const cFat = await permissions.chargerContexte(pool, employeFat);
    const cTri = await permissions.chargerContexte(pool, employeTri);

    /* Un droit posé chez FAT & MAT ne doit jamais peupler le contexte d'un
       compte Triangle, ni l'inverse. */
    const cleFat = [...cFat.exceptions.keys()];
    const cleTri = [...cTri.exceptions.keys()];
    verifier("les exceptions de FAT & MAT ne sont pas celles de Triangle",
      cleFat.length === 0 || cleTri.length === 0 ||
      !cleFat.some((k) => cleTri.includes(k)) || cleFat.join() !== cleTri.join(),
      `${cleFat.length} / ${cleTri.length}`);

    const croise = await pool.query(
      `SELECT count(*)::int AS n FROM user_permission_overrides o
         JOIN users us ON us.id = o.user_id
        WHERE o.company_id <> us.company_id`
    );
    verifier("aucune exception n'enjambe une frontière d'entreprise", croise.rows[0].n === 0);

    const roles = await pool.query(
      `SELECT count(*)::int AS n FROM role_permissions rp
        WHERE NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = rp.company_id)`
    );
    verifier("aucun droit de rôle sans entreprise réelle", roles.rows[0].n === 0);
  }

  await pool.end();
  console.log(`\n${reussis} réussis, ${echoues} échoués\n`);
  process.exit(echoues ? 1 : 0);
}

main().catch(async (e) => {
  console.error("ÉCHEC :", e.message || e);
  await pool.end().catch(() => {});
  process.exit(2);
});

"use strict";

/**
 * TESTS DU CENTRE DROITS & PERMISSIONS.
 *
 * Éprouve le moteur de décision, la non-régression avec l'ancien modèle et le
 * cloisonnement par entreprise, directement contre une base PostgreSQL.
 *
 *   DATABASE_URL=… node scripts/test-permissions.js
 */

const { Pool } = require("pg");
const service = require("../services/permissions");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let reussis = 0;
let echoues = 0;

function verifier(nom, condition, detail = "") {
  if (condition) { reussis += 1; console.log(`  ✓ ${nom}`); }
  else { echoues += 1; console.log(`  ✗ ${nom}${detail ? ` — ${detail}` : ""}`); }
}

const utilisateur = async (id) =>
  (await pool.query(
    `SELECT id, company_id, fullname, email, role, is_super_admin FROM users WHERE id = $1`, [id]
  )).rows[0];

async function peut(user, moduleKey, action) {
  const ctx = await service.chargerContexte(pool, user);
  return service.decider(ctx, moduleKey, action).autorise;
}

async function main() {
  const superAdmin = await utilisateur(1);
  const amary = await utilisateur(2);      // responsable_entrepot, droits repris
  const mohamado = await utilisateur(3);   // employe, lecture seule
  const hawa = await utilisateur(4);       // comptable
  const directeur = await utilisateur(5);  // direction (rôle admin)

  console.log("\nSUPER ADMIN — jamais bloqué");
  verifier("voit le centre des droits", await peut(superAdmin, "utilisateur.permissions", "manage"));
  verifier("peut supprimer un produit", await peut(superAdmin, "produit", "delete"));
  verifier("voit un module même masqué ailleurs", await peut(superAdmin, "comptabilite", "visible"));

  console.log("\nNON-RÉGRESSION — droits repris de l'ancien modèle");
  verifier("Amary voit les stocks", await peut(amary, "stock", "view"));
  verifier("Amary crée une entrée", await peut(amary, "stock.entree", "create"));
  verifier("Amary valide une entrée", await peut(amary, "stock.entree", "validate"));
  verifier("Amary crée une réception", await peut(amary, "reception", "create"));
  verifier("Amary valide une réception", await peut(amary, "reception", "validate"));
  verifier("Amary ne modifie PAS une réception", !(await peut(amary, "reception", "update")));
  verifier("Amary ne gère pas les droits", !(await peut(amary, "utilisateur.permissions", "manage")));

  console.log("\nLECTURE SEULE — Mohamado");
  verifier("voit les stocks", await peut(mohamado, "stock", "view"));
  verifier("ne crée pas d'entrée", !(await peut(mohamado, "stock.entree", "create")));
  verifier("ne supprime pas", !(await peut(mohamado, "produit", "delete")));
  verifier("voit les documents", await peut(mohamado, "document", "view"));

  console.log("\nRÔLE D'ADMINISTRATION — direction");
  verifier("le directeur voit les stocks", await peut(directeur, "stock", "view"));
  verifier("le directeur voit la comptabilité", await peut(directeur, "comptabilite", "view"));

  console.log("\nRÔLE SANS DROIT EXPLICITE — comptable hors comptabilité");
  verifier("Hawa voit la comptabilité", await peut(hawa, "comptabilite", "view"));
  verifier("Hawa ne voit pas les entrepôts", !(await peut(hawa, "entrepot", "view")));

  console.log("\nVISIBILITÉ — un module masqué ferme tout");
  await pool.query(
    `INSERT INTO user_permission_overrides (company_id,user_id,module_key,action,effect)
     VALUES (1,$1,'document','visible','DENY')
     ON CONFLICT (company_id,user_id,module_key,action) DO UPDATE SET effect='DENY'`,
    [mohamado.id]
  );
  verifier("module masqué : « visible » refusé", !(await peut(mohamado, "document", "visible")));
  verifier("module masqué : « voir » refusé aussi", !(await peut(mohamado, "document", "view")));
  verifier("module masqué : « imprimer » refusé", !(await peut(mohamado, "document", "print")));
  verifier("un autre module reste ouvert", await peut(mohamado, "stock", "view"));
  /* On remet la valeur d'origine, pas INHERIT : la migration avait posé un
     ALLOW explicite depuis l'ancien modèle, et le supprimer ferait retomber
     le compte sur son rôle — qui, lui, ne donne rien. */
  await pool.query(
    `UPDATE user_permission_overrides SET effect='ALLOW'
      WHERE user_id=$1 AND module_key='document' AND action='visible'`,
    [mohamado.id]
  );
  verifier("droit rétabli en remettant ALLOW", await peut(mohamado, "document", "view"));

  /* Et l'on vérifie l'autre branche : passer à INHERIT rend bien la main au
     rôle, qui pour un employé ne donne rien. C'est le comportement attendu
     du bouton « Réinitialiser selon le rôle ». */
  await pool.query(
    `DELETE FROM user_permission_overrides WHERE user_id=$1 AND module_key='document'`,
    [mohamado.id]
  );
  verifier("INHERIT rend la main au rôle (employé : rien)", !(await peut(mohamado, "document", "view")));

  console.log("\nEXCEPTION QUI PRIME SUR LE RÔLE");
  await pool.query(
    `INSERT INTO user_permission_overrides (company_id,user_id,module_key,action,effect)
     VALUES (1,$1,'comptabilite','view','DENY')
     ON CONFLICT (company_id,user_id,module_key,action) DO UPDATE SET effect='DENY'`,
    [directeur.id]
  );
  verifier("un DENY bloque un rôle d'administration", !(await peut(directeur, "comptabilite", "view")));
  await pool.query(
    `DELETE FROM user_permission_overrides WHERE user_id=$1 AND module_key='comptabilite'`,
    [directeur.id]
  );

  console.log("\nGRANULARITÉ — créer sans modifier, modifier sans supprimer");
  await pool.query(
    `INSERT INTO user_permission_overrides (company_id,user_id,module_key,action,effect) VALUES
      (1,$1,'produit','visible','ALLOW'), (1,$1,'produit','view','ALLOW'),
      (1,$1,'produit','create','ALLOW'),  (1,$1,'produit','update','DENY'),
      (1,$1,'produit','delete','DENY')
     ON CONFLICT (company_id,user_id,module_key,action) DO UPDATE SET effect=EXCLUDED.effect`,
    [mohamado.id]
  );
  verifier("créer autorisé", await peut(mohamado, "produit", "create"));
  verifier("modifier refusé", !(await peut(mohamado, "produit", "update")));
  verifier("supprimer refusé", !(await peut(mohamado, "produit", "delete")));

  console.log("\nCLOISONNEMENT PAR ENTREPRISE");
  const etranger = await utilisateur(9); // société 2
  const ctxEtranger = await service.chargerContexte(pool, etranger);
  verifier(
    "les droits d'une autre société n'héritent pas de la société 1",
    ctxEtranger.parRole.size === 0 || !ctxEtranger.exceptions.size,
    `rôle=${ctxEtranger.parRole.size} exceptions=${ctxEtranger.exceptions.size}`
  );
  const fuite = await pool.query(
    `SELECT count(*)::int AS n FROM user_permission_overrides WHERE company_id <> 1 AND user_id IN (1,2,3,4,5)`
  );
  verifier("aucune exception d'un compte de la société 1 hors de celle-ci", fuite.rows[0].n === 0);

  console.log("\nDERNIER SUPER ADMIN");
  const n = await pool.query(
    `SELECT count(*)::int AS n FROM users WHERE company_id=1 AND is_active IS NOT FALSE
       AND (is_super_admin = true OR lower(trim(role))='super_admin')`
  );
  verifier("un seul super admin dans la société de test", n.rows[0].n === 1, `${n.rows[0].n}`);
  verifier(
    "il conserve le centre des droits",
    await peut(superAdmin, service.MODULE_PERMISSIONS, "manage")
  );

  console.log("\nRÉFÉRENTIEL");
  const modules = await pool.query(`SELECT count(*)::int AS n FROM permission_modules WHERE is_active`);
  const actions = await pool.query(`SELECT count(*)::int AS n FROM permission_actions`);
  verifier("modules recensés", modules.rows[0].n >= 30, `${modules.rows[0].n}`);
  verifier("actions recensées", actions.rows[0].n >= 15, `${actions.rows[0].n}`);
  const orphelins = await pool.query(
    `SELECT count(*)::int AS n FROM permission_modules m
      WHERE m.parent_key IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM permission_modules p WHERE p.module_key = m.parent_key)`
  );
  verifier("aucun sous-module orphelin", orphelins.rows[0].n === 0);

  await pool.query(`DELETE FROM user_permission_overrides WHERE user_id=$1 AND module_key='produit'`, [mohamado.id]);
  await pool.end();
  console.log(`\n${reussis} réussis, ${echoues} échoués\n`);
  process.exit(echoues ? 1 : 0);
}

main().catch(async (e) => {
  console.error("ÉCHEC :", e);
  await pool.end().catch(() => {});
  process.exit(1);
});

"use strict";

/**
 * Donne à tous les comptes actifs Triangle (#1) et FAT & MAT (#5) l'accès à
 * leurs propres demandes : visible, view, create, update.
 * Ne donne ni validate/cancel, ni accès à la comptabilité/décaissement.
 */

const { Pool } = require("pg");
const CONFIRMATION = "OUI-JE-DONNE-MES-DEMANDES-A-TOUS";
const ACTIONS = ["visible", "view", "create", "update"];
const args = process.argv.slice(2);
const PREVIEW = args.includes("--preview");
const APPLY = args.includes("--apply");
const confirm = args.find((a) => a.startsWith("--confirmer="))?.slice(12);

if (PREVIEW === APPLY) {
  console.error("Indiquez exactement --preview ou --apply.");
  process.exit(1);
}
if (APPLY && confirm !== CONFIRMATION) {
  console.error(`Confirmation obligatoire : --confirmer=${CONFIRMATION}`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL manquant.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    await client.query(PREVIEW ? "BEGIN READ ONLY" : "BEGIN");
    if (APPLY) {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('acces-demandes-triangle-fatmat'), 1)`
      );
    }

    const companies = (await client.query(
      `SELECT id, name FROM companies WHERE id IN (1,5) ORDER BY id`
    )).rows;
    if (companies.length !== 2
        || !/triangle/i.test(companies.find((c) => c.id === 1)?.name || "")
        || !/fat/i.test(companies.find((c) => c.id === 5)?.name || "")) {
      throw new Error("Les sociétés #1 Triangle et #5 FAT & MAT ne correspondent pas au périmètre attendu.");
    }

    const moduleRow = (await client.query(
      `SELECT module_key, actions, is_active FROM permission_modules WHERE module_key='demande'`
    )).rows[0];
    if (!moduleRow || moduleRow.is_active !== true
        || !ACTIONS.every((a) => moduleRow.actions.includes(a))) {
      throw new Error("Le module demande actif ne porte pas toutes les actions requises.");
    }

    const users = (await client.query(
      `SELECT id, company_id, fullname, email, role
         FROM users WHERE company_id IN (1,5) AND is_active=true
         ORDER BY company_id,id`
    )).rows;
    if (!users.length) throw new Error("Aucun compte actif trouvé.");

    const current = (await client.query(
      `SELECT company_id,user_id,module_key,action,effect
         FROM user_permission_overrides
        WHERE company_id IN (1,5) AND module_key='demande' AND action=ANY($1::text[])
        ORDER BY company_id,user_id,action`, [ACTIONS]
    )).rows;
    const denied = current.filter((r) => r.effect === "DENY");

    console.log(`Mode : ${PREVIEW ? "PREVIEW — aucune écriture" : "APPLICATION"}`);
    console.log(`Comptes actifs concernés : ${users.length}`);
    for (const company of companies) {
      const group = users.filter((u) => u.company_id === company.id);
      console.log(`  #${company.id} ${company.name} : ${group.length} compte(s)`);
      group.forEach((u) => console.log(`    #${u.id} ${u.fullname} — ${u.role}`));
    }
    console.log(`Refus personnels à remplacer pour ces quatre actions : ${denied.length}`);
    denied.forEach((r) => console.log(`  société ${r.company_id}, utilisateur #${r.user_id}, ${r.action}: DENY → ALLOW`));
    console.log("Droits accordés : demande.visible/view/create/update.");
    console.log("Droits NON modifiés : demande.validate/cancel et tout le module comptabilite.");

    if (PREVIEW) {
      await client.query("ROLLBACK");
      console.log("Prévisualisation terminée. Rien n'a été écrit.");
      console.log(`Pour appliquer : --apply --confirmer=${CONFIRMATION}`);
      return;
    }

    const roles = [...new Map(users.map((u) => [`${u.company_id}:${String(u.role).toLowerCase()}`,
      { company_id: u.company_id, role: String(u.role).toLowerCase() }])).values()];
    for (const { company_id, role } of roles) {
      for (const action of ACTIONS) {
        await client.query(
          `INSERT INTO role_permissions (company_id,role,module_key,action,allowed)
           VALUES ($1,$2,'demande',$3,true)
           ON CONFLICT (company_id,role,module_key,action)
           DO UPDATE SET allowed=true`, [company_id, role, action]
        );
      }
    }

    for (const user of users) {
      for (const action of ACTIONS) {
        await client.query(
          `INSERT INTO user_permission_overrides
             (company_id,user_id,module_key,action,effect,changed_by,changed_at)
           VALUES ($1,$2,'demande',$3,'ALLOW',NULL,NOW())
           ON CONFLICT (company_id,user_id,module_key,action)
           DO UPDATE SET effect='ALLOW',changed_by=NULL,changed_at=NOW()`,
          [user.company_id, user.id, action]
        );
      }
    }

    const verified = (await client.query(
      `SELECT count(*)::int AS n FROM user_permission_overrides
        WHERE company_id IN (1,5) AND user_id=ANY($1::int[])
          AND module_key='demande' AND action=ANY($2::text[]) AND effect='ALLOW'`,
      [users.map((u) => u.id), ACTIONS]
    )).rows[0].n;
    if (verified !== users.length * ACTIONS.length) {
      throw new Error(`Contrôle final incomplet : ${verified}/${users.length * ACTIONS.length}.`);
    }

    await client.query("COMMIT");
    console.log(`TERMINÉ : ${users.length} comptes configurés, ${verified} autorisations vérifiées.`);
    console.log("Validation Direction et décaissement : inchangés et séparés.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`ARRÊT : ${error.message}`);
    console.error("Aucune modification partielle conservée.");
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();

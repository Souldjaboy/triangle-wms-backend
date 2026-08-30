"use strict";

/**
 * RATTACHER UN COMPTE À LA BONNE ENTREPRISE.
 *
 * Un employé créé depuis FAT & MAT s'est retrouvé chez Triangle avec un badge
 * Triangle. La cause est corrigée pour l'avenir ; ce script répare le compte
 * déjà créé.
 *
 * Il ne corrige personne au nom : le nom sert à CHERCHER, l'identifiant à
 * AGIR. S'il trouve zéro ou plusieurs candidats, il s'arrête et les affiche —
 * déplacer le mauvais compte serait pire que ne rien faire.
 *
 *   # 1. chercher, sans rien écrire
 *   DATABASE_URL=… node scripts/corriger-rattachement-utilisateur.js \
 *       --nom="Jules" --vers="FAT"
 *
 *   # 2. simuler, avec l'identifiant relevé à l'étape 1
 *   DATABASE_URL=… node scripts/corriger-rattachement-utilisateur.js \
 *       --user-id=42 --target-company-id=2
 *
 *   # 3. appliquer — l'identifiant et la confirmation sont exigés
 *   DATABASE_URL=… node scripts/corriger-rattachement-utilisateur.js \
 *       --user-id=42 --target-company-id=2 --executer --je-confirme
 */

const { Pool } = require("pg");
const ctx = require("../services/company-context");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const arg = (nom, defaut = "") => {
  const t = process.argv.find((a) => a.startsWith(`--${nom}=`));
  return t ? t.split("=").slice(1).join("=") : defaut;
};
const EXECUTER = process.argv.includes("--executer");
const CONFIRME = process.argv.includes("--je-confirme");

const CHAMPS = `id, company_id, fullname, email, phone, role, badge_code,
                is_super_admin, is_active, created_at`;

async function main() {
  const nom = arg("nom");
  /* `--user-id` est la forme demandée ; `--id` reste acceptée. */
  const idDemande = Number(arg("user-id", arg("id", "0")));
  const societeCible = Number(arg("target-company-id", "0"));
  const vers = arg("vers");

  if (!nom && !idDemande) throw new Error("Indiquez --nom=… pour chercher, ou --user-id=… pour agir.");
  if (!vers && !societeCible) {
    throw new Error("Indiquez --target-company-id=… ou --vers=… pour désigner l'entreprise cible.");
  }
  /* Un nom n'identifie personne : deux employés peuvent le partager, et se
     tromper de compte est pire que ne rien faire. En application réelle,
     l'identifiant est obligatoire. */
  if (EXECUTER && !idDemande) {
    throw new Error(
      "Le mode --executer exige --user-id=<identifiant>. Lancez d'abord la recherche par nom, " +
      "relevez l'identifiant affiché, puis relancez avec lui."
    );
  }
  if (EXECUTER && !CONFIRME) {
    throw new Error(
      "Ajoutez --je-confirme pour appliquer. Sans cette confirmation explicite, rien n'est écrit."
    );
  }

  /* ── Entreprise cible ── */
  const { rows: societes } = societeCible
    ? await pool.query(
        `SELECT id, name, badge_prefix FROM companies
          WHERE id = $1 AND COALESCE(status,'active') <> 'deleted'`,
        [societeCible]
      )
    : await pool.query(
        `SELECT id, name, badge_prefix FROM companies
          WHERE name ILIKE '%' || $1 || '%' AND COALESCE(status,'active') <> 'deleted'
          ORDER BY id`,
        [vers]
      );
  if (societes.length !== 1) {
    console.log(`\n« ${societeCible || vers} » désigne ${societes.length} entreprise(s) :`);
    societes.forEach((c) => console.log(`  #${c.id} ${c.name}`));
    throw new Error("Précisez --target-company-id= pour ne désigner qu'une seule entreprise.");
  }
  const cible = societes[0];
  console.log(`\nENTREPRISE CIBLE  #${cible.id} ${cible.name}  (préfixe ${cible.badge_prefix || "—"})`);

  /* ── Candidats ── */
  const { rows: candidats } = idDemande
    ? await pool.query(`SELECT ${CHAMPS} FROM users WHERE id = $1`, [idDemande])
    : await pool.query(
        `SELECT ${CHAMPS} FROM users
          WHERE fullname ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%'
          ORDER BY id`,
        [nom]
      );

  console.log(`\nCANDIDATS (${candidats.length})`);
  for (const u of candidats) {
    const soc = (await pool.query(`SELECT name FROM companies WHERE id=$1`, [u.company_id])).rows[0];
    console.log(
      `  #${u.id}  ${u.fullname}\n` +
      `     email    ${u.email || "—"}\n` +
      `     tél.     ${u.phone || "—"}\n` +
      `     rôle     ${u.role || "—"}${u.is_super_admin ? "  (super admin)" : ""}\n` +
      `     badge    ${u.badge_code || "—"}\n` +
      `     société  #${u.company_id || "—"} ${soc?.name || "—"}\n` +
      `     créé le  ${u.created_at ? new Date(u.created_at).toLocaleString("fr-FR") : "—"}\n` +
      `     actif    ${u.is_active === false ? "non" : "oui"}`
    );
  }

  if (candidats.length !== 1) {
    throw new Error(
      candidats.length === 0
        ? "Aucun candidat : rien à corriger."
        : "Plusieurs candidats : relancez avec --user-id=<identifiant> pour désigner celui-ci et pas un autre."
    );
  }
  const u = candidats[0];

  if (!idDemande) {
    console.log(
      `\nRecherche seule. Pour appliquer :\n` +
      `  node scripts/corriger-rattachement-utilisateur.js --user-id=${u.id} ` +
      `--target-company-id=${cible.id}\n`
    );
    return;
  }
  if (Number(u.company_id) === Number(cible.id)) {
    console.log(`\n#${u.id} appartient déjà à ${cible.name}. Rien à faire.\n`);
    return;
  }

  /* ── Ce qui suit ce compte ── */
  const compte = async (sql) => Number((await pool.query(sql, [u.id])).rows[0]?.n || 0);
  const attaches = {
    exceptions: await compte(`SELECT count(*)::int AS n FROM user_permission_overrides WHERE user_id=$1`),
    permissions: await compte(`SELECT count(*)::int AS n FROM user_permissions WHERE user_id=$1`),
  };
  console.log(`\nRATTACHEMENTS  ${attaches.exceptions} exception(s), ${attaches.permissions} permission(s) historique(s)`);

  const socOrigine = (await pool.query(
    `SELECT name FROM companies WHERE id = $1`, [u.company_id]
  )).rows[0]?.name || "—";

  if (!EXECUTER) {
    const prochain = String(Number(
      (await pool.query(`SELECT badge_sequence FROM companies WHERE id=$1`, [cible.id]))
        .rows[0]?.badge_sequence || 0
    ) + 1).padStart(3, "0");
    console.log(
      `\nSIMULATION — aucune écriture.\n` +
      `  entreprise source : #${u.company_id} ${socOrigine}\n` +
      `  entreprise cible  : #${cible.id} ${cible.name}\n` +
      `  badge avant       : ${u.badge_code || "—"}\n` +
      `  badge proposé     : ${cible.badge_prefix || "ENT" + cible.id}-EMP-${prochain}\n` +
      `  rôle              : ${u.role || "—"} → inchangé\n` +
      `  exceptions        : ${attaches.exceptions} → suivront le compte\n` +
      `  mot de passe, email et téléphone : inchangés\n` +
      `Pour appliquer :\n` +
      `  node scripts/corriger-rattachement-utilisateur.js --user-id=${u.id} ` +
      `--target-company-id=${cible.id} --executer --je-confirme\n`
    );
    return;
  }

  /* ── Application ── */
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const badge = await ctx.prochainBadge(client, cible.id);

    const { rows: apres } = await client.query(
      `UPDATE users SET company_id = $1, badge_code = $2 WHERE id = $3
       RETURNING ${CHAMPS}`,
      [cible.id, badge, u.id]
    );

    /* Les exceptions de droits portent l'entreprise : elles doivent suivre,
       sinon le compte garderait des droits rattachés à son ancienne société
       et le moteur ne les verrait plus. */
    const { rowCount: deplacees } = await client.query(
      `UPDATE user_permission_overrides SET company_id = $1 WHERE user_id = $2`,
      [cible.id, u.id]
    );

    await client.query(
      `INSERT INTO permission_audit_log
         (company_id, target_user_id, target_role, module_key, action,
          old_value, new_value, origin, changed_by_name)
       VALUES ($1,$2,$3,'utilisateur','company',$4,$5,'manual',$6)`,
      [cible.id, u.id, u.role,
       `company_id=${u.company_id}, badge=${u.badge_code || "—"}`,
       `company_id=${cible.id}, badge=${badge}`,
       `correction de rattachement (${new Date().toISOString()})`]
    );

    /* Vérification dans la même transaction : si quelque chose ne concorde
       pas, on annule plutôt que de constater après coup. */
    const apresUser = apres[0];
    if (Number(apresUser.company_id) !== Number(cible.id)) {
      throw new Error("L'entreprise n'a pas été appliquée : annulation.");
    }
    if (apresUser.role !== u.role) {
      throw new Error("Le rôle a changé, ce qui n'était pas demandé : annulation.");
    }
    const { rows: verif } = await client.query(
      `SELECT count(*)::int AS n FROM user_permission_overrides
        WHERE user_id = $1 AND company_id <> $2`, [u.id, cible.id]
    );
    if (verif[0].n > 0) {
      throw new Error(`${verif[0].n} exception(s) sont restées sur l'ancienne entreprise : annulation.`);
    }

    await client.query("COMMIT");

    const { rows: apresExceptions } = await pool.query(
      `SELECT count(*)::int AS n FROM user_permission_overrides WHERE user_id = $1`, [u.id]
    );
    console.log(
      `\nAVANT   société #${u.company_id} (${socOrigine})\n` +
      `        badge ${u.badge_code || "—"} · rôle ${u.role || "—"}\n` +
      `        ${attaches.exceptions} exception(s) de droits\n` +
      `APRÈS   société #${apresUser.company_id} (${cible.name})\n` +
      `        badge ${apresUser.badge_code} · rôle ${apresUser.role || "—"}\n` +
      `        ${apresExceptions[0].n} exception(s), dont ${deplacees} déplacée(s)\n` +
      `        mot de passe, email et téléphone inchangés\n` +
      `        correction journalisée et vérifiée avant validation\n`
    );
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

main()
  .then(() => pool.end())
  .catch(async (e) => {
    console.error(`\nARRÊT : ${e.message}\n`);
    await pool.end().catch(() => {});
    process.exit(1);
  });

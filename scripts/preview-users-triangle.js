"use strict";

/**
 * PREVIEW DES UTILISATEURS TRIANGLE — LECTURE SEULE.
 *
 * Ce script ne contient QUE des SELECT. Aucun UPDATE, aucun DELETE, aucun
 * changement de rôle, aucun email envoyé. Il produit le tableau avant/après
 * demandé (B9) à partir des comptes RÉELS, et n'applique rien.
 *
 *   node scripts/preview-users-triangle.js --company=<triangle_id>
 *
 * Aucun mot de passe ni hash n'est lu, affiché ni journalisé.
 */

require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const arg = (name, def = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
};

/* Cibles validées par le propriétaire. Le rapprochement se fait par BADGE :
   c'est l'identifiant stable de l'employé. Jamais par nom — deux personnes
   peuvent porter le même, et un nom n'identifie personne de façon fiable. */
const CIBLES = [
  { badge: "TRIANGLE-EMP-28", email: "souldiallo@triangletli.com",   role: null,          verifier: true },
  { badge: "TRIANGLE-EMP-27", email: "awadiarra@triangletli.com",    role: null,          verifier: true },
  { badge: "TRIANGLE-EMP-25", email: "mohdiallo@triangletli.com",    role: null,          verifier: true },
  { badge: "TRIANGLE-EMP-23", email: "amazerbo@triangletli.com",     role: null,          verifier: true },
  /* Décision confirmée par le propriétaire : comptable -> super_admin.
     Le script ne l'APPLIQUE toujours pas — il ne fait que la présenter. */
  { badge: "TRIANGLE-EMP-24", email: null, role: "super_admin", verifier: true },
  /* Retrait d'accès Triangle, jamais suppression : l'historique reste (B6). */
  { badge: "TRIANGLE-EMP-22", email: null, role: null, verifier: false, retirer: true },
];

const T = (v, w) => String(v ?? "—").slice(0, w).padEnd(w);

async function main() {
  const companyId = Number(arg("company"));
  if (!companyId) {
    console.error("Usage : node scripts/preview-users-triangle.js --company=<triangle_id>");
    process.exit(1);
  }

  console.log("═".repeat(78));
  console.log("PREVIEW UTILISATEURS TRIANGLE — LECTURE SEULE, AUCUNE ÉCRITURE");
  console.log("═".repeat(78));

  const users = (await pool.query(
    `SELECT u.id, u.fullname, u.email, u.role, u.badge_code, u.company_id, u.tenant_id,
            u.is_active, u.email_verified, u.verification_required, u.account_status,
            u.verification_status, u.created_at, u.updated_at,
            c.name AS company_name
       FROM users u LEFT JOIN companies c ON c.id = u.company_id
      WHERE u.company_id = $1
         OR u.badge_code = ANY($2::text[])
      ORDER BY u.badge_code NULLS LAST, u.id`,
    [companyId, CIBLES.map((c) => c.badge)]
  )).rows;

  if (!users.length) {
    console.log("\n  Aucun utilisateur trouvé pour cette entreprise.");
    await pool.end();
    return;
  }

  console.log("\n── ÉTAT ACTUEL EN BASE ──\n");
  console.log(`  ${T("ID", 5)}${T("NOM", 22)}${T("EMAIL", 30)}${T("RÔLE", 20)}${T("BADGE", 18)}${T("ENTREPRISE", 18)}${T("VÉRIFIÉ", 8)}`);
  console.log("  " + "─".repeat(119));
  users.forEach((u) => console.log(
    `  ${T(u.id, 5)}${T(u.fullname, 22)}${T(u.email, 30)}${T(u.role, 20)}${T(u.badge_code, 18)}` +
    `${T(`${u.company_id} ${u.company_name || ""}`, 18)}${T(u.email_verified ? "oui" : "non", 8)}`));

  console.log("\n── ACTIONS PROPOSÉES (aucune appliquée) ──\n");
  console.log(`  ${T("NOM", 22)}${T("BADGE", 18)}${T("EMAIL ACTUEL", 30)}${T("EMAIL CIBLE", 30)}${T("RÔLE→CIBLE", 26)}${T("ACTION", 30)}`);
  console.log("  " + "─".repeat(156));

  const plan = [];
  for (const u of users) {
    const cible = CIBLES.find((c) => c.badge === u.badge_code);
    const actions = [];
    let emailCible = null, roleCible = null;

    if (!cible) {
      /* Compte non listé par le propriétaire : on ne touche à rien et on le
         signale, plutôt que de décider à sa place. */
      actions.push(u.company_id === companyId ? "KEEP" : "KEEP_HAFIYA");
    } else {
      if (cible.retirer) {
        actions.push("REMOVE_TRIANGLE_ACCESS");
      } else {
        if (cible.email && String(u.email || "").toLowerCase() !== cible.email.toLowerCase()) {
          emailCible = cible.email;
          actions.push("UPDATE_EMAIL");
        }
        if (cible.verifier && (!u.email_verified || u.verification_required)) {
          actions.push("VERIFY_EMAIL");
        }
        if (cible.role && u.role !== cible.role) {
          roleCible = cible.role;
          actions.push(cible.confirmation ? "CHANGE_ROLE_PENDING_CONFIRMATION" : "CHANGE_ROLE");
        }
        if (!actions.length) actions.push("KEEP");
      }
    }

    /* L'index unique users_email_key est GLOBAL : un email déjà pris ailleurs
       fait échouer l'UPDATE, quel que soit le tenant. On le détecte ici. */
    if (emailCible) {
      const conflit = (await pool.query(
        `SELECT id, company_id, badge_code FROM users WHERE LOWER(email) = LOWER($1) AND id <> $2`,
        [emailCible, u.id]
      )).rows[0];
      if (conflit) {
        actions.length = 0;
        actions.push(`TO_REVIEW — email déjà utilisé par user ${conflit.id} (${conflit.badge_code || "sans badge"})`);
      }
    }

    plan.push({ user: u, emailCible, roleCible, actions });
    console.log(
      `  ${T(u.fullname, 22)}${T(u.badge_code, 18)}${T(u.email, 30)}${T(emailCible || "inchangé", 30)}` +
      `${T(`${u.role}${roleCible ? " → " + roleCible : ""}`, 26)}${T(actions.join(" + "), 30)}`);
  }

  // ------------------------------------------------- impact d'un retrait d'accès
  const aRetirer = plan.filter((p) => p.actions.includes("REMOVE_TRIANGLE_ACCESS"));
  if (aRetirer.length) {
    console.log("\n── IMPACT D'UN RETRAIT D'ACCÈS (historique à préserver) ──\n");
    for (const { user } of aRetirer) {
      const refs = {};
      for (const [table, col] of [
        ["stock_movements", "created_by"], ["stock_movements", "validated_by"],
        ["stock_receptions", "created_by"], ["stock_putaways", "created_by"],
        ["stock_documents", "generated_by"], ["stock_documents", "validated_by"],
        ["inventory_history", "user_name"],
      ]) {
        try {
          const q = col === "user_name"
            ? `SELECT COUNT(*)::int AS n FROM ${table} WHERE user_name = $1`
            : `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${col} = $1`;
          const { rows } = await pool.query(q, [col === "user_name" ? user.fullname : user.id]);
          if (rows[0].n > 0) refs[`${table}.${col}`] = rows[0].n;
        } catch { /* table absente : sans objet */ }
      }
      const total = Object.values(refs).reduce((a, b) => a + b, 0);
      console.log(`  ${user.fullname} (${user.badge_code}) — ${total} référence(s) historiques`);
      Object.entries(refs).forEach(([k, v]) => console.log(`    ${k.padEnd(34)} ${v}`));
      console.log(total > 0
        ? "    → SUPPRESSION INTERDITE. Retirer l'accès (is_active=false / company_id) sans effacer les lignes."
        : "    → aucune référence : l'archivage reste malgré tout préférable à la suppression.");

      const autres = (await pool.query(
        `SELECT id, company_id, badge_code, role FROM users
          WHERE LOWER(email) = LOWER($1) AND id <> $2`, [user.email, user.id]
      )).rows;
      console.log(autres.length
        ? `    → autre(s) compte(s) même email : ${autres.map((a) => `${a.id}/${a.badge_code}`).join(", ")} — ne pas y toucher`
        : "    → aucun autre compte avec cet email : PAS de compte HAFIYA séparé, décision humaine requise");
    }
  }

  console.log("\n" + "═".repeat(78));
  console.log("Aucun utilisateur modifié. Aucun rôle changé. Aucun email envoyé.");
  console.log("═".repeat(78));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

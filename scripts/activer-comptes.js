"use strict";

/**
 * ACTIVATION DE COMPTES NOMMÉMENT DÉSIGNÉS.
 *
 *   node scripts/activer-comptes.js --company=1 --noms="Mohamado,Hawa"          (lecture seule)
 *   node scripts/activer-comptes.js --company=1 --noms="Mohamado,Hawa" --appliquer
 *
 * Sans --appliquer, RIEN n'est écrit : le script se contente d'afficher l'état.
 *
 * Ce qu'il modifie, et rien d'autre :
 *   is_active = TRUE, email_verified = TRUE, verification_required = FALSE,
 *   verification_status = 'verified', account_status = 'active',
 *   verified_at = NOW() si absent.
 *
 * Ce qu'il ne touche JAMAIS : rôle, email, mot de passe, badge, entreprise,
 * permissions, modules. Aucun mot de passe ni hash n'est lu ni affiché.
 *
 * Si un nom correspond à PLUSIEURS comptes, le script s'arrête sans rien
 * écrire et affiche les candidats : deux homonymes ne se devinent pas.
 */

require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const arg = (name, def = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
};
const T = (v, w) => String(v ?? "—").slice(0, w).padEnd(w);

/* Colonnes lues et affichées. Aucune colonne de secret n'y figure. */
const CHAMPS = `id, fullname, email, phone, role, badge_code, company_id,
                is_active, email_verified, verification_required,
                verification_status, account_status, verified_at`;

const LIGNES = [
  ["id", 6], ["fullname", 24], ["email", 30], ["role", 16],
  ["is_active", 10], ["email_verified", 15], ["verification_required", 21],
  ["verification_status", 19], ["account_status", 15], ["verified_at", 12],
];

const afficher = (titre, users) => {
  console.log(`\n  ${titre}`);
  console.log(`  ${LIGNES.map(([k, w]) => T(k.toUpperCase(), w)).join("")}`);
  console.log("  " + "─".repeat(LIGNES.reduce((s, [, w]) => s + w, 0)));
  users.forEach((u) => console.log("  " + LIGNES.map(([k, w]) => {
    const v = u[k];
    if (k === "verified_at") return T(v ? new Date(v).toLocaleDateString("fr-FR") : "—", w);
    if (typeof v === "boolean") return T(v ? "oui" : "non", w);
    return T(v, w);
  }).join("")));
};

async function main() {
  const companyId = Number(arg("company"));
  const noms = String(arg("noms", "")).split(",").map((s) => s.trim()).filter(Boolean);
  const appliquer = process.argv.includes("--appliquer");
  if (!companyId || !noms.length) {
    console.error('Usage : node scripts/activer-comptes.js --company=1 --noms="Mohamado,Hawa" [--appliquer]');
    process.exit(1);
  }

  console.log("═".repeat(80));
  console.log(`ACTIVATION DE COMPTES — ${appliquer ? "APPLICATION" : "LECTURE SEULE"}`);
  console.log(`entreprise ${companyId} · noms recherchés : ${noms.join(", ")}`);
  console.log("═".repeat(80));

  const entreprise = (await pool.query("SELECT id, name FROM companies WHERE id=$1", [companyId])).rows[0];
  if (!entreprise) {
    console.error(`\nEntreprise ${companyId} introuvable. Aucune écriture.`);
    process.exit(1);
  }
  console.log(`\nEntreprise : ${entreprise.name}`);

  /* Un nom est cherché SANS accents ni casse, mais bien dans la seule
     entreprise demandée : un homonyme d'un autre tenant n'est pas un candidat. */
  const cibles = [];
  let ambigu = false;
  for (const nom of noms) {
    const { rows } = await pool.query(
      `SELECT ${CHAMPS} FROM users
        WHERE company_id = $1
          AND UNACCENT(LOWER(fullname)) LIKE UNACCENT(LOWER($2))
        ORDER BY id`,
      [companyId, `%${nom}%`]
    ).catch(async () => pool.query(
      /* UNACCENT peut ne pas être installé : repli sans normalisation. */
      `SELECT ${CHAMPS} FROM users
        WHERE company_id = $1 AND LOWER(fullname) LIKE LOWER($2) ORDER BY id`,
      [companyId, `%${nom}%`]
    ));

    if (rows.length === 0) {
      console.log(`\n  « ${nom} » : AUCUN compte trouvé dans cette entreprise.`);
      ambigu = true;
    } else if (rows.length > 1) {
      console.log(`\n  « ${nom} » : ${rows.length} comptes correspondent — AMBIGU.`);
      afficher(`Candidats pour « ${nom} »`, rows);
      ambigu = true;
    } else {
      cibles.push({ nom, avant: rows[0] });
    }
  }

  if (cibles.length) afficher("AVANT", cibles.map((c) => c.avant));

  if (ambigu) {
    console.log("\n" + "═".repeat(80));
    console.log("STOP — au moins un nom est ambigu ou introuvable.");
    console.log("Aucune écriture n'a eu lieu. Précisez l'identifiant du compte voulu.");
    console.log("═".repeat(80));
    await pool.end();
    process.exit(1);
  }

  if (!appliquer) {
    console.log("\n" + "═".repeat(80));
    console.log("LECTURE SEULE — aucune écriture. Relancez avec --appliquer pour activer.");
    console.log("Seront modifiés : is_active, email_verified, verification_required,");
    console.log("verification_status, account_status, verified_at.");
    console.log("Ne seront PAS touchés : rôle, email, mot de passe, badge, permissions.");
    console.log("═".repeat(80));
    await pool.end();
    return;
  }

  // ─────────────────────────────────────────────────────────── application
  const client = await pool.connect();
  let apres = [];
  try {
    await client.query("BEGIN");
    for (const c of cibles) {
      /* Chaque UPDATE est borné à l'identifiant ET à l'entreprise : aucun
         autre compte ne peut être atteint, même par erreur. */
      await client.query(
        `UPDATE users
            SET is_active = TRUE,
                email_verified = TRUE,
                verification_required = FALSE,
                verification_status = 'verified',
                account_status = 'active',
                verified_at = COALESCE(verified_at, NOW()),
                updated_at = NOW()
          WHERE id = $1 AND company_id = $2`,
        [c.avant.id, companyId]
      );
    }
    const { rows } = await client.query(
      `SELECT ${CHAMPS} FROM users WHERE id = ANY($1::int[]) AND company_id = $2 ORDER BY id`,
      [cibles.map((c) => c.avant.id), companyId]
    );
    apres = rows;

    /* Garde-fou : rôle, email et badge doivent être STRICTEMENT identiques. */
    for (const c of cibles) {
      const a = apres.find((x) => x.id === c.avant.id);
      for (const champ of ["role", "email", "badge_code", "company_id"]) {
        if (String(a[champ] ?? "") !== String(c.avant[champ] ?? "")) {
          throw new Error(`${champ} modifié pour l'utilisateur ${a.id} — annulation.`);
        }
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`\nÉCHEC : ${e.message}\nAucune modification appliquée.`);
    client.release();
    await pool.end();
    process.exit(1);
  }
  client.release();

  afficher("APRÈS", apres);
  console.log("\n" + "═".repeat(80));
  console.log(`${apres.length} compte(s) activé(s). Rôle, email, mot de passe et permissions inchangés.`);
  console.log("Aucun autre utilisateur n'a été touché.");
  console.log("═".repeat(80));
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });

"use strict";

/**
 * DROITS RÉELS SUR LES PRODUITS ET LES STOCKS.
 *
 * Un employé recevait le droit de créer un produit, d'enregistrer une entrée,
 * une sortie, un transfert — et son écran restait en « Lecture seule ». On
 * vérifie ici que chaque droit accordé produit l'action attendue, et que
 * l'absence de droit continue de refuser.
 *
 *   DATABASE_URL=… node scripts/test-droits-stocks-produits.js
 */

const { Pool } = require("pg");
const p = require("../services/permissions");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let reussis = 0;
let echoues = 0;
const verifier = (nom, ok, detail = "") => {
  if (ok) { reussis += 1; console.log(`  ✓ ${nom}`); }
  else { echoues += 1; console.log(`  ✗ ${nom}${detail ? ` — ${detail}` : ""}`); }
};

const user = async (id) => (await pool.query(
  `SELECT id, company_id, fullname, role, is_super_admin FROM users WHERE id=$1`, [id]
)).rows[0];

async function droits(u) { return p.chargerContexte(pool, u); }
const peut = (ctx, m, a) => p.decider(ctx, m, a).autorise;
const origine = (ctx, m, a) => p.decider(ctx, m, a).source;

async function accorder(companyId, userId, couples, effet = "ALLOW") {
  for (const [m, a] of couples) {
    await pool.query(
      `INSERT INTO user_permission_overrides (company_id,user_id,module_key,action,effect)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (company_id,user_id,module_key,action) DO UPDATE SET effect=EXCLUDED.effect`,
      [companyId, userId, m, a, effet]
    );
  }
}

async function main() {
  const TRIANGLE = 1;
  const employe = await user(3);      // employe Triangle, aucun droit d'écriture
  const superAdmin = await user(1);

  console.log("\nAVANT TOUT DROIT — l'écran doit rester en lecture seule");
  {
    const c = await droits(employe);
    verifier("stock visible", !peut(c, "stock", "create"), "create déjà autorisé ?");
    verifier("aucune création d'entrée", !peut(c, "stock.entree", "create"));
    verifier("aucune création de produit", !peut(c, "produit", "create"));
  }

  console.log("\nDROITS ACCORDÉS — exactement ceux de la mission");
  await accorder(TRIANGLE, employe.id, [
    ["produit", "visible"], ["produit", "view"], ["produit", "create"], ["produit", "update"],
    ["stock", "visible"], ["stock", "view"],
    ["stock.entree", "visible"], ["stock.entree", "view"], ["stock.entree", "create"],
    ["stock.sortie", "visible"], ["stock.sortie", "view"], ["stock.sortie", "create"],
    ["stock.transfert", "visible"], ["stock.transfert", "view"], ["stock.transfert", "transfer"],
    ["stock.emplacement", "visible"], ["stock.emplacement", "view"],
    ["stock.emplacement", "create"], ["stock.emplacement", "update"],
  ]);

  {
    const c = await droits(employe);
    console.log("  — produits —");
    verifier("module produits visible", peut(c, "produit", "visible"));
    verifier("créer un produit", peut(c, "produit", "create"));
    verifier("modifier un produit", peut(c, "produit", "update"));
    verifier("supprimer reste refusé", !peut(c, "produit", "delete"));

    console.log("  — stocks —");
    verifier("module stocks visible", peut(c, "stock", "visible"));
    verifier("consulter les stocks", peut(c, "stock", "view"));
    /* Le cœur du défaut : la page demande can("stock","create"), une action
       que le parent ne déclare pas. La réponse doit venir des sous-modules. */
    verifier("can(stock, create) répond OUI via les sous-modules",
      peut(c, "stock", "create"), `origine ${origine(c, "stock", "create")}`);
    verifier("et l'origine le dit", origine(c, "stock", "create") === "sous_module");
    verifier("→ l'écran n'est donc PAS en lecture seule", peut(c, "stock", "create"));

    console.log("  — mouvements —");
    verifier("enregistrer une entrée", peut(c, "stock.entree", "create"));
    verifier("enregistrer une sortie", peut(c, "stock.sortie", "create"));
    verifier("transférer du stock", peut(c, "stock.transfert", "transfer"));
    verifier("sélectionner les emplacements", peut(c, "stock.emplacement", "view"));
    verifier("créer un emplacement", peut(c, "stock.emplacement", "create"));

    console.log("  — ce qui n'a PAS été accordé reste refusé —");
    verifier("valider une entrée : refusé", !peut(c, "stock.entree", "validate"));
    verifier("annuler une sortie : refusé", !peut(c, "stock.sortie", "cancel"));
    verifier("inventaire : refusé", !peut(c, "stock.inventaire", "create"));
    verifier("imprimer un document : refusé", !peut(c, "document", "print"));
  }

  console.log("\nUN REFUS EXPLICITE PRIME SUR LE DROIT ACCORDÉ");
  await accorder(TRIANGLE, employe.id, [["stock.entree", "create"]], "DENY");
  {
    const c = await droits(employe);
    verifier("l'entrée devient refusée", !peut(c, "stock.entree", "create"));
    verifier("l'origine dit « override »", origine(c, "stock.entree", "create") === "override");
    /* La sortie et le transfert restent accordés : can(stock,create) doit
       donc rester vrai, sans quoi un seul refus rendrait tout l'écran muet. */
    verifier("can(stock, create) reste OUI grâce à la sortie", peut(c, "stock", "create"));
  }
  await accorder(TRIANGLE, employe.id, [["stock.entree", "create"]], "ALLOW");

  console.log("\nLECTURE SEULE VÉRITABLE — seule la consultation accordée");
  const lecteur = await user(4);
  await pool.query(`DELETE FROM user_permission_overrides WHERE user_id=$1`, [lecteur.id]);
  await accorder(TRIANGLE, lecteur.id, [
    ["stock", "visible"], ["stock", "view"],
    ["stock.entree", "visible"], ["stock.entree", "view"],
    ["stock.sortie", "visible"], ["stock.sortie", "view"],
  ]);
  {
    const c = await droits(lecteur);
    verifier("il consulte les stocks", peut(c, "stock", "view"));
    verifier("il ne crée rien", !peut(c, "stock", "create"), `origine ${origine(c, "stock", "create")}`);
    verifier("ni entrée", !peut(c, "stock.entree", "create"));
    verifier("ni sortie", !peut(c, "stock.sortie", "create"));
    verifier("→ l'écran reste bien en lecture seule", !peut(c, "stock", "create"));
  }

  console.log("\nACTIONS DE L'ÉCRAN EMPLACEMENTS");
  {
    const { rows } = await pool.query(
      `SELECT actions FROM permission_modules WHERE module_key='stock.emplacement'`
    );
    const actions = rows[0]?.actions || [];
    verifier("« archiver » existe au catalogue", actions.includes("archive"), actions.join(","));
    verifier("« réorganiser » existe au catalogue", actions.includes("reorganize"));
    const connues = (await pool.query(`SELECT action_key FROM permission_actions`)).rows
      .map((r) => r.action_key);
    verifier("les deux sont des actions déclarées",
      connues.includes("archive") && connues.includes("reorganize"));
  }

  console.log("\nSUPER ADMIN");
  {
    const c = await droits(superAdmin);
    verifier("tout autorisé", peut(c, "stock", "create") && peut(c, "produit", "delete"));
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

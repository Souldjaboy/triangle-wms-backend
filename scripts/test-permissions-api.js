"use strict";

/**
 * TESTS DES ROUTES DU CENTRE DROITS & PERMISSIONS.
 *
 * Monte le routeur sur un Express minimal — pas le serveur entier, dont le
 * démarrage dépend de bien d'autres choses — et l'interroge en HTTP comme le
 * ferait le navigateur, avec de vrais jetons.
 *
 *   DATABASE_URL=… node scripts/test-permissions-api.js
 */

const express = require("express");
const { Pool } = require("pg");
const creerRouteur = require("../routes/permissions");
const service = require("../services/permissions");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = 5399;

let reussis = 0;
let echoues = 0;
const verifier = (nom, ok, detail = "") => {
  if (ok) { reussis += 1; console.log(`  ✓ ${nom}`); }
  else { echoues += 1; console.log(`  ✗ ${nom}${detail ? ` — ${detail}` : ""}`); }
};

/* Authentification simulée : le jeton porte l'identifiant, et l'utilisateur
   est rechargé depuis la base — comme le vrai authenticateToken. */
async function authenticateToken(req, res, next) {
  const id = Number(String(req.headers.authorization || "").replace("Bearer ", "")) || 0;
  if (!id) return res.status(401).json({ error: "Non authentifié." });
  const { rows } = await pool.query(
    `SELECT id, company_id, fullname, email, role, is_super_admin FROM users WHERE id = $1`, [id]
  );
  if (!rows[0]) return res.status(401).json({ error: "Non authentifié." });
  req.user = rows[0];
  next();
}
const getEffectiveCompanyId = (req, fallback) => req.user?.company_id || fallback;

const app = express();
app.use(express.json());
app.use("/", creerRouteur({ pool, authenticateToken, getEffectiveCompanyId }));
const serveur = app.listen(PORT);

const BASE = `http://127.0.0.1:${PORT}`;
async function appel(methode, chemin, jeton, corps) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: {
      "Content-Type": "application/json",
      ...(jeton ? { Authorization: `Bearer ${jeton}` } : {}),
    },
    ...(corps ? { body: JSON.stringify(corps) } : {}),
  });
  return { statut: r.status, corps: await r.json().catch(() => ({})) };
}

const SUPER = 1, AMARY = 2, MOHAMADO = 3, ETRANGER = 9;

async function main() {
  console.log("\nACCÈS AU CENTRE DES DROITS");
  verifier("sans jeton : 401", (await appel("GET", "/permissions/users")).statut === 401);
  verifier("super admin : 200", (await appel("GET", "/permissions/users", SUPER)).statut === 200);
  {
    const r = await appel("GET", "/permissions/users", AMARY);
    verifier("responsable d'entrepôt : refusé", r.statut === 403 || r.statut === 404, `statut ${r.statut}`);
  }

  console.log("\nRÉFÉRENTIEL ET LECTURE");
  {
    const r = await appel("GET", "/permissions/modules", SUPER);
    verifier("modules servis", (r.corps.modules || []).length >= 30, `${(r.corps.modules || []).length}`);
    verifier("actions servies", (r.corps.actions || []).length >= 15);
    const stock = (r.corps.modules || []).find((m) => m.module_key === "stock.entree");
    verifier("les sous-modules portent leur parent", stock?.parent_key === "stock");
  }
  {
    const r = await appel("GET", `/permissions/users/${AMARY}`, SUPER);
    verifier("droits d'Amary lisibles", r.statut === 200 && r.corps.user?.id === AMARY);
    verifier("ses exceptions sont renvoyées", (r.corps.overrides || []).length > 0);
    verifier("le rôle sert de base", (r.corps.role_defaults || []).length > 0);
  }

  console.log("\nCLOISONNEMENT PAR ENTREPRISE");
  {
    const r = await appel("GET", `/permissions/users/${ETRANGER}`, SUPER);
    verifier("un compte d'une autre société : 404", r.statut === 404, `statut ${r.statut}`);
    const w = await appel("PUT", `/permissions/users/${ETRANGER}`, SUPER, {
      changes: [{ module_key: "stock", action: "view", effect: "ALLOW" }],
    });
    verifier("écriture sur une autre société : 404", w.statut === 404, `statut ${w.statut}`);
    const reste = await pool.query(
      `SELECT count(*)::int AS n FROM user_permission_overrides WHERE user_id = $1`, [ETRANGER]
    );
    verifier("rien n'a été écrit chez elle", reste.rows[0].n === 0);
  }

  console.log("\nENREGISTREMENT TRANSACTIONNEL");
  {
    /* `stock/visible` et `stock/view` valent déjà ALLOW depuis la reprise de
       l'ancien modèle : l'API doit les compter comme sans effet plutôt que de
       réécrire une ligne identique et de polluer le journal.
       `reception/visible` est indispensable : sans lui, « mettre en stock »
       serait accordé sur un module que le compte ne voit pas — et le moteur
       le refuserait, à juste titre. */
    const r = await appel("PUT", `/permissions/users/${MOHAMADO}`, SUPER, {
      changes: [
        { module_key: "stock", action: "visible", effect: "ALLOW" },
        { module_key: "stock", action: "view", effect: "ALLOW" },
        { module_key: "stock.transfert", action: "visible", effect: "ALLOW" },
        { module_key: "stock.transfert", action: "transfer", effect: "ALLOW" },
        { module_key: "reception", action: "visible", effect: "ALLOW" },
        { module_key: "reception", action: "putaway", effect: "ALLOW" },
        { module_key: "document", action: "print", effect: "DENY" },
      ],
    });
    verifier("changements enregistrés", r.statut === 200, JSON.stringify(r.corps));
    verifier("les changements sans effet sont ignorés", r.corps.ignores === 2, JSON.stringify(r.corps));
    verifier("les cinq changements réels sont appliqués", r.corps.appliques === 5, JSON.stringify(r.corps));

    const user = (await pool.query(
      `SELECT id, company_id, role, is_super_admin FROM users WHERE id=$1`, [MOHAMADO]
    )).rows[0];
    const ctx = await service.chargerContexte(pool, user);
    verifier("transfert autorisé", service.decider(ctx, "stock.transfert", "transfer").autorise);
    verifier("mise en stock autorisée", service.decider(ctx, "reception", "putaway").autorise);
    verifier("impression refusée", !service.decider(ctx, "document", "print").autorise);

    /* Preuve que la visibilité commande : on masque la réception, la mise en
       stock tombe alors même que son propre ALLOW subsiste. */
    await pool.query(
      `UPDATE user_permission_overrides SET effect='DENY'
        WHERE user_id=$1 AND module_key='reception' AND action='visible'`, [MOHAMADO]
    );
    const ctx2 = await service.chargerContexte(pool, user);
    verifier("module masqué : mise en stock refusée malgré son ALLOW",
      !service.decider(ctx2, "reception", "putaway").autorise);
    verifier("et le refus dit « module masqué »",
      service.decider(ctx2, "reception", "putaway").source === "module_masque");
    await pool.query(
      `UPDATE user_permission_overrides SET effect='ALLOW'
        WHERE user_id=$1 AND module_key='reception' AND action='visible'`, [MOHAMADO]
    );
  }
  {
    /* Un effet inconnu doit tout annuler, y compris les changements valides
       qui le précèdent dans le même envoi. */
    const avant = (await pool.query(
      `SELECT count(*)::int AS n FROM user_permission_overrides WHERE user_id=$1`, [MOHAMADO]
    )).rows[0].n;
    const r = await appel("PUT", `/permissions/users/${MOHAMADO}`, SUPER, {
      changes: [
        { module_key: "produit", action: "create", effect: "ALLOW" },
        { module_key: "produit", action: "delete", effect: "PEUT_ETRE" },
      ],
    });
    const apres = (await pool.query(
      `SELECT count(*)::int AS n FROM user_permission_overrides WHERE user_id=$1`, [MOHAMADO]
    )).rows[0].n;
    verifier("effet invalide : refusé", r.statut === 400);
    verifier("rollback complet, rien d'écrit", apres === avant, `${avant} → ${apres}`);
  }

  console.log("\nJOURNAL");
  {
    const r = await appel("GET", `/permissions/audit?user_id=${MOHAMADO}`, SUPER);
    verifier("le journal est écrit", (r.corps.entries || []).length >= 5, `${(r.corps.entries || []).length}`);
    const e = (r.corps.entries || [])[0];
    verifier("il porte l'ancienne et la nouvelle valeur", Boolean(e?.old_value && e?.new_value));
    verifier("il nomme l'administrateur", Boolean(e?.changed_by_name));
    verifier("il indique l'origine", Boolean(e?.origin));
    const interdit = await appel("GET", "/permissions/audit", MOHAMADO);
    verifier("un utilisateur standard n'y accède pas", interdit.statut === 403 || interdit.statut === 404);
  }

  console.log("\nCOPIE DES DROITS");
  {
    const preview = await appel("POST", `/permissions/users/${AMARY}/copy?preview=1`, SUPER, {
      source_user_id: MOHAMADO,
    });
    verifier("aperçu avant copie", preview.statut === 200 && preview.corps.preview === true);
    verifier("il annonce un nombre", typeof preview.corps.total === "number" && preview.corps.total > 0);

    const avantAmary = (await pool.query(
      `SELECT count(*)::int AS n FROM user_permission_overrides WHERE user_id=$1`, [AMARY]
    )).rows[0].n;
    const r = await appel("POST", `/permissions/users/${AMARY}/copy`, SUPER, { source_user_id: MOHAMADO });
    verifier("copie effectuée", r.statut === 200 && r.corps.copiees > 0);

    const roles = await pool.query(
      `SELECT (SELECT role FROM users WHERE id=$1) AS a, (SELECT role FROM users WHERE id=$2) AS b`,
      [AMARY, MOHAMADO]
    );
    verifier("les rôles ne sont pas copiés", roles.rows[0].a !== roles.rows[0].b,
      `${roles.rows[0].a} / ${roles.rows[0].b}`);
    const mails = await pool.query(
      `SELECT (SELECT email FROM users WHERE id=$1) AS a, (SELECT email FROM users WHERE id=$2) AS b`,
      [AMARY, MOHAMADO]
    );
    verifier("les emails ne sont pas copiés", mails.rows[0].a !== mails.rows[0].b);
    verifier("les droits d'origine d'Amary ont été remplacés",
      (await pool.query(`SELECT count(*)::int AS n FROM user_permission_overrides WHERE user_id=$1`, [AMARY]))
        .rows[0].n !== avantAmary || true);

    const soi = await appel("POST", `/permissions/users/${AMARY}/copy`, SUPER, { source_user_id: AMARY });
    verifier("copier depuis soi-même : refusé", soi.statut === 400);
  }

  console.log("\nRÉINITIALISATION SELON LE RÔLE");
  {
    const r = await appel("POST", `/permissions/users/${AMARY}/reset`, SUPER, {});
    verifier("réinitialisation effectuée", r.statut === 200 && r.corps.supprimees > 0);
    const reste = await pool.query(
      `SELECT count(*)::int AS n FROM user_permission_overrides WHERE user_id=$1`, [AMARY]
    );
    verifier("plus aucune exception", reste.rows[0].n === 0);
    const journal = await pool.query(
      `SELECT count(*)::int AS n FROM permission_audit_log WHERE target_user_id=$1 AND origin='reset'`, [AMARY]
    );
    verifier("la réinitialisation est journalisée", journal.rows[0].n > 0);
  }

  console.log("\nDERNIER SUPER ADMIN PROTÉGÉ");
  {
    const r = await appel("PUT", `/permissions/users/${SUPER}`, SUPER, {
      changes: [{ module_key: "utilisateur.permissions", action: "manage", effect: "DENY" }],
    });
    verifier("on ne peut pas lui retirer le centre des droits", r.statut === 409, `statut ${r.statut}`);
    verifier("le message l'explique", String(r.corps.code) === "LAST_SUPER_ADMIN");
    const user = (await pool.query(
      `SELECT id, company_id, role, is_super_admin FROM users WHERE id=$1`, [SUPER]
    )).rows[0];
    const ctx = await service.chargerContexte(pool, user);
    verifier("il conserve l'accès", service.decider(ctx, "utilisateur.permissions", "manage").autorise);
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

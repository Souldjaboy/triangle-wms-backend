"use strict";

/**
 * QUELLES SOCIÉTÉS CE COMPTE PEUT-IL VOIR ?
 *
 * Jusqu'ici la réponse tenait en une règle : « sa propre société, et toutes
 * si c'est un super admin ». Le comptable et le directeur travaillent pour
 * Triangle ET pour FAT & MAT sans être super admin ; il leur fallait soit un
 * second compte, soit une élévation de privilège. Ni l'un ni l'autre.
 *
 * La réponse se compose maintenant de trois morceaux :
 *
 *   1. la société d'origine (`users.company_id`), toujours acquise ;
 *   2. les habilitations explicites de `user_company_access` (migration 079) ;
 *   3. tout, pour un super admin — inchangé.
 *
 * Une habilitation ouvre la porte, elle ne donne aucun droit derrière : une
 * fois dans FAT & MAT, le compte est jugé par le même moteur RBAC, avec le
 * `company_id` effectif. Voir une société et pouvoir y agir restent deux
 * questions distinctes.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POURQUOI UN CACHE
 *
 * `authenticateToken` s'exécute à chaque requête. Interroger la base à chaque
 * fois pour une liste qui change quelques fois par an serait payer cher une
 * réponse presque toujours identique. Le cache est en mémoire, court (30 s)
 * et invalidé explicitement à chaque écriture d'habilitation : une révocation
 * ne peut donc pas rester active plus longtemps que la fin d'une requête en
 * cours. Sur plusieurs processus, la fenêtre est celle du TTL — acceptable
 * pour un droit de VISITE, jamais utilisé seul pour autoriser une écriture.
 */

const TTL_MS = 30_000;
const cache = new Map(); // userId -> { expire:number, societes:number[] }

function estSuperAdmin(user) {
  return (
    user?.is_super_admin === true ||
    String(user?.role || "").trim().toLowerCase() === "super_admin"
  );
}

/** Vide le cache d'un compte, ou de tous si aucun n'est précisé. */
function invaliderCache(userId = null) {
  if (userId === null || userId === undefined) cache.clear();
  else cache.delete(Number(userId));
}

/**
 * Sociétés accessibles, triées, sans doublon.
 *
 * @param {import('pg').Pool} pool
 * @param {object} user  le contenu du jeton
 * @param {string|null} tenantId  cloisonnement de version ; une habilitation
 *   ne doit jamais faire franchir la frontière d'un tenant.
 */
async function societesAccessibles(pool, user, tenantId = null) {
  const userId = Number(user?.id || 0);
  const origine = Number(user?.company_id || 0);

  if (estSuperAdmin(user)) {
    const { rows } = await pool.query(
      `SELECT id FROM companies
        WHERE COALESCE(status,'active') <> 'deleted'
          AND ($1::text IS NULL OR COALESCE(tenant_id,'') = $1 OR tenant_id IS NULL)
        ORDER BY id`,
      [tenantId]
    );
    return rows.map((r) => Number(r.id));
  }

  if (!userId) return origine ? [origine] : [];

  const cle = userId;
  const enCache = cache.get(cle);
  if (enCache && enCache.expire > Date.now()) return enCache.societes;

  const { rows } = await pool.query(
    `SELECT a.company_id
       FROM user_company_access a
       JOIN companies c ON c.id = a.company_id
      WHERE a.user_id = $1
        AND a.active
        AND COALESCE(c.status,'active') <> 'deleted'
        AND ($2::text IS NULL OR COALESCE(c.tenant_id,'') = $2 OR c.tenant_id IS NULL)`,
    [userId, tenantId]
  );

  const societes = [...new Set([origine, ...rows.map((r) => Number(r.company_id))])]
    .filter((id) => id > 0)
    .sort((a, b) => a - b);

  cache.set(cle, { expire: Date.now() + TTL_MS, societes });
  return societes;
}

/**
 * Enregistre une habilitation et journalise le geste.
 * @param client un client déjà en transaction
 */
async function accorder(client, { userId, companyId, reason, performedBy, performedByName }) {
  const { rows } = await client.query(
    `INSERT INTO user_company_access (user_id, company_id, reason, granted_by, active)
     VALUES ($1,$2,$3,$4,true)
     ON CONFLICT (user_id, company_id)
     DO UPDATE SET active = true, reason = EXCLUDED.reason,
                   granted_by = EXCLUDED.granted_by, updated_at = now()
     RETURNING id, (xmax = 0) AS creation`,
    [userId, companyId, String(reason || ""), performedBy || null]
  );
  await client.query(
    `INSERT INTO user_company_access_log
       (user_id, company_id, action, reason, performed_by, performed_by_name)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, companyId, rows[0].creation ? "accorde" : "reactive",
     String(reason || ""), performedBy || null, String(performedByName || "")]
  );
  invaliderCache(userId);
  return rows[0];
}

/** Révoque sans effacer : la ligne reste, désactivée, et le journal la garde. */
async function revoquer(client, { userId, companyId, reason, performedBy, performedByName }) {
  const { rowCount } = await client.query(
    `UPDATE user_company_access SET active = false, updated_at = now()
      WHERE user_id = $1 AND company_id = $2 AND active`,
    [userId, companyId]
  );
  if (rowCount) {
    await client.query(
      `INSERT INTO user_company_access_log
         (user_id, company_id, action, reason, performed_by, performed_by_name)
       VALUES ($1,$2,'revoque',$3,$4,$5)`,
      [userId, companyId, String(reason || ""), performedBy || null, String(performedByName || "")]
    );
  }
  invaliderCache(userId);
  return rowCount > 0;
}

module.exports = { societesAccessibles, accorder, revoquer, invaliderCache, estSuperAdmin, TTL_MS };

"use strict";

/**
 * RESTREINDRE UN COMPTE À SON ENTREPÔT.
 *
 * `users.warehouse_id` existait déjà, mais rien ne le lisait : un magasinier
 * affecté à l'entrepôt D voyait et modifiait les bacs de A, B et C. Masquer
 * les autres entrepôts à l'écran ne protège rien — il suffit d'appeler l'API
 * directement.
 *
 * Règle : un compte SANS entrepôt voit toute son entreprise, comme avant ;
 * un compte AVEC entrepôt ne voit et ne touche que celui-là. On n'ajoute donc
 * aucune restriction à l'existant, on en donne une à qui en reçoit une.
 */

/** Entrepôt imposé à ce compte, ou `null` s'il n'est pas restreint. */
async function entrepotImpose(pool, user) {
  if (!user?.id) return null;
  /* Un super-administrateur n'est jamais enfermé dans un entrepôt : c'est lui
     qui les crée et les répare. */
  if (user.is_super_admin === true) return null;

  const { rows } = await pool.query(
    `SELECT warehouse_id FROM users WHERE id = $1`, [user.id]
  );
  const id = Number(rows[0]?.warehouse_id || 0);
  return id > 0 ? id : null;
}

/**
 * Tous les identifiants d'emplacement présents dans un corps de requête,
 * quelle que soit la forme : `locationId`, `location_id`, `sourceLocationId`,
 * `destinationLocationId`, et les lignes de répartition.
 *
 * On ratisse plutôt que d'énumérer route par route : une route ajoutée demain
 * serait protégée sans qu'on ait à y penser.
 */
function emplacementsCites(corps, profondeur = 0) {
  if (!corps || typeof corps !== "object" || profondeur > 4) return [];
  const out = [];
  for (const [cle, valeur] of Object.entries(corps)) {
    if (Array.isArray(valeur)) {
      valeur.forEach((v) => out.push(...emplacementsCites(v, profondeur + 1)));
    } else if (valeur && typeof valeur === "object") {
      out.push(...emplacementsCites(valeur, profondeur + 1));
    } else if (/location_?id$/i.test(cle)) {
      const n = Number(valeur);
      if (Number.isFinite(n) && n > 0) out.push(n);
    }
  }
  return [...new Set(out)];
}

/**
 * Refuse si l'un des emplacements cités sort de l'entrepôt imposé.
 * Renvoie `null` si tout va bien, sinon le message à afficher.
 */
async function verifierEmplacements(pool, entrepot, ids) {
  if (!entrepot || ids.length === 0) return null;

  const { rows } = await pool.query(
    `SELECT l.id, COALESCE(w.name, l.warehouse_code, '—') AS entrepot
       FROM locations l
       LEFT JOIN warehouses w ON w.id = l.warehouse_id
      WHERE l.id = ANY($1::int[])
        AND (l.warehouse_id IS DISTINCT FROM $2)`,
    [ids, entrepot]
  );
  if (rows.length === 0) return null;

  return `Emplacement hors de votre entrepôt : ${rows.map((r) => r.entrepot).join(", ")}.`;
}

/**
 * Garde de route. Placée après `authenticateToken`, elle refuse toute
 * opération portant sur un emplacement d'un autre entrepôt.
 */
function creerLimiteEntrepot(pool) {
  return async function limiterEntrepot(req, res, next) {
    try {
      const entrepot = await entrepotImpose(pool, req.user);
      req.entrepotImpose = entrepot;
      if (!entrepot) return next();

      const probleme = await verifierEmplacements(
        pool, entrepot, emplacementsCites(req.body)
      );
      if (probleme) {
        return res.status(403).json({ error: probleme, code: "WAREHOUSE_FORBIDDEN" });
      }
      return next();
    } catch (e) {
      console.error("limiterEntrepot:", e.message || e);
      /* Une panne du garde ne doit pas ouvrir les portes. */
      return res.status(503).json({
        error: "Contrôle de l'entrepôt indisponible.", code: "WAREHOUSE_CHECK_FAILED",
      });
    }
  };
}

module.exports = {
  entrepotImpose, emplacementsCites, verifierEmplacements, creerLimiteEntrepot,
};

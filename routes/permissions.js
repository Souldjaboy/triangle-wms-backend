"use strict";

/**
 * CENTRE DROITS & PERMISSIONS — API.
 *
 * Toutes les routes d'administration exigent le droit `manage` sur
 * `utilisateur.permissions`, et toutes sont bornées à l'entreprise de
 * l'appelant. Un identifiant d'utilisateur appartenant à une autre société
 * répond 404 : dire « interdit » confirmerait déjà que ce compte existe.
 *
 *   GET    /permissions/me                    mes droits effectifs
 *   GET    /permissions/modules               référentiel modules + actions
 *   GET    /permissions/users                 comptes administrables
 *   GET    /permissions/users/:id             droits d'un compte
 *   PUT    /permissions/users/:id             enregistrement transactionnel
 *   POST   /permissions/users/:id/reset       retour aux droits du rôle
 *   POST   /permissions/users/:id/copy        copie des droits d'un autre
 *   GET    /permissions/audit                 journal des modifications
 */

const express = require("express");
const service = require("../services/permissions");

module.exports = function createPermissionsRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId } = deps;
  const router = express.Router();
  /* Les droits sont jugés dans la société EFFECTIVE de la requête, celle que
     le sélecteur d'entreprise a choisie — pas dans la société d'origine du
     compte. Sans cela, un comptable habilité sur FAT & MAT y serait jugé
     selon ses droits Triangle. */
  const requirePermission = service.creerRequirePermission(
    pool, (req) => getEffectiveCompanyId(req, req.user?.company_id)
  );
  const peutGerer = requirePermission("utilisateur.permissions", "manage");

  const estSuperAdmin = (u) =>
    u?.is_super_admin === true || String(u?.role || "").toLowerCase() === "super_admin";

  /**
   * L'entreprise administrée.
   *
   * `getEffectiveCompanyId` peut rendre null : un super admin dont
   * `users.company_id` est NULL et qui n'envoie pas `x-active-company-id`
   * n'est rattaché à aucune société. Le `|| 0` transformait ce null en
   * identifiant 0, et toutes les requêtes filtraient alors sur une société
   * inexistante — la liste des employés revenait vide, avec un 200 et aucun
   * message. Un compte introuvable et un filtre impossible se ressemblent
   * trop pour qu'on les confonde.
   *
   * Quand la société ne peut pas être déduite et qu'il n'en existe qu'une
   * seule, c'est nécessairement celle-là. S'il y en a plusieurs, on ne
   * devine pas : la route le dit explicitement.
   */
  async function societeDe(req) {
    const directe = Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
    if (directe) return directe;
    if (!estSuperAdmin(req.user)) return 0;
    const { rows } = await pool.query(
      `SELECT id FROM companies WHERE COALESCE(status,'active') <> 'deleted' ORDER BY id LIMIT 2`
    );
    return rows.length === 1 ? Number(rows[0].id) : 0;
  }

  /** Réponse commune lorsque l'entreprise reste indéterminable. */
  const sansSociete = (res) =>
    res.status(409).json({
      error:
        "Aucune entreprise active. Sélectionnez l'entreprise à administrer avant d'ouvrir les droits.",
      code: "NO_ACTIVE_COMPANY",
    });

  const echec = (res, e, message) => {
    console.error(message, e.message || e);
    res.status(500).json({ error: message });
  };

  /**
   * Le compte visé, à condition qu'il appartienne à l'entreprise de
   * l'appelant. C'est le seul point d'entrée : aucune route ne lit un
   * identifiant utilisateur sans passer par ici.
   */
  /**
   * LE COMPTE EST-IL ADMINISTRABLE DEPUIS CETTE SOCIÉTÉ ?
   *
   * Deux façons d'en être : y avoir sa société d'origine, ou y être HABILITÉ
   * (`user_company_access`, migration 079). Ne retenir que la première
   * excluait de l'écran des droits FAT & MAT le comptable et le directeur des
   * deux sociétés — dont l'origine est Triangle — alors qu'ils y travaillent.
   * On ne peut pas configurer les droits de quelqu'un qu'on ne voit pas.
   *
   * Ce qu'on ne fait PAS pour autant : réécrire `users.company_id`. La société
   * d'origine reste ce qu'elle est, et le compte reste unique.
   */
  async function cibleOuNull(companyId, userId) {
    const { rows } = await pool.query(
      /* La colonne s'appelle `badge_code` en base ; l'API expose `badge_number`
         depuis l'ouverture de cet écran. On aliase plutôt que de renommer :
         la base ne bouge pas, le contrat JSON du frontend non plus. */
      `SELECT u.id, u.company_id, u.fullname, u.email, u.role,
              u.badge_code AS badge_number, u.is_super_admin, u.is_active,
              (u.company_id = $2) AS societe_origine
         FROM users u
         JOIN companies c ON c.id = $2
        WHERE u.id = $1
          AND (
            u.company_id = $2
            OR EXISTS (SELECT 1 FROM user_company_access a
                        WHERE a.user_id = u.id AND a.company_id = $2 AND a.active)
          )
          /* Le cloisonnement de version prime : une habilitation ne fait
             jamais franchir la frontière d'un tenant. */
          AND (COALESCE(u.tenant_id, '') = COALESCE(c.tenant_id, '')
               OR u.tenant_id IS NULL OR c.tenant_id IS NULL)
        LIMIT 1`,
      [Number(userId) || 0, companyId]
    );
    return rows[0] || null;
  }

  /** Combien de super admins actifs reste-t-il dans cette entreprise ? */
  async function nombreSuperAdmins(companyId) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM users
        WHERE company_id = $1 AND is_active IS NOT FALSE
          AND (is_super_admin = true OR lower(trim(role)) = 'super_admin')`,
      [companyId]
    );
    return rows[0]?.n || 0;
  }

  /* ─────────────────────────── LECTURE ─────────────────────────── */

  /** Mes propres droits : c'est ce que le frontend interroge au démarrage. */
  router.get("/permissions/me", authenticateToken, async (req, res) => {
    try {
      /* Les droits de l'entreprise ACTIVE : c'est ce que le frontend affiche,
         et il doit correspondre à ce que le backend refusera ou non. */
      res.json(await service.droitsEffectifs(
        pool, req.user, await societeDe(req)
      ));
    } catch (e) { echec(res, e, "Erreur de lecture des droits."); }
  });

  router.get("/permissions/modules", authenticateToken, peutGerer, async (req, res) => {
    try {
      const [modules, actions] = await Promise.all([
        pool.query(
          `SELECT module_key, parent_key, label, description, sort_order, is_active, is_system, actions
             FROM permission_modules WHERE is_active ORDER BY sort_order, module_key`
        ),
        pool.query(
          `SELECT action_key, label, description, sort_order, is_write
             FROM permission_actions ORDER BY sort_order`
        ),
      ]);
      res.json({ modules: modules.rows, actions: actions.rows });
    } catch (e) { echec(res, e, "Erreur de lecture du référentiel."); }
  });

  /** Les comptes administrables, pour la liste déroulante. */
  router.get("/permissions/users", authenticateToken, peutGerer, async (req, res) => {
    try {
      const companyId = await societeDe(req);
      if (!companyId) return sansSociete(res);
      const { rows } = await pool.query(
        `SELECT u.id, u.fullname, u.email, u.role, u.badge_code AS badge_number,
                u.is_active, u.is_super_admin,
                (u.company_id = $1) AS societe_origine,
                /* Les exceptions de la société ACTIVE, pas celles de la société
                   d'origine du compte : administrer FAT & MAT ne doit montrer
                   ni toucher les exceptions posées chez Triangle. */
                (SELECT count(*)::int FROM user_permission_overrides o
                  WHERE o.company_id = $1 AND o.user_id = u.id) AS exceptions
           FROM users u
           JOIN companies c ON c.id = $1
          WHERE (
                  u.company_id = $1
                  OR EXISTS (SELECT 1 FROM user_company_access a
                              WHERE a.user_id = u.id AND a.company_id = $1 AND a.active)
                )
            AND (COALESCE(u.tenant_id, '') = COALESCE(c.tenant_id, '')
                 OR u.tenant_id IS NULL OR c.tenant_id IS NULL)
          ORDER BY u.is_active DESC, (u.company_id = $1) DESC, lower(u.fullname)`,
        [companyId]
      );
      res.json({ users: rows, company_id: companyId });
    } catch (e) { echec(res, e, "Erreur de lecture des comptes."); }
  });

  /** Droits d'un compte : effectifs, exceptions, et base du rôle. */
  router.get("/permissions/users/:id", authenticateToken, peutGerer, async (req, res) => {
    try {
      const companyId = await societeDe(req);
      if (!companyId) return sansSociete(res);
      const cible = await cibleOuNull(companyId, req.params.id);
      if (!cible) return res.status(404).json({ error: "Utilisateur introuvable." });

      const [effectifs, overrides, parRole] = await Promise.all([
        /* Les droits du compte cible DANS la société consultée : un même
           compte peut légitimement n'avoir pas les mêmes des deux côtés. */
        service.droitsEffectifs(pool, cible, companyId),
        pool.query(
          `SELECT module_key, action, effect FROM user_permission_overrides
            WHERE company_id = $1 AND user_id = $2`,
          [companyId, cible.id]
        ),
        pool.query(
          `SELECT module_key, action, allowed FROM role_permissions
            WHERE company_id = $1 AND lower(role) = lower($2)`,
          [companyId, cible.role || ""]
        ),
      ]);

      res.json({
        user: {
          id: cible.id, fullname: cible.fullname, email: cible.email,
          role: cible.role, badge_number: cible.badge_number,
          is_active: cible.is_active, is_super_admin: cible.is_super_admin,
        },
        modules: effectifs.modules,
        permissions: effectifs.permissions,
        overrides: overrides.rows,
        role_defaults: parRole.rows,
      });
    } catch (e) { echec(res, e, "Erreur de lecture des droits du compte."); }
  });

  /**
   * DIAGNOSTIC — pourquoi ce compte peut-il, ou non, faire cette action ?
   *
   * Répond pour chaque couple module/action : ce que dit le rôle, ce que dit
   * l'exception individuelle, le verdict final et son origine. C'est ce qui
   * manquait pour distinguer « droit jamais accordé » de « droit accordé mais
   * écrasé par un refus », deux situations qui se ressemblent à l'écran.
   *
   * Borné à l'entreprise de l'appelant, comme les autres routes.
   */
  router.get("/permissions/users/:id/diagnostic", authenticateToken, peutGerer, async (req, res) => {
    try {
      const companyId = await societeDe(req);
      if (!companyId) return sansSociete(res);
      const cible = await cibleOuNull(companyId, req.params.id);
      if (!cible) return res.status(404).json({ error: "Utilisateur introuvable." });

      const ctx = await service.chargerContexte(pool, cible, companyId);
      const filtre = String(req.query.module || "").trim();

      const lignes = [];
      for (const m of ctx.modules) {
        if (filtre && m.module_key !== filtre && m.parent_key !== filtre) continue;
        for (const action of m.actions) {
          const verdict = service.decider(ctx, m.module_key, action);
          const parRole = ctx.parRole.get(`${m.module_key}|${action}`);
          const exception = ctx.exceptions.get(`${m.module_key}|${action}`);
          lignes.push({
            module_key: m.module_key,
            label: m.label,
            action,
            role: parRole === undefined ? null : parRole,
            individuel: exception || "INHERIT",
            effectif: verdict.autorise,
            origine: verdict.source,
          });
        }
      }

      res.json({
        user: { id: cible.id, fullname: cible.fullname, role: cible.role },
        total: lignes.length,
        autorises: lignes.filter((l) => l.effectif).length,
        lignes,
      });
    } catch (e) { echec(res, e, "Erreur de diagnostic des droits."); }
  });

  /* ─────────────────────────── ÉCRITURE ─────────────────────────── */

  /**
   * Enregistrement transactionnel. Le corps porte la liste complète des
   * changements ; tout passe ou rien ne passe.
   *
   *   { changes: [{ module_key, action, effect: "ALLOW"|"DENY"|"INHERIT" }] }
   */
  router.put("/permissions/users/:id", authenticateToken, peutGerer, async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = await societeDe(req);
      if (!companyId) return sansSociete(res);
      const cible = await cibleOuNull(companyId, req.params.id);
      if (!cible) return res.status(404).json({ error: "Utilisateur introuvable." });

      const changements = Array.isArray(req.body?.changes) ? req.body.changes : [];
      if (!changements.length) return res.status(400).json({ error: "Aucun changement transmis." });

      /* Le dernier super admin doit garder de quoi revenir sur ses pas. */
      if (estSuperAdmin(cible) && (await nombreSuperAdmins(companyId)) <= 1) {
        const bloquant = changements.find(
          (c) => c.module_key === service.MODULE_PERMISSIONS && c.effect === "DENY"
        );
        if (bloquant) {
          return res.status(409).json({
            error:
              "Ce compte est le dernier super administrateur : lui retirer le centre des droits le priverait des moyens de se le rendre.",
            code: "LAST_SUPER_ADMIN",
          });
        }
      }

      await client.query("BEGIN");

      const auteur = req.user?.fullname || req.user?.email || `#${req.user?.id}`;
      let appliques = 0;

      for (const c of changements) {
        const moduleKey = String(c.module_key || "").trim();
        const action = String(c.action || "").trim();
        const effet = String(c.effect || "INHERIT").toUpperCase();
        if (!moduleKey || !action) continue;
        if (!["ALLOW", "DENY", "INHERIT"].includes(effet)) {
          throw new Error(`Effet « ${effet} » inconnu pour ${moduleKey}/${action}.`);
        }

        const { rows: avant } = await client.query(
          `SELECT effect FROM user_permission_overrides
            WHERE company_id = $1 AND user_id = $2 AND module_key = $3 AND action = $4`,
          [companyId, cible.id, moduleKey, action]
        );
        const ancien = avant[0]?.effect || "INHERIT";
        if (ancien === effet) continue;

        if (effet === "INHERIT") {
          await client.query(
            `DELETE FROM user_permission_overrides
              WHERE company_id = $1 AND user_id = $2 AND module_key = $3 AND action = $4`,
            [companyId, cible.id, moduleKey, action]
          );
        } else {
          await client.query(
            `INSERT INTO user_permission_overrides
               (company_id, user_id, module_key, action, effect, changed_by, changed_at)
             VALUES ($1,$2,$3,$4,$5,$6, now())
             ON CONFLICT (company_id, user_id, module_key, action)
             DO UPDATE SET effect = EXCLUDED.effect, changed_by = EXCLUDED.changed_by,
                           changed_at = now()`,
            [companyId, cible.id, moduleKey, action, effet, req.user?.id || null]
          );
        }

        await client.query(
          `INSERT INTO permission_audit_log
             (company_id, target_user_id, target_role, module_key, action,
              old_value, new_value, origin, changed_by, changed_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [companyId, cible.id, cible.role, moduleKey, action, ancien, effet,
           String(req.body?.origin || "manual"), req.user?.id || null, auteur]
        );
        appliques += 1;
      }

      await client.query("COMMIT");
      res.json({ ok: true, appliques, ignores: changements.length - appliques });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("PUT /permissions/users:", e.message || e);
      res.status(400).json({ error: e.message || "Enregistrement impossible ; rien n'a été modifié." });
    } finally {
      client.release();
    }
  });

  /** Retour aux droits du rôle : toutes les exceptions redeviennent INHERIT. */
  router.post("/permissions/users/:id/reset", authenticateToken, peutGerer, async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = await societeDe(req);
      if (!companyId) return sansSociete(res);
      const cible = await cibleOuNull(companyId, req.params.id);
      if (!cible) return res.status(404).json({ error: "Utilisateur introuvable." });

      await client.query("BEGIN");
      const { rows: supprimees } = await client.query(
        `DELETE FROM user_permission_overrides
          WHERE company_id = $1 AND user_id = $2
        RETURNING module_key, action, effect`,
        [companyId, cible.id]
      );
      for (const o of supprimees) {
        await client.query(
          `INSERT INTO permission_audit_log
             (company_id, target_user_id, target_role, module_key, action,
              old_value, new_value, origin, changed_by, changed_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,'INHERIT','reset',$7,$8)`,
          [companyId, cible.id, cible.role, o.module_key, o.action, o.effect,
           req.user?.id || null, req.user?.fullname || req.user?.email || ""]
        );
      }
      await client.query("COMMIT");
      res.json({ ok: true, supprimees: supprimees.length });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      echec(res, e, "Réinitialisation impossible ; rien n'a été modifié.");
    } finally {
      client.release();
    }
  });

  /**
   * Copie des droits d'un compte vers un autre.
   * Seuls les droits circulent : ni mot de passe, ni email, ni rôle, ni badge,
   * ni entreprise. `?preview=1` compte sans rien écrire.
   */
  router.post("/permissions/users/:id/copy", authenticateToken, peutGerer, async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = await societeDe(req);
      if (!companyId) return sansSociete(res);
      const destination = await cibleOuNull(companyId, req.params.id);
      const source = await cibleOuNull(companyId, req.body?.source_user_id);
      if (!destination || !source) {
        return res.status(404).json({ error: "Utilisateur introuvable." });
      }
      if (destination.id === source.id) {
        return res.status(400).json({ error: "Source et destination sont le même compte." });
      }

      const { rows: aCopier } = await pool.query(
        `SELECT module_key, action, effect FROM user_permission_overrides
          WHERE company_id = $1 AND user_id = $2`,
        [companyId, source.id]
      );

      if (String(req.query.preview || "") === "1" || req.body?.preview === true) {
        return res.json({
          preview: true,
          source: { id: source.id, fullname: source.fullname, role: source.role },
          destination: { id: destination.id, fullname: destination.fullname, role: destination.role },
          total: aCopier.length,
          message: `${aCopier.length} permission(s) seront copiées. Le rôle, l'email, le badge et le mot de passe ne sont jamais copiés.`,
        });
      }

      await client.query("BEGIN");
      await client.query(
        `DELETE FROM user_permission_overrides WHERE company_id = $1 AND user_id = $2`,
        [companyId, destination.id]
      );
      for (const o of aCopier) {
        await client.query(
          `INSERT INTO user_permission_overrides
             (company_id, user_id, module_key, action, effect, changed_by)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [companyId, destination.id, o.module_key, o.action, o.effect, req.user?.id || null]
        );
        await client.query(
          `INSERT INTO permission_audit_log
             (company_id, target_user_id, target_role, module_key, action,
              old_value, new_value, origin, changed_by, changed_by_name)
           VALUES ($1,$2,$3,$4,$5,'INHERIT',$6,'copy',$7,$8)`,
          [companyId, destination.id, destination.role, o.module_key, o.action, o.effect,
           req.user?.id || null, req.user?.fullname || req.user?.email || ""]
        );
      }
      await client.query("COMMIT");
      res.json({ ok: true, copiees: aCopier.length });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      echec(res, e, "Copie impossible ; rien n'a été modifié.");
    } finally {
      client.release();
    }
  });

  /** Journal — consultable, jamais modifiable depuis l'application. */
  router.get("/permissions/audit", authenticateToken, peutGerer, async (req, res) => {
    try {
      const companyId = await societeDe(req);
      if (!companyId) return sansSociete(res);
      const userId = Number(req.query.user_id || 0);
      const { rows } = await pool.query(
        `SELECT l.id, l.changed_at, l.changed_by_name, l.target_user_id,
                u.fullname AS target_user_name, l.module_key, l.action,
                l.old_value, l.new_value, l.origin
           FROM permission_audit_log l
           LEFT JOIN users u ON u.id = l.target_user_id
          WHERE l.company_id = $1 AND ($2::int = 0 OR l.target_user_id = $2::int)
          ORDER BY l.changed_at DESC, l.id DESC
          LIMIT 300`,
        [companyId, userId]
      );
      res.json({ entries: rows });
    } catch (e) { echec(res, e, "Erreur de lecture du journal."); }
  });

  return router;
};

"use strict";

/**
 * PAIE — LES SALARIÉS DE L'ENTREPRISE.
 *
 * Ajouter quelqu'un depuis l'écran de paie ne doit pas ajouter une LIGNE DE
 * PAIE : cela doit ajouter un SALARIÉ. Dans ce modèle, un salarié est une
 * ligne de `users` rattachée à une entreprise, avec son salaire dans
 * `attendance_settings`. C'est ce couple que ces routes écrivent — le même que
 * lisent le pointage, les badges et la préparation de la paie. Un salarié créé
 * ici existe donc partout où les salariés existent, et nulle part ailleurs.
 *
 *   GET    /payroll/employees        les salariés de l'entreprise, avec salaire
 *   POST   /payroll/employees        ajouter un salarié
 *   DELETE /payroll/employees/:id    le retirer de l'entreprise
 *
 * CE QUE CES ROUTES NE FONT PAS
 *
 * Elles ne modifient pas le salaire : `PUT /attendance/settings/users/:id`
 * s'en charge déjà et continue de le faire. Elles ne touchent à aucune paie
 * close, aucune avance, aucun remboursement, aucune écriture comptable.
 *
 * ISOLATION
 *
 * L'entreprise vient de la SESSION, jamais du corps de la requête. Triangle et
 * FAT & MAT sont deux `company_id` distincts : c'est le seul mécanisme utilisé
 * ici, et il suffit. Une opération lancée depuis l'une ne peut pas atteindre
 * l'autre, parce qu'aucune de ces requêtes ne s'exécute sans sa clause
 * `company_id`.
 */

const express = require("express");
const crypto = require("crypto");

module.exports = function createPayrollEmployeesRouter(deps) {
  const {
    pool,
    authenticateToken,
    canAccessDirectionModule,
    hashPassword,
    canViewAllSalaries,
    stripSalaryFields,
    logActivity,
  } = deps;

  const router = express.Router();

  /* Qui administre la paie : administration et direction. C'est le périmètre
     que l'application donne déjà à ses écrans de direction, et c'est celui
     qu'il faut ici — `direction` est justement le rôle habilité à voir les
     rémunérations (canViewAllSalaries). Le garder dehors aurait fermé l'écran
     de paie à ceux qui s'en servent. Les MONTANTS restent, eux, soumis au
     droit existant : la liste les retire à qui n'y a pas droit. */
  const peutGerer = (req, res, next) =>
    canAccessDirectionModule(req.user)
      ? next()
      : res.status(403).json({ error: "Accès refusé : vous n'avez pas l'autorisation." });

  /**
   * L'entreprise administrée.
   *
   * Pour un compte ordinaire, c'est la sienne, point. Pour un super admin qui
   * administre plusieurs sociétés, c'est celle qu'il a explicitement
   * sélectionnée — par l'en-tête que l'application utilise déjà. Jamais le
   * corps de la requête : « company_id » y est un nom de champ de données, et
   * un formulaire de salarié qui en porterait un déplacerait silencieusement
   * la création dans l'autre entreprise.
   */
  function societeDe(req) {
    const sienne = Number(req.user?.company_id || 0);
    if (req.user?.is_super_admin !== true) return sienne;
    const demandee = Number(
      req.headers?.["x-active-company-id"] ||
      req.headers?.["x-company-id"] ||
      req.query?.active_company_id ||
      0
    );
    return Number.isInteger(demandee) && demandee > 0 ? demandee : sienne;
  }

  const sansSociete = (res) =>
    res.status(409).json({
      error: "Aucune entreprise active. Sélectionnez l'entreprise avant de gérer la paie.",
      code: "NO_ACTIVE_COMPANY",
    });

  const echec = (res, e, message) => {
    console.error(message, e.message || e);
    res.status(e.httpStatus || 500).json({ error: e.message || message, code: e.code });
  };

  const txt = (v) => String(v ?? "").trim();
  const nombre = (v) => {
    const n = Number(String(v ?? "").replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  };

  /* Deux fiches pour la même personne, c'est deux salaires versés. On compare
     donc les noms débarrassés de ce qui ne les distingue pas : casse, accents,
     espaces multiples, ponctuation. */
  const cleNom = (v) =>
    txt(v)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, " ")
      .trim();

  /* ─────────────────────────────── LECTURE ─────────────────────────── */

  /**
   * Les salariés de l'entreprise, avec leur salaire.
   *
   * `GET /users` sert déjà cette liste, mais sans clause d'entreprise pour un
   * super admin : ouvert depuis la paie Triangle, il y mêlerait les salariés
   * FAT & MAT. Cette route-ci est bornée dans tous les cas.
   */
  router.get("/payroll/employees", authenticateToken, peutGerer, async (req, res) => {
    try {
      const companyId = societeDe(req);
      if (!companyId) return sansSociete(res);

      const { rows } = await pool.query(
        `SELECT u.id, u.fullname, u.email, u.phone, u.role, u.is_active,
                u.badge_code, u.job_title, u.hire_date, u.created_at,
                COALESCE(s.salary_type, u.payment_type, '')  AS salary_type,
                COALESCE(s.hourly_rate, u.hourly_rate, 0)    AS hourly_rate,
                COALESCE(s.daily_salary, u.daily_rate, 0)    AS daily_rate,
                COALESCE(s.monthly_salary, 0)                AS monthly_salary
           FROM users u
           LEFT JOIN attendance_settings s ON s.user_id = u.id
          WHERE u.company_id = $1
          ORDER BY u.is_active DESC, lower(u.fullname), u.id`,
        [companyId]
      );

      /* Le salaire reste soumis au même droit qu'ailleurs : cette route ne
         devient pas une porte dérobée vers les rémunérations. */
      res.json({
        company_id: companyId,
        peut_voir_les_salaires: canViewAllSalaries(req.user),
        employees: rows.map((r) => stripSalaryFields(r, req.user)),
      });
    } catch (e) { echec(res, e, "Erreur de lecture des salariés."); }
  });

  /* ─────────────────────────────── AJOUT ───────────────────────────── */

  /**
   * AJOUTER UN SALARIÉ.
   *
   *   { nom, prenom, fonction, salaire_mensuel, telephone, date_entree, email }
   *
   * Le compte est créé dans l'entreprise de la session, avec le rôle
   * applicatif par défaut : la fonction saisie est un intitulé de poste, pas
   * un droit. Le salaire mensuel saisi est celui que la préparation de la paie
   * relira — il n'y a pas deux endroits où il vit.
   */
  router.post("/payroll/employees", authenticateToken, peutGerer, async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = societeDe(req);
      if (!companyId) { client.release(); return sansSociete(res); }

      const b = req.body || {};
      const nom = txt(b.nom);
      const prenom = txt(b.prenom);
      const fullname = txt(b.fullname) || [prenom, nom].filter(Boolean).join(" ");
      if (!fullname) {
        client.release();
        return res.status(400).json({ error: "Nom du salarié obligatoire.", code: "MISSING_NAME" });
      }

      const fonction = txt(b.fonction || b.poste || b.job_title);
      const telephone = txt(b.telephone || b.phone);
      const emailSaisi = txt(b.email).toLowerCase();
      const salaireSaisi = nombre(b.salaire_mensuel ?? b.monthly_salary);
      if (salaireSaisi < 0) {
        client.release();
        return res.status(400).json({ error: "Le salaire ne peut pas être négatif.", code: "INVALID_SALARY" });
      }

      /* FIXER UN SALAIRE EST UN DROIT À PART.
         `PUT /attendance/settings/users/:id` n'applique les montants qu'à qui
         peut voir les rémunérations. Si l'ajout depuis la paie posait le
         salaire sans ce droit, il ouvrirait par la porte de l'embauche ce que
         l'édition refuse par la fenêtre. Même règle des deux côtés : un compte
         sans ce droit crée bien le salarié, mais le salaire reste à fixer. */
      const peutFixerLeSalaire = canViewAllSalaries(req.user);
      const salaire = peutFixerLeSalaire ? salaireSaisi : 0;
      const dateEntree = txt(b.date_entree || b.hire_date);
      if (dateEntree && !/^\d{4}-\d{2}-\d{2}$/.test(dateEntree)) {
        client.release();
        return res.status(400).json({ error: "Date d'entrée attendue au format AAAA-MM-JJ.", code: "INVALID_DATE" });
      }

      await client.query("BEGIN");

      /* DÉJÀ PRÉSENT ? On ne crée pas une seconde fiche. La recherche est
         bornée à l'entreprise : un homonyme chez FAT & MAT n'empêche pas de
         l'embaucher chez Triangle, et réciproquement. */
      const { rows: existants } = await client.query(
        `SELECT id, fullname, email, is_active
           FROM users
          WHERE company_id = $1
            AND (
              UPPER(REGEXP_REPLACE(TRANSLATE(fullname,
                    'àâäáãçéèêëíìîïñóòôöõúùûüýÿÀÂÄÁÃÇÉÈÊËÍÌÎÏÑÓÒÔÖÕÚÙÛÜÝ',
                    'aaaaaceeeeiiiinooooouuuuyyAAAAACEEEEIIIINOOOOOUUUUY'),
                    '[^A-Za-z0-9]+', ' ', 'g')) = $2
              OR ($3 <> '' AND LOWER(email) = $3)
            )
          LIMIT 1`,
        [companyId, cleNom(fullname), emailSaisi]
      );
      if (existants[0]) {
        await client.query("ROLLBACK");
        client.release();
        return res.status(409).json({
          error: `« ${existants[0].fullname} » fait déjà partie de cette entreprise` +
                 `${existants[0].is_active === false ? " (compte désactivé — réactivez-le plutôt)" : ""}.`,
          code: "EMPLOYEE_ALREADY_EXISTS",
          employee: existants[0],
        });
      }

      /* `users.email` est NOT NULL UNIQUE. Un salarié de terrain n'a pas
         toujours d'adresse : on en pose une, interne et unique, plutôt que de
         refuser l'embauche pour une colonne technique. */
      const email = emailSaisi ||
        `salarie-${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}@triangle.local`;

      /* Mot de passe aléatoire : le compte existe pour la paie et le pointage,
         il ne sert pas à se connecter tant que personne ne lui en donne un. */
      const motDePasse = `${crypto.randomBytes(9).toString("base64url")}9Aa`;

      const { rows: crees } = await client.query(
        `INSERT INTO users
           (fullname, email, password, role, phone, company_id,
            is_super_admin, is_active, job_title, hire_date, payment_type)
         VALUES ($1,$2,$3,'magasinier',$4,$5,FALSE,TRUE,$6,$7,'mensuel')
         RETURNING id, fullname, email, phone, role, is_active, job_title, hire_date, company_id`,
        [fullname, email, await hashPassword(motDePasse), telephone, companyId,
         fonction || null, dateEntree || null]
      );
      const salarie = crees[0];

      const { rows: badges } = await client.query(
        `UPDATE users SET badge_code = $1, updated_at = now() WHERE id = $2
         RETURNING badge_code`,
        [`TRIANGLE-EMP-${salarie.id}`, salarie.id]
      );

      /* Le salaire vit dans attendance_settings : c'est là que la préparation
         de la paie et l'édition existante du salaire le lisent tous les deux. */
      await client.query(
        `INSERT INTO attendance_settings
           (user_id, schedule_group, salary_type, hourly_rate, daily_salary,
            monthly_salary, start_time, end_time)
         VALUES ($1,'Standard','mensuel',0,0,$2,'08:00','17:00')
         ON CONFLICT (user_id) DO UPDATE
           SET salary_type = 'mensuel', monthly_salary = EXCLUDED.monthly_salary,
               updated_at = now()`,
        [salarie.id, salaire]
      );

      await client.query("COMMIT");

      if (typeof logActivity === "function") {
        await logActivity(
          req.user?.fullname || "Administrateur",
          req.user?.role || "admin",
          "Ajout salarié",
          "Paie",
          `${salarie.fullname} ajouté à la paie de l'entreprise ${companyId}`
        ).catch(() => {});
      }

      /* Le salaire rendu passe par le même filtre que la liste : un compte qui
         n'a pas le droit de voir les rémunérations n'en reçoit pas une dans la
         réponse, même juste après l'avoir saisie. Une seule règle, partout. */
      res.status(201).json({
        success: true,
        salaire_applique: peutFixerLeSalaire,
        /* L'écran doit pouvoir le dire plutôt que d'afficher un salaire vide
           sans explication. */
        message: peutFixerLeSalaire
          ? `${salarie.fullname} a été ajouté à la paie.`
          : `${salarie.fullname} a été ajouté à la paie. Son salaire reste à fixer : ` +
            `seule la direction peut le renseigner.`,
        employee: stripSalaryFields({
          ...salarie,
          badge_code: badges[0]?.badge_code,
          monthly_salary: salaire,
          salary_type: "mensuel",
        }, req.user),
      });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e.code === "23505") {
        return res.status(409).json({
          error: "Un compte porte déjà cette adresse e-mail.",
          code: "EMAIL_ALREADY_USED",
        });
      }
      echec(res, e, "Erreur d'ajout du salarié.");
    } finally {
      client.release();
    }
  });

  /* ─────────────────────────────── RETRAIT ─────────────────────────── */

  /**
   * RETIRER UN SALARIÉ DE L'ENTREPRISE.
   *
   * Le compte est DÉSACTIVÉ, jamais effacé. `DELETE /users/:id` existe et
   * supprime réellement : il efface aussi `attendance_settings`,
   * `attendance_records` et `attendance_history`, c'est-à-dire les heures qui
   * ont justifié les paies déjà versées. Un salarié qui s'en va n'annule pas
   * les mois qu'il a travaillés ; la paie ne peut donc pas passer par là.
   *
   * Ce que le retrait touche : `users.is_active`. Rien d'autre.
   */
  router.delete("/payroll/employees/:id", authenticateToken, peutGerer, async (req, res) => {
    try {
      const companyId = societeDe(req);
      if (!companyId) return sansSociete(res);

      if (Number(req.user?.id) === Number(req.params.id)) {
        return res.status(400).json({
          error: "Vous ne pouvez pas vous retirer vous-même de la paie.",
          code: "CANNOT_REMOVE_SELF",
        });
      }

      const { rows } = await pool.query(
        `UPDATE users
            SET is_active = FALSE, updated_at = now()
          WHERE id = $1 AND company_id = $2
          RETURNING id, fullname, email, is_active, company_id`,
        [Number(req.params.id) || 0, companyId]
      );

      /* Un identifiant d'une autre entreprise répond « introuvable » : dire
         « interdit » confirmerait déjà que ce salarié existe ailleurs. */
      if (!rows[0]) {
        return res.status(404).json({ error: "Salarié introuvable.", code: "EMPLOYEE_NOT_FOUND" });
      }

      if (typeof logActivity === "function") {
        await logActivity(
          req.user?.fullname || "Administrateur",
          req.user?.role || "admin",
          "Retrait salarié",
          "Paie",
          `${rows[0].fullname} retiré de la paie de l'entreprise ${companyId}`
        ).catch(() => {});
      }

      res.json({
        success: true,
        employee: rows[0],
        message: `${rows[0].fullname} a été retiré de l'entreprise. ` +
                 `Ses paies, avances et heures déjà enregistrées sont conservées.`,
        historique_conserve: true,
      });
    } catch (e) { echec(res, e, "Erreur de retrait du salarié."); }
  });

  return router;
};

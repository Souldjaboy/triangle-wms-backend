"use strict";

/**
 * LE CALENDRIER ADMINISTRATIF — jours fériés, jours chômés, journées
 * exceptionnelles.
 *
 *   GET    /pointage/calendrier/types            le catalogue des types
 *   GET    /pointage/calendrier                  les journées d'un intervalle
 *   POST   /pointage/calendrier                  déclarer une journée
 *   PATCH  /pointage/calendrier/:id              corriger une journée
 *   POST   /pointage/calendrier/:id/desactiver   la retirer sans l'effacer
 *   GET    /pointage/calendrier/:id/audit        son histoire complète
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CE QUI EST REFUSÉ, ET POURQUOI
 *
 * Une journée qui a DÉJÀ participé à une paie soumise, autorisée ou payée ne
 * se modifie pas en silence : la modifier changerait un net déjà annoncé, et
 * personne ne saurait pourquoi le bulletin de septembre ne correspond plus au
 * bulletin imprimé en septembre. La correction reste possible — une erreur doit
 * pouvoir se réparer — mais elle est explicite, motivée, réservée au super
 * administrateur relu en base, et tracée comme correction rétroactive.
 *
 * Une paie déjà PAYÉE, elle, ne se corrige pas du tout par ce chemin : l'argent
 * est sorti. Ce qui doit être rattrapé le sera sur la période suivante, par un
 * élément de paie qui porte son motif.
 */

const express = require("express");
const JS = require("../services/jours-speciaux");

/* Les états dans lesquels une paie n'est plus un brouillon. */
const PAIE_ENGAGEE = ["EN_ATTENTE_DIRECTION", "VALIDEE_DIRECTION",
                      "AUTORISEE_AU_PAIEMENT", "PARTIALLY_PAID", "PAID"];

module.exports = function createPointageCalendrierRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission, logActivity } = deps;
  const router = express.Router();

  const garde = (action) => (
    typeof requirePermission === "function"
      ? requirePermission("pointage.calendrier", action)
      : (_req, res) => res.status(503).json({
          error: "Contrôle des droits indisponible.", code: "PERMISSION_CHECK_MISSING" })
  );
  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const nomDe = (req) => req.user?.fullname || req.user?.email || "Utilisateur";
  const requireCompany = (req, res) => {
    const id = companyOf(req);
    if (!id) { res.status(409).json({ error: "Entreprise active requise.", code: "COMPANY_REQUIRED" }); return 0; }
    return id;
  };
  const erreur = (message, code, httpStatus = 400) =>
    Object.assign(new Error(message), { code, httpStatus });
  const fail = (res, e, secours) => {
    if (!e.httpStatus) console.error(secours, e);
    res.status(e.httpStatus || 500).json({ error: e.message || secours, code: e.code });
  };
  const jourValide = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

  /** L'état de la paie qui couvre cette date, s'il y en a une. */
  async function paieCouvrant(client, companyId, date) {
    const { rows } = await client.query(
      `SELECT p.code, p.status AS periode_status, r.id AS run_id, r.status AS run_status,
              (SELECT count(*)::int FROM attendance_payroll_items_v2 i
                WHERE i.payroll_run_id = r.id AND i.status = 'PAID') AS lignes_payees
         FROM attendance_periods p
         LEFT JOIN attendance_payroll_runs_v2 r ON r.period_id = p.id
        WHERE p.company_id = $1 AND $2::date BETWEEN p.date_debut AND p.date_fin
        ORDER BY r.id DESC NULLS LAST LIMIT 1`,
      [companyId, date]
    );
    return rows[0] || null;
  }

  async function tracer(client, { companyId, journee, action, avant, apres, motif, req, paie }) {
    await client.query(
      `INSERT INTO attendance_special_day_audit
         (company_id, special_day_id, day_date, action, avant, apres, motif,
          portee, traitement_salarial, paie_concernee, par, par_nom)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [companyId, journee?.id || null, journee?.day_date || null, action,
       avant ? JSON.stringify(avant) : null, apres ? JSON.stringify(apres) : null,
       String(motif || ""), String(journee?.portee || ""),
       String(journee?.traitement_si_travaille || ""),
       paie ? `${paie.code || ""} run=${paie.run_status || "aucune"}` : "",
       req.user?.id || null, nomDe(req)]
    );
  }

  /** Les cibles d'une portée, validées et rattachées à la bonne société. */
  async function poserCibles(client, { companyId, journeeId, portee, cibles }) {
    await client.query(`DELETE FROM attendance_special_day_targets WHERE special_day_id = $1`, [journeeId]);
    if (portee === "ENTREPRISE") return 0;

    const liste = Array.isArray(cibles) ? cibles : [];
    if (!liste.length) {
      throw erreur(`Une portée « ${portee} » sans cible ne désigne personne.`, "SCOPE_TARGETS_REQUIRED", 400);
    }
    let posees = 0;
    for (const c of liste) {
      if (portee === "SITE" || portee === "ENTREPOT") {
        const { rows } = await client.query(
          `SELECT id FROM attendance_work_sites WHERE id = $1 AND company_id = $2`,
          [Number(c) || 0, companyId]);
        if (!rows[0]) throw erreur("Site introuvable dans cette entreprise.", "SITE_NOT_FOUND", 404);
        await client.query(
          `INSERT INTO attendance_special_day_targets (special_day_id, company_id, site_id)
           VALUES ($1,$2,$3)`, [journeeId, companyId, rows[0].id]);
      } else if (portee === "SALARIES") {
        const { rows } = await client.query(
          `SELECT id FROM attendance_employees WHERE id = $1 AND company_id = $2`,
          [Number(c) || 0, companyId]);
        if (!rows[0]) throw erreur("Salarié introuvable dans cette entreprise.", "EMPLOYEE_NOT_FOUND", 404);
        await client.query(
          `INSERT INTO attendance_special_day_targets (special_day_id, company_id, employee_id)
           VALUES ($1,$2,$3)`, [journeeId, companyId, rows[0].id]);
      } else if (portee === "SERVICE") {
        const v = String(c || "").trim();
        if (!v) throw erreur("Service vide.", "SCOPE_TARGETS_REQUIRED", 400);
        await client.query(
          `INSERT INTO attendance_special_day_targets (special_day_id, company_id, service)
           VALUES ($1,$2,$3)`, [journeeId, companyId, v]);
      } else if (portee === "CATEGORIE") {
        const v = String(c || "").trim();
        if (!v) throw erreur("Catégorie vide.", "SCOPE_TARGETS_REQUIRED", 400);
        await client.query(
          `INSERT INTO attendance_special_day_targets (special_day_id, company_id, categorie)
           VALUES ($1,$2,$3)`, [journeeId, companyId, v]);
      }
      posees += 1;
    }
    return posees;
  }

  /**
   * Les champs de traitement.
   *
   * `corps` est ce que la requête DEMANDE, `base` ce qui existait déjà (les
   * défauts du type à la création, la journée elle-même à la modification). La
   * distinction compte : à la modification, passer `est_paye: false` seul doit
   * faire suivre l'impact salarial. En relisant l'ancien `impact_salaire` comme
   * s'il avait été demandé, on obtenait une journée « non payée » au salaire
   * « maintenu » — une contradiction que la base refusait par une erreur 500
   * qui ne nommait pas le problème.
   */
  async function traitementDe(client, corps, type, base = null) {
    const donne = (champ) => Object.prototype.hasOwnProperty.call(corps || {}, champ)
      && corps[champ] !== undefined && corps[champ] !== null && corps[champ] !== "";
    const bool = (champ, defaut) => (donne(champ) ? corps[champ] === true || corps[champ] === "true" : defaut);
    const est_chome = bool("est_chome", base ? base.est_chome : type.defaut_est_chome);
    const est_paye = bool("est_paye", base ? base.est_paye : type.defaut_est_paye);
    const pointage_requis = bool("pointage_requis", base ? base.pointage_requis : type.defaut_pointage_requis);

    /* L'impact salarial DÉCOULE de « payée ou non » quand il n'est pas demandé
       explicitement : une journée non payée retient un jour. Il reste réglable,
       parce qu'une journée non payée peut aussi n'avoir aucun effet — un salarié
       mensualisé dont la convention l'exclut, par exemple. */
    const impactSalaireHerite = base && base.est_paye === est_paye
      ? base.impact_salaire : (est_paye ? type.defaut_impact_salaire : "RETENUE_JOUR");
    const impact_salaire = String(donne("impact_salaire")
      ? corps.impact_salaire : impactSalaireHerite).toUpperCase();
    const impactAbsenceHerite = base && base.pointage_requis === pointage_requis
      ? base.impact_absence : (pointage_requis ? "NORMALE" : type.defaut_impact_absence);
    const impact_absence = String(donne("impact_absence")
      ? corps.impact_absence : impactAbsenceHerite).toUpperCase();
    const traitement = String(donne("traitement_si_travaille")
      ? corps.traitement_si_travaille
      : (base ? base.traitement_si_travaille : "AUCUN")).toUpperCase();

    /* Une contradiction demandée explicitement se dit en clair, plutôt que de
       remonter comme une violation de contrainte que personne ne peut lire. */
    if (est_paye && impact_salaire === "RETENUE_JOUR") {
      throw erreur(
        "Une journée déclarée payée ne peut pas retenir un jour de salaire : choisissez « non payée », ou un impact salarial sans retenue.",
        "TREATMENT_CONTRADICTORY", 400);
    }
    if (!est_paye && impact_salaire === "MAINTENU") {
      throw erreur(
        "Une journée déclarée non payée ne peut pas maintenir le salaire : choisissez « payée », ou un impact salarial de retenue.",
        "TREATMENT_CONTRADICTORY", 400);
    }

    let typeElement = donne("compensation_type_key") ? String(corps.compensation_type_key) : null;
    if (typeElement) {
      const { rows } = await client.query(
        `SELECT type_key FROM payroll_element_types WHERE type_key = $1 AND is_active`, [typeElement]);
      if (!rows[0]) throw erreur("Type d'élément de paie inconnu.", "ELEMENT_TYPE_UNKNOWN", 400);
    }
    return {
      est_chome, est_paye, pointage_requis, impact_absence, impact_salaire,
      traitement_si_travaille: traitement,
      compensation_montant: donne("compensation_montant")
        ? Number(corps.compensation_montant) : (base ? base.compensation_montant : null),
      compensation_taux: donne("compensation_taux")
        ? Number(corps.compensation_taux) : (base ? base.compensation_taux : null),
      compensation_type_key: typeElement || (base ? base.compensation_type_key : null),
      compensation_note: donne("compensation_note")
        ? String(corps.compensation_note).trim() : String(base?.compensation_note || ""),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  router.get("/pointage/calendrier/types", authenticateToken, garde("view"), async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    const client = await pool.connect();
    try {
      res.json({
        types: await JS.typesActifs(client),
        /* Les traitements possibles viennent du serveur, pas de l'écran : en
           ajouter un demain sera une ligne de données. */
        traitements: [
          { cle: "AUCUN", label: "Aucune compensation" },
          { cle: "PRIME_FIXE", label: "Prime fixe", besoin: "montant" },
          { cle: "MAJORATION", label: "Majoration du taux journalier", besoin: "taux" },
          { cle: "HEURES_SUP", label: "Heures supplémentaires", besoin: "taux_horaire" },
          { cle: "REPOS_COMPENSATEUR", label: "Repos compensateur" },
          { cle: "AUTRE", label: "Autre traitement", besoin: "montant_ou_taux" },
        ],
        portees: ["ENTREPRISE", "SITE", "ENTREPOT", "SERVICE", "CATEGORIE", "SALARIES"],
      });
    } catch (e) { fail(res, e, "Catalogue indisponible."); }
    finally { client.release(); }
  });

  /* LES CIBLES POSSIBLES D'UNE PORTÉE, servies par ce module et gardées par SA
     permission. L'écran n'a pas à passer par un endpoint d'organisation réservé
     au super administrateur pour savoir quels sites existent : qui peut
     déclarer une journée doit pouvoir en désigner le périmètre.

     Les services et les catégories viennent des fiches existantes : on ne
     demande pas de retaper un libellé qui doit correspondre au caractère près. */
  router.get("/pointage/calendrier/cibles", authenticateToken, garde("view"), async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    const client = await pool.connect();
    try {
      const [sites, salaries] = await Promise.all([
        client.query(
          `SELECT id, code, name, site_type FROM attendance_work_sites
            WHERE company_id = $1 AND active ORDER BY site_type, name`, [companyId]),
        client.query(
          `SELECT id, employee_number, full_name, site_id, service, categorie
             FROM attendance_employees
            WHERE company_id = $1 AND active ORDER BY employee_number`, [companyId]),
      ]);
      const distinct = (champ) => [...new Set(
        salaries.rows.map((e) => String(e[champ] || "").trim()).filter(Boolean))].sort();
      res.json({
        sites: sites.rows, salaries: salaries.rows,
        services: distinct("service"), categories: distinct("categorie"),
      });
    } catch (e) { fail(res, e, "Lecture des cibles impossible."); }
    finally { client.release(); }
  });

  router.get("/pointage/calendrier", authenticateToken, garde("view"), async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    const debut = jourValide(req.query.debut) ? String(req.query.debut) : null;
    const fin = jourValide(req.query.fin) ? String(req.query.fin) : null;
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        `SELECT s.*, t.label AS type_label,
                COALESCE(array_agg(DISTINCT c.site_id)     FILTER (WHERE c.site_id IS NOT NULL), '{}')     AS sites,
                COALESCE(array_agg(DISTINCT c.employee_id) FILTER (WHERE c.employee_id IS NOT NULL), '{}') AS salaries,
                COALESCE(array_agg(DISTINCT c.service)     FILTER (WHERE NULLIF(BTRIM(c.service), '') IS NOT NULL), '{}')   AS services,
                COALESCE(array_agg(DISTINCT c.categorie)   FILTER (WHERE NULLIF(BTRIM(c.categorie), '') IS NOT NULL), '{}') AS categories
           FROM attendance_special_days s
           JOIN attendance_special_day_types t ON t.type_key = s.type_key
           LEFT JOIN attendance_special_day_targets c ON c.special_day_id = s.id
          WHERE s.company_id = $1
            AND ($2::date IS NULL OR s.day_date >= $2::date)
            AND ($3::date IS NULL OR s.day_date <= $3::date)
          GROUP BY s.id, t.label
          ORDER BY s.day_date DESC, s.id DESC`,
        [companyId, debut, fin]
      );
      res.json({ journees: rows });
    } catch (e) { fail(res, e, "Lecture du calendrier impossible."); }
    finally { client.release(); }
  });

  router.post("/pointage/calendrier", authenticateToken, garde("create"), async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const date = String(req.body?.day_date || "").trim();
      if (!jourValide(date)) throw erreur("Date attendue au format AAAA-MM-JJ.", "DATE_INVALID", 400);
      const label = String(req.body?.label || "").trim();
      if (label.length < 3) throw erreur("Libellé obligatoire.", "LABEL_REQUIRED", 400);

      const { rows: types } = await client.query(
        `SELECT * FROM attendance_special_day_types WHERE type_key = $1 AND is_active`,
        [String(req.body?.type_key || "")]);
      const type = types[0];
      if (!type) throw erreur("Type de journée inconnu.", "DAY_TYPE_UNKNOWN", 400);

      const description = String(req.body?.description || "").trim();
      if (type.motif_obligatoire && description.length < 10) {
        throw erreur(
          "Motif obligatoire (10 caractères minimum) : une journée chômée se relit des mois plus tard.",
          "REASON_REQUIRED", 400);
      }
      const portee = String(req.body?.portee || "ENTREPRISE").toUpperCase();
      const t = await traitementDe(client, req.body || {}, type, null);

      /* Une journée qui tomberait dans une paie déjà engagée ne se déclare pas
         plus librement qu'elle ne se modifie : elle changerait un net annoncé. */
      const paie = await paieCouvrant(client, companyId, date);
      if (paie && PAIE_ENGAGEE.includes(String(paie.run_status || ""))) {
        throw erreur(
          `La paie de la période ${paie.code} est « ${paie.run_status} » : déclarer une journée dans cette période changerait un net déjà annoncé. Retirez la soumission, ou déclarez la journée sur la période suivante.`,
          "PAYROLL_ALREADY_ENGAGED", 409);
      }

      const { rows: creees } = await client.query(
        `INSERT INTO attendance_special_days
           (company_id, day_date, label, type_key, description, decision_reference,
            est_chome, est_paye, pointage_requis, impact_absence, impact_salaire,
            portee, traitement_si_travaille, compensation_montant, compensation_taux,
            compensation_type_key, compensation_note, created_by, created_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING *`,
        [companyId, date, label, type.type_key, description,
         String(req.body?.decision_reference || "").trim(),
         t.est_chome, t.est_paye, t.pointage_requis, t.impact_absence, t.impact_salaire,
         portee, t.traitement_si_travaille, t.compensation_montant, t.compensation_taux,
         t.compensation_type_key, t.compensation_note, req.user?.id || null, nomDe(req)]
      );
      const journee = creees[0];
      await poserCibles(client, { companyId, journeeId: journee.id, portee, cibles: req.body?.cibles });
      await tracer(client, { companyId, journee, action: "CREATION", avant: null,
                             apres: journee, motif: description, req, paie });
      await client.query("COMMIT");
      if (typeof logActivity === "function") {
        await logActivity(nomDe(req), req.user?.role, "Déclaration d'une journée spéciale", "Pointage",
          `${date} — ${label} — ${type.type_key} — portée ${portee} — entreprise ${companyId}`).catch(() => {});
      }
      res.status(201).json({ journee, message: "Journée enregistrée. Le calendrier s'applique au prochain calcul de paie." });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e.code === "23505") {
        return res.status(409).json({
          error: "Une journée concernant toute l'entreprise existe déjà à cette date.",
          code: "DAY_ALREADY_DECLARED" });
      }
      fail(res, e, "Déclaration impossible.");
    } finally { client.release(); }
  });

  router.patch("/pointage/calendrier/:id", authenticateToken, garde("update"), async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: avantRows } = await client.query(
        `SELECT * FROM attendance_special_days WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [Number(req.params.id), companyId]);
      const avant = avantRows[0];
      if (!avant) throw erreur("Journée introuvable.", "DAY_NOT_FOUND", 404);

      const motif = String(req.body?.reason || "").trim();
      if (motif.length < 10) {
        throw erreur("Motif de la modification obligatoire (10 caractères minimum).", "REASON_REQUIRED", 400);
      }
      await garantirCorrectionAutorisee(client, { companyId, avant, req, motif });

      const { rows: types } = await client.query(
        `SELECT * FROM attendance_special_day_types WHERE type_key = $1 AND is_active`,
        [String(req.body?.type_key || avant.type_key)]);
      const type = types[0];
      if (!type) throw erreur("Type de journée inconnu.", "DAY_TYPE_UNKNOWN", 400);
      const t = await traitementDe(client, req.body || {}, type, avant);
      const portee = String(req.body?.portee || avant.portee).toUpperCase();

      const { rows: majRows } = await client.query(
        `UPDATE attendance_special_days
            SET label = $1, type_key = $2, description = $3, decision_reference = $4,
                est_chome = $5, est_paye = $6, pointage_requis = $7,
                impact_absence = $8, impact_salaire = $9, portee = $10,
                traitement_si_travaille = $11, compensation_montant = $12,
                compensation_taux = $13, compensation_type_key = $14,
                compensation_note = $15, updated_by = $16, updated_by_name = $17,
                updated_at = now()
          WHERE id = $18 RETURNING *`,
        [String(req.body?.label || avant.label).trim(), type.type_key,
         String(req.body?.description ?? avant.description).trim(),
         String(req.body?.decision_reference ?? avant.decision_reference).trim(),
         t.est_chome, t.est_paye, t.pointage_requis, t.impact_absence, t.impact_salaire,
         portee, t.traitement_si_travaille, t.compensation_montant, t.compensation_taux,
         t.compensation_type_key, t.compensation_note,
         req.user?.id || null, nomDe(req), avant.id]
      );
      const apres = majRows[0];
      if (req.body?.cibles !== undefined || portee !== avant.portee) {
        await poserCibles(client, { companyId, journeeId: avant.id, portee, cibles: req.body?.cibles });
      }
      const paie = await paieCouvrant(client, companyId, avant.day_date);
      await tracer(client, { companyId, journee: apres, motif, req, paie,
        action: req.body?.correction_controlee === true ? "CORRECTION_CONTROLEE" : "MODIFICATION",
        avant, apres });
      await client.query("COMMIT");
      res.json({ journee: apres, message: "Journée modifiée. Recalculez la paie de la période pour appliquer le changement." });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      fail(res, e, "Modification impossible.");
    } finally { client.release(); }
  });

  router.post("/pointage/calendrier/:id/desactiver", authenticateToken, garde("delete"), async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: avantRows } = await client.query(
        `SELECT * FROM attendance_special_days WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [Number(req.params.id), companyId]);
      const avant = avantRows[0];
      if (!avant) throw erreur("Journée introuvable.", "DAY_NOT_FOUND", 404);
      const motif = String(req.body?.reason || "").trim();
      if (motif.length < 10) {
        throw erreur("Motif du retrait obligatoire (10 caractères minimum).", "REASON_REQUIRED", 400);
      }
      await garantirCorrectionAutorisee(client, { companyId, avant, req, motif });

      /* Désactivée, jamais supprimée : ce qui a été décidé un jour doit rester
         lisible, même quand on le défait. */
      const { rows } = await client.query(
        `UPDATE attendance_special_days
            SET status = 'INACTIF', updated_by = $1, updated_by_name = $2, updated_at = now()
          WHERE id = $3 RETURNING *`, [req.user?.id || null, nomDe(req), avant.id]);
      const paie = await paieCouvrant(client, companyId, avant.day_date);
      await tracer(client, { companyId, journee: rows[0], action: "DESACTIVATION",
                             avant, apres: rows[0], motif, req, paie });
      await client.query("COMMIT");
      res.json({ journee: rows[0], message: "Journée retirée du calendrier. Elle reste lisible dans l'historique." });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      fail(res, e, "Retrait impossible.");
    } finally { client.release(); }
  });

  router.get("/pointage/calendrier/:id/audit", authenticateToken, garde("view"), async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        `SELECT * FROM attendance_special_day_audit
          WHERE company_id = $1 AND special_day_id = $2 ORDER BY le DESC, id DESC`,
        [companyId, Number(req.params.id)]);
      res.json({ audit: rows });
    } catch (e) { fail(res, e, "Historique indisponible."); }
    finally { client.release(); }
  });

  /**
   * LA PROTECTION CONTRE LA CORRECTION RÉTROACTIVE SILENCIEUSE.
   *
   * Trois degrés, du plus permissif au plus fermé :
   *   • la paie de la période est un brouillon → on corrige librement ;
   *   • elle est soumise, validée ou autorisée → il faut le dire explicitement
   *     (`correction_controlee`), un motif circonstancié, et le privilège de
   *     super administrateur relu EN BASE ;
   *   • un seul salaire a déjà été PAYÉ → on ne corrige pas. L'argent est
   *     sorti ; le rattrapage se fait sur la période suivante, par un élément
   *     de paie qui porte son motif.
   */
  async function garantirCorrectionAutorisee(client, { companyId, avant, req, motif }) {
    const paie = await paieCouvrant(client, companyId, avant.day_date);
    if (!paie) return;
    if (Number(paie.lignes_payees || 0) > 0) {
      throw erreur(
        `La paie de la période ${paie.code} comporte ${paie.lignes_payees} salaire(s) déjà payé(s) : cette journée ne se corrige plus. Le rattrapage se fait sur la période suivante, par un élément de paie motivé.`,
        "PAYROLL_ALREADY_PAID", 409);
    }
    if (!PAIE_ENGAGEE.includes(String(paie.run_status || ""))) return;

    if (req.body?.correction_controlee !== true) {
      throw erreur(
        `La paie de la période ${paie.code} est « ${paie.run_status} » : modifier cette journée changerait un net déjà annoncé. Confirmez une correction contrôlée si c'est bien l'intention.`,
        "RETROACTIVE_CORRECTION_REQUIRED", 409);
    }
    if (motif.length < 20) {
      throw erreur(
        "Une correction rétroactive demande un motif circonstancié (20 caractères minimum).",
        "REASON_TOO_SHORT", 400);
    }
    const { rows } = await client.query(
      `SELECT is_super_admin FROM users WHERE id = $1`, [req.user?.id || 0]);
    if (rows[0]?.is_super_admin !== true) {
      throw erreur(
        "Une correction rétroactive du calendrier est réservée au super administrateur.",
        "RETROACTIVE_CORRECTION_FORBIDDEN", 403);
    }
  }

  return router;
};

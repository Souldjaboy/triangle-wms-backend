"use strict";

/**
 * LE CHEMIN D'UNE PAIE, DU POINTAGE VALIDÉ AU BON SIGNÉ.
 *
 *   GET  /paie/periodes                        les périodes de la société
 *   POST /paie/periodes/:code/ouvrir           ouvrir (et combler les trous)
 *   POST /paie/periodes/:code/valider-pointage Awa / le responsable valide
 *   POST /paie/periodes/:code/rouvrir          rouvrir, motif obligatoire
 *   POST /paie/periodes/:code/cloturer         clôturer après paiement complet
 *
 *   POST /paie/runs/:id/soumettre              le comptable saisit la Direction
 *   POST /paie/runs/:id/decision               la Direction tranche
 *   POST /paie/lignes/:id/ajuster              la Direction corrige un montant
 *   POST /paie/lignes/:id/bon                  émettre le bon numéroté
 *   GET  /paie/lignes/:id/bon                  relire le bon figé
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CE QUI REND LE PASSAGE PAR LA DIRECTION OBLIGATOIRE
 *
 * Pas le rôle de celui qui clique — un rôle se change à l'écran des droits —
 * mais l'état d'un objet que quelqu'un d'AUTRE a dû toucher : la route de
 * paiement exige une `payroll_requests` VALIDEE. Le comptable ne peut donc
 * pas s'autoriser lui-même, même si on lui accordait par erreur le droit de
 * valider : la validation et la soumission sont deux gestes, et le second
 * refuse d'être posé par l'auteur du premier.
 */

const express = require("express");
const P = require("../services/attendance-periodes");
const PAIE = require("../services/attendance-payroll");
const AV = require("../services/avances-salaire");

module.exports = function createPaieWorkflowRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission, nextAccountingNumber } = deps;
  const router = express.Router();

  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const nomDe = (req) => req.user?.fullname || req.user?.email || "Utilisateur";
  const requireCompany = (req, res) => {
    const id = companyOf(req);
    if (!id) { res.status(409).json({ error: "Entreprise active requise.", code: "COMPANY_REQUIRED" }); return 0; }
    return id;
  };
  const fail = (res, e, secours) => {
    if (!e.httpStatus) console.error(secours, e);
    res.status(e.httpStatus || 500).json({ error: e.message || secours, code: e.code });
  };
  const motifDe = (req, minimum = 3) => {
    const m = String(req.body?.reason || req.body?.motif || "").trim();
    if (m.length < minimum) {
      throw P.erreur("Un motif est obligatoire.", "REASON_REQUIRED", 400);
    }
    return m;
  };

  async function chargerPeriode(client, companyId, code, pourEcriture = false) {
    const { rows } = await client.query(
      `SELECT * FROM attendance_periods WHERE company_id = $1 AND code = $2
       ${pourEcriture ? "FOR UPDATE" : ""}`,
      [companyId, code]
    );
    if (!rows[0]) throw P.erreur(`Période ${code} non ouverte.`, "PERIOD_NOT_FOUND", 404);
    return rows[0];
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LES PÉRIODES
  // ═══════════════════════════════════════════════════════════════════════
  router.get(
    "/paie/periodes",
    authenticateToken,
    requirePermission("pointage.periode", "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const { rows } = await pool.query(
          `SELECT p.*, p.date_debut::text AS debut, p.date_fin::text AS fin,
                  u.fullname AS validee_par,
                  (SELECT count(*)::int FROM attendance_payroll_runs_v2 r WHERE r.period_id = p.id) AS paies
             FROM attendance_periods p
             LEFT JOIN users u ON u.id = p.attendance_validated_by
            WHERE p.company_id = $1
            ORDER BY p.date_debut DESC
            LIMIT 36`,
          [companyId]
        );
        res.json({ periodes: rows });
      } catch (e) { fail(res, e, "Impossible de lire les périodes."); }
    }
  );

  router.post(
    "/paie/periodes/:code/ouvrir",
    authenticateToken,
    requirePermission("pointage.periode", "create"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        /* Verrou par société : deux ouvertures simultanées ne doivent pas
           créer deux fois les périodes intermédiaires. */
        await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [812_000, companyId]);
        const periode = await P.garantirPeriode(client, companyId, String(req.params.code));
        await client.query("COMMIT");
        res.status(201).json({
          periode: { ...periode, debut: String(periode.date_debut).slice(0, 10), fin: String(periode.date_fin).slice(0, 10) },
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Ouverture de la période impossible.");
      } finally { client.release(); }
    }
  );

  router.post(
    "/paie/periodes/:code/valider-pointage",
    authenticateToken,
    requirePermission("pointage.periode", "validate"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const periode = await chargerPeriode(client, companyId, String(req.params.code), true);

        /* Une période OUVERTE passe d'abord en révision : valider sans avoir
           contrôlé n'a pas de sens, et la machine à états le dit plutôt que
           de compter sur l'habitude. */
        const depuis = periode.status === "OUVERTE" ? "EN_REVISION_POINTAGE" : periode.status;
        if (periode.status === "OUVERTE") {
          P.assertTransition("OUVERTE", "EN_REVISION_POINTAGE");
        }
        P.assertTransition(depuis, "POINTAGE_VALIDE");

        const { rows } = await client.query(
          `UPDATE attendance_periods
              SET status = 'POINTAGE_VALIDE', attendance_validated_by = $1,
                  attendance_validated_at = now(), updated_at = now()
            WHERE id = $2 RETURNING *`,
          [req.user?.id || null, periode.id]
        );
        await client.query("COMMIT");
        res.json({ periode: rows[0], message: "Pointage validé : la paie peut être préparée." });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Validation du pointage impossible.");
      } finally { client.release(); }
    }
  );

  router.post(
    "/paie/periodes/:code/rouvrir",
    authenticateToken,
    requirePermission("pointage.periode", "reopen"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        const motif = motifDe(req);
        await client.query("BEGIN");
        const periode = await chargerPeriode(client, companyId, String(req.params.code), true);
        P.assertTransition(periode.status, "EN_REVISION_POINTAGE");
        const { rows } = await client.query(
          `UPDATE attendance_periods
              SET status = 'EN_REVISION_POINTAGE', reopened_by = $1, reopened_at = now(),
                  reopen_reason = $2, updated_at = now()
            WHERE id = $3 RETURNING *`,
          [req.user?.id || null, motif, periode.id]
        );
        await client.query("COMMIT");
        res.json({ periode: rows[0], message: "Période rouverte pour correction." });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Réouverture impossible.");
      } finally { client.release(); }
    }
  );

  router.post(
    "/paie/periodes/:code/cloturer",
    authenticateToken,
    requirePermission("pointage.periode", "close"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const periode = await chargerPeriode(client, companyId, String(req.params.code), true);

        /* Clôturer une période dont des salaires restent à payer ferait
           disparaître de l'écran ce que quelqu'un attend encore. */
        const { rows: restants } = await client.query(
          `SELECT count(*)::int AS n
             FROM attendance_payroll_items_v2 i
             JOIN attendance_payroll_runs_v2 r ON r.id = i.payroll_run_id
            WHERE r.period_id = $1 AND i.status IN ('TO_PAY', 'BLOCKED')`,
          [periode.id]
        );
        if (Number(restants[0].n) > 0) {
          throw P.erreur(
            `${restants[0].n} salaire(s) ne sont pas encore payés : la période ne peut pas être clôturée.`,
            "PERIOD_HAS_UNPAID", 409
          );
        }

        P.assertTransition(periode.status, "CLOTUREE");
        const { rows } = await client.query(
          `UPDATE attendance_periods
              SET status = 'CLOTUREE', closed_by = $1, closed_at = now(), updated_at = now()
            WHERE id = $2 RETURNING *`,
          [req.user?.id || null, periode.id]
        );
        await client.query("COMMIT");
        res.json({ periode: rows[0] });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Clôture impossible.");
      } finally { client.release(); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  // PRÉPARER LA PAIE D'UNE PÉRIODE RÉELLE
  //
  // L'ancien point d'entrée (`/attendance-v2/payroll/:month/generate`) calcule
  // sur un mois CIVIL. L'écran, lui, annonce une période du 25 au 24 : les
  // deux ne couvrent pas les mêmes journées, et personne ne pouvait le voir
  // sans recompter à la main. Une présence du 25 août tombait hors de la paie
  // de septembre, alors qu'elle en fait partie.
  //
  // Cette route part des bornes ENREGISTRÉES de la période, exige que le
  // pointage ait été validé, et rattache la paie à sa période — ce que
  // l'ancienne route ne faisait pas, laissant une paie orpheline que le verrou
  // de paiement traitait ensuite comme une paie historique.
  // ═══════════════════════════════════════════════════════════════════════
  router.post(
    "/paie/periodes/:code/preparer",
    authenticateToken,
    requirePermission("paie", "prepare"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        /* Verrou par société et par période : deux préparations simultanées
           ne doivent pas produire deux paies pour la même période. */
        await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [813_000, companyId]);

        const { rows: periodes } = await client.query(
          `SELECT *, date_debut::text AS debut, date_fin::text AS fin
             FROM attendance_periods
            WHERE company_id = $1 AND code = $2
            FOR UPDATE`,
          [companyId, String(req.params.code)]
        );
        const periode = periodes[0];
        if (!periode) {
          throw P.erreur(
            `La période ${req.params.code} n'est pas ouverte. Ouvrez-la avant de préparer la paie.`,
            "PERIOD_NOT_FOUND", 404);
        }

        /* Préparer une paie sur un pointage non validé, c'est payer des
           journées que personne n'a contrôlées. */
        const ETATS_PRETS = [
          "POINTAGE_VALIDE", "PAIE_PREPAREE", "EN_ATTENTE_DIRECTION",
          "VALIDEE_DIRECTION", "AUTORISEE_AU_PAIEMENT",
        ];
        if (!ETATS_PRETS.includes(periode.status)) {
          throw P.erreur(
            `Le pointage de cette période n'est pas validé (état « ${periode.status} »). Validez-le avant de préparer la paie.`,
            "ATTENDANCE_NOT_VALIDATED", 409);
        }

        const { rows: existantes } = await client.query(
          `SELECT * FROM attendance_payroll_runs_v2
            WHERE company_id = $1 AND period_id = $2 FOR UPDATE`,
          [companyId, periode.id]
        );
        const existante = existantes[0] || null;
        if (existante && !["DRAFT", "CORRECTION_DEMANDEE", "REFUSEE"].includes(existante.status)) {
          throw P.erreur(
            `Une paie « ${existante.status} » ne se recalcule pas : elle a déjà suivi son chemin.`,
            "PAYROLL_LOCKED", 409);
        }

        const lignes = await PAIE.calculerPaiePeriode(client, companyId, {
          date_debut: periode.debut, date_fin: periode.fin,
        });
        if (!lignes.length) {
          throw P.erreur("Aucun employé actif sur cette période.", "NO_EMPLOYEE", 409);
        }

        /* `period_month` reste renseigné — la colonne est NOT NULL et les
           écrans historiques la lisent — mais c'est `period_id` qui fait foi. */
        const ancrage = `${String(periode.code).slice(0, 7)}-01`;
        const { rows: paies } = await client.query(
          `INSERT INTO attendance_payroll_runs_v2
             (company_id, period_id, period_month, status, prepared_by, prepared_at)
           VALUES ($1,$2,$3::date,'DRAFT',$4, now())
           ON CONFLICT (company_id, period_month) DO UPDATE
             SET period_id = EXCLUDED.period_id, prepared_by = EXCLUDED.prepared_by,
                 prepared_at = now(), status = 'DRAFT', updated_at = now()
           RETURNING *`,
          [companyId, periode.id, ancrage, req.user?.id || null]
        );
        const paie = paies[0];

        /* Régénérer efface les lignes — donc les retenues d'avance qu'elles
           portaient. On les rend au solde avant de supprimer, sinon préparer
           deux fois retiendrait deux fois la même échéance. */
        const { rows: retenues } = await client.query(
          `SELECT r.id, r.advance_id, r.installment_id, r.amount
             FROM salary_advance_repayments r
             JOIN attendance_payroll_items_v2 i ON i.id = r.payroll_item_id
            WHERE i.payroll_run_id = $1 AND r.origin = 'RETENUE_PAIE'`,
          [paie.id]
        );
        for (const retenue of retenues) {
          await client.query(
            `UPDATE salary_advances
                SET balance = balance + $1,
                    status = CASE WHEN balance + $1 >= amount_paid THEN 'VERSEE' ELSE 'EN_REMBOURSEMENT' END,
                    updated_at = now()
              WHERE id = $2`, [retenue.amount, retenue.advance_id]);
          if (retenue.installment_id) {
            await client.query(
              `UPDATE salary_advance_installments
                  SET amount_taken = GREATEST(0, amount_taken - $1), status = 'A_VENIR', updated_at = now()
                WHERE id = $2`, [retenue.amount, retenue.installment_id]);
          }
        }
        await client.query(
          `DELETE FROM salary_advance_repayments
            WHERE origin = 'RETENUE_PAIE' AND payroll_item_id IN
              (SELECT id FROM attendance_payroll_items_v2 WHERE payroll_run_id = $1)`,
          [paie.id]);
        await client.query(
          `DELETE FROM attendance_payroll_items_v2 WHERE payroll_run_id = $1`, [paie.id]);

        for (const l of lignes) {
          const { rows: creees } = await client.query(
            `INSERT INTO attendance_payroll_items_v2
               (company_id, payroll_run_id, employee_id, employee_name, monthly_salary,
                daily_rate, expected_days, attended_days, absence_days, late_minutes,
                absence_deduction, adjustments, net_salary, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             RETURNING id, net_salary`,
            [companyId, paie.id, l.id, l.full_name, l.monthly_salary, l.daily_rate,
             l.expected_days, l.attended_days, l.absence_days, l.late_minutes,
             l.absence_deduction, l.adjustments, l.net_salary, l.status]
          );
          const ligne = creees[0];

          if (ligne.net_salary != null) {
            const dues = await AV.retenueDue(client, {
              companyId, employeeId: l.id, periodCode: periode.code,
              netDisponible: Number(ligne.net_salary),
            });
            let total = 0;
            for (const d of dues) {
              await AV.rembourser(client, {
                companyId, advanceId: d.advance_id, montant: d.montant,
                origine: "RETENUE_PAIE", installmentId: d.installment_id,
                payrollItemId: ligne.id, reference: d.reference,
                userId: req.user?.id || null, userName: nomDe(req),
              });
              total += d.montant;
            }
            if (total > 0) {
              await client.query(
                `UPDATE attendance_payroll_items_v2
                    SET advance_deduction = $1, net_salary = GREATEST(0, net_salary - $1), updated_at = now()
                  WHERE id = $2`, [total, ligne.id]);
            }
          }
        }

        const { rows: totaux } = await client.query(
          `UPDATE attendance_payroll_runs_v2 r
              SET gross_amount = x.brut, deductions_amount = x.retenues,
                  adjustments_amount = x.ajustements, net_amount = x.net, updated_at = now()
             FROM (SELECT payroll_run_id,
                          COALESCE(sum(monthly_salary), 0) AS brut,
                          COALESCE(sum(absence_deduction), 0) + COALESCE(sum(advance_deduction), 0) AS retenues,
                          COALESCE(sum(adjustments), 0) AS ajustements,
                          COALESCE(sum(net_salary), 0) AS net
                     FROM attendance_payroll_items_v2 WHERE payroll_run_id = $1
                    GROUP BY payroll_run_id) x
            WHERE r.id = x.payroll_run_id
            RETURNING r.*`,
          [paie.id]
        );

        await client.query(
          `UPDATE attendance_periods SET status = 'PAIE_PREPAREE', updated_at = now()
            WHERE id = $1 AND status = 'POINTAGE_VALIDE'`, [periode.id]);

        await client.query("COMMIT");
        res.status(201).json({
          paie: totaux[0] || paie,
          periode: { code: periode.code, debut: periode.debut, fin: periode.fin },
          employes: lignes,
          message: `Paie préparée sur la période du ${periode.debut} au ${periode.fin}.`,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Préparation de la paie impossible.");
      } finally { client.release(); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  // LA DEMANDE À LA DIRECTION
  // ═══════════════════════════════════════════════════════════════════════
  router.post(
    "/paie/runs/:id/soumettre",
    authenticateToken,
    requirePermission("paie", "submit"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: runs } = await client.query(
          `SELECT * FROM attendance_payroll_runs_v2
            WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [Number(req.params.id), companyId]
        );
        const run = runs[0];
        if (!run) throw P.erreur("Paie introuvable.", "PAYROLL_NOT_FOUND", 404);
        if (!["DRAFT", "CORRECTION_DEMANDEE", "REFUSEE"].includes(run.status)) {
          throw P.erreur(
            `Une paie « ${run.status} » ne se soumet pas : elle a déjà suivi son chemin.`,
            "PAYROLL_NOT_SUBMITTABLE", 409
          );
        }

        const { rows: lignes } = await client.query(
          `SELECT count(*)::int AS n, COALESCE(sum(net_salary), 0) AS total,
                  count(*) FILTER (WHERE status = 'BLOCKED')::int AS bloquees
             FROM attendance_payroll_items_v2 WHERE payroll_run_id = $1`,
          [run.id]
        );
        if (Number(lignes[0].n) === 0) {
          throw P.erreur("Cette paie ne contient aucune ligne.", "PAYROLL_EMPTY", 409);
        }
        if (Number(lignes[0].bloquees) > 0) {
          throw P.erreur(
            `${lignes[0].bloquees} salaire(s) sans montant calculable : renseignez leur salaire avant de soumettre.`,
            "PAYROLL_HAS_BLOCKED", 409
          );
        }

        const { rows: demandes } = await client.query(
          `INSERT INTO payroll_requests
             (company_id, payroll_run_id, period_id, amount_submitted,
              submitted_by, submitted_by_name)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [companyId, run.id, run.period_id, lignes[0].total, req.user?.id || null, nomDe(req)]
        );

        await client.query(
          `UPDATE attendance_payroll_runs_v2 SET status = 'EN_ATTENTE_DIRECTION', updated_at = now()
            WHERE id = $1`, [run.id]
        );
        if (run.period_id) {
          await client.query(
            `UPDATE attendance_periods SET status = 'EN_ATTENTE_DIRECTION', updated_at = now()
              WHERE id = $1 AND status IN ('POINTAGE_VALIDE', 'PAIE_PREPAREE')`,
            [run.period_id]
          );
        }

        await client.query("COMMIT");
        res.status(201).json({
          demande: demandes[0],
          message: "Demande transmise à la Direction. Le paiement reste bloqué tant qu'elle n'a pas tranché.",
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        /* Deux soumissions simultanées : l'index partiel « une seule en
           attente » refuse la seconde. Le dire clairement vaut mieux qu'une
           erreur PostgreSQL brute. */
        if (e.code === "23505") {
          return res.status(409).json({
            error: "Cette paie attend déjà une décision de la Direction.",
            code: "PAYROLL_ALREADY_SUBMITTED",
          });
        }
        fail(res, e, "Soumission impossible.");
      } finally { client.release(); }
    }
  );

  router.post(
    "/paie/runs/:id/decision",
    authenticateToken,
    requirePermission("paie", "validate"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const decision = String(req.body?.decision || "").trim().toUpperCase();
      const permises = ["VALIDEE", "REFUSEE", "CORRECTION_DEMANDEE"];
      if (!permises.includes(decision)) {
        return res.status(400).json({
          error: `Décision attendue : ${permises.join(", ")}.`, code: "DECISION_INVALID",
        });
      }

      const client = await pool.connect();
      try {
        /* Refuser ou demander une correction sans dire pourquoi laisse le
           comptable deviner. Valider, en revanche, peut se passer de motif. */
        const motif = decision === "VALIDEE"
          ? String(req.body?.reason || "").trim()
          : motifDe(req);

        await client.query("BEGIN");
        const { rows: demandes } = await client.query(
          `SELECT * FROM payroll_requests
            WHERE payroll_run_id = $1 AND company_id = $2 AND status = 'EN_ATTENTE_DIRECTION'
            FOR UPDATE`,
          [Number(req.params.id), companyId]
        );
        const demande = demandes[0];
        if (!demande) throw P.erreur("Aucune demande en attente pour cette paie.", "REQUEST_NOT_PENDING", 404);

        /* LA règle : celui qui a soumis ne décide pas. Elle ne dépend pas du
           rôle — un comptable à qui l'on accorderait par erreur le droit de
           valider resterait bloqué ici, sur sa PROPRE demande. */
        if (Number(demande.submitted_by) === Number(req.user?.id)) {
          throw P.erreur(
            "Vous avez soumis cette paie : vous ne pouvez pas la valider vous-même.",
            "SELF_APPROVAL_FORBIDDEN", 403
          );
        }

        await client.query(
          `UPDATE payroll_requests
              SET status = $1, decided_by = $2, decided_by_name = $3,
                  decided_at = now(), decision_reason = $4, updated_at = now()
            WHERE id = $5`,
          [decision, req.user?.id || null, nomDe(req), motif, demande.id]
        );

        const statutPaie = decision === "VALIDEE" ? "AUTORISEE_AU_PAIEMENT"
          : decision === "REFUSEE" ? "REFUSEE" : "CORRECTION_DEMANDEE";
        await client.query(
          `UPDATE attendance_payroll_runs_v2 SET status = $1, updated_at = now() WHERE id = $2`,
          [statutPaie, demande.payroll_run_id]
        );

        if (demande.period_id) {
          const statutPeriode = decision === "VALIDEE" ? "AUTORISEE_AU_PAIEMENT" : "PAIE_PREPAREE";
          if (decision === "VALIDEE") {
            await client.query(
              `UPDATE attendance_periods SET status = 'VALIDEE_DIRECTION', updated_at = now()
                WHERE id = $1 AND status = 'EN_ATTENTE_DIRECTION'`, [demande.period_id]);
          }
          await client.query(
            `UPDATE attendance_periods SET status = $1, updated_at = now()
              WHERE id = $2 AND status IN ('EN_ATTENTE_DIRECTION', 'VALIDEE_DIRECTION')`,
            [statutPeriode, demande.period_id]
          );
        }

        await client.query("COMMIT");
        res.json({
          decision,
          message: decision === "VALIDEE"
            ? "Paie autorisée au paiement."
            : decision === "REFUSEE"
              ? "Paie refusée. Le comptable en est informé avec le motif."
              : "Correction demandée. La paie retourne au comptable.",
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Décision impossible.");
      } finally { client.release(); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  // AJUSTER UN MONTANT — avant/après conservé
  // ═══════════════════════════════════════════════════════════════════════
  router.post(
    "/paie/lignes/:id/ajuster",
    authenticateToken,
    requirePermission("paie", "adjust"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        const motif = motifDe(req, 5);
        const nouveau = Number(req.body?.net_salary);
        if (!Number.isFinite(nouveau) || nouveau < 0) {
          throw P.erreur("Montant invalide.", "AMOUNT_INVALID", 400);
        }

        await client.query("BEGIN");
        const { rows: lignes } = await client.query(
          `SELECT * FROM attendance_payroll_items_v2
            WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [Number(req.params.id), companyId]
        );
        const ligne = lignes[0];
        if (!ligne) throw P.erreur("Ligne de paie introuvable.", "PAYROLL_ITEM_NOT_FOUND", 404);
        if (ligne.status === "PAID") {
          throw P.erreur(
            "Ce salaire est déjà payé : une correction passe par une contrepassation, pas par une réécriture.",
            "PAYROLL_ITEM_PAID", 409
          );
        }

        await client.query(
          `INSERT INTO payroll_item_adjustments
             (company_id, payroll_item_id, field, old_value, new_value, reason,
              performed_by, performed_by_name)
           VALUES ($1,$2,'net_salary',$3,$4,$5,$6,$7)`,
          [companyId, ligne.id, String(ligne.net_salary ?? ""), String(nouveau),
           motif, req.user?.id || null, nomDe(req)]
        );

        const { rows: majs } = await client.query(
          `UPDATE attendance_payroll_items_v2
              SET net_salary = $1, status = CASE WHEN status = 'BLOCKED' THEN 'TO_PAY' ELSE status END,
                  updated_at = now()
            WHERE id = $2 RETURNING *`,
          [nouveau, ligne.id]
        );

        /* Le total de la paie suit, sinon l'écran afficherait une somme qui
           ne correspond plus à ses lignes. */
        await client.query(
          `UPDATE attendance_payroll_runs_v2 r
              SET net_amount = x.net, updated_at = now()
             FROM (SELECT payroll_run_id, COALESCE(sum(net_salary), 0) AS net
                     FROM attendance_payroll_items_v2 WHERE payroll_run_id = $1
                    GROUP BY payroll_run_id) x
            WHERE r.id = x.payroll_run_id`,
          [ligne.payroll_run_id]
        );

        await client.query("COMMIT");
        res.json({
          ligne: majs[0],
          ancien: ligne.net_salary,
          nouveau,
          message: "Montant corrigé. L'ancien montant, le motif et l'auteur sont conservés.",
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Ajustement impossible.");
      } finally { client.release(); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  // LE BON DE PAIEMENT
  // ═══════════════════════════════════════════════════════════════════════
  router.post(
    "/paie/lignes/:id/bon",
    authenticateToken,
    requirePermission("paie", "print"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: lignes } = await client.query(
          `SELECT i.*, r.period_id, r.period_month::text AS mois,
                  p.code AS periode_code, p.date_debut::text AS periode_debut,
                  p.date_fin::text AS periode_fin,
                  c.name AS societe, b.bank_name, k.nom_caisse
             FROM attendance_payroll_items_v2 i
             JOIN attendance_payroll_runs_v2 r ON r.id = i.payroll_run_id
             JOIN companies c ON c.id = i.company_id
             LEFT JOIN attendance_periods p ON p.id = r.period_id
             LEFT JOIN accounting_banks b ON b.id = i.bank_id
             LEFT JOIN caisses k ON k.id = i.caisse_id
            WHERE i.id = $1 AND i.company_id = $2
            FOR UPDATE OF i`,
          [Number(req.params.id), companyId]
        );
        const ligne = lignes[0];
        if (!ligne) throw P.erreur("Ligne de paie introuvable.", "PAYROLL_ITEM_NOT_FOUND", 404);
        if (ligne.status !== "PAID") {
          throw P.erreur(
            "Le bon s'émet après le paiement : avant, il attesterait de quelque chose qui n'a pas eu lieu.",
            "PAYROLL_ITEM_NOT_PAID", 409
          );
        }

        const { rows: existants } = await client.query(
          `SELECT * FROM payroll_vouchers WHERE payroll_item_id = $1`, [ligne.id]);
        if (existants[0]) {
          await client.query("COMMIT");
          return res.json({ bon: existants[0], deja_emis: true });
        }

        const numero = await nextAccountingNumber(
          client, "payroll_vouchers", "voucher_number", "BON-SAL", companyId);

        /* Le contenu est RECOPIÉ, pas référencé : un bon signé doit dire ce
           qu'il disait le jour de la signature, même si l'employé change de
           nom ou de salaire ensuite. */
        const payload = {
          societe: ligne.societe,
          periode: ligne.periode_code
            ? { code: ligne.periode_code, du: ligne.periode_debut, au: ligne.periode_fin }
            : { mois: ligne.mois },
          employe: ligne.employee_name,
          salaire_de_base: ligne.monthly_salary,
          taux_journalier: ligne.daily_rate,
          jours_attendus: ligne.expected_days,
          jours_travailles: ligne.attended_days,
          jours_absence: ligne.absence_days,
          minutes_retard: ligne.late_minutes,
          retenue_absence: ligne.absence_deduction,
          ajustements: ligne.adjustments,
          net_paye: ligne.net_salary,
          mode: ligne.payment_method,
          reference: ligne.payment_reference,
          compte: ligne.bank_name || ligne.nom_caisse || "Trésorerie",
          paye_le: ligne.paid_at,
        };

        const { rows: bons } = await client.query(
          `INSERT INTO payroll_vouchers
             (company_id, payroll_item_id, voucher_number, payload, issued_by, issued_by_name)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [companyId, ligne.id, numero, JSON.stringify(payload), req.user?.id || null, nomDe(req)]
        );

        await client.query("COMMIT");
        res.status(201).json({ bon: bons[0], deja_emis: false });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Émission du bon impossible.");
      } finally { client.release(); }
    }
  );

  router.get(
    "/paie/lignes/:id/bon",
    authenticateToken,
    requirePermission("paie", "print"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(
          `UPDATE payroll_vouchers
              SET print_count = print_count + 1, last_printed_at = now()
            WHERE payroll_item_id = $1 AND company_id = $2
            RETURNING *`,
          [Number(req.params.id), companyId]
        );
        await client.query("COMMIT");
        if (!rows[0]) return res.status(404).json({ error: "Aucun bon émis pour ce salaire." });
        res.json({ bon: rows[0], reimpression: rows[0].print_count > 1 });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Lecture du bon impossible.");
      } finally { client.release(); }
    }
  );

  return router;
};

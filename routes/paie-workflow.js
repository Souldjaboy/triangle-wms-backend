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
const EL = require("../services/paie-elements");
const P = require("../services/attendance-periodes");
const PAIE = require("../services/attendance-payroll");
const AV = require("../services/avances-salaire");

module.exports = function createPaieWorkflowRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission, nextAccountingNumber, logActivity } = deps;
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
          /* `code` est indispensable : c'est la clé sous laquelle les primes et
             les heures supplémentaires sont rangées. Sans lui, elles existent en
             base et n'atteignent jamais le bulletin. */
          code: periode.code,
          date_debut: periode.debut, date_fin: periode.fin,
          /* L'exception d'absences porte sur CETTE période : elle est lue ici,
             avec la période, et nulle part ailleurs. */
          absences_non_retenues: periode.absences_non_retenues === true,
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
                absence_deduction, absence_deduction_annulee, adjustments,
                primes_total, heures_sup_total, heures_sup_heures, retenues_autres_total,
                non_remunere, net_salary, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
             RETURNING id, net_salary`,
            [companyId, paie.id, l.id, l.full_name, l.monthly_salary, l.daily_rate,
             l.expected_days, l.attended_days, l.absence_days, l.late_minutes,
             l.absence_deduction, l.absence_deduction_annulee || 0, l.adjustments,
             l.primes_total || 0, l.heures_sup_total || 0, l.heures_sup_heures || 0,
             l.retenues_autres_total || 0, l.non_remunere === true,
             l.net_salary, l.status]
          );
          const ligne = creees[0];

          if (ligne.net_salary != null) {
            /* Une retenue de cette période a pu être enregistrée AILLEURS que
               par la paie — c'est le cas des avances historiques reprises par
               script. Elle a déjà réduit le solde ; on la lit d'abord pour ne
               pas la reprendre une seconde fois, et pour que le net disponible
               qui plafonne la nouvelle retenue soit le vrai. */
            const externes = await AV.retenuesHorsPaie(client, {
              companyId, employeeId: l.id, periodCode: periode.code,
            });
            const totalExterne = externes.reduce((somme, r) => somme + r.montant, 0);

            const dues = await AV.retenueDue(client, {
              companyId, employeeId: l.id, periodCode: periode.code,
              netDisponible: Math.max(0, Number(ligne.net_salary) - totalExterne),
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
            /* Le total porté sur la ligne est celui de la PÉRIODE, d'où qu'il
               vienne : la paie projette le journal, elle ne le concurrence pas.
               La part externe reste identifiée, pour que personne ne la prenne
               un jour pour une retenue à contrepasser. */
            const totalRetenu = total + totalExterne;
            if (totalRetenu > 0) {
              await client.query(
                `UPDATE attendance_payroll_items_v2
                    SET advance_deduction = $1, advance_deduction_externe = $2,
                        net_salary = GREATEST(0, net_salary - $1), updated_at = now()
                  WHERE id = $3`, [totalRetenu, totalExterne, ligne.id]);
            }
          }
        }

        const { rows: totaux } = await client.query(
          `UPDATE attendance_payroll_runs_v2 r
              SET gross_amount = x.brut, deductions_amount = x.retenues,
                  adjustments_amount = x.ajustements, net_amount = x.net, updated_at = now()
             FROM (SELECT payroll_run_id,
                          /* Le brut inclut désormais primes et heures
                             supplémentaires : sans elles, le total annoncé ne
                             correspondrait plus à la somme des bulletins. */
                          COALESCE(sum(monthly_salary), 0)
                            + COALESCE(sum(primes_total), 0)
                            + COALESCE(sum(heures_sup_total), 0) AS brut,
                          COALESCE(sum(absence_deduction), 0)
                            + COALESCE(sum(advance_deduction), 0)
                            + COALESCE(sum(retenues_autres_total), 0) AS retenues,
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
           valider resterait bloqué ici, sur sa PROPRE demande.

           UNE SEULE EXCEPTION : le super administrateur. Dans une petite
           structure, il est parfois seul à pouvoir préparer ET autoriser ; le
           lui interdire bloquerait la paie plutôt que de la contrôler. La
           séparation reste entière pour tous les autres rôles.

           Le jeton porte `is_super_admin`, mais on ne s'en contente pas : le
           droit est relu en base, dans cette transaction. Un jeton émis avant
           un retrait de privilège continuerait sinon d'ouvrir ce passage
           jusqu'à son expiration — et c'est précisément le passage qui lève un
           contrôle. */
        const estAuteur = Number(demande.submitted_by) === Number(req.user?.id);
        let superAdminConfirme = false;
        if (estAuteur) {
          const { rows: compte } = await client.query(
            `SELECT is_super_admin FROM users WHERE id = $1`, [req.user?.id || 0]
          );
          superAdminConfirme = compte[0]?.is_super_admin === true;
          if (!superAdminConfirme) {
            throw P.erreur(
              "Vous avez soumis cette paie : vous ne pouvez pas la valider vous-même.",
              "SELF_APPROVAL_FORBIDDEN", 403
            );
          }
        }

        /* Une auto-validation laisse une trace explicite : relue plus tard,
           elle doit se distinguer d'une validation par un tiers. */
        const motifFinal = estAuteur && superAdminConfirme
          ? `[Auto-validation super administrateur] ${motif}`.trim()
          : motif;

        await client.query(
          `UPDATE payroll_requests
              SET status = $1, decided_by = $2, decided_by_name = $3,
                  decided_at = now(), decision_reason = $4, updated_at = now()
            WHERE id = $5`,
          [decision, req.user?.id || null, nomDe(req), motifFinal, demande.id]
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

  /* ══════════════════════════════════════════════════════════════════════
     LE CATALOGUE DES TYPES D'ÉLÉMENTS

     Servi depuis la base, pas écrit dans l'écran : ajouter « prime d'ancienneté »
     demain sera une ligne de données, pas un déploiement.
     ══════════════════════════════════════════════════════════════════════ */
  router.get(
    "/paie/elements/types",
    authenticateToken,
    requirePermission("paie", "view"),
    async (req, res) => {
      try {
        res.json({ types: await EL.typesActifs(pool) });
      } catch (e) { fail(res, e, "Erreur lecture des types d'éléments de paie."); }
    }
  );

  /* ══════════════════════════════════════════════════════════════════════
     LES ÉLÉMENTS D'UNE PÉRIODE

     Lecture de la source métier, indépendamment de l'état de la paie. Une prime
     existe même si la paie n'a pas encore été préparée — et elle existe encore
     après qu'on l'a recalculée.
     ══════════════════════════════════════════════════════════════════════ */
  router.get(
    "/paie/periodes/:code/elements",
    authenticateToken,
    requirePermission("paie", "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const { rows } = await pool.query(
          `SELECT e.*, t.kind, t.label AS type_label, t.sign, t.uses_quantity,
                  emp.full_name AS salarie, emp.employee_number AS matricule
             FROM payroll_elements e
             JOIN payroll_element_types t ON t.type_key = e.type_key
             JOIN attendance_employees emp ON emp.id = e.employee_id
            WHERE e.company_id = $1 AND e.period_code = $2
            ORDER BY emp.employee_number, t.sort_order, e.id`,
          [companyId, String(req.params.code)]
        );
        res.json({ elements: rows });
      } catch (e) { fail(res, e, "Erreur lecture des éléments de paie."); }
    }
  );

  /* ══════════════════════════════════════════════════════════════════════
     AJOUTER UN ÉLÉMENT DE PAIE

     Prime, heures supplémentaires ou retenue autorisée. Le montant d'heures
     supplémentaires est CALCULÉ par le serveur : accepter un troisième chiffre
     à côté de la quantité et du taux permettrait au bulletin d'afficher
     « 8 h × 1 500 = 15 000 » sans que personne ne sache lequel croire.

     L'élément est rattaché à la période, jamais à la ligne de paie : c'est ce
     qui le fait survivre au recalcul. Préparer la paie ensuite le fera
     apparaître ; la préparer dix fois ne le comptera pas dix fois.
     ══════════════════════════════════════════════════════════════════════ */
  router.post(
    "/paie/periodes/:code/elements",
    authenticateToken,
    requirePermission("paie", "adjust"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const periodCode = String(req.params.code);
      if (!/^\d{4}-\d{2}$/.test(periodCode)) {
        return res.status(400).json({ error: "Période attendue au format AAAA-MM.", code: "PERIOD_INVALID" });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const type = await EL.typeDe(client, String(req.body?.type_key || ""));
        if (!type) throw P.erreur("Type d'élément de paie inconnu.", "TYPE_UNKNOWN", 400);

        /* Le salarié doit appartenir à l'entreprise active : sans ce contrôle,
           une prime de Triangle pourrait atterrir sur un salarié de FAT & MAT. */
        const { rows: emp } = await client.query(
          `SELECT id, full_name FROM attendance_employees
            WHERE id = $1 AND company_id = $2`,
          [Number(req.body?.employee_id), companyId]
        );
        if (!emp[0]) throw P.erreur("Salarié introuvable dans l'entreprise active.", "EMPLOYEE_NOT_IN_COMPANY", 400);

        const motif = String(req.body?.reason || "").trim();
        if (motif.length < 5) {
          throw P.erreur("Motif obligatoire (5 caractères minimum).", "REASON_REQUIRED", 400);
        }
        const libelle = String(req.body?.label || "").trim();
        if (type.requires_label && libelle.length < 3) {
          throw P.erreur(
            `« ${type.label} » exige une description : sans elle, la ligne ne dit rien à qui la relit.`,
            "LABEL_REQUIRED", 400);
        }

        const montantForce = req.body?.montant_force === true;
        if (montantForce && motif.length < 10) {
          throw P.erreur(
            "Corriger un montant calculé exige un motif détaillé (10 caractères minimum).",
            "REASON_TOO_SHORT", 400);
        }
        const calcul = EL.calculerMontant({
          type, quantity: req.body?.quantity, unitAmount: req.body?.unit_amount,
          amount: req.body?.amount, montantForce,
        });

        const { rows } = await client.query(
          `INSERT INTO payroll_elements
             (company_id, employee_id, period_code, type_key, quantity, unit_amount,
              amount, label, reason, created_by, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING *`,
          [companyId, emp[0].id, periodCode, type.type_key,
           type.uses_quantity ? EL.francs(req.body?.quantity) : null,
           type.uses_quantity ? EL.francs(req.body?.unit_amount) : null,
           calcul.montant, libelle,
           calcul.corrige
             ? `${motif} [montant calculé ${calcul.produit} corrigé à ${calcul.montant}]`
             : motif,
           req.user?.id || null, nomDe(req)]
        );

        await client.query("COMMIT");
        if (typeof logActivity === "function") {
          await logActivity(nomDe(req), req.user?.role, "Élément de paie ajouté", "Paie",
            `${type.label} — ${emp[0].full_name} — ${periodCode} — ${calcul.montant} FCFA`
            + (type.uses_quantity ? ` (${req.body?.quantity} × ${req.body?.unit_amount})` : "")
            + ` — ${motif}`).catch(() => {});
        }
        res.status(201).json({
          element: rows[0], type,
          montant_calcule: calcul.produit, montant_corrige: calcul.corrige,
          message: `${type.label} de ${calcul.montant} FCFA enregistrée pour ${emp[0].full_name}. `
            + "Recalculez la paie de la période pour la faire apparaître sur le bulletin.",
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Erreur ajout d'un élément de paie.");
      } finally { client.release(); }
    }
  );

  /* ══════════════════════════════════════════════════════════════════════
     ANNULER UN ÉLÉMENT DE PAIE — sans l'effacer

     Une prime accordée puis retirée est un fait à conserver : la ligne passe à
     ANNULE, avec son motif et son auteur. La supprimer laisserait un bulletin
     changer de montant sans que rien n'explique pourquoi.
     ══════════════════════════════════════════════════════════════════════ */
  router.post(
    "/paie/elements/:id/annuler",
    authenticateToken,
    requirePermission("paie", "adjust"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const motif = String(req.body?.reason || "").trim();
      if (motif.length < 5) {
        return res.status(400).json({
          error: "Motif d'annulation obligatoire (5 caractères minimum).", code: "REASON_REQUIRED" });
      }
      try {
        const { rows } = await pool.query(
          `UPDATE payroll_elements
              SET status = 'ANNULE', cancelled_by = $1, cancelled_by_name = $2,
                  cancelled_at = now(), cancel_reason = $3, updated_at = now()
            WHERE id = $4 AND company_id = $5 AND status = 'ACTIF'
            RETURNING *`,
          [req.user?.id || null, nomDe(req), motif, Number(req.params.id), companyId]
        );
        if (!rows[0]) {
          return res.status(404).json({
            error: "Élément introuvable dans cette entreprise, ou déjà annulé.",
            code: "ELEMENT_NOT_ACTIVE" });
        }
        if (typeof logActivity === "function") {
          await logActivity(nomDe(req), req.user?.role, "Élément de paie annulé", "Paie",
            `Élément ${rows[0].id} — ${rows[0].period_code} — ${rows[0].amount} FCFA — ${motif}`).catch(() => {});
        }
        res.json({
          element: rows[0],
          message: "Élément annulé. Il reste visible dans l'historique. "
            + "Recalculez la paie de la période pour le retirer du bulletin.",
        });
      } catch (e) { fail(res, e, "Erreur annulation d'un élément de paie."); }
    }
  );

  /* ══════════════════════════════════════════════════════════════════════
     NON RÉMUNÉRÉ VOLONTAIREMENT

     Un directeur qui ne se verse pas de salaire n'est pas une fiche incomplète.
     Le système distinguait mal les deux, et l'on s'en sortait en corrigeant le
     net à la main — ce qui faisait passer un salaire oublié pour une décision.

     Ce drapeau est POSÉ, jamais déduit. Réservé au super administrateur, relu en
     base : décider qu'une personne ne sera pas payée n'est pas une saisie.
     ══════════════════════════════════════════════════════════════════════ */
  router.post(
    "/paie/salaries/:id/non-remunere",
    authenticateToken,
    requirePermission("paie", "prepare"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: compte } = await client.query(
          `SELECT is_super_admin FROM users WHERE id = $1`, [req.user?.id || 0]
        );
        if (compte[0]?.is_super_admin !== true) {
          throw P.erreur(
            "Déclarer un salarié non rémunéré est réservé au super administrateur.",
            "NON_REMUNERE_FORBIDDEN", 403);
        }
        const actif = req.body?.actif !== false;
        const motif = String(req.body?.reason || "").trim();
        if (actif && motif.length < 15) {
          throw P.erreur(
            "Motif obligatoire (15 caractères minimum) : un salaire absent par erreur ne doit "
            + "jamais pouvoir se confondre avec un salaire volontairement nul.",
            "REASON_REQUIRED", 400);
        }
        const { rows } = await client.query(
          `UPDATE attendance_employees
              SET non_remunere = $1,
                  non_remunere_motif = CASE WHEN $1 THEN $2 ELSE '' END,
                  non_remunere_par   = CASE WHEN $1 THEN $3::int ELSE NULL END,
                  non_remunere_le    = CASE WHEN $1 THEN now() ELSE NULL END,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = $4 AND company_id = $5
            RETURNING id, full_name, non_remunere, non_remunere_motif, non_remunere_le`,
          [actif, motif, req.user?.id || null, Number(req.params.id), companyId]
        );
        if (!rows[0]) throw P.erreur("Salarié introuvable dans cette entreprise.", "EMPLOYEE_NOT_FOUND", 404);

        await client.query("COMMIT");
        if (typeof logActivity === "function") {
          await logActivity(nomDe(req), req.user?.role,
            actif ? "Salarié déclaré non rémunéré" : "Salarié redevenu rémunéré", "Paie",
            `${rows[0].full_name} — entreprise ${companyId}` + (motif ? ` — ${motif}` : "")).catch(() => {});
        }
        res.json({
          salarie: rows[0],
          message: actif
            ? `${rows[0].full_name} est déclaré non rémunéré : sa paie sera de 0 FCFA et ne bloquera plus la préparation. Recalculez la période pour appliquer la décision.`
            : `${rows[0].full_name} redevient rémunéré : configurez son salaire, sinon sa ligne de paie sera bloquée.`,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Erreur déclaration non rémunéré.");
      } finally { client.release(); }
    }
  );

  router.post(
    "/paie/lignes/:id/ajuster",
    authenticateToken,
    requirePermission("paie", "adjust"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        /* CE CHEMIN N'EST PLUS LA MÉTHODE NORMALE.
           Il a servi à porter un vrai salaire, deux retenues et une prime — et
           les quatre ont disparu au premier recalcul, parce que
           `payroll_item_adjustments` est rattachée à la ligne de paie en
           ON DELETE CASCADE. Un salaire se corrige sur la fiche, une prime et
           des heures supplémentaires passent par les éléments de paie : ceux-là
           survivent.
           La route reste, parce qu'une correction exceptionnelle existe. Mais
           elle exige un motif plus long, elle marque la ligne comme corrigée à
           la main, et elle laisse une trace dans le journal d'activité — qui,
           lui, survit au recalcul. */
        const motif = motifDe(req, 15);
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
              SET net_salary = $1,
                  /* La ligne DIT qu'elle a été corrigée à la main : un net sans
                     explication sur un bulletin est précisément ce qu'on veut
                     rendre impossible. */
                  net_corrige_manuellement = TRUE,
                  status = CASE WHEN status = 'BLOCKED' THEN 'TO_PAY' ELSE status END,
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

        /* Le journal d'activité survit au recalcul, contrairement à
           payroll_item_adjustments. C'est donc là que la trace doit aussi
           vivre, sinon la correction disparaîtrait sans laisser de mémoire. */
        if (typeof logActivity === "function") {
          await logActivity(nomDe(req), req.user?.role,
            "Correction manuelle d'un net de paie", "Paie",
            `${ligne.employee_name} — ligne ${ligne.id} — ${ligne.net_salary ?? "NULL"} -> ${nouveau} FCFA — ${motif}`
          ).catch(() => {});
        }

        res.json({
          ligne: majs[0],
          ancien: ligne.net_salary,
          nouveau,
          message: "Montant corrigé. ATTENTION : une correction manuelle du net NE SURVIT PAS "
            + "à un recalcul de la paie. Pour un salaire réel, corrigez la fiche du salarié ; "
            + "pour une prime ou des heures supplémentaires, utilisez les éléments de paie — "
            + "ceux-là sont relus à chaque recalcul.",
          avertissement: "NON_DURABLE",
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

        /* Les éléments sont lus depuis la source métier, par période et par
           salarié : le bulletin les nomme un par un, avec leur motif. */
        const { rows: elementsDuBulletin } = await client.query(
          `SELECT e.type_key, t.label AS type_label, t.kind, t.sign, t.uses_quantity,
                  e.label, e.quantity, e.unit_amount, e.amount, e.reason,
                  e.created_by_name, e.created_at
             FROM payroll_elements e
             JOIN payroll_element_types t ON t.type_key = e.type_key
            WHERE e.company_id = $1 AND e.employee_id = $2
              AND e.period_code = to_char($3::date, 'YYYY-MM') AND e.status = 'ACTIF'
            ORDER BY t.sort_order, e.id`,
          [companyId, ligne.employee_id, ligne.mois]);
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
          /* Ce que l'exception de la période a épargné : un bulletin où trois
             jours manquent sans rien retenir doit le dire, sinon il se lit comme
             une erreur de calcul. */
          retenue_absence_annulee: ligne.absence_deduction_annulee,
          ajustements: ligne.adjustments,
          /* Chaque composante séparément : « ne jamais afficher uniquement un
             net inexpliqué ». Le détail des primes est joint ligne par ligne. */
          primes_total: ligne.primes_total,
          heures_supplementaires_total: ligne.heures_sup_total,
          heures_supplementaires_heures: ligne.heures_sup_heures,
          autres_retenues_total: ligne.retenues_autres_total,
          retenue_avance: ligne.advance_deduction,
          retenue_avance_hors_paie: ligne.advance_deduction_externe,
          non_remunere: ligne.non_remunere === true,
          net_corrige_manuellement: ligne.net_corrige_manuellement === true,
          elements: elementsDuBulletin,
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


  /* ══════════════════════════════════════════════════════════════════════
     RETIRER SA PROPRE SOUMISSION

     Soumettre et décider sont deux actes séparés, et c'est bien ainsi. Mais
     RETIRER sa demande n'est pas décider : c'est renoncer. Interdire à l'auteur
     de reprendre sa propre soumission ne protège rien — cela le laisse
     seulement bloqué, avec une paie en attente d'une Direction qui ne peut pas
     trancher parce que l'auteur est le seul habilité.

     La paie redevient un brouillon, la période revient à « paie préparée », et
     la demande passe à ANNULEE — elle n'est pas supprimée : la trace de ce qui
     a été soumis, par qui, pour quel montant, et retiré par qui, reste lisible.

     Rien d'autre ne bouge : ni les lignes de paie, ni les avances, ni les
     remboursements, ni les pointages. Aucun paiement n'est possible depuis cet
     état.
     ══════════════════════════════════════════════════════════════════════ */
  router.post(
    "/paie/runs/:id/retirer-soumission",
    authenticateToken,
    requirePermission("paie", "submit"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: demandes } = await client.query(
          `SELECT * FROM payroll_requests
            WHERE payroll_run_id = $1 AND company_id = $2 AND status = 'EN_ATTENTE_DIRECTION'
            FOR UPDATE`,
          [Number(req.params.id), companyId]
        );
        const demande = demandes[0];
        if (!demande) {
          throw P.erreur(
            "Aucune soumission en attente pour cette paie : il n'y a rien à retirer.",
            "REQUEST_NOT_PENDING", 404);
        }

        /* Retirer la demande de quelqu'un d'autre, c'est décider à sa place.
           Seul l'auteur le fait — ou le super administrateur, relu en base. */
        const estAuteur = Number(demande.submitted_by) === Number(req.user?.id);
        let superAdminConfirme = false;
        if (!estAuteur) {
          const { rows: compte } = await client.query(
            `SELECT is_super_admin FROM users WHERE id = $1`, [req.user?.id || 0]
          );
          superAdminConfirme = compte[0]?.is_super_admin === true;
          if (!superAdminConfirme) {
            throw P.erreur(
              `Cette paie a été soumise par ${demande.submitted_by_name || "un autre utilisateur"} : seul son auteur peut la retirer.`,
              "WITHDRAW_NOT_AUTHOR", 403);
          }
        }

        /* Un retrait se relit des mois plus tard : « pourquoi cette paie
           est-elle repartie en brouillon ? ». Le motif est donc exigé, et
           APRÈS le contrôle d'auteur — sans quoi un tiers apprendrait, par un
           400 plutôt qu'un 403, qu'il s'est trompé de motif et non de droit. */
        const motif = String(req.body?.reason || "").trim();
        if (motif.length < 10) {
          throw P.erreur(
            "Motif du retrait obligatoire (10 caractères minimum) : il restera attaché à la demande.",
            "REASON_REQUIRED", 400);
        }
        await client.query(
          `UPDATE payroll_requests
              SET status = 'ANNULEE', decided_by = $1, decided_by_name = $2,
                  decided_at = now(),
                  decision_reason = $3, updated_at = now()
            WHERE id = $4`,
          [req.user?.id || null, nomDe(req),
           (estAuteur ? "Soumission retirée par son auteur." : "Soumission retirée par le super administrateur.")
             + (motif ? ` Motif : ${motif}` : ""),
           demande.id]
        );

        /* DRAFT, et non « l'état d'avant » deviné : c'est l'état depuis lequel
           on prépare et l'on soumet à nouveau. */
        await client.query(
          `UPDATE attendance_payroll_runs_v2 SET status = 'DRAFT', updated_at = now()
            WHERE id = $1 AND company_id = $2`,
          [demande.payroll_run_id, companyId]
        );
        if (demande.period_id) {
          await client.query(
            `UPDATE attendance_periods SET status = 'PAIE_PREPAREE', updated_at = now()
              WHERE id = $1 AND status = 'EN_ATTENTE_DIRECTION'`,
            [demande.period_id]
          );
        }

        await client.query("COMMIT");
        if (typeof logActivity === "function") {
          await logActivity(nomDe(req), req.user?.role, "Retrait d'une soumission de paie", "Paie",
            `Paie ${demande.payroll_run_id} — montant soumis ${demande.amount_submitted} — entreprise ${companyId}`
            + (motif ? ` — motif : ${motif}` : "")).catch(() => {});
        }
        res.json({
          retiree: true,
          message: "Soumission retirée. La paie est revenue en brouillon : elle peut être préparée puis soumise à nouveau. Aucun paiement n'a été effectué.",
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Erreur retrait de la soumission.");
      } finally { client.release(); }
    }
  );

  /* ══════════════════════════════════════════════════════════════════════
     EXCEPTION D'ABSENCES SUR UNE PÉRIODE

     Un mois où le pointage a été défaillant ne doit pas coûter aux salariés ce
     qu'ils n'ont pas manqué. La Direction peut décider que, pour CETTE période,
     les absences ne réduisent pas le salaire.

     Ce qui n'est PAS fait, volontairement : écrire « présent » sur chaque jour
     manquant. Ce serait affirmer un fait que personne n'a constaté, et effacer
     à jamais la trace de ce que le pointage avait ou n'avait pas enregistré.
     Les absences restent donc comptées et visibles ; elles ne sont plus
     retenues, et la ligne de paie chiffre ce que l'exception a coûté.

     La portée est la période, et rien d'autre. La suivante repart au
     comportement normal sans qu'on ait à défaire quoi que ce soit.

     Réservé au super administrateur, relu en base : lever une règle de calcul
     de la paie n'est pas une opération de saisie.
     ══════════════════════════════════════════════════════════════════════ */
  router.post(
    "/paie/periodes/:code/exception-absences",
    authenticateToken,
    requirePermission("paie", "prepare"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: compte } = await client.query(
          `SELECT is_super_admin FROM users WHERE id = $1`, [req.user?.id || 0]
        );
        if (compte[0]?.is_super_admin !== true) {
          throw P.erreur(
            "Lever la retenue des absences sur une période est réservé au super administrateur.",
            "EXCEPTION_FORBIDDEN", 403);
        }

        const actif = req.body?.actif !== false;
        const motif = String(req.body?.reason || "").trim();
        if (actif && motif.length < 15) {
          throw P.erreur(
            "Motif obligatoire (15 caractères minimum) : une exception se relit des mois plus tard.",
            "REASON_REQUIRED", 400);
        }

        const { rows } = await client.query(
          `UPDATE attendance_periods
              SET absences_non_retenues = $1,
                  absences_non_retenues_motif = CASE WHEN $1 THEN $2 ELSE '' END,
                  absences_non_retenues_par  = CASE WHEN $1 THEN $3::int ELSE NULL END,
                  absences_non_retenues_le   = CASE WHEN $1 THEN now() ELSE NULL END,
                  updated_at = now()
            WHERE company_id = $4 AND code = $5
            RETURNING *`,
          [actif, motif, req.user?.id || null, companyId, String(req.params.code)]
        );
        if (!rows[0]) throw P.erreur("Période introuvable dans cette entreprise.", "PERIOD_NOT_FOUND", 404);

        await client.query("COMMIT");
        if (typeof logActivity === "function") {
          await logActivity(nomDe(req), req.user?.role,
            actif ? "Exception d'absences posée" : "Exception d'absences levée", "Paie",
            `Période ${req.params.code} — entreprise ${companyId}` + (motif ? ` — ${motif}` : "")
          ).catch(() => {});
        }
        res.json({
          periode: rows[0],
          message: actif
            ? `Les absences de la période ${req.params.code} ne réduiront plus le salaire. Préparez la paie à nouveau pour appliquer la décision. Les absences restent enregistrées et visibles.`
            : `La période ${req.params.code} retient à nouveau ses absences. Préparez la paie à nouveau pour appliquer le changement.`,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Erreur exception d'absences.");
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

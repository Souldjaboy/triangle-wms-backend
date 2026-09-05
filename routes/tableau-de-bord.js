"use strict";

/**
 * TABLEAU DE BORD ET NOTIFICATIONS MÉTIER.
 *
 *   GET  /tableau-de-bord            tout ce qui compte, pour la société active
 *   GET  /notifications-metier       les alertes non lues
 *   POST /notifications-metier/rafraichir   recalcule les alertes
 *   POST /notifications-metier/:id/lue
 *
 * Le tableau de bord ne calcule rien qu'il ne puisse justifier : chaque
 * nombre vient d'une requête sur la société active, jamais d'un cumul
 * mémorisé qui finirait par diverger de ses lignes.
 *
 * Les notifications portent une clé d'ÉVÉNEMENT (migration 087) : rafraîchir
 * dix fois ne crée pas dix alertes. Une notification répétée ne prévient pas
 * davantage — au bout de quarante lignes identiques, plus personne ne regarde.
 */

const express = require("express");
const N = require("../services/notifications-metier");

module.exports = function createTableauDeBordRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission } = deps;
  const router = express.Router();

  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const requireCompany = (req, res) => {
    const id = companyOf(req);
    if (!id) { res.status(409).json({ error: "Entreprise active requise.", code: "COMPANY_REQUIRED" }); return 0; }
    return id;
  };
  const fail = (res, e, secours) => {
    if (!e.httpStatus) console.error(secours, e);
    res.status(e.httpStatus || 500).json({ error: e.message || secours, code: e.code });
  };
  const nb = (v) => Number(v || 0);

  router.get(
    "/tableau-de-bord", authenticateToken, requirePermission("tableau_de_bord", "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const [
          banques, caisses, tresorerie, paie, avances, depots, creances, fiscal, periode,
        ] = await Promise.all([
          pool.query(`SELECT COALESCE(sum(current_balance),0) AS total, count(*)::int AS n
                        FROM accounting_banks WHERE company_id=$1 AND COALESCE(is_active,true)`, [companyId]),
          pool.query(`SELECT COALESCE(sum(solde_actuel),0) AS total, count(*)::int AS n
                        FROM caisses WHERE company_id=$1 AND COALESCE(actif,true)`, [companyId]),
          pool.query(`SELECT COALESCE(sum(current_balance),0) AS total
                        FROM treasury_accounts WHERE company_id=$1`, [companyId]),
          pool.query(`SELECT r.id, r.status, r.net_amount, r.period_month::text AS mois,
                             p.code AS periode,
                             (SELECT count(*)::int FROM attendance_payroll_items_v2 i
                               WHERE i.payroll_run_id=r.id AND i.status='TO_PAY') AS a_payer
                        FROM attendance_payroll_runs_v2 r
                        LEFT JOIN attendance_periods p ON p.id = r.period_id
                       WHERE r.company_id=$1
                       ORDER BY r.id DESC LIMIT 1`, [companyId]),
          pool.query(`SELECT count(*)::int AS n, COALESCE(sum(balance),0) AS solde
                        FROM salary_advances WHERE company_id=$1 AND balance>0`, [companyId]),
          pool.query(`SELECT COALESCE(sum(amount),0) AS recus,
                             COALESCE(sum(amount - available_amount),0) AS utilises,
                             COALESCE(sum(available_amount),0) AS disponibles,
                             count(*) FILTER (WHERE available_amount > 0 AND available_amount < amount * 0.1)::int AS presque_epuises
                        FROM client_deposits WHERE company_id=$1 AND status <> 'ANNULE'`, [companyId]),
          pool.query(`SELECT COALESCE(sum(remaining_amount),0) AS impaye, count(*)::int AS n
                        FROM (
                          SELECT remaining_amount FROM sand_invoices
                           WHERE company_id=$1 AND COALESCE(remaining_amount,0) > 0
                             AND cancelled_at IS NULL
                          UNION ALL
                          SELECT remaining_amount FROM cement_invoices
                           WHERE company_id=$1 AND COALESCE(remaining_amount,0) > 0
                        ) x`, [companyId]),
          pool.query(`SELECT
                        count(*) FILTER (WHERE status NOT IN ('PAYEE','EXONEREE','ANNULEE')
                                          AND due_date >= CURRENT_DATE)::int AS a_venir,
                        count(*) FILTER (WHERE status NOT IN ('PAYEE','EXONEREE','ANNULEE')
                                          AND due_date < CURRENT_DATE)::int AS en_retard,
                        count(*) FILTER (WHERE status='PAYEE')::int AS payees,
                        COALESCE(sum(remaining_amount) FILTER (WHERE status NOT IN ('PAYEE','EXONEREE','ANNULEE')),0) AS du
                        FROM tax_declarations WHERE company_id=$1`, [companyId]),
          pool.query(`SELECT code, status, date_debut::text AS debut, date_fin::text AS fin
                        FROM attendance_periods WHERE company_id=$1
                       ORDER BY date_debut DESC LIMIT 1`, [companyId]),
        ]);

        const totalBanques = nb(banques.rows[0]?.total);
        const totalCaisses = nb(caisses.rows[0]?.total);
        const totalTreso   = nb(tresorerie.rows[0]?.total);

        res.json({
          tresorerie: {
            banques: totalBanques, nombre_banques: nb(banques.rows[0]?.n),
            caisses: totalCaisses, nombre_caisses: nb(caisses.rows[0]?.n),
            compte_general: totalTreso,
            total: totalBanques + totalCaisses + totalTreso,
          },
          periode: periode.rows[0] || null,
          paie: paie.rows[0] ? {
            statut: paie.rows[0].status, periode: paie.rows[0].periode || paie.rows[0].mois,
            net: nb(paie.rows[0].net_amount), salaires_a_payer: nb(paie.rows[0].a_payer),
          } : null,
          avances: { en_cours: nb(avances.rows[0]?.n), solde_du: nb(avances.rows[0]?.solde) },
          acomptes: {
            recus: nb(depots.rows[0]?.recus),
            utilises: nb(depots.rows[0]?.utilises),
            disponibles: nb(depots.rows[0]?.disponibles),
            presque_epuises: nb(depots.rows[0]?.presque_epuises),
          },
          creances_clients: { impaye: nb(creances.rows[0]?.impaye), factures: nb(creances.rows[0]?.n) },
          fiscalite: {
            a_venir: nb(fiscal.rows[0]?.a_venir), en_retard: nb(fiscal.rows[0]?.en_retard),
            payees: nb(fiscal.rows[0]?.payees), reste_du: nb(fiscal.rows[0]?.du),
          },
        });
      } catch (e) { fail(res, e, "Tableau de bord indisponible."); }
    }
  );

  router.get("/notifications-metier", authenticateToken, async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    try {
      const { rows } = await pool.query(
        `SELECT id, title, message, type, priority, action_url, event_key, created_at, is_read
           FROM notifications
          WHERE company_id = $1 AND (user_id = $2 OR user_id IS NULL)
            AND ($3 OR COALESCE(is_read, false) = false)
          ORDER BY created_at DESC LIMIT 100`,
        [companyId, req.user?.id || null, String(req.query?.toutes || "") === "1"]);
      res.json({ notifications: rows, non_lues: rows.filter((n) => !n.is_read).length });
    } catch (e) { fail(res, e, "Impossible de lire les notifications."); }
  });

  router.post("/notifications-metier/:id/lue", authenticateToken, async (req, res) => {
    const companyId = requireCompany(req, res); if (!companyId) return;
    try {
      const { rowCount } = await pool.query(
        `UPDATE notifications SET is_read = true
          WHERE id = $1 AND company_id = $2 AND (user_id = $3 OR user_id IS NULL)`,
        [Number(req.params.id), companyId, req.user?.id || null]);
      if (!rowCount) return res.status(404).json({ error: "Notification introuvable." });
      res.json({ ok: true });
    } catch (e) { fail(res, e, "Impossible de marquer cette notification."); }
  });

  /**
   * Recalcule les alertes de la société. Idempotent par construction : la clé
   * d'événement empêche la répétition, donc appeler cette route dix fois de
   * suite ne produit pas dix alertes.
   */
  router.post(
    "/notifications-metier/rafraichir", authenticateToken,
    requirePermission("notification", "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        let crees = 0;

        /* Une paie qui attend la Direction. */
        const { rows: enAttente } = await client.query(
          `SELECT q.id, q.payroll_run_id, q.amount_submitted, q.submitted_by_name
             FROM payroll_requests q
            WHERE q.company_id = $1 AND q.status = 'EN_ATTENTE_DIRECTION'`, [companyId]);
        if (enAttente.length) {
          const directeurs = await N.destinatairesPour(client, companyId, "paie", "validate");
          for (const d of enAttente) {
            crees += await N.notifier(client, {
              companyId, evenement: "PAIE_SOUMISE", cle: `paie:${d.payroll_run_id}`,
              titre: "Une paie attend votre validation",
              message: `${d.submitted_by_name} a soumis une paie de ${Number(d.amount_submitted).toLocaleString("fr-FR")} FCFA.`,
              destinataires: directeurs, priorite: "haute",
              entite: "payroll_run", entiteId: d.payroll_run_id,
              lien: `/paie/runs/${d.payroll_run_id}`,
            });
          }
        }

        /* Une période dont le pointage reste à contrôler. */
        const { rows: periodes } = await client.query(
          `SELECT id, code FROM attendance_periods
            WHERE company_id = $1 AND status IN ('OUVERTE','EN_REVISION_POINTAGE')
              AND date_fin <= CURRENT_DATE`, [companyId]);
        if (periodes.length) {
          const valideurs = await N.destinatairesPour(client, companyId, "pointage.periode", "validate");
          for (const p of periodes) {
            crees += await N.notifier(client, {
              companyId, evenement: "PERIODE_A_CONTROLER", cle: `periode:${p.id}`,
              titre: `Pointage à contrôler — ${p.code}`,
              message: "La période est terminée : le pointage doit être contrôlé puis validé avant la paie.",
              destinataires: valideurs, entite: "attendance_period", entiteId: p.id,
            });
          }
        }

        /* Les échéances fiscales : J-15, J-7, J-3, J-1 et le jour même. */
        const { rows: echeances } = await client.query(
          `SELECT d.id, d.reference, d.due_date, (d.due_date - CURRENT_DATE) AS jours,
                  d.remaining_amount, t.name
             FROM tax_declarations d JOIN tax_types t ON t.id = d.tax_type_id
            WHERE d.company_id = $1 AND d.status NOT IN ('PAYEE','EXONEREE','ANNULEE')
              AND d.due_date IS NOT NULL
              AND (d.due_date - CURRENT_DATE) IN (15, 7, 3, 1, 0)`, [companyId]);
        if (echeances.length) {
          const payeurs = await N.destinatairesPour(client, companyId, "fiscalite", "pay");
          for (const e of echeances) {
            crees += await N.notifier(client, {
              companyId, evenement: "ECHEANCE_FISCALE", cle: `decl:${e.id}:J-${e.jours}`,
              titre: `${e.name} — échéance dans ${e.jours} jour(s)`,
              message: `${Number(e.remaining_amount).toLocaleString("fr-FR")} FCFA restent dus (${e.reference}).`,
              destinataires: payeurs, priorite: Number(e.jours) <= 3 ? "haute" : "normale",
              entite: "tax_declaration", entiteId: e.id,
            });
          }
        }

        /* Un dépôt client presque épuisé, ou épuisé. */
        const { rows: depots } = await client.query(
          `SELECT id, reference, customer_name, available_amount, amount
             FROM client_deposits
            WHERE company_id = $1 AND status <> 'ANNULE'
              AND available_amount < amount * 0.1`, [companyId]);
        if (depots.length) {
          const comptables = await N.destinatairesPour(client, companyId, "acompte_client", "view");
          for (const d of depots) {
            const epuise = Number(d.available_amount) === 0;
            crees += await N.notifier(client, {
              companyId,
              evenement: epuise ? "DEPOT_EPUISE" : "DEPOT_PRESQUE_EPUISE",
              cle: `depot:${d.id}:${epuise ? "epuise" : "bas"}`,
              titre: epuise ? `Dépôt épuisé — ${d.customer_name}` : `Dépôt presque épuisé — ${d.customer_name}`,
              message: epuise
                ? `${d.reference} n'a plus rien de disponible.`
                : `${d.reference} : il reste ${Number(d.available_amount).toLocaleString("fr-FR")} FCFA.`,
              destinataires: comptables, entite: "client_deposit", entiteId: d.id,
            });
          }
        }

        /* Une avance dont une échéance tombe dans la période en cours. */
        const { rows: avances } = await client.query(
          `SELECT i.id, i.amount_due, i.period_code, a.reference, e.full_name
             FROM salary_advance_installments i
             JOIN salary_advances a ON a.id = i.advance_id
             JOIN attendance_employees e ON e.id = a.employee_id
            WHERE i.company_id = $1 AND i.status = 'A_VENIR'
              AND i.period_code <= to_char(CURRENT_DATE, 'YYYY-MM')`, [companyId]);
        if (avances.length) {
          const comptables = await N.destinatairesPour(client, companyId, "paie.avance", "view");
          for (const a of avances) {
            crees += await N.notifier(client, {
              companyId, evenement: "ECHEANCE_AVANCE", cle: `echeance:${a.id}`,
              titre: `Retenue d'avance à opérer — ${a.full_name}`,
              message: `${Number(a.amount_due).toLocaleString("fr-FR")} FCFA sur ${a.reference}, période ${a.period_code}.`,
              destinataires: comptables, entite: "salary_advance_installment", entiteId: a.id,
            });
          }
        }

        await client.query("COMMIT");
        res.json({ creees: crees, message: crees ? `${crees} nouvelle(s) alerte(s).` : "Rien de nouveau." });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Rafraîchissement impossible.");
      } finally { client.release(); }
    }
  );

  return router;
};

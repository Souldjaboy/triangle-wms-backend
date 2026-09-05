"use strict";

/**
 * AVANCES SUR SALAIRE.
 *
 *   GET  /avances                       la liste, avec soldes
 *   GET  /avances/:id                   fiche complète : échéancier + historique
 *   POST /avances                       demander
 *   POST /avances/:id/decision          valider ou refuser (Direction)
 *   POST /avances/:id/versement         verser — l'argent sort une seule fois
 *   POST /avances/:id/remboursement     versement direct au comptoir
 *   POST /avances/:id/reechelonner      changer la mensualité, avec motif
 *   POST /avances/:id/suspendre         suspendre les retenues, avec motif
 *   POST /avances/remboursements/:id/contrepasser  défaire, sans effacer
 *
 * Tout mouvement d'argent passe par `services/tresorerie.js` : verrou sur le
 * compte, contrôle du solde, transaction et écritures équilibrées écrites
 * ensemble. Aucune de ces routes ne touche un solde directement.
 *
 * Le versement est le seul geste qui fait SORTIR de l'argent, et il n'a lieu
 * qu'une fois — le statut le garantit, pas la prudence de l'appelant.
 */

const express = require("express");
const T = require("../services/tresorerie");
const A = require("../services/avances-salaire");

module.exports = function createAvancesRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission,
          nextAccountingNumber, createAccountingEntry } = deps;
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
    res.status(e.httpStatus || 500).json({
      error: e.message || secours, code: e.code,
      ...(e.disponible !== undefined ? { disponible: e.disponible, demande: e.demande, manquant: e.manquant } : {}),
      ...(e.solde !== undefined ? { solde: e.solde, saisi: e.saisi } : {}),
    });
  };
  const motifDe = (req, minimum = 3) => {
    const m = String(req.body?.reason || req.body?.motif || "").trim();
    if (m.length < minimum) throw T.erreur("Un motif est obligatoire.", "REASON_REQUIRED", 400);
    return m;
  };

  // ═══════════════════════════════════════════════════════════════════════
  router.get(
    "/avances", authenticateToken, requirePermission("paie.avance", "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const { rows } = await pool.query(
          `SELECT a.id, a.reference, a.status, a.amount_requested, a.amount_authorized,
                  a.amount_paid, a.balance, a.installment_amount, a.first_period_code,
                  a.reason, a.requested_at, a.paid_at,
                  e.id AS employee_id, e.full_name, e.employee_number
             FROM salary_advances a
             JOIN attendance_employees e ON e.id = a.employee_id
            WHERE a.company_id = $1
              AND ($2::int IS NULL OR a.employee_id = $2)
            ORDER BY a.created_at DESC
            LIMIT 300`,
          [companyId, req.query?.employee_id ? Number(req.query.employee_id) : null]
        );
        res.json({ avances: rows });
      } catch (e) { fail(res, e, "Impossible de lire les avances."); }
    }
  );

  router.get(
    "/avances/:id", authenticateToken, requirePermission("paie.avance", "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const id = Number(req.params.id);
        const { rows: avances } = await pool.query(
          `SELECT a.*, e.full_name, e.employee_number
             FROM salary_advances a
             JOIN attendance_employees e ON e.id = a.employee_id
            WHERE a.id = $1 AND a.company_id = $2`, [id, companyId]);
        if (!avances[0]) return res.status(404).json({ error: "Avance introuvable." });

        const { rows: echeances } = await pool.query(
          `SELECT rank, period_code, amount_due, amount_taken, status, suspended_reason
             FROM salary_advance_installments WHERE advance_id = $1 ORDER BY rank`, [id]);
        const { rows: mouvements } = await pool.query(
          `SELECT id, amount, origin, balance_before, balance_after, reference, reason,
                  performed_by_name, created_at, reverses_repayment_id
             FROM salary_advance_repayments WHERE advance_id = $1
            ORDER BY created_at DESC, id DESC`, [id]);

        res.json({ avance: avances[0], echeancier: echeances, mouvements });
      } catch (e) { fail(res, e, "Impossible de lire cette avance."); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  router.post(
    "/avances", authenticateToken, requirePermission("paie.avance", "create"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        const employeeId = Number(req.body?.employee_id);
        const montant = T.francs(req.body?.amount_requested);
        const mensualite = T.francs(req.body?.installment_amount || 0);
        const periode = String(req.body?.first_period_code || "").trim();

        if (!Number.isInteger(employeeId) || employeeId <= 0) {
          throw T.erreur("Employé obligatoire.", "EMPLOYEE_REQUIRED", 400);
        }
        if (!(montant > 0)) throw T.erreur("Le montant demandé doit être supérieur à zéro.", "AMOUNT_INVALID", 400);
        if (periode && !/^\d{4}-\d{2}$/.test(periode)) {
          throw T.erreur("Première période attendue au format AAAA-MM.", "PERIOD_CODE_INVALID", 400);
        }

        await client.query("BEGIN");
        const { rows: employes } = await client.query(
          `SELECT id, full_name, active FROM attendance_employees
            WHERE id = $1 AND company_id = $2`, [employeeId, companyId]);
        if (!employes[0]) throw T.erreur("Employé introuvable dans cette société.", "EMPLOYEE_NOT_FOUND", 404);
        if (!employes[0].active) throw T.erreur("Cet employé n'est plus actif.", "EMPLOYEE_INACTIVE", 409);

        const reference = await nextAccountingNumber(
          client, "salary_advances", "reference", "AVA", companyId);

        const { rows } = await client.query(
          `INSERT INTO salary_advances
             (company_id, employee_id, reference, amount_requested, installment_amount,
              first_period_code, reason, status, requested_by, requested_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'DEMANDEE',$8,now()) RETURNING *`,
          [companyId, employeeId, reference, montant, mensualite, periode,
           String(req.body?.reason || "").trim(), req.user?.id || null]
        );
        await client.query("COMMIT");
        res.status(201).json({ avance: rows[0] });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Demande d'avance impossible.");
      } finally { client.release(); }
    }
  );

  router.post(
    "/avances/:id/decision", authenticateToken, requirePermission("paie.avance", "validate"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        const decision = String(req.body?.decision || "").trim().toUpperCase();
        if (!["VALIDEE", "REFUSEE"].includes(decision)) {
          throw T.erreur("Décision attendue : VALIDEE ou REFUSEE.", "DECISION_INVALID", 400);
        }
        const motif = decision === "REFUSEE" ? motifDe(req) : String(req.body?.reason || "").trim();

        await client.query("BEGIN");
        const { rows: avances } = await client.query(
          `SELECT * FROM salary_advances WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [Number(req.params.id), companyId]);
        const avance = avances[0];
        if (!avance) throw T.erreur("Avance introuvable.", "ADVANCE_NOT_FOUND", 404);
        if (avance.status !== "DEMANDEE") {
          throw T.erreur(`Une avance « ${avance.status} » ne se décide plus.`, "ADVANCE_NOT_PENDING", 409);
        }

        /* Celui qui demande ne décide pas — même règle que pour la paie. */
        if (Number(avance.requested_by) === Number(req.user?.id)) {
          throw T.erreur(
            "Vous avez demandé cette avance : vous ne pouvez pas la valider vous-même.",
            "SELF_APPROVAL_FORBIDDEN", 403);
        }

        const autorise = decision === "VALIDEE"
          ? T.francs(req.body?.amount_authorized ?? avance.amount_requested)
          : null;
        if (decision === "VALIDEE" && !(autorise > 0)) {
          throw T.erreur("Le montant autorisé doit être supérieur à zéro.", "AMOUNT_INVALID", 400);
        }
        if (decision === "VALIDEE" && autorise > T.francs(avance.amount_requested)) {
          throw T.erreur(
            "Le montant autorisé ne peut pas dépasser le montant demandé.",
            "AMOUNT_ABOVE_REQUEST", 409);
        }

        const { rows } = await client.query(
          `UPDATE salary_advances
              SET status = $1, amount_authorized = $2, validated_by = $3, validated_at = now(),
                  refused_reason = $4, updated_at = now()
            WHERE id = $5 RETURNING *`,
          [decision === "VALIDEE" ? "VALIDEE" : "REFUSEE", autorise,
           req.user?.id || null, decision === "REFUSEE" ? motif : "", avance.id]
        );
        await client.query("COMMIT");
        res.json({ avance: rows[0] });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Décision impossible.");
      } finally { client.release(); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  // LE VERSEMENT — le seul geste qui fait sortir l'argent
  // ═══════════════════════════════════════════════════════════════════════
  router.post(
    "/avances/:id/versement", authenticateToken, requirePermission("paie.avance", "pay"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows: avances } = await client.query(
          `SELECT a.*, e.full_name FROM salary_advances a
             JOIN attendance_employees e ON e.id = a.employee_id
            WHERE a.id = $1 AND a.company_id = $2 FOR UPDATE OF a`,
          [Number(req.params.id), companyId]);
        const avance = avances[0];
        if (!avance) throw T.erreur("Avance introuvable.", "ADVANCE_NOT_FOUND", 404);

        /* Le statut EST la protection contre le double versement : une avance
           déjà VERSEE n'est plus VALIDEE, et le second appel s'arrête ici —
           même si deux clics arrivent en même temps, le FOR UPDATE les
           sérialise. */
        if (avance.status !== "VALIDEE") {
          throw T.erreur(
            avance.status === "VERSEE" || avance.status === "EN_REMBOURSEMENT" || avance.status === "REMBOURSEE"
              ? "Cette avance a déjà été versée."
              : `Une avance « ${avance.status} » ne se verse pas : elle doit d'abord être validée.`,
            avance.status === "VERSEE" ? "ADVANCE_ALREADY_PAID" : "ADVANCE_NOT_VALIDATED", 409);
        }

        const montant = T.francs(avance.amount_authorized);
        const mouvement = await T.debiter(client, {
          companyId, montant,
          bankId: req.body?.bank_id ? Number(req.body.bank_id) : null,
          caisseId: req.body?.caisse_id ? Number(req.body.caisse_id) : null,
          prefixe: "AVA",
          typeOperation: "versement_avance_salaire",
          sourceType: "salary_advance", sourceId: avance.id,
          description: `Avance sur salaire ${avance.reference} — ${avance.full_name}`,
          /* Une avance n'est pas une charge : c'est une créance sur le
             salarié. La comptabiliser en charges de personnel la ferait
             disparaître le jour du remboursement. */
          compteCharge: "Créances sur le personnel",
          partenaire: avance.full_name,
          reference: String(req.body?.reference || ""),
          userId: req.user?.id || null,
          nextAccountingNumber, createAccountingEntry,
        });

        const premierCode = avance.first_period_code
          || new Date().toISOString().slice(0, 7);
        const echeances = await A.poserEcheancier(client, {
          companyId, advanceId: avance.id, montant,
          mensualite: avance.installment_amount, premierCode,
        });

        const { rows } = await client.query(
          `UPDATE salary_advances
              SET status = 'VERSEE', amount_paid = $1, balance = $1,
                  paid_by = $2, paid_at = now(), bank_id = $3, caisse_id = $4,
                  accounting_transaction_id = $5, first_period_code = $6, updated_at = now()
            WHERE id = $7 RETURNING *`,
          [montant, req.user?.id || null,
           req.body?.bank_id ? Number(req.body.bank_id) : null,
           req.body?.caisse_id ? Number(req.body.caisse_id) : null,
           mouvement.transaction.id, premierCode, avance.id]
        );

        await client.query("COMMIT");
        res.json({
          avance: rows[0],
          echeancier: echeances,
          compte: mouvement.compte,
          solde_compte_apres: mouvement.solde_apres,
          message: echeances.length === 1
            ? `${montant.toLocaleString("fr-FR")} FCFA versés, retenus en une fois sur la paie de ${premierCode}.`
            : `${montant.toLocaleString("fr-FR")} FCFA versés, remboursés en ${echeances.length} mensualités.`,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Versement impossible.");
      } finally { client.release(); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  // REMBOURSEMENT DIRECT — l'argent RENTRE
  // ═══════════════════════════════════════════════════════════════════════
  router.post(
    "/avances/:id/remboursement", authenticateToken, requirePermission("paie.avance", "pay"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        const montant = T.francs(req.body?.amount);
        if (!(montant > 0)) throw T.erreur("Le montant doit être supérieur à zéro.", "AMOUNT_INVALID", 400);

        await client.query("BEGIN");
        const { rows: avances } = await client.query(
          `SELECT a.*, e.full_name FROM salary_advances a
             JOIN attendance_employees e ON e.id = a.employee_id
            WHERE a.id = $1 AND a.company_id = $2 FOR UPDATE OF a`,
          [Number(req.params.id), companyId]);
        const avance = avances[0];
        if (!avance) throw T.erreur("Avance introuvable.", "ADVANCE_NOT_FOUND", 404);
        if (!["VERSEE", "EN_REMBOURSEMENT"].includes(avance.status)) {
          throw T.erreur(
            `Une avance « ${avance.status} » ne se rembourse pas.`, "ADVANCE_NOT_REPAYABLE", 409);
        }

        const mouvement = await T.crediter(client, {
          companyId, montant,
          bankId: req.body?.bank_id ? Number(req.body.bank_id) : null,
          caisseId: req.body?.caisse_id ? Number(req.body.caisse_id) : null,
          prefixe: "REMB-AVA",
          typeOperation: "remboursement_avance_salaire",
          sourceType: "salary_advance_repayment", sourceId: avance.id,
          description: `Remboursement avance ${avance.reference} — ${avance.full_name}`,
          compteCharge: "Créances sur le personnel",
          partenaire: avance.full_name,
          reference: String(req.body?.reference || ""),
          userId: req.user?.id || null,
          nextAccountingNumber, createAccountingEntry,
        });

        const r = await A.rembourser(client, {
          companyId, advanceId: avance.id, montant, origine: "VERSEMENT_DIRECT",
          bankId: req.body?.bank_id ? Number(req.body.bank_id) : null,
          caisseId: req.body?.caisse_id ? Number(req.body.caisse_id) : null,
          reference: String(req.body?.reference || ""),
          transactionId: mouvement.transaction.id,
          userId: req.user?.id || null, userName: nomDe(req),
        });

        await client.query("COMMIT");
        res.json({
          remboursement: r.remboursement,
          solde_avant: r.solde_avant,
          solde_apres: r.solde_apres,
          recu: mouvement.transaction.transaction_number,
          message: r.solde_apres === 0
            ? "Avance intégralement remboursée."
            : `Nouveau solde : ${r.solde_apres.toLocaleString("fr-FR")} FCFA.`,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Remboursement impossible.");
      } finally { client.release(); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  router.post(
    "/avances/:id/reechelonner", authenticateToken, requirePermission("paie.avance", "update"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        const motif = motifDe(req, 5);
        const mensualite = T.francs(req.body?.installment_amount);
        if (mensualite < 0) throw T.erreur("Mensualité invalide.", "AMOUNT_INVALID", 400);

        await client.query("BEGIN");
        const { rows: avances } = await client.query(
          `SELECT * FROM salary_advances WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [Number(req.params.id), companyId]);
        const avance = avances[0];
        if (!avance) throw T.erreur("Avance introuvable.", "ADVANCE_NOT_FOUND", 404);
        if (!["VERSEE", "EN_REMBOURSEMENT"].includes(avance.status)) {
          throw T.erreur("Seule une avance en cours se rééchelonne.", "ADVANCE_NOT_REPAYABLE", 409);
        }

        /* On replanifie le SOLDE restant, pas le montant initial : rééchelonner
           après trois retenues ne doit pas faire repayer ces trois-là. */
        const codeDepart = String(req.body?.first_period_code || avance.first_period_code
          || new Date().toISOString().slice(0, 7));
        const echeances = await A.poserEcheancier(client, {
          companyId, advanceId: avance.id, montant: avance.balance,
          mensualite, premierCode: codeDepart,
        });

        await client.query(
          `UPDATE salary_advances SET installment_amount = $1, first_period_code = $2,
                  reason = CASE WHEN reason = '' THEN $3 ELSE reason || ' | rééchelonné : ' || $3 END,
                  updated_at = now()
            WHERE id = $4`,
          [mensualite, codeDepart, motif, avance.id]);

        await client.query("COMMIT");
        res.json({ echeancier: echeances, solde: T.francs(avance.balance) });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Rééchelonnement impossible.");
      } finally { client.release(); }
    }
  );

  router.post(
    "/avances/:id/suspendre", authenticateToken, requirePermission("paie.avance", "update"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const motif = motifDe(req, 5);
        const { rowCount } = await pool.query(
          `UPDATE salary_advance_installments
              SET status = 'SUSPENDUE', suspended_reason = $1, updated_at = now()
            WHERE company_id = $2 AND status = 'A_VENIR'
              AND advance_id = (SELECT id FROM salary_advances WHERE id = $3 AND company_id = $2)`,
          [motif, companyId, Number(req.params.id)]);
        if (!rowCount) return res.status(404).json({ error: "Aucune échéance à venir à suspendre." });
        res.json({ suspendues: rowCount, message: "Les retenues sont suspendues. Le solde reste dû." });
      } catch (e) { fail(res, e, "Suspension impossible."); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  // CONTREPASSER — défaire sans effacer
  // ═══════════════════════════════════════════════════════════════════════
  router.post(
    "/avances/remboursements/:id/contrepasser",
    authenticateToken, requirePermission("paie.avance", "cancel"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        const motif = motifDe(req, 5);
        await client.query("BEGIN");
        const { rows: lignes } = await client.query(
          `SELECT * FROM salary_advance_repayments
            WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [Number(req.params.id), companyId]);
        const ligne = lignes[0];
        if (!ligne) throw T.erreur("Remboursement introuvable.", "REPAYMENT_NOT_FOUND", 404);
        if (ligne.origin === "CONTREPASSATION") {
          throw T.erreur("Une contrepassation ne se contrepasse pas.", "ALREADY_REVERSAL", 409);
        }

        const { rows: dejaFait } = await client.query(
          `SELECT 1 FROM salary_advance_repayments WHERE reverses_repayment_id = $1`, [ligne.id]);
        if (dejaFait[0]) throw T.erreur("Ce remboursement est déjà contrepassé.", "ALREADY_REVERSED", 409);

        /* Un versement direct avait fait RENTRER de l'argent : le
           contrepasser le fait ressortir. Une retenue sur paie, elle, n'a
           bougé aucun compte — on ne défait alors que la créance. */
        if (ligne.origin === "VERSEMENT_DIRECT") {
          await T.debiter(client, {
            companyId, montant: T.francs(ligne.amount),
            bankId: ligne.bank_id, caisseId: ligne.caisse_id,
            prefixe: "REV-AVA",
            typeOperation: "contrepassation_remboursement_avance",
            sourceType: "salary_advance_repayment_reversal", sourceId: ligne.id,
            description: `Contrepassation du remboursement #${ligne.id} — ${motif}`,
            compteCharge: "Créances sur le personnel",
            userId: req.user?.id || null,
            nextAccountingNumber, createAccountingEntry,
          });
        }

        const r = await A.rembourser(client, {
          companyId, advanceId: ligne.advance_id,
          montant: -T.francs(ligne.amount), origine: "CONTREPASSATION",
          reversesRepaymentId: ligne.id, reason: motif,
          userId: req.user?.id || null, userName: nomDe(req),
        });

        await client.query("COMMIT");
        res.json({
          contrepassation: r.remboursement,
          solde_avant: r.solde_avant, solde_apres: r.solde_apres,
          message: "Remboursement contrepassé. La ligne d'origine reste au journal.",
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Contrepassation impossible.");
      } finally { client.release(); }
    }
  );

  return router;
};

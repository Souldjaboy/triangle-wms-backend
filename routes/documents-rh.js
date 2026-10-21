"use strict";

/**
 * LES DOCUMENTS DU PERSONNEL.
 *
 *   GET  /rh/contrats                      la liste
 *   POST /rh/contrats                      créer un CDI ou un CDD
 *   POST /rh/contrats/:id/activer          mettre en vigueur
 *   POST /rh/contrats/:id/terminer         clore, avec motif
 *   GET  /rh/contrats/:id/pdf              le contrat imprimable
 *   GET  /rh/clauses                       les clauses, et celles à valider
 *   POST /rh/bulletins/:employeeId/:periode/pdf   un bulletin
 *   POST /rh/attestations                  attestation, certificat, formation
 *   POST /rh/diplomes                      un diplôme
 *   GET  /rh/documents                     le registre des pièces remises
 *
 * DEUX DROITS DISTINCTS. `rh.document.view` permet d'éditer une attestation
 * de travail, qui ne révèle aucun salaire. `rh.document.voir_remuneration`
 * est exigé en plus dès qu'un montant apparaît — contrat et bulletin.
 */

const express = require("express");
const crypto = require("crypto");
const PDF = require("../services/pdf-documents-rh");
const BULLETIN = require("../services/rh-bulletin");

const MODULE = "rh.document";

module.exports = function createDocumentsRhRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission,
          permissionsService, logActivity } = deps;
  const router = express.Router();

  const companyOf = (req) => Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
  const requireCompany = (req, res) => {
    const id = companyOf(req);
    if (!id) { res.status(409).json({ error: "Entreprise active requise.", code: "COMPANY_REQUIRED" }); return 0; }
    return id;
  };
  const nomDe = (req) => req.user?.fullname || req.user?.email || "Utilisateur";
  const fail = (res, e, secours) => {
    if (!e.httpStatus) console.error(secours, e);
    res.status(e.httpStatus || 500).json({ error: e.message || secours, code: e.code });
  };
  const erreur = (message, code, httpStatus = 400) => {
    const e = new Error(message); e.code = code; e.httpStatus = httpStatus; return e;
  };

  /** Le droit de voir un montant, vérifié à part du droit de voir la pièce. */
  async function peutVoirRemuneration(req, companyId) {
    if (req.user?.is_super_admin === true) return true;
    const ctx = await permissionsService.chargerContexte(pool, req.user, companyId);
    return permissionsService.decider(ctx, MODULE, "voir_remuneration").autorise === true;
  }
  const exigerRemuneration = async (req, companyId) => {
    if (!(await peutVoirRemuneration(req, companyId))) {
      throw erreur(
        "Ce document contient une rémunération : le droit « Voir les rémunérations » est requis.",
        "SALARY_FORBIDDEN", 403);
    }
  };

  /**
   * Une référence unique et lisible, par société et par type.
   *
   * Les contrats sont numérotés dans `hr_contracts`, les pièces remises dans
   * `hr_documents` : compter dans la seule table des documents redonnait
   * « CT-2026-0001 » au deuxième contrat, et l'index unique le refusait.
   */
  const TABLE_DE = { CT: "hr_contracts" };
  async function reference(client, companyId, prefixe) {
    const annee = new Date().getFullYear();
    const table = TABLE_DE[prefixe] || "hr_documents";
    const { rows } = await client.query(
      `SELECT COALESCE(MAX(NULLIF(regexp_replace(reference, '^.*-', ''), ''))::int, 0) + 1 AS n
         FROM ${table}
        WHERE company_id = $1 AND reference LIKE $2`,
      [companyId, `${prefixe}-${annee}-%`]);
    return `${prefixe}-${annee}-${String(rows[0].n).padStart(4, "0")}`;
  }

  /**
   * L'entreprise, sous une forme STABLE pour les PDF.
   *
   * `company_settings` nomme la société `company_name` et `companies` la
   * nomme `name` : sans cette normalisation, l'en-tête des documents sortait
   * vide selon la table qui répondait. Le représentant légal n'existe dans
   * aucune des deux — il reste donc optionnel, et le document écrit « son
   * représentant légal » plutôt qu'un nom inventé.
   */
  async function entrepriseDe(companyId) {
    const { rows: reglages } = await pool.query(
      `SELECT * FROM company_settings WHERE company_id = $1 LIMIT 1`, [companyId]);
    const { rows: societes } = await pool.query(
      `SELECT id, name FROM companies WHERE id = $1`, [companyId]);
    const r = reglages[0] || {};
    const c = societes[0] || {};
    return {
      ...r,
      id: companyId,
      name: r.company_name || c.name || "",
      address: r.address || null,
      phone: r.phone || null,
      email: r.email || null,
      logo_url: r.logo_url || null,
      manager: r.manager || r.representative || null,
    };
  }

  const salarieDe = async (companyId, id) => (await pool.query(
    `SELECT * FROM attendance_employees WHERE id = $1 AND company_id = $2`, [id, companyId]
  )).rows[0];

  /** Enregistre la pièce remise, avec ce qu'elle disait et son empreinte. */
  async function enregistrer(client, {
    companyId, employeeId, contractId = null, docType, ref, titre,
    periode = null, payload, pdf, utilisateur,
  }) {
    const { rows } = await client.query(
      `INSERT INTO hr_documents
         (company_id, employee_id, contract_id, doc_type, reference, title,
          period_code, payload, pdf_sha256, issued_by, issued_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) RETURNING *`,
      [companyId, employeeId || null, contractId, docType, ref, titre, periode,
       JSON.stringify(payload), crypto.createHash("sha256").update(pdf).digest("hex"),
       utilisateur?.id || null, utilisateur?.name || ""]);
    return rows[0];
  }

  const envoyerPdf = (res, pdf, nom) => {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${nom}.pdf"`);
    res.setHeader("Content-Length", pdf.length);
    res.end(pdf);
  };

  /* ───────────────────────────── LES CLAUSES ──────────────────────────── */
  router.get("/rh/clauses", authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const { rows } = await pool.query(
          `SELECT * FROM hr_contract_clauses
            WHERE is_active AND (company_id IS NULL OR company_id = $1)
            ORDER BY sort_order, clause_key`, [companyId]);
        const aValider = rows.filter((c) => c.requires_legal_validation);
        res.json({
          clauses: rows,
          a_valider: aValider.length,
          /* Le logiciel ne se prononce pas sur la conformité d'un texte
             juridique : il dit lesquels n'ont pas été relus. */
          avertissement: aValider.length
            ? `${aValider.length} clause(s) n'ont pas été relues par un juriste. `
              + `Les contrats qui les contiennent portent une mention visible.`
            : "Toutes les clauses actives ont été validées.",
        });
      } catch (e) { fail(res, e, "Lecture des clauses impossible."); }
    });

  /* ──────────────────────────── LES CONTRATS ──────────────────────────── */
  router.get("/rh/contrats", authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const montants = await peutVoirRemuneration(req, companyId);
        const { rows } = await pool.query(
          `SELECT c.*, e.full_name, e.employee_number
             FROM hr_contracts c
             LEFT JOIN attendance_employees e ON e.id = c.employee_id
            WHERE c.company_id = $1
            ORDER BY c.start_date DESC, c.id DESC LIMIT 300`, [companyId]);
        res.json({
          contrats: rows.map((c) => montants ? c : { ...c, gross_salary: null }),
          /* Dire que le montant est masqué vaut mieux que de le montrer à
             zéro, qu'on lirait comme un salaire nul. */
          remunerations_masquees: !montants,
        });
      } catch (e) { fail(res, e, "Lecture des contrats impossible."); }
    });

  router.post("/rh/contrats", authenticateToken, requirePermission(MODULE, "create"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        const b = req.body || {};
        if (b.gross_salary != null) await exigerRemuneration(req, companyId);

        await client.query("BEGIN");
        const salarie = await salarieDe(companyId, Number(b.employee_id));
        if (!salarie) throw erreur("Salarié introuvable dans cette société.", "EMPLOYEE_NOT_FOUND", 404);

        const type = String(b.contract_type || "").toUpperCase();
        if (!["CDI", "CDD", "STAGE", "APPRENTISSAGE"].includes(type)) {
          throw erreur("Type de contrat invalide : CDI, CDD, STAGE ou APPRENTISSAGE.",
            "CONTRACT_TYPE_INVALID");
        }
        /* Les contraintes de la base diront la même chose, mais un message
           clair vaut mieux qu'une violation de contrainte. */
        if (type === "CDI" && b.end_date) {
          throw erreur("Un CDI n'a pas de date de fin.", "CDI_WITH_END_DATE");
        }
        if (type !== "CDI" && !b.end_date) {
          throw erreur(`Un ${type} doit porter une date de fin.`, "END_DATE_REQUIRED");
        }
        if (type === "CDD" && !String(b.cdd_reason || "").trim()) {
          throw erreur(
            "Le motif de recours au CDD est obligatoire. Aucun motif par défaut n'est "
            + "proposé : c'est à l'employeur de le dire.",
            "CDD_REASON_REQUIRED");
        }

        const ref = await reference(client, companyId, "CT");
        const { rows } = await client.query(
          `INSERT INTO hr_contracts
             (company_id, employee_id, reference, contract_type, job_title, site_label,
              start_date, end_date, trial_period_days, weekly_hours, gross_salary,
              cdd_reason, status, signed_place, notes, created_by, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9,$10,$11,$12,'BROUILLON',$13,$14,$15,$16)
           RETURNING *`,
          [companyId, salarie.id, ref, type, String(b.job_title || salarie.job_title || "").trim(),
           b.site_label || null, b.start_date, b.end_date || null,
           b.trial_period_days ?? null, b.weekly_hours ?? null, b.gross_salary ?? null,
           b.cdd_reason || null, b.signed_place || null, b.notes || null,
           req.user?.id || null, nomDe(req)]);

        await client.query("COMMIT");
        if (typeof logActivity === "function") {
          logActivity(nomDe(req), req.user?.role, `Création d'un contrat ${type}`,
            "Ressources humaines", `${ref} — ${salarie.full_name}`).catch(() => {});
        }
        res.status(201).json({ contrat: rows[0] });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Création du contrat impossible.");
      } finally { client.release(); }
    });

  router.post("/rh/contrats/:id/activer", authenticateToken, requirePermission(MODULE, "update"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const { rows } = await pool.query(
          `UPDATE hr_contracts SET status='ACTIF', signed_at=COALESCE($3::date, CURRENT_DATE),
                  updated_at=now()
            WHERE id=$1 AND company_id=$2 AND status='BROUILLON' RETURNING *`,
          [req.params.id, companyId, req.body?.signed_at || null]);
        if (!rows[0]) {
          return res.status(409).json({
            error: "Contrat introuvable, ou déjà actif. Un salarié n'a qu'un contrat actif à la fois.",
            code: "NOT_ACTIVATABLE" });
        }
        res.json({ contrat: rows[0] });
      } catch (e) {
        if (e.code === "23505") {
          return res.status(409).json({
            error: "Ce salarié a déjà un contrat actif. Terminez-le avant d'en activer un autre : "
              + "deux contrats actifs voudraient dire deux salaires.",
            code: "ALREADY_ACTIVE" });
        }
        fail(res, e, "Activation impossible.");
      }
    });

  router.post("/rh/contrats/:id/terminer", authenticateToken, requirePermission(MODULE, "update"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const motif = String(req.body?.motif || req.body?.reason || "").trim();
      if (motif.length < 5) {
        return res.status(400).json({ error: "Motif de fin de contrat obligatoire.", code: "REASON_REQUIRED" });
      }
      try {
        const { rows } = await pool.query(
          `UPDATE hr_contracts
              SET status='TERMINE', ended_at=COALESCE($3::date, CURRENT_DATE),
                  end_reason=$4, updated_at=now()
            WHERE id=$1 AND company_id=$2 AND status IN ('ACTIF','SUSPENDU') RETURNING *`,
          [req.params.id, companyId, req.body?.ended_at || null, motif]);
        if (!rows[0]) {
          return res.status(409).json({ error: "Contrat introuvable ou non actif.", code: "NOT_ENDABLE" });
        }
        res.json({ contrat: rows[0] });
      } catch (e) { fail(res, e, "Fin de contrat impossible."); }
    });

  router.get("/rh/contrats/:id/pdf", authenticateToken, requirePermission(MODULE, "print"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        /* Un contrat porte un salaire : le droit de l'imprimer ne suffit pas. */
        await exigerRemuneration(req, companyId);

        const { rows } = await client.query(
          `SELECT * FROM hr_contracts WHERE id=$1 AND company_id=$2`, [req.params.id, companyId]);
        const contrat = rows[0];
        if (!contrat) throw erreur("Contrat introuvable.", "CONTRACT_NOT_FOUND", 404);

        const salarie = await salarieDe(companyId, contrat.employee_id);
        const entreprise = await entrepriseDe(companyId);
        const { rows: clauses } = await client.query(
          `SELECT * FROM hr_contract_clauses
            WHERE is_active AND (company_id IS NULL OR company_id = $1)
              AND $2 = ANY(applies_to)
            ORDER BY sort_order`, [companyId, contrat.contract_type]);

        /* Les annexes ne sont citées que si elles sont RÉELLEMENT jointes. */
        const annexes = Array.isArray(req.body?.annexes) ? req.body.annexes : [];

        const pdf = await PDF.contrat({ entreprise, salarie, contrat, clauses, annexes });

        await client.query("BEGIN");
        await enregistrer(client, {
          companyId, employeeId: salarie?.id, contractId: contrat.id,
          docType: "CONTRAT", ref: await reference(client, companyId, "DOC"),
          titre: `Contrat ${contrat.contract_type} — ${salarie?.full_name || ""}`,
          payload: { contrat, clauses: clauses.map((c) => c.clause_key), annexes },
          pdf, utilisateur: { id: req.user?.id, name: nomDe(req) },
        });
        await client.query("COMMIT");

        envoyerPdf(res, pdf, contrat.reference);
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Édition du contrat impossible.");
      } finally { client.release(); }
    });

  /* ──────────────────────────── LES BULLETINS ─────────────────────────── */
  router.post("/rh/bulletins/:employeeId/:periode", authenticateToken,
    requirePermission(MODULE, "create"), async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        await exigerRemuneration(req, companyId);

        const salarie = await salarieDe(companyId, Number(req.params.employeeId));
        if (!salarie) throw erreur("Salarié introuvable.", "EMPLOYEE_NOT_FOUND", 404);

        const { rows: contrats } = await client.query(
          `SELECT * FROM hr_contracts
            WHERE company_id=$1 AND employee_id=$2 AND status='ACTIF' LIMIT 1`,
          [companyId, salarie.id]);
        const contrat = contrats[0] || null;

        const brut = Number(req.body?.brut ?? contrat?.gross_salary ?? 0);
        if (!(brut > 0)) {
          throw erreur(
            "Aucune rémunération brute : ni fournie, ni portée par un contrat actif.",
            "BRUT_INTROUVABLE");
        }

        const periode = String(req.params.periode);
        const dateRef = /^\d{4}-\d{2}$/.test(periode) ? `${periode}-01` : periode;
        const taux = await BULLETIN.tauxApplicables(client, companyId, dateRef);
        const calcul = BULLETIN.calculer({
          brut,
          gains: Array.isArray(req.body?.gains) ? req.body.gains : [],
          retenues: Array.isArray(req.body?.retenues) ? req.body.retenues : [],
          taux,
        });

        const entreprise = await entrepriseDe(companyId);
        const pdf = await PDF.bulletin({ entreprise, salarie, periode, calcul, contrat });

        await client.query("BEGIN");
        const doc = await enregistrer(client, {
          companyId, employeeId: salarie.id, contractId: contrat?.id || null,
          docType: "BULLETIN", ref: await reference(client, companyId, "BP"),
          titre: `Bulletin ${periode} — ${salarie.full_name}`, periode,
          payload: { calcul, brut }, pdf,
          utilisateur: { id: req.user?.id, name: nomDe(req) },
        });
        await client.query("COMMIT");

        if (req.query.pdf === "1") return envoyerPdf(res, pdf, doc.reference);
        res.status(201).json({
          document: doc, calcul,
          /* Le point qui compte : on dit quand le net n'a PAS été calculé. */
          message: calcul.complet
            ? `Bulletin ${doc.reference} établi. Net à payer : ${PDF.fcfa(calcul.net_a_payer)}.`
            : `Bulletin ${doc.reference} établi SANS net à payer. ${calcul.avertissement}`,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Établissement du bulletin impossible.");
      } finally { client.release(); }
    });

  /* ─────────────────── ATTESTATIONS ET CERTIFICATS ────────────────────── */
  router.post("/rh/attestations", authenticateToken, requirePermission(MODULE, "create"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        const type = String(req.body?.type || "").toUpperCase();
        if (!PDF.ATTESTATIONS[type]) {
          throw erreur(
            `Type inconnu. Attendu : ${Object.keys(PDF.ATTESTATIONS).join(", ")}.`,
            "TYPE_INVALIDE");
        }
        const salarie = await salarieDe(companyId, Number(req.body?.employee_id));
        if (!salarie) throw erreur("Salarié introuvable.", "EMPLOYEE_NOT_FOUND", 404);

        const { rows: contrats } = await client.query(
          `SELECT * FROM hr_contracts WHERE company_id=$1 AND employee_id=$2
            ORDER BY (status='ACTIF') DESC, start_date DESC LIMIT 1`,
          [companyId, salarie.id]);
        const contrat = contrats[0] || null;
        if (!contrat) {
          throw erreur(
            "Aucun contrat pour ce salarié : une attestation de travail ne s'invente pas.",
            "CONTRACT_REQUIRED", 409);
        }

        const entreprise = await entrepriseDe(companyId);
        const ref = await reference(client, companyId, "AT");
        const donnees = {
          entreprise, salarie, contrat, reference: ref,
          formation: req.body?.formation || {},
          lieu: req.body?.lieu || null, date: req.body?.date || new Date(),
        };
        const pdf = await PDF.attestation(type, donnees);

        await client.query("BEGIN");
        const doc = await enregistrer(client, {
          companyId, employeeId: salarie.id, contractId: contrat.id,
          docType: type, ref, titre: PDF.ATTESTATIONS[type].titre,
          payload: { contrat_reference: contrat.reference, formation: donnees.formation },
          pdf, utilisateur: { id: req.user?.id, name: nomDe(req) },
        });
        await client.query("COMMIT");

        if (req.query.pdf === "1") return envoyerPdf(res, pdf, ref);
        res.status(201).json({ document: doc });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Édition de l'attestation impossible.");
      } finally { client.release(); }
    });

  /* ───────────────────────────── LE DIPLÔME ───────────────────────────── */
  router.post("/rh/diplomes", authenticateToken, requirePermission(MODULE, "create"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        const b = req.body || {};
        if (!String(b.intitule || "").trim()) {
          throw erreur("L'intitulé de la formation est obligatoire.", "INTITULE_REQUIS");
        }
        const salarie = b.employee_id ? await salarieDe(companyId, Number(b.employee_id)) : null;
        const nom = salarie?.full_name || String(b.beneficiaire || "").trim();
        if (!nom) {
          throw erreur("Le bénéficiaire est obligatoire : un diplôme nomme quelqu'un.",
            "BENEFICIAIRE_REQUIS");
        }

        const entreprise = await entrepriseDe(companyId);
        const ref = await reference(client, companyId, "DIP");
        const pdf = await PDF.diplome({
          entreprise, beneficiaire: { full_name: nom },
          intitule: b.intitule, mention: b.mention, du: b.du, au: b.au,
          duree_heures: b.duree_heures, lieu: b.lieu, date: b.date || new Date(),
          reference: ref,
          signataire: b.signataire || { fonction: "La Direction", nom: entreprise?.manager || "" },
        });

        await client.query("BEGIN");
        const doc = await enregistrer(client, {
          companyId, employeeId: salarie?.id || null, docType: "DIPLOME", ref,
          titre: `Diplôme — ${nom}`, payload: { beneficiaire: nom, intitule: b.intitule },
          pdf, utilisateur: { id: req.user?.id, name: nomDe(req) },
        });
        await client.query("COMMIT");

        if (req.query.pdf === "1") return envoyerPdf(res, pdf, ref);
        res.status(201).json({ document: doc });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Édition du diplôme impossible.");
      } finally { client.release(); }
    });

  /* ──────────────────────────── LE REGISTRE ───────────────────────────── */
  router.get("/rh/documents", authenticateToken, requirePermission(MODULE, "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const montants = await peutVoirRemuneration(req, companyId);
        const conditions = ["d.company_id = $1"];
        const params = [companyId];
        if (req.query.type) { params.push(String(req.query.type)); conditions.push(`d.doc_type = $${params.length}`); }
        if (req.query.employee_id) { params.push(Number(req.query.employee_id)); conditions.push(`d.employee_id = $${params.length}`); }

        const { rows } = await pool.query(
          `SELECT d.*, e.full_name, e.employee_number
             FROM hr_documents d
             LEFT JOIN attendance_employees e ON e.id = d.employee_id
            WHERE ${conditions.join(" AND ")}
            ORDER BY d.issued_on DESC, d.id DESC LIMIT 300`, params);

        res.json({
          documents: rows.map((d) => montants ? d : { ...d, payload: { masque: true } }),
          remunerations_masquees: !montants,
        });
      } catch (e) { fail(res, e, "Lecture du registre impossible."); }
    });

  return router;
};

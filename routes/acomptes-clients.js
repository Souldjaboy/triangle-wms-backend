"use strict";

/**
 * ACOMPTES ET DÉPÔTS CLIENTS — sable et ciment.
 *
 *   GET  /acomptes                          les dépôts, filtrables
 *   GET  /acomptes/client/:activite/:id     la situation d'un compte client
 *   GET  /acomptes/:id/etat                 l'état d'un dépôt, imprimable
 *   POST /acomptes                          enregistrer un versement
 *   POST /acomptes/affectation              imputer sur une facture (FIFO ou choisi)
 *   POST /acomptes/allocations/:id/annuler  défaire une imputation, sans l'effacer
 *   POST /acomptes/:id/remboursement        rendre au client ce qui reste
 *   POST /acomptes/:id/annuler              annuler un dépôt jamais utilisé
 *
 * ─────────────────────────────────────────────────────────────────────────
 * LA RÈGLE QU'IL NE FAUT PAS PERDRE DE VUE
 *
 * L'argent n'entre en banque QU'UNE FOIS, au versement. Imputer un dépôt sur
 * une facture ne fait entrer aucun argent : cela déplace une dette envers le
 * client vers une créance éteinte. C'est l'erreur la plus naturelle du
 * domaine — encaisser la facture « payée par acompte » comme un vrai
 * encaissement — et elle double le chiffre d'affaires sans que le solde
 * bancaire ne le contredise, puisqu'il a bel et bien augmenté… un mois plus
 * tôt.
 *
 * Ici : le versement passe par `tresorerie.crediter()`. L'imputation ne
 * touche AUCUN compte financier ; elle n'écrit que les deux écritures qui
 * soldent l'avance contre la créance client.
 */

const express = require("express");
const T = require("../services/tresorerie");

const ACTIVITES = {
  sable:  { clients: "sand_customers",   factures: "sand_invoices",   prefixe: "DEP-SAB" },
  ciment: { clients: "cement_customers", factures: "cement_invoices", prefixe: "DEP-CIM" },
};

module.exports = function createAcomptesRouter(deps) {
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
    });
  };
  const activiteDe = (valeur) => {
    const a = String(valeur || "").trim().toLowerCase();
    if (!ACTIVITES[a]) {
      throw T.erreur("Activité attendue : sable ou ciment.", "ACTIVITY_INVALID", 400);
    }
    return a;
  };
  const motifDe = (req, minimum = 5) => {
    const m = String(req.body?.reason || "").trim();
    if (m.length < minimum) throw T.erreur("Un motif est obligatoire.", "REASON_REQUIRED", 400);
    return m;
  };

  /* L'intégrité référentielle ne pouvant être posée en base (deux jeux de
     tables selon l'activité), elle est vérifiée ici, à chaque écriture. */
  async function chargerClient(client, companyId, activite, customerId) {
    const { rows } = await client.query(
      `SELECT id, name FROM ${ACTIVITES[activite].clients}
        WHERE id = $1 AND company_id = $2`, [customerId, companyId]);
    if (!rows[0]) throw T.erreur("Client introuvable dans cette activité.", "CUSTOMER_NOT_FOUND", 404);
    return rows[0];
  }

  async function chargerFacture(client, companyId, activite, invoiceId, pourEcriture = false) {
    const { rows } = await client.query(
      `SELECT id, customer_id, invoice_number, total_amount, paid_amount,
              remaining_amount, status
         FROM ${ACTIVITES[activite].factures}
        WHERE id = $1 AND company_id = $2 ${pourEcriture ? "FOR UPDATE" : ""}`,
      [invoiceId, companyId]);
    if (!rows[0]) throw T.erreur("Facture introuvable dans cette activité.", "INVOICE_NOT_FOUND", 404);
    return rows[0];
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LECTURES
  // ═══════════════════════════════════════════════════════════════════════
  router.get(
    "/acomptes", authenticateToken, requirePermission("acompte_client", "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const { rows } = await pool.query(
          `SELECT d.*, (d.amount - d.available_amount) AS used_amount
             FROM client_deposits d
            WHERE d.company_id = $1
              AND ($2::text IS NULL OR d.activity = $2)
              AND ($3::int IS NULL OR d.customer_id = $3)
            ORDER BY d.business_date DESC, d.id DESC
            LIMIT 300`,
          [companyId,
           req.query?.activite ? String(req.query.activite).toLowerCase() : null,
           req.query?.client_id ? Number(req.query.client_id) : null]
        );
        res.json({ acomptes: rows });
      } catch (e) { fail(res, e, "Impossible de lire les acomptes."); }
    }
  );

  /** La situation d'un compte client : disponible, utilisé, factures impayées. */
  router.get(
    "/acomptes/client/:activite/:id", authenticateToken, requirePermission("acompte_client", "view"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const activite = activiteDe(req.params.activite);
        const customerId = Number(req.params.id);

        const { rows: depots } = await pool.query(
          `SELECT id, reference, amount, available_amount, business_date, status
             FROM client_deposits
            WHERE company_id = $1 AND activity = $2 AND customer_id = $3 AND status <> 'ANNULE'
            ORDER BY business_date, id`,
          [companyId, activite, customerId]);

        const { rows: factures } = await pool.query(
          `SELECT id, invoice_number, invoice_date, total_amount, paid_amount,
                  remaining_amount, status
             FROM ${ACTIVITES[activite].factures}
            WHERE company_id = $1 AND customer_id = $2
            ORDER BY invoice_date, id`,
          [companyId, customerId]);

        const somme = (liste, champ) => liste.reduce((t, l) => t + T.francs(l[champ]), 0);
        res.json({
          activite, client_id: customerId,
          depots,
          total_depose: somme(depots, "amount"),
          total_disponible: somme(depots, "available_amount"),
          total_utilise: somme(depots, "amount") - somme(depots, "available_amount"),
          factures,
          total_facture: somme(factures, "total_amount"),
          total_impaye: somme(factures, "remaining_amount"),
        });
      } catch (e) { fail(res, e, "Impossible de lire la situation du client."); }
    }
  );

  /**
   * L'état d'un dépôt, prêt à imprimer : dépôt initial, imputations,
   * remboursements, solde — dans l'ordre chronologique, avec un solde courant
   * ligne à ligne. C'est ce document que le client demande.
   */
  router.get(
    "/acomptes/:id/etat", authenticateToken, requirePermission("acompte_client", "print"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      try {
        const id = Number(req.params.id);
        const { rows: depots } = await pool.query(
          `SELECT d.*, c.name AS societe FROM client_deposits d
             JOIN companies c ON c.id = d.company_id
            WHERE d.id = $1 AND d.company_id = $2`, [id, companyId]);
        if (!depots[0]) return res.status(404).json({ error: "Dépôt introuvable." });
        const depot = depots[0];

        const { rows: imputations } = await pool.query(
          `SELECT created_at, amount, invoice_number, reason, performed_by_name,
                  reverses_allocation_id
             FROM client_deposit_allocations
            WHERE deposit_id = $1 ORDER BY created_at, id`, [id]);
        const { rows: remboursements } = await pool.query(
          `SELECT created_at, amount, reason, reference, performed_by_name
             FROM client_deposit_refunds WHERE deposit_id = $1 ORDER BY created_at, id`, [id]);

        /* Le solde courant est recalculé ligne à ligne plutôt que relu : un
           état doit pouvoir être vérifié à la main, ligne après ligne. */
        const lignes = [{
          date: depot.business_date, libelle: `Dépôt initial ${depot.reference}`,
          depot: T.francs(depot.amount), utilisation: 0,
        }];
        for (const i of imputations) {
          lignes.push({
            date: String(i.created_at).slice(0, 10),
            libelle: i.reverses_allocation_id
              ? `Annulation d'imputation — facture ${i.invoice_number}`
              : `Imputation facture ${i.invoice_number}`,
            depot: T.francs(i.amount) < 0 ? -T.francs(i.amount) : 0,
            utilisation: T.francs(i.amount) > 0 ? T.francs(i.amount) : 0,
          });
        }
        for (const r of remboursements) {
          lignes.push({
            date: String(r.created_at).slice(0, 10),
            libelle: `Remboursement au client${r.reference ? ` — réf. ${r.reference}` : ""}`,
            depot: 0, utilisation: T.francs(r.amount),
          });
        }
        let courant = 0;
        for (const l of lignes) { courant += l.depot - l.utilisation; l.solde = courant; }

        res.json({
          depot: {
            reference: depot.reference, societe: depot.societe, client: depot.customer_name,
            activite: depot.activity, date: depot.business_date,
            montant_initial: T.francs(depot.amount),
            total_utilise: T.francs(depot.amount) - T.francs(depot.available_amount),
            solde: T.francs(depot.available_amount),
            statut: depot.status,
          },
          lignes,
          /* Le solde du détail et celui de la fiche doivent coïncider. S'ils
             divergent, mieux vaut le dire sur l'état que le laisser croire. */
          coherent: courant === T.francs(depot.available_amount),
        });
      } catch (e) { fail(res, e, "Impossible d'établir l'état du dépôt."); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  // LE VERSEMENT — le seul moment où l'argent entre
  // ═══════════════════════════════════════════════════════════════════════
  router.post(
    "/acomptes", authenticateToken, requirePermission("acompte_client", "create"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        const activite = activiteDe(req.body?.activite);
        const customerId = Number(req.body?.client_id);
        const montant = T.francs(req.body?.amount);
        if (!(montant > 0)) throw T.erreur("Le montant doit être supérieur à zéro.", "AMOUNT_INVALID", 400);

        await client.query("BEGIN");
        const clientRow = await chargerClient(client, companyId, activite, customerId);

        const reference = await nextAccountingNumber(
          client, "client_deposits", "reference", ACTIVITES[activite].prefixe, companyId);

        const mouvement = await T.crediter(client, {
          companyId, montant,
          bankId: req.body?.bank_id ? Number(req.body.bank_id) : null,
          caisseId: req.body?.caisse_id ? Number(req.body.caisse_id) : null,
          prefixe: ACTIVITES[activite].prefixe,
          typeOperation: "acompte_client",
          sourceType: "client_deposit", sourceId: 0,
          description: `Acompte ${clientRow.name} (${activite})`,
          /* Un acompte est une DETTE envers le client tant qu'aucune facture
             ne l'absorbe — pas un produit. Le passer en chiffre d'affaires
             gonflerait le résultat du mois avec de l'argent non encore
             mérité. */
          compteCharge: "Avances reçues des clients",
          partenaire: clientRow.name,
          reference: String(req.body?.external_reference || ""),
          userId: req.user?.id || null,
          nextAccountingNumber, createAccountingEntry,
        });

        const { rows } = await client.query(
          `INSERT INTO client_deposits
             (company_id, activity, customer_id, customer_name, reference, amount, available_amount,
              business_date, payment_method, external_reference, justificatif_url, notes,
              bank_id, caisse_id, accounting_transaction_id, created_by, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$6,COALESCE($7::date, CURRENT_DATE),$8,$9,$10,$11,$12,$13,$14,$15,$16)
           RETURNING *`,
          [companyId, activite, customerId, clientRow.name, reference, montant,
           req.body?.business_date || null,
           String(req.body?.payment_method || ""), String(req.body?.external_reference || ""),
           String(req.body?.justificatif_url || ""), String(req.body?.notes || ""),
           req.body?.bank_id ? Number(req.body.bank_id) : null,
           req.body?.caisse_id ? Number(req.body.caisse_id) : null,
           mouvement.transaction.id, req.user?.id || null, nomDe(req)]
        );

        /* La transaction pointait sur l'identifiant 0 tant que le dépôt
           n'existait pas : on la rattache maintenant qu'il a un identifiant. */
        await client.query(
          `UPDATE accounting_transactions SET source_id = $1 WHERE id = $2`,
          [rows[0].id, mouvement.transaction.id]);
        await client.query(
          `UPDATE accounting_entries SET source_id = $1
            WHERE source_type = 'client_deposit' AND source_id = 0`, [rows[0].id]);

        await client.query("COMMIT");
        res.status(201).json({
          acompte: rows[0],
          recu: mouvement.transaction.transaction_number,
          compte: mouvement.compte,
          solde_compte_apres: mouvement.solde_apres,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Enregistrement de l'acompte impossible.");
      } finally { client.release(); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  // L'IMPUTATION — aucun argent ne bouge
  // ═══════════════════════════════════════════════════════════════════════
  router.post(
    "/acomptes/affectation", authenticateToken, requirePermission("acompte_client", "update"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        const activite = activiteDe(req.body?.activite);
        const invoiceId = Number(req.body?.invoice_id);
        const depotChoisi = req.body?.deposit_id ? Number(req.body.deposit_id) : null;
        const plafond = req.body?.amount != null ? T.francs(req.body.amount) : null;
        if (plafond !== null && !(plafond > 0)) {
          throw T.erreur("Le montant à imputer doit être supérieur à zéro.", "AMOUNT_INVALID", 400);
        }

        await client.query("BEGIN");
        const facture = await chargerFacture(client, companyId, activite, invoiceId, true);

        const restant = T.francs(facture.remaining_amount ??
          (T.francs(facture.total_amount) - T.francs(facture.paid_amount)));
        if (restant <= 0) {
          throw T.erreur("Cette facture est déjà soldée.", "INVOICE_ALREADY_SETTLED", 409);
        }

        /* FIFO par défaut : le plus ancien dépôt d'abord. C'est ce qu'attend
           un client qui a versé plusieurs fois — son premier argent sert en
           premier. Un dépôt nommément choisi court-circuite l'ordre, ce qui
           reste légitime quand un versement était fléché. */
        const { rows: depots } = await client.query(
          `SELECT * FROM client_deposits
            WHERE company_id = $1 AND activity = $2 AND customer_id = $3
              AND status = 'ACTIF' AND available_amount > 0
              AND ($4::int IS NULL OR id = $4)
            ORDER BY business_date, id
            FOR UPDATE`,
          [companyId, activite, facture.customer_id, depotChoisi]);

        if (!depots.length) {
          throw T.erreur(
            depotChoisi
              ? "Ce dépôt n'a plus rien de disponible."
              : "Ce client n'a aucun dépôt disponible.",
            "NO_DEPOSIT_AVAILABLE", 409);
        }

        let aImputer = Math.min(restant, plafond ?? restant);
        const imputations = [];
        for (const depot of depots) {
          if (aImputer <= 0) break;
          const part = Math.min(T.francs(depot.available_amount), aImputer);
          if (part <= 0) continue;

          const apres = T.francs(depot.available_amount) - part;
          const { rows: lignes } = await client.query(
            `INSERT INTO client_deposit_allocations
               (company_id, deposit_id, activity, invoice_id, invoice_number, amount,
                available_before, available_after, performed_by, performed_by_name)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
            [companyId, depot.id, activite, facture.id, facture.invoice_number || "",
             part, T.francs(depot.available_amount), apres, req.user?.id || null, nomDe(req)]);

          await client.query(
            `UPDATE client_deposits
                SET available_amount = $1::numeric,
                    status = CASE WHEN $1::numeric = 0 THEN 'EPUISE' ELSE 'ACTIF' END,
                    updated_at = now()
              WHERE id = $2`, [apres, depot.id]);

          /* Aucun compte financier n'est touché : l'argent est entré au
             versement. On solde seulement l'avance contre la créance. */
          for (const ecriture of [
            { accountLabel: "Avances reçues des clients", debit: part, credit: 0 },
            { accountLabel: "Créances clients",           debit: 0,    credit: part },
          ]) {
            await createAccountingEntry(client, {
              companyId, sourceType: "client_deposit_allocation", sourceId: lignes[0].id,
              ...ecriture,
              description: `Imputation acompte ${depot.reference} sur facture ${facture.invoice_number || facture.id}`,
              createdBy: req.user?.id || null,
            });
          }

          imputations.push({
            depot: depot.reference, montant: part, disponible_apres: apres,
          });
          aImputer -= part;
        }

        const impute = imputations.reduce((t, i) => t + i.montant, 0);
        if (impute <= 0) throw T.erreur("Rien n'a pu être imputé.", "NOTHING_ALLOCATED", 409);

        const paye = T.francs(facture.paid_amount) + impute;
        const reste = T.francs(facture.total_amount) - paye;
        const { rows: facturesMaj } = await client.query(
          /* Types explicites : sans eux, PostgreSQL déduit $1 comme numeric
             pour l'affectation et comme entier pour la comparaison, et refuse
             la requête (« inconsistent types deduced for parameter $1 »). */
          `UPDATE ${ACTIVITES[activite].factures}
              SET paid_amount = $1::numeric, remaining_amount = $2::numeric,
                  status = CASE WHEN $2::numeric <= 0 THEN 'PAYEE'
                                WHEN $1::numeric > 0 THEN 'PARTIELLEMENT_PAYEE'
                                ELSE status END,
                  updated_at = now()
            WHERE id = $3 RETURNING invoice_number, total_amount, paid_amount, remaining_amount, status`,
          [paye, Math.max(0, reste), facture.id]);

        await client.query("COMMIT");
        res.json({
          facture: facturesMaj[0],
          imputations,
          total_impute: impute,
          reste_impaye: Math.max(0, reste),
          message: reste <= 0
            ? "Facture entièrement réglée par acompte."
            : `${impute.toLocaleString("fr-FR")} FCFA imputés ; il reste ${Math.max(0, reste).toLocaleString("fr-FR")} FCFA impayés.`,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Imputation impossible.");
      } finally { client.release(); }
    }
  );

  router.post(
    "/acomptes/allocations/:id/annuler", authenticateToken, requirePermission("acompte_client", "cancel"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        const motif = motifDe(req);
        await client.query("BEGIN");
        const { rows: lignes } = await client.query(
          `SELECT * FROM client_deposit_allocations WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [Number(req.params.id), companyId]);
        const ligne = lignes[0];
        if (!ligne) throw T.erreur("Imputation introuvable.", "ALLOCATION_NOT_FOUND", 404);
        if (ligne.reverses_allocation_id) {
          throw T.erreur("Une annulation ne s'annule pas.", "ALREADY_REVERSAL", 409);
        }
        const { rows: deja } = await client.query(
          `SELECT 1 FROM client_deposit_allocations WHERE reverses_allocation_id = $1`, [ligne.id]);
        if (deja[0]) throw T.erreur("Cette imputation est déjà annulée.", "ALREADY_REVERSED", 409);

        const { rows: depots } = await client.query(
          `SELECT * FROM client_deposits WHERE id = $1 FOR UPDATE`, [ligne.deposit_id]);
        const depot = depots[0];
        const rendu = T.francs(ligne.amount);
        const apres = T.francs(depot.available_amount) + rendu;
        if (apres > T.francs(depot.amount)) {
          throw T.erreur("L'annulation rendrait au dépôt plus qu'il n'a jamais contenu.",
            "DEPOSIT_BALANCE_INVALID", 409);
        }

        await client.query(
          `INSERT INTO client_deposit_allocations
             (company_id, deposit_id, activity, invoice_id, invoice_number, amount,
              available_before, available_after, reverses_allocation_id, reason,
              performed_by, performed_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [companyId, depot.id, ligne.activity, ligne.invoice_id, ligne.invoice_number,
           -rendu, T.francs(depot.available_amount), apres, ligne.id, motif,
           req.user?.id || null, nomDe(req)]);

        await client.query(
          `UPDATE client_deposits SET available_amount = $1, status = 'ACTIF', updated_at = now()
            WHERE id = $2`, [apres, depot.id]);

        const facture = await chargerFacture(client, companyId, ligne.activity, ligne.invoice_id, true);
        const paye = Math.max(0, T.francs(facture.paid_amount) - rendu);
        await client.query(
          `UPDATE ${ACTIVITES[ligne.activity].factures}
              SET paid_amount = $1::numeric, remaining_amount = $2::numeric,
                  status = CASE WHEN $2::numeric <= 0 THEN 'PAYEE'
                                WHEN $1::numeric > 0 THEN 'PARTIELLEMENT_PAYEE'
                                ELSE 'IMPAYEE' END,
                  updated_at = now()
            WHERE id = $3`,
          [paye, T.francs(facture.total_amount) - paye, facture.id]);

        for (const ecriture of [
          { accountLabel: "Créances clients",           debit: rendu, credit: 0 },
          { accountLabel: "Avances reçues des clients", debit: 0,     credit: rendu },
        ]) {
          await createAccountingEntry(client, {
            companyId, sourceType: "client_deposit_allocation_reversal", sourceId: ligne.id,
            ...ecriture, description: `Annulation d'imputation — ${motif}`,
            createdBy: req.user?.id || null,
          });
        }

        await client.query("COMMIT");
        res.json({
          rendu, disponible_apres: apres,
          message: "Imputation annulée. La ligne d'origine reste sur l'état du dépôt.",
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Annulation impossible.");
      } finally { client.release(); }
    }
  );

  // ═══════════════════════════════════════════════════════════════════════
  // REMBOURSEMENT — l'argent ressort
  // ═══════════════════════════════════════════════════════════════════════
  router.post(
    "/acomptes/:id/remboursement", authenticateToken, requirePermission("acompte_client", "cancel"),
    async (req, res) => {
      const companyId = requireCompany(req, res); if (!companyId) return;
      const client = await pool.connect();
      try {
        const motif = motifDe(req);
        const montant = T.francs(req.body?.amount);
        if (!(montant > 0)) throw T.erreur("Le montant doit être supérieur à zéro.", "AMOUNT_INVALID", 400);

        await client.query("BEGIN");
        const { rows: depots } = await client.query(
          `SELECT * FROM client_deposits WHERE id = $1 AND company_id = $2 FOR UPDATE`,
          [Number(req.params.id), companyId]);
        const depot = depots[0];
        if (!depot) throw T.erreur("Dépôt introuvable.", "DEPOSIT_NOT_FOUND", 404);
        if (depot.status === "ANNULE") throw T.erreur("Ce dépôt est annulé.", "DEPOSIT_CANCELLED", 409);

        const disponible = T.francs(depot.available_amount);
        if (montant > disponible) {
          throw T.erreur(
            `Ce dépôt ne dispose que de ${disponible.toLocaleString("fr-FR")} FCFA ; ${montant.toLocaleString("fr-FR")} ont été saisis.`,
            "REFUND_ABOVE_AVAILABLE", 409, { disponible, demande: montant });
        }

        const mouvement = await T.debiter(client, {
          companyId, montant,
          bankId: req.body?.bank_id ? Number(req.body.bank_id) : depot.bank_id,
          caisseId: req.body?.caisse_id ? Number(req.body.caisse_id) : depot.caisse_id,
          prefixe: "REMB-DEP",
          typeOperation: "remboursement_acompte_client",
          sourceType: "client_deposit_refund", sourceId: depot.id,
          description: `Remboursement acompte ${depot.reference} — ${depot.customer_name}`,
          compteCharge: "Avances reçues des clients",
          partenaire: depot.customer_name,
          reference: String(req.body?.reference || ""),
          userId: req.user?.id || null,
          nextAccountingNumber, createAccountingEntry,
        });

        const apres = disponible - montant;
        const { rows } = await client.query(
          `INSERT INTO client_deposit_refunds
             (company_id, deposit_id, amount, available_before, available_after, reason,
              bank_id, caisse_id, accounting_transaction_id, reference, performed_by, performed_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [companyId, depot.id, montant, disponible, apres, motif,
           req.body?.bank_id ? Number(req.body.bank_id) : depot.bank_id,
           req.body?.caisse_id ? Number(req.body.caisse_id) : depot.caisse_id,
           mouvement.transaction.id, String(req.body?.reference || ""),
           req.user?.id || null, nomDe(req)]);

        await client.query(
          `UPDATE client_deposits
              SET available_amount = $1::numeric,
                  status = CASE WHEN $1::numeric = 0 THEN 'EPUISE' ELSE 'ACTIF' END,
                  updated_at = now()
            WHERE id = $2`, [apres, depot.id]);

        await client.query("COMMIT");
        res.json({
          remboursement: rows[0], disponible_apres: apres,
          recu: mouvement.transaction.transaction_number,
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        fail(res, e, "Remboursement impossible.");
      } finally { client.release(); }
    }
  );

  return router;
};

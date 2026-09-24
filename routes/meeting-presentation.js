"use strict";

const express = require("express");

module.exports = function createMeetingPresentationRouter({
  pool,
  authenticateToken,
  getEffectiveCompanyId,
  requirePermission,
}) {
  const router = express.Router();

  const permission = requirePermission
    ? requirePermission("presentation_reunion", "view")
    : (req,res,next)=>next();

  const companyOf = (req) =>
    Number(getEffectiveCompanyId(req, req.user?.company_id) || req.user?.company_id || 0);

  router.get(
    "/meeting-presentation",
    authenticateToken,
    permission,
    async (req,res) => {
      try {
        const companyId = companyOf(req);

        if (!companyId) {
          return res.status(409).json({
            error: "Entreprise active requise."
          });
        }

        const today = new Date();
        const defaultStart =
          `${today.getUTCFullYear()}-${String(today.getUTCMonth()+1).padStart(2,"0")}-01`;

        const defaultEnd =
          `${today.getUTCFullYear()}-${String(today.getUTCMonth()+1).padStart(2,"0")}-${String(today.getUTCDate()).padStart(2,"0")}`;

        const from = String(req.query.from || defaultStart);
        const to = String(req.query.to || defaultEnd);

        let revenue = 0;
        let expenses = 0;
        let sales = [];
        let expenseDetails = [];

        if (companyId === 1) {

          const ca = await pool.query(
            `SELECT COALESCE(SUM(total_amount),0) total
               FROM cement_sales
              WHERE company_id=$1
                AND sale_date BETWEEN $2::date AND $3::date
                AND COALESCE(status,'') <> 'ANNULEE'`,
            [companyId,from,to]
          );

          revenue = Number(ca.rows[0]?.total || 0);

          sales = (
            await pool.query(
              `SELECT
                  sale_date,
                  tonnage,
                  total_amount,
                  paid_amount,
                  remaining_amount,
                  status
                 FROM cement_sales
                WHERE company_id=$1
                  AND sale_date BETWEEN $2::date AND $3::date
                  AND COALESCE(status,'') <> 'ANNULEE'
                ORDER BY sale_date DESC,id DESC
                LIMIT 500`,
              [companyId,from,to]
            )
          ).rows;

        } else if (companyId === 5) {

          const ca = await pool.query(
            `SELECT
                COALESCE(SUM(recette),0) recette,
                COALESCE(SUM(depense),0) depense
               FROM camion_operations
              WHERE company_id=$1
                AND op_date BETWEEN $2::date AND $3::date`,
            [companyId,from,to]
          );

          revenue = Number(ca.rows[0]?.recette || 0);
          expenses = Number(ca.rows[0]?.depense || 0);

          sales = (
            await pool.query(
              `SELECT
                  op_date,
                  libelle,
                  recette,
                  depense,
                  piece_ref
                 FROM camion_operations
                WHERE company_id=$1
                  AND op_date BETWEEN $2::date AND $3::date
                ORDER BY op_date DESC,id DESC
                LIMIT 500`,
              [companyId,from,to]
            )
          ).rows;
        }

        /*
         * Pour Triangle, les dépenses viennent des vraies opérations
         * comptables, jamais des rapprochements/retraits/transferts.
         */
        if (companyId !== 5) {
          const dep = await pool.query(
            `SELECT COALESCE(SUM(amount),0) total
               FROM accounting_transactions
              WHERE company_id=$1
                AND direction='sortie'
                AND status='validé'
                AND COALESCE(operation_date,created_at::date)
                    BETWEEN $2::date AND $3::date

                AND COALESCE(transaction_type,'') NOT IN (
                  'ajustement_bancaire',
                  'retrait_banque',
                  'retrait_historique',
                  'depot_historique',
                  'transfert',
                  'virement'
                )

                AND COALESCE(source_type,'')
                    NOT ILIKE 'reconciliation%'`,
            [companyId,from,to]
          );

          expenses = Number(dep.rows[0]?.total || 0);

          expenseDetails = (
            await pool.query(
              `SELECT
                  COALESCE(operation_date,created_at::date) AS date,
                  transaction_number,
                  transaction_type,
                  category,
                  description,
                  amount
                 FROM accounting_transactions
                WHERE company_id=$1
                  AND direction='sortie'
                  AND status='validé'
                  AND COALESCE(operation_date,created_at::date)
                      BETWEEN $2::date AND $3::date

                  AND COALESCE(transaction_type,'') NOT IN (
                    'ajustement_bancaire',
                    'retrait_banque',
                    'retrait_historique',
                    'depot_historique',
                    'transfert',
                    'virement'
                  )

                  AND COALESCE(source_type,'')
                      NOT ILIKE 'reconciliation%'

                ORDER BY
                  COALESCE(operation_date,created_at::date) DESC,
                  id DESC
                LIMIT 500`,
              [companyId,from,to]
            )
          ).rows;
        }

        res.json({
          company_id: companyId,
          from,
          to,

          chiffre_affaires: revenue,
          depenses: expenses,
          resultat: revenue - expenses,

          ventes: sales,
          detail_depenses: expenseDetails,

          confidentialite: {
            bank_balances_exposed: false,
            treasury_balance_exposed: false,
          },
        });

      } catch (e) {
        console.error("meeting presentation:",e);
        res.status(500).json({
          error:"Erreur génération présentation réunion."
        });
      }
    }
  );

  return router;
};

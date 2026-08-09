const express = require("express");

module.exports = function createSandSalesRouter({
  pool,
  authenticateToken,
  getEffectiveCompanyId,
  requirePermission
}) {
  const router = express.Router();

  const companyOf = (req) =>
    Number(getEffectiveCompanyId(req) || 0);

  const perm = (action) =>
    requirePermission("sand", action);

  function fatMatOnly(req, res, next) {
    const companyId = companyOf(req);

    if (companyId !== 5) {
      return res.status(403).json({
        error: "Le module Vente de Sable est réservé à FAT & MAT.",
        code: "SAND_FATMAT_ONLY"
      });
    }

    next();
  }

  // ==========================================================
  // PRODUITS SABLE
  // ==========================================================

  router.get(
    "/sand/products",
    authenticateToken,
    fatMatOnly,
    perm("view"),
    async (req, res) => {
      try {
        const { rows } = await pool.query(
          `SELECT *
           FROM sand_products
           WHERE company_id=$1
           ORDER BY name`,
          [companyOf(req)]
        );

        res.json(rows);
      } catch (error) {
        console.error("SAND PRODUCTS:", error);
        res.status(500).json({
          error: "Erreur chargement produits sable."
        });
      }
    }
  );

  // ==========================================================
  // TARIFS SABLE
  // ==========================================================

  router.get(
    "/sand/prices",
    authenticateToken,
    fatMatOnly,
    perm("view"),
    async (req, res) => {
      try {
        const { rows } = await pool.query(
          `SELECT
             p.*,
             sp.name AS product_name,
             sp.unit,
             CASE
               WHEN p.quantity_reference > 0
               THEN ROUND(p.price / p.quantity_reference,2)
               ELSE 0
             END AS unit_price_m3
           FROM sand_prices p
           JOIN sand_products sp
             ON sp.id=p.sand_product_id
            AND sp.company_id=p.company_id
           WHERE p.company_id=$1
           ORDER BY p.destination,p.id`,
          [companyOf(req)]
        );

        res.json(rows);
      } catch (error) {
        console.error("SAND PRICES:", error);
        res.status(500).json({
          error: "Erreur chargement tarifs sable."
        });
      }
    }
  );

  // ==========================================================
  // CLIENTS
  // ==========================================================

  router.get(
    "/sand/customers",
    authenticateToken,
    fatMatOnly,
    perm("view"),
    async (req, res) => {
      try {
        const { rows } = await pool.query(
          `SELECT *
           FROM sand_customers
           WHERE company_id=$1
           ORDER BY name`,
          [companyOf(req)]
        );

        res.json(rows);
      } catch (error) {
        console.error("SAND CUSTOMERS:", error);
        res.status(500).json({
          error: "Erreur chargement clients sable."
        });
      }
    }
  );

  // ==========================================================
  // VENTES
  // ==========================================================

  router.get(
    "/sand/sales",
    authenticateToken,
    fatMatOnly,
    perm("view"),
    async (req, res) => {
      try {
        const { rows } = await pool.query(
          `SELECT *
           FROM sand_sales
           WHERE company_id=$1
           ORDER BY sale_date DESC,id DESC`,
          [companyOf(req)]
        );

        res.json(rows);
      } catch (error) {
        console.error("SAND SALES:", error);
        res.status(500).json({
          error: "Erreur chargement ventes sable."
        });
      }
    }
  );

  // ==========================================================
  // FACTURES
  // ==========================================================

  router.get(
    "/sand/invoices",
    authenticateToken,
    fatMatOnly,
    perm("view"),
    async (req, res) => {
      try {
        const { rows } = await pool.query(
          `SELECT *
           FROM sand_invoices
           WHERE company_id=$1
           ORDER BY invoice_date DESC,id DESC`,
          [companyOf(req)]
        );

        res.json(rows);
      } catch (error) {
        console.error("SAND INVOICES:", error);
        res.status(500).json({
          error: "Erreur chargement factures sable."
        });
      }
    }
  );

  // ==========================================================
  // BONS DE LIVRAISON
  // ==========================================================

  router.get(
    "/sand/deliveries",
    authenticateToken,
    fatMatOnly,
    perm("view"),
    async (req, res) => {
      try {
        const { rows } = await pool.query(
          `SELECT *
           FROM sand_deliveries
           WHERE company_id=$1
           ORDER BY delivery_date DESC,id DESC`,
          [companyOf(req)]
        );

        res.json(rows);
      } catch (error) {
        console.error("SAND DELIVERIES:", error);
        res.status(500).json({
          error: "Erreur chargement BL sable."
        });
      }
    }
  );

  // ==========================================================
  // PROFORMAS
  // ==========================================================

  router.get(
    "/sand/proformas",
    authenticateToken,
    fatMatOnly,
    perm("view"),
    async (req, res) => {
      try {
        const { rows } = await pool.query(
          `SELECT *
           FROM sand_proformas
           WHERE company_id=$1
           ORDER BY proforma_date DESC,id DESC`,
          [companyOf(req)]
        );

        res.json(rows);
      } catch (error) {
        console.error("SAND PROFORMAS:", error);
        res.status(500).json({
          error: "Erreur chargement proformas sable."
        });
      }
    }
  );



  // ==========================================================
  // SAND_WRITE_WORKFLOW_V1
  // FAT & MAT : tarifs + clients + ventes + validation
  // ==========================================================

  async function nextSandNumber(client, companyId, prefix) {
    const { rows } = await client.query(
      `INSERT INTO sand_counters
       (company_id,counter_key,counter_date,current_value)
       VALUES($1,$2,CURRENT_DATE,1)
       ON CONFLICT(company_id,counter_key,counter_date)
       DO UPDATE SET current_value=sand_counters.current_value+1
       RETURNING current_value`,
      [companyId, prefix]
    );

    const d = new Date();
    const yy = String(d.getFullYear()).slice(-2);
    const mm = String(d.getMonth()+1).padStart(2,"0");
    const dd = String(d.getDate()).padStart(2,"0");

    return `${prefix}-${yy}${mm}${dd}-${String(rows[0].current_value).padStart(3,"0")}`;
  }

  // ---------------- TARIFS : AJOUTER ----------------

  router.post(
    "/sand/prices",
    authenticateToken,
    fatMatOnly,
    perm("create"),
    async (req,res) => {
      try {
        const companyId = companyOf(req);

        const productId = Number(req.body?.sand_product_id);
        const destination = String(req.body?.destination || "").trim();
        const quantityReference = Number(req.body?.quantity_reference || 10);
        const price = Number(req.body?.price || 0);
        const transportPrice = Number(req.body?.transport_price || 0);

        if (!productId || !destination || quantityReference <= 0 || price <= 0) {
          return res.status(400).json({
            error: "Produit, destination, quantité de référence et prix obligatoires."
          });
        }

        const product = (
          await pool.query(
            `SELECT id
             FROM sand_products
             WHERE id=$1 AND company_id=$2`,
            [productId,companyId]
          )
        ).rows[0];

        if (!product) {
          return res.status(404).json({error:"Produit sable introuvable."});
        }

        const { rows } = await pool.query(
          `INSERT INTO sand_prices(
             company_id,
             sand_product_id,
             destination,
             quantity_reference,
             price,
             transport_price,
             status,
             created_by
           )
           VALUES($1,$2,$3,$4,$5,$6,'ACTIF',$7)
           RETURNING *`,
          [
            companyId,
            productId,
            destination,
            quantityReference,
            price,
            transportPrice,
            req.user.id
          ]
        );

        res.status(201).json(rows[0]);

      } catch(e) {
        console.error("CREATE SAND PRICE:",e);
        res.status(500).json({error:"Erreur création tarif sable."});
      }
    }
  );

  // ---------------- TARIFS : MODIFIER ----------------

  router.patch(
    "/sand/prices/:id",
    authenticateToken,
    fatMatOnly,
    perm("update"),
    async (req,res) => {
      try {
        const companyId = companyOf(req);

        const { rows } = await pool.query(
          `UPDATE sand_prices
           SET destination=COALESCE($3,destination),
               quantity_reference=COALESCE($4,quantity_reference),
               price=COALESCE($5,price),
               transport_price=COALESCE($6,transport_price),
               status=COALESCE($7,status),
               updated_at=NOW()
           WHERE id=$1 AND company_id=$2
           RETURNING *`,
          [
            req.params.id,
            companyId,
            req.body?.destination ?? null,
            req.body?.quantity_reference ?? null,
            req.body?.price ?? null,
            req.body?.transport_price ?? null,
            req.body?.status ?? null
          ]
        );

        if (!rows[0]) {
          return res.status(404).json({error:"Tarif introuvable."});
        }

        res.json(rows[0]);

      } catch(e) {
        console.error("UPDATE SAND PRICE:",e);
        res.status(500).json({error:"Erreur modification tarif."});
      }
    }
  );

  // ---------------- TARIFS : SUPPRIMER ----------------

  router.delete(
    "/sand/prices/:id",
    authenticateToken,
    fatMatOnly,
    perm("delete"),
    async (req,res) => {
      try {
        const result = await pool.query(
          `DELETE FROM sand_prices
           WHERE id=$1 AND company_id=$2`,
          [req.params.id,companyOf(req)]
        );

        if (!result.rowCount) {
          return res.status(404).json({error:"Tarif introuvable."});
        }

        res.json({success:true});

      } catch(e) {
        console.error("DELETE SAND PRICE:",e);
        res.status(500).json({error:"Erreur suppression tarif."});
      }
    }
  );

  // ---------------- CLIENT : CRÉER ----------------

  router.post(
    "/sand/customers",
    authenticateToken,
    fatMatOnly,
    perm("create"),
    async (req,res) => {
      const client = await pool.connect();

      try {
        const companyId = companyOf(req);
        const name = String(req.body?.name || "").trim();

        if (!name) {
          return res.status(400).json({error:"Nom du client obligatoire."});
        }

        await client.query("BEGIN");

        const number = await nextSandNumber(
          client,
          companyId,
          "CLI-SAB"
        );

        const { rows } = await client.query(
          `INSERT INTO sand_customers(
             company_id,
             customer_code,
             name,
             phone,
             email,
             address,
             nif,
             rccm,
             status,
             created_by
           )
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ACTIF',$9)
           RETURNING *`,
          [
            companyId,
            number,
            name,
            String(req.body?.phone || "").trim() || null,
            String(req.body?.email || "").trim() || null,
            String(req.body?.address || "").trim() || null,
            String(req.body?.nif || "").trim() || null,
            String(req.body?.rccm || "").trim() || null,
            req.user.id
          ]
        );

        await client.query("COMMIT");

        res.status(201).json(rows[0]);

      } catch(e) {
        await client.query("ROLLBACK").catch(()=>{});
        console.error("CREATE SAND CUSTOMER:",e);
        res.status(500).json({error:"Erreur création client sable."});
      } finally {
        client.release();
      }
    }
  );

  // ---------------- VENTE : CRÉER ----------------

  router.post(
    "/sand/sales",
    authenticateToken,
    fatMatOnly,
    perm("create"),
    async (req,res) => {
      const client = await pool.connect();

      try {
        const companyId = companyOf(req);

        const customerId = Number(req.body?.customer_id);
        const productId = Number(req.body?.sand_product_id);
        const destination = String(req.body?.destination || "").trim();
        const quantity = Number(req.body?.quantity_m3 || 0);

        if (!customerId || !productId || !destination || quantity <= 0) {
          return res.status(400).json({
            error:"Client, produit, destination et quantité m³ obligatoires."
          });
        }

        await client.query("BEGIN");

        const customer = (
          await client.query(
            `SELECT *
             FROM sand_customers
             WHERE id=$1 AND company_id=$2`,
            [customerId,companyId]
          )
        ).rows[0];

        if (!customer) {
          await client.query("ROLLBACK");
          return res.status(404).json({error:"Client introuvable."});
        }

        const product = (
          await client.query(
            `SELECT *
             FROM sand_products
             WHERE id=$1 AND company_id=$2`,
            [productId,companyId]
          )
        ).rows[0];

        if (!product) {
          await client.query("ROLLBACK");
          return res.status(404).json({error:"Produit sable introuvable."});
        }

        const tariff = (
          await client.query(
            `SELECT *
             FROM sand_prices
             WHERE company_id=$1
               AND sand_product_id=$2
               AND LOWER(destination)=LOWER($3)
               AND status='ACTIF'
             ORDER BY id DESC
             LIMIT 1`,
            [companyId,productId,destination]
          )
        ).rows[0];

        let unitPrice = Number(req.body?.unit_price || 0);
        let transportPrice = Number(req.body?.transport_price || 0);

        if (!unitPrice && tariff) {
          unitPrice =
            Number(tariff.price) /
            Number(tariff.quantity_reference || 1);
        }

        if (!transportPrice && tariff) {
          transportPrice = Number(tariff.transport_price || 0);
        }

        if (unitPrice <= 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error:"Aucun prix valide pour cette destination."
          });
        }

        const sandSubtotal = quantity * unitPrice;

        const transportMode =
          String(req.body?.transport_mode || "PAR_OPERATION");

        const transportTotal =
          transportMode === "PAR_M3"
            ? quantity * transportPrice
            : transportPrice;

        const discount = Math.max(Number(req.body?.discount || 0),0);
        const taxAmount = Math.max(Number(req.body?.tax_amount || 0),0);

        const total =
          Math.max(
            sandSubtotal +
            transportTotal -
            discount +
            taxAmount,
            0
          );

        const paid =
          Math.max(
            Math.min(Number(req.body?.paid_amount || 0),total),
            0
          );

        const remaining = total - paid;

        const saleNumber =
          await nextSandNumber(client,companyId,"VS");

        const { rows } = await client.query(
          `INSERT INTO sand_sales(
             company_id,
             sale_number,
             customer_id,
             customer_name,
             customer_phone,
             customer_address,
             sand_product_id,
             product_name,
             destination,
             delivery_place,
             quantity_m3,
             unit_price,
             sand_subtotal,
             transport_price,
             transport_total,
             discount,
             tax_amount,
             total_amount,
             paid_amount,
             remaining_amount,
             truck,
             driver_name,
             voucher_number,
             notes,
             status,
             created_by
           )
           VALUES(
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
             $21,$22,$23,$24,'BROUILLON',$25
           )
           RETURNING *`,
          [
            companyId,
            saleNumber,
            customer.id,
            customer.name,
            customer.phone,
            customer.address,
            product.id,
            product.name,
            destination,
            String(req.body?.delivery_place || destination),
            quantity,
            unitPrice,
            sandSubtotal,
            transportPrice,
            transportTotal,
            discount,
            taxAmount,
            total,
            paid,
            remaining,
            String(req.body?.truck || "").trim() || null,
            String(req.body?.driver_name || "").trim() || null,
            String(req.body?.voucher_number || "").trim() || null,
            String(req.body?.notes || "").trim() || null,
            req.user.id
          ]
        );

        await client.query("COMMIT");

        res.status(201).json({
          ...rows[0],
          stock_impacted:false
        });

      } catch(e) {
        await client.query("ROLLBACK").catch(()=>{});
        console.error("CREATE SAND SALE:",e);
        res.status(500).json({error:"Erreur création vente sable."});
      } finally {
        client.release();
      }
    }
  );

  // ---------------- VENTE : VALIDER ----------------
  // Crée automatiquement BL + facture.
  // Aucun mouvement de stock Triangle.

  router.post(
    "/sand/sales/:id/validate",
    authenticateToken,
    fatMatOnly,
    perm("validate"),
    async (req,res) => {
      const client = await pool.connect();

      try {
        const companyId = companyOf(req);

        await client.query("BEGIN");

        const sale = (
          await client.query(
            `SELECT *
             FROM sand_sales
             WHERE id=$1 AND company_id=$2
             FOR UPDATE`,
            [req.params.id,companyId]
          )
        ).rows[0];

        if (!sale) {
          await client.query("ROLLBACK");
          return res.status(404).json({error:"Vente introuvable."});
        }

        if (sale.status !== "BROUILLON") {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error:`Vente déjà traitée (${sale.status}).`
          });
        }

        const deliveryNumber =
          await nextSandNumber(client,companyId,"BL-SAB");

        const invoiceNumber =
          await nextSandNumber(client,companyId,"FAC-SAB");

        const userRow = (
          await client.query(
            `SELECT fullname
             FROM users
             WHERE id=$1`,
            [req.user.id]
          )
        ).rows[0];

        const author =
          userRow?.fullname ||
          req.user.email ||
          "Utilisateur";

        const delivery = (
          await client.query(
            `INSERT INTO sand_deliveries(
               company_id,
               sale_id,
               delivery_number,
               destination,
               quantity_m3,
               truck,
               driver_name,
               voucher_number,
               delivered_by,
               notes,
               created_by
             )
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             RETURNING *`,
            [
              companyId,
              sale.id,
              deliveryNumber,
              sale.delivery_place || sale.destination,
              sale.quantity_m3,
              sale.truck,
              sale.driver_name,
              sale.voucher_number,
              author,
              sale.notes,
              req.user.id
            ]
          )
        ).rows[0];

        const invoiceStatus =
          Number(sale.remaining_amount) <= 0
            ? "PAYEE"
            : Number(sale.paid_amount) > 0
              ? "PARTIELLEMENT_PAYEE"
              : "IMPAYEE";

        const invoice = (
          await client.query(
            `INSERT INTO sand_invoices(
               company_id,
               sale_id,
               customer_id,
               invoice_number,
               operation_reference,
               destination,
               total_amount,
               paid_amount,
               remaining_amount,
               status,
               notes,
               created_by,
               validated_by,
               validated_at
             )
             VALUES(
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()
             )
             RETURNING *`,
            [
              companyId,
              sale.id,
              sale.customer_id,
              invoiceNumber,
              sale.sale_number,
              sale.destination,
              sale.total_amount,
              sale.paid_amount,
              sale.remaining_amount,
              invoiceStatus,
              sale.notes,
              req.user.id,
              req.user.id
            ]
          )
        ).rows[0];

        const validatedSale = (
          await client.query(
            `UPDATE sand_sales
             SET status='VALIDEE',
                 validated_by=$3,
                 validated_at=NOW(),
                 updated_at=NOW()
             WHERE id=$1 AND company_id=$2
             RETURNING *`,
            [sale.id,companyId,req.user.id]
          )
        ).rows[0];

        await client.query("COMMIT");

        res.json({
          success:true,
          sale:validatedSale,
          delivery,
          invoice,
          stock_impacted:false
        });

      } catch(e) {
        await client.query("ROLLBACK").catch(()=>{});
        console.error("VALIDATE SAND SALE:",e);
        res.status(500).json({error:"Erreur validation vente sable."});
      } finally {
        client.release();
      }
    }
  );


  return router;
};

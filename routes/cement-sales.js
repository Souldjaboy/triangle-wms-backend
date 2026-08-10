"use strict";

const express = require("express");
const { listActiveBanks, recordSalePaymentAccounting } = require("./sales-payment-accounting");

module.exports = function createCementSalesRouter({
  pool,
  authenticateToken,
  getEffectiveCompanyId,
  requirePermission,
  requireCompanyModule,
  accounting = {},
}) {
  const router = express.Router();
  const perm = (action) => requirePermission("cement", action);
  /* Le module Ciment n'était accessible à AUCUNE condition d'entreprise : toute
     société pouvait l'utiliser. Il est désormais soumis, comme le Sable, à
     l'activation du module pour l'entreprise + au RBAC `cement`. */
  const cementModuleGuard = requireCompanyModule("cement");
  const companyOf = (req) => getEffectiveCompanyId(req, req.user?.company_id);
  const txt = (v) => String(v ?? "").trim();
  const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
  const positive = (v) => Math.max(num(v), 0);

  async function nextNumber(client, companyId, prefix) {
    const d = new Date();
    const stamp =
      String(d.getFullYear()).slice(2) +
      String(d.getMonth() + 1).padStart(2, "0") +
      String(d.getDate()).padStart(2, "0");
    const key = `${prefix}#${stamp}`;
    const { rows } = await client.query(
      `INSERT INTO cement_counters(company_id,counter_key,last_seq,updated_at)
       VALUES($1,$2,1,NOW())
       ON CONFLICT(company_id,counter_key)
       DO UPDATE SET last_seq=cement_counters.last_seq+1,updated_at=NOW()
       RETURNING last_seq`,
      [companyId, key]
    );
    return `${prefix}-${stamp}-${String(rows[0].last_seq).padStart(3, "0")}`;
  }

  function computeSale(b, old = {}) {
    const tonnage = b.tonnage === undefined ? positive(old.tonnage) : positive(b.tonnage);
    const unitPrice = b.unit_price === undefined ? positive(old.unit_price) : positive(b.unit_price);
    const transportPrice = b.transport_price === undefined ? positive(old.transport_price) : positive(b.transport_price);
    const transportMode = txt(b.transport_mode || old.transport_mode || "PAR_TONNE").toUpperCase();
    const discount = b.discount === undefined ? positive(old.discount) : positive(b.discount);
    const taxAmount = b.tax_amount === undefined ? positive(old.tax_amount) : positive(b.tax_amount);
    const cementSubtotal = tonnage * unitPrice;
    const transportTotal = transportMode === "FORFAIT" ? transportPrice : tonnage * transportPrice;
    const totalAmount = Math.max(cementSubtotal + transportTotal + taxAmount - discount, 0);
    let paidAmount = b.paid_amount === undefined ? positive(old.paid_amount) : positive(b.paid_amount);
    paidAmount = Math.min(paidAmount, totalAmount);
    return {
      tonnage, unitPrice, transportPrice, transportMode,
      cementSubtotal, transportTotal, discount, taxAmount,
      totalAmount, paidAmount,
      remainingAmount: Math.max(totalAmount - paidAmount, 0),
    };
  }

  async function audit(client, req, action, entityType, entityId, reference, oldValue, newValue) {
    await client.query(
      `INSERT INTO cement_audit_logs
       (company_id,user_id,action,entity_type,entity_id,reference,old_value,new_value,ip_address)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        companyOf(req), req.user?.id || null, action, entityType, entityId || null,
        reference || null,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
        req.ip || null
      ]
    );
  }

  router.get("/cement/dashboard", authenticateToken, cementModuleGuard, perm("view"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const sales = await pool.query(
        `SELECT
           COALESCE(SUM(total_amount) FILTER (WHERE sale_date=CURRENT_DATE AND status<>'ANNULEE'),0) ca_today,
           COALESCE(SUM(total_amount) FILTER (
             WHERE date_trunc('month',sale_date)=date_trunc('month',CURRENT_DATE)
               AND status<>'ANNULEE'),0) ca_month,
           COALESCE(SUM(tonnage) FILTER (
             WHERE date_trunc('month',sale_date)=date_trunc('month',CURRENT_DATE)
               AND status<>'ANNULEE'),0) tonnage_month,
           COUNT(*) FILTER (WHERE status<>'ANNULEE') sales_count
         FROM cement_sales WHERE company_id=$1`,
        [companyId]
      );
      const unpaid = await pool.query(
        `SELECT COUNT(*) unpaid_count,
                COALESCE(SUM(total_amount),0) total_invoiced,
                COALESCE(SUM(paid_amount),0) total_paid,
                COALESCE(SUM(remaining_amount),0) total_unpaid
         FROM cement_invoices
         WHERE company_id=$1 AND remaining_amount>0
           AND status NOT IN ('PAYEE','ANNULEE')`,
        [companyId]
      );
      res.json({ ...(sales.rows[0] || {}), ...(unpaid.rows[0] || {}) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Erreur tableau de bord ciment." });
    }
  });

  router.get("/cement/products", authenticateToken, cementModuleGuard, perm("view"), async (req, res) => {
    const companyId = companyOf(req);
    const q = txt(req.query.q);
    const { rows } = await pool.query(
      `SELECT * FROM cement_products
       WHERE company_id=$1 AND (
         $2='' OR name ILIKE '%'||$2||'%' OR cement_type ILIKE '%'||$2||'%' OR strength ILIKE '%'||$2||'%'
       )
       ORDER BY status DESC,cement_type,strength,name`,
      [companyId, q]
    );
    res.json(rows);
  });

  router.post("/cement/products", authenticateToken, cementModuleGuard, perm("create"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      const b = req.body || {};
      if (!txt(b.name) || !txt(b.cement_type) || !txt(b.strength)) {
        return res.status(400).json({ error: "Nom, type et classe obligatoires." });
      }
      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO cement_products
         (company_id,name,cement_type,strength,unit,status,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [companyId,txt(b.name),txt(b.cement_type).toUpperCase(),txt(b.strength),
         txt(b.unit || "tonne"),txt(b.status || "ACTIF").toUpperCase(),req.user.id]
      );
      await audit(client,req,"CREATE","cement_product",rows[0].id,rows[0].name,null,rows[0]);
      await client.query("COMMIT");
      res.status(201).json(rows[0]);
    } catch (e) {
      await client.query("ROLLBACK").catch(()=>{});
      res.status(400).json({ error: e.detail || e.message });
    } finally { client.release(); }
  });

  router.patch("/cement/products/:id", authenticateToken, cementModuleGuard, perm("update"), async (req, res) => {
    const companyId = companyOf(req);
    const b = req.body || {};
    const { rows } = await pool.query(
      `UPDATE cement_products SET
       name=COALESCE($3,name),cement_type=COALESCE($4,cement_type),
       strength=COALESCE($5,strength),unit=COALESCE($6,unit),
       status=COALESCE($7,status),updated_at=NOW()
       WHERE id=$1 AND company_id=$2 RETURNING *`,
      [req.params.id,companyId,b.name ?? null,b.cement_type ?? null,b.strength ?? null,b.unit ?? null,b.status ?? null]
    );
    if (!rows[0]) return res.status(404).json({ error: "Produit ciment introuvable." });
    res.json(rows[0]);
  });

  router.get("/cement/prices", authenticateToken, cementModuleGuard, perm("view"), async (req, res) => {
    const companyId = companyOf(req);
    const q = txt(req.query.q);
    const { rows } = await pool.query(
      `SELECT cp.*,p.name product_name,p.cement_type,p.strength
       FROM cement_prices cp
       JOIN cement_products p ON p.id=cp.cement_product_id AND p.company_id=cp.company_id
       WHERE cp.company_id=$1 AND (
         $2='' OR cp.destination ILIKE '%'||$2||'%' OR p.name ILIKE '%'||$2||'%'
       )
       ORDER BY cp.status DESC,cp.destination,p.cement_type,p.strength,cp.effective_from DESC`,
      [companyId,q]
    );
    res.json(rows);
  });

  router.post("/cement/prices", authenticateToken, cementModuleGuard, perm("create"), async (req, res) => {
    const companyId = companyOf(req);
    const b = req.body || {};
    if (!b.cement_product_id || !txt(b.destination)) {
      return res.status(400).json({ error: "Produit et destination obligatoires." });
    }
    const { rows } = await pool.query(
      `INSERT INTO cement_prices
       (company_id,cement_product_id,destination,cement_price,transport_price,
        transport_mode,effective_from,status,created_by)
       VALUES($1,$2,$3,$4,$5,$6,COALESCE($7,CURRENT_DATE),$8,$9) RETURNING *`,
      [companyId,b.cement_product_id,txt(b.destination),positive(b.cement_price),
       positive(b.transport_price),txt(b.transport_mode || "PAR_TONNE").toUpperCase(),
       b.effective_from || null,txt(b.status || "ACTIF").toUpperCase(),req.user.id]
    );
    res.status(201).json(rows[0]);
  });

  router.patch("/cement/prices/:id", authenticateToken, cementModuleGuard, perm("update"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      await client.query("BEGIN");
      const old = (await client.query(
        `SELECT * FROM cement_prices WHERE id=$1 AND company_id=$2 FOR UPDATE`,
        [req.params.id,companyId]
      )).rows[0];
      if (!old) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Tarif introuvable." });
      }
      const b = req.body || {};
      const newPrice = b.cement_price === undefined ? Number(old.cement_price) : positive(b.cement_price);
      const newTransport = b.transport_price === undefined ? Number(old.transport_price) : positive(b.transport_price);
      const newMode = b.transport_mode === undefined ? old.transport_mode : txt(b.transport_mode).toUpperCase();

      if (newPrice !== Number(old.cement_price) || newTransport !== Number(old.transport_price) || newMode !== old.transport_mode) {
        await client.query(
          `INSERT INTO cement_price_history
           (company_id,cement_price_id,old_cement_price,new_cement_price,
            old_transport_price,new_transport_price,old_transport_mode,new_transport_mode,changed_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [companyId,old.id,old.cement_price,newPrice,old.transport_price,newTransport,old.transport_mode,newMode,req.user.id]
        );
      }

      const { rows } = await client.query(
        `UPDATE cement_prices SET
         destination=COALESCE($3,destination),
         cement_price=$4,transport_price=$5,transport_mode=$6,
         status=COALESCE($7,status),updated_at=NOW()
         WHERE id=$1 AND company_id=$2 RETURNING *`,
        [old.id,companyId,b.destination ?? null,newPrice,newTransport,newMode,b.status ?? null]
      );
      await audit(client,req,"UPDATE","cement_price",old.id,old.destination,old,rows[0]);
      await client.query("COMMIT");
      res.json(rows[0]);
    } catch (e) {
      await client.query("ROLLBACK").catch(()=>{});
      res.status(400).json({ error: e.detail || e.message });
    } finally { client.release(); }
  });

  router.delete("/cement/prices/:id", authenticateToken, cementModuleGuard, perm("delete"), async (req, res) => {
    const companyId = companyOf(req);
    const { rows } = await pool.query(
      `UPDATE cement_prices SET status='INACTIF',effective_to=COALESCE(effective_to,CURRENT_DATE),updated_at=NOW()
       WHERE id=$1 AND company_id=$2 RETURNING *`,
      [req.params.id,companyId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Tarif introuvable." });
    res.json({ success:true,disabled:true,price:rows[0] });
  });

  router.get("/cement/customers", authenticateToken, cementModuleGuard, perm("view"), async (req, res) => {
    const companyId = companyOf(req);
    const q = txt(req.query.q);
    const { rows } = await pool.query(
      `SELECT c.*,
        (SELECT COALESCE(SUM(i.remaining_amount),0)
         FROM cement_invoices i
         WHERE i.company_id=c.company_id AND i.customer_id=c.id
           AND i.status NOT IN ('PAYEE','ANNULEE')) outstanding_amount
       FROM cement_customers c
       WHERE c.company_id=$1 AND (
         $2='' OR c.name ILIKE '%'||$2||'%' OR c.phone ILIKE '%'||$2||'%' OR c.customer_code ILIKE '%'||$2||'%'
       )
       ORDER BY c.name`,
      [companyId,q]
    );
    res.json(rows);
  });

  router.post("/cement/customers", authenticateToken, cementModuleGuard, perm("create"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      const b = req.body || {};
      if (!txt(b.name)) return res.status(400).json({ error:"Nom du client obligatoire." });
      await client.query("BEGIN");
      const code = txt(b.customer_code) || await nextNumber(client,companyId,"CLI-CIM");
      const { rows } = await client.query(
        `INSERT INTO cement_customers
         (company_id,customer_code,name,phone,email,address,nif,rccm,contact_name,payment_terms_days,status,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [companyId,code,txt(b.name),txt(b.phone)||null,txt(b.email)||null,txt(b.address)||null,
         txt(b.nif)||null,txt(b.rccm)||null,txt(b.contact_name)||null,
         Math.max(parseInt(b.payment_terms_days || 0,10)||0,0),
         txt(b.status || "ACTIF").toUpperCase(),req.user.id]
      );
      await audit(client,req,"CREATE","cement_customer",rows[0].id,rows[0].customer_code,null,rows[0]);
      await client.query("COMMIT");
      res.status(201).json(rows[0]);
    } catch (e) {
      await client.query("ROLLBACK").catch(()=>{});
      res.status(400).json({ error:e.detail || e.message });
    } finally { client.release(); }
  });

  router.get("/cement/sales", authenticateToken, cementModuleGuard, perm("view"), async (req, res) => {
    const companyId = companyOf(req);
    const q = txt(req.query.q);
    const { rows } = await pool.query(
      /* invoice_id / delivery_id : permettent d'ouvrir depuis la liste des ventes
         les documents DÉJÀ créés par la validation, sans jamais en générer un
         second. LATERAL + LIMIT 1 : une seule ligne par vente. */
      `SELECT s.*,p.name product_name, i.id AS invoice_id, d.id AS delivery_id
       FROM cement_sales s
       LEFT JOIN cement_products p ON p.id=s.cement_product_id AND p.company_id=s.company_id
       LEFT JOIN LATERAL (SELECT id FROM cement_invoices WHERE sale_id=s.id AND company_id=s.company_id ORDER BY id DESC LIMIT 1) i ON TRUE
       LEFT JOIN LATERAL (SELECT id FROM cement_deliveries WHERE sale_id=s.id AND company_id=s.company_id ORDER BY id DESC LIMIT 1) d ON TRUE
       WHERE s.company_id=$1 AND (
         $2='' OR s.sale_number ILIKE '%'||$2||'%' OR s.customer_name ILIKE '%'||$2||'%'
         OR s.customer_phone ILIKE '%'||$2||'%' OR s.destination ILIKE '%'||$2||'%'
       )
       ORDER BY s.sale_date DESC,s.id DESC LIMIT 500`,
      [companyId,q]
    );
    res.json(rows);
  });

  router.post("/cement/sales", authenticateToken, cementModuleGuard, perm("create"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      const b = req.body || {};
      if (!b.cement_product_id) return res.status(400).json({ error:"Produit ciment obligatoire." });
      if (positive(b.tonnage) <= 0) return res.status(400).json({ error:"Tonnage > 0 obligatoire." });

      await client.query("BEGIN");

      const product = (await client.query(
        `SELECT * FROM cement_products WHERE id=$1 AND company_id=$2 AND status='ACTIF'`,
        [b.cement_product_id,companyId]
      )).rows[0];
      if (!product) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error:"Produit ciment actif introuvable." });
      }

      let customer = null;
      if (b.customer_id) {
        customer = (await client.query(
          `SELECT * FROM cement_customers WHERE id=$1 AND company_id=$2`,
          [b.customer_id,companyId]
        )).rows[0] || null;
      }
      if (!customer && !txt(b.customer_name)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error:"Client obligatoire." });
      }

      const calc = computeSale(b);
      const saleNumber = await nextNumber(client,companyId,"VC");

      const { rows } = await client.query(
        `INSERT INTO cement_sales(
          company_id,sale_number,customer_id,customer_name,customer_phone,customer_address,customer_nif,customer_rccm,
          destination,loading_place,delivery_place,cement_product_id,cement_type,strength,
          tonnage,unit_price,transport_price,transport_mode,cement_subtotal,transport_total,discount,tax_amount,
          total_amount,paid_amount,remaining_amount,payment_method,tonnage_voucher_number,tonnage_voucher_url,
          truck,driver_name,status,sale_date,notes,created_by
        ) VALUES(
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
          $23,$24,$25,$26,$27,$28,$29,$30,'BROUILLON',COALESCE($31,CURRENT_DATE),$32,$33
        ) RETURNING *`,
        [
          companyId,saleNumber,customer?.id || b.customer_id || null,
          txt(b.customer_name || customer?.name),txt(b.customer_phone || customer?.phone)||null,
          txt(b.customer_address || customer?.address)||null,txt(b.customer_nif || customer?.nif)||null,
          txt(b.customer_rccm || customer?.rccm)||null,txt(b.destination)||null,txt(b.loading_place)||null,
          txt(b.delivery_place || b.destination)||null,product.id,product.cement_type,product.strength,
          calc.tonnage,calc.unitPrice,calc.transportPrice,calc.transportMode,calc.cementSubtotal,calc.transportTotal,
          calc.discount,calc.taxAmount,calc.totalAmount,calc.paidAmount,calc.remainingAmount,txt(b.payment_method)||null,
          txt(b.tonnage_voucher_number)||null,txt(b.tonnage_voucher_url)||null,txt(b.truck)||null,
          txt(b.driver_name)||null,b.sale_date || null,txt(b.notes)||null,req.user.id
        ]
      );

      const sale = rows[0];
      await client.query(
        `INSERT INTO cement_sale_lines
         (company_id,sale_id,line_type,description,quantity,unit,unit_price,line_total,sort_order)
         VALUES($1,$2,'CIMENT',$3,$4,$5,$6,$7,0)`,
        [companyId,sale.id,`${product.name} - ${product.cement_type} ${product.strength}`,
         calc.tonnage,product.unit || "tonne",calc.unitPrice,calc.cementSubtotal]
      );

      if (calc.transportTotal > 0) {
        await client.query(
          `INSERT INTO cement_sale_lines
           (company_id,sale_id,line_type,description,quantity,unit,unit_price,line_total,sort_order)
           VALUES($1,$2,'TRANSPORT',$3,$4,$5,$6,$7,1)`,
          [companyId,sale.id,`Transport vers ${txt(b.destination) || "destination"}`,
           calc.transportMode === "FORFAIT" ? 1 : calc.tonnage,
           calc.transportMode === "FORFAIT" ? "forfait" : "tonne",
           calc.transportPrice,calc.transportTotal]
        );
      }

      await audit(client,req,"CREATE","cement_sale",sale.id,sale.sale_number,null,sale);
      await client.query("COMMIT");
      res.status(201).json({ ...sale, stock_impacted:false });
    } catch (e) {
      await client.query("ROLLBACK").catch(()=>{});
      console.error(e);
      res.status(400).json({ error:e.detail || e.message });
    } finally { client.release(); }
  });

  router.get("/cement/invoices/unpaid", authenticateToken, cementModuleGuard, perm("view"), async (req, res) => {
    const companyId = companyOf(req);
    const customerId = req.query.customer_id ? Number(req.query.customer_id) : null;
    const from = req.query.from || "2000-01-01";
    const to = req.query.to || "2999-12-31";
    const { rows } = await pool.query(
      `SELECT i.id,i.invoice_number,i.invoice_date,i.due_date,i.operation_reference,i.destination,
              i.total_amount,i.paid_amount,i.remaining_amount,i.status,
              c.id customer_id,c.name customer_name,c.phone customer_phone,
              s.tonnage,s.cement_type,s.strength
       FROM cement_invoices i
       LEFT JOIN cement_customers c ON c.id=i.customer_id AND c.company_id=i.company_id
       LEFT JOIN cement_sales s ON s.id=i.sale_id AND s.company_id=i.company_id
       WHERE i.company_id=$1 AND i.remaining_amount>0
         AND i.status NOT IN ('PAYEE','ANNULEE')
         AND ($2::bigint IS NULL OR i.customer_id=$2)
         AND i.invoice_date BETWEEN $3 AND $4
       ORDER BY c.name,i.invoice_date,i.invoice_number`,
      [companyId,customerId,from,to]
    );
    const totals = rows.reduce((a,r)=>{
      a.invoice_count += 1;
      a.total_invoiced += Number(r.total_amount || 0);
      a.total_paid += Number(r.paid_amount || 0);
      a.total_unpaid += Number(r.remaining_amount || 0);
      return a;
    },{invoice_count:0,total_invoiced:0,total_paid:0,total_unpaid:0});
    res.json({ rows, totals });
  });


  // ============================================================
  // PHASE3_CEMENT_WORKFLOW
  // Validation vente -> BL + facture -> paiement -> impayés
  // ============================================================

  async function loadSaleDetail(client, companyId, id) {
    const sale = (
      await client.query(
        `SELECT s.*, p.name AS product_name
         FROM cement_sales s
         LEFT JOIN cement_products p
           ON p.id=s.cement_product_id
          AND p.company_id=s.company_id
         WHERE s.id=$1 AND s.company_id=$2`,
        [id, companyId]
      )
    ).rows[0];

    if (!sale) return null;

    const lines = await client.query(
      `SELECT *
       FROM cement_sale_lines
       WHERE sale_id=$1 AND company_id=$2
       ORDER BY sort_order,id`,
      [id, companyId]
    );

    const invoices = await client.query(
      `SELECT *
       FROM cement_invoices
       WHERE sale_id=$1 AND company_id=$2
       ORDER BY id`,
      [id, companyId]
    );

    const deliveries = await client.query(
      `SELECT *
       FROM cement_deliveries
       WHERE sale_id=$1 AND company_id=$2
       ORDER BY id`,
      [id, companyId]
    );

    return {
      ...sale,
      lines: lines.rows,
      invoices: invoices.rows,
      deliveries: deliveries.rows
    };
  }

  router.get(
    "/cement/sales/:id",
    authenticateToken,
    cementModuleGuard,
    perm("view"),
    async (req, res) => {
      try {
        const sale = await loadSaleDetail(
          pool,
          companyOf(req),
          req.params.id
        );

        if (!sale) {
          return res.status(404).json({ error: "Vente introuvable." });
        }

        res.json(sale);
      } catch (e) {
        console.error(e);
        res.status(500).json({ error: "Erreur chargement vente." });
      }
    }
  );

  router.post(
    "/cement/sales/:id/validate",
    authenticateToken,
    cementModuleGuard,
    perm("validate"),
    async (req, res) => {
      const client = await pool.connect();

      try {
        const companyId = companyOf(req);

        await client.query("BEGIN");

        const sale = (
          await client.query(
            `SELECT *
             FROM cement_sales
             WHERE id=$1 AND company_id=$2
             FOR UPDATE`,
            [req.params.id, companyId]
          )
        ).rows[0];

        if (!sale) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Vente introuvable." });
        }

        if (sale.status !== "BROUILLON") {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "Vente déjà traitée.",
            code: "ALREADY_PROCESSED",
            status: sale.status
          });
        }

        const existingInvoice = await client.query(
          `SELECT id
           FROM cement_invoices
           WHERE company_id=$1 AND sale_id=$2
           LIMIT 1`,
          [companyId, sale.id]
        );

        if (existingInvoice.rows[0]) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "Une facture existe déjà pour cette vente.",
            code: "INVOICE_ALREADY_EXISTS"
          });
        }

        const invoiceNumber = await nextNumber(
          client,
          companyId,
          "FAC-CIM"
        );

        const deliveryNumber = await nextNumber(
          client,
          companyId,
          "BL-CIM"
        );

        let paymentTermsDays = 0;

        if (sale.customer_id) {
          const customer = await client.query(
            `SELECT payment_terms_days
             FROM cement_customers
             WHERE id=$1 AND company_id=$2`,
            [sale.customer_id, companyId]
          );

          paymentTermsDays = Math.max(
            parseInt(customer.rows[0]?.payment_terms_days || 0, 10) || 0,
            0
          );
        }

        let invoiceStatus = "IMPAYEE";

        if (Number(sale.remaining_amount) <= 0) {
          invoiceStatus = "PAYEE";
        } else if (Number(sale.paid_amount) > 0) {
          invoiceStatus = "PARTIELLEMENT_PAYEE";
        }

        const invoice = (
          await client.query(
            `INSERT INTO cement_invoices (
               company_id,
               sale_id,
               customer_id,
               invoice_number,
               operation_reference,
               invoice_date,
               due_date,
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
             VALUES (
               $1,$2,$3,$4,$5,
               CURRENT_DATE,
               CURRENT_DATE + ($6::int * INTERVAL '1 day'),
               $7,$8,$9,$10,$11,$12,$13,$13,NOW()
             )
             RETURNING *`,
            [
              companyId,
              sale.id,
              sale.customer_id,
              invoiceNumber,
              sale.sale_number,
              paymentTermsDays,
              sale.destination,
              sale.total_amount,
              sale.paid_amount,
              sale.remaining_amount,
              invoiceStatus,
              sale.notes,
              req.user.id
            ]
          )
        ).rows[0];

        const saleLines = await client.query(
          `SELECT *
           FROM cement_sale_lines
           WHERE company_id=$1 AND sale_id=$2
           ORDER BY sort_order,id`,
          [companyId, sale.id]
        );

        for (const line of saleLines.rows) {
          await client.query(
            `INSERT INTO cement_invoice_lines (
               company_id,
               invoice_id,
               description,
               quantity,
               unit,
               unit_price,
               line_total,
               sort_order
             )
             VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              companyId,
              invoice.id,
              line.description,
              line.quantity,
              line.unit,
              line.unit_price,
              line.line_total,
              line.sort_order
            ]
          );
        }

        await client.query(
          `INSERT INTO cement_deliveries (
             company_id,
             sale_id,
             delivery_number,
             tonnage_delivered,
             delivery_date,
             destination,
             truck,
             driver_name,
             tonnage_voucher_number,
             tonnage_voucher_url,
             received_by_name,
             delivered_by_name,
             notes,
             status,
             created_by,
             validated_by,
             validated_at
           )
           VALUES(
             $1,$2,$3,$4,
             CURRENT_DATE,
             $5,$6,$7,$8,$9,$10,$11,$12,
             'VALIDEE',$13,$13,NOW()
           )`,
          [
            companyId,
            sale.id,
            deliveryNumber,
            sale.tonnage,
            sale.delivery_place || sale.destination,
            sale.truck,
            sale.driver_name,
            sale.tonnage_voucher_number,
            sale.tonnage_voucher_url,
            txt(req.body?.received_by_name) || null,
            txt(req.body?.delivered_by_name) || sale.driver_name || null,
            sale.notes,
            req.user.id
          ]
        );

        let saleStatus = "FACTUREE";

        if (invoiceStatus === "PAYEE") {
          saleStatus = "PAYEE";
        } else if (invoiceStatus === "PARTIELLEMENT_PAYEE") {
          saleStatus = "PARTIELLEMENT_PAYEE";
        }

        await client.query(
          `UPDATE cement_sales
           SET
             status=$3,
             validated_by=$4,
             validated_at=NOW(),
             updated_at=NOW()
           WHERE id=$1 AND company_id=$2`,
          [sale.id, companyId, saleStatus, req.user.id]
        );

        await audit(
          client,
          req,
          "VALIDATE",
          "cement_sale",
          sale.id,
          sale.sale_number,
          { status: sale.status },
          {
            status: saleStatus,
            invoice_number: invoiceNumber,
            delivery_number: deliveryNumber
          }
        );

        await client.query("COMMIT");

        res.json({
          success: true,
          sale: await loadSaleDetail(pool, companyId, sale.id),
          invoice_number: invoiceNumber,
          delivery_number: deliveryNumber,
          stock_impacted: false
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(e);

        res.status(500).json({
          error: "Erreur validation vente ciment."
        });
      } finally {
        client.release();
      }
    }
  );

  router.get(
    "/cement/invoices",
    authenticateToken,
    cementModuleGuard,
    perm("view"),
    async (req, res) => {
      try {
        const companyId = companyOf(req);

        const q = txt(req.query.q);
        const status = txt(req.query.status);

        const { rows } = await pool.query(
          `SELECT
             i.*,
             c.name AS customer_name,
             c.phone AS customer_phone,
             s.tonnage,
             s.cement_type,
             s.strength
           FROM cement_invoices i
           LEFT JOIN cement_customers c
             ON c.id=i.customer_id
            AND c.company_id=i.company_id
           LEFT JOIN cement_sales s
             ON s.id=i.sale_id
            AND s.company_id=i.company_id
           WHERE i.company_id=$1
             AND ($2='' OR i.status=$2)
             AND (
               $3=''
               OR i.invoice_number ILIKE '%'||$3||'%'
               OR i.operation_reference ILIKE '%'||$3||'%'
               OR i.destination ILIKE '%'||$3||'%'
               OR c.name ILIKE '%'||$3||'%'
             )
           ORDER BY i.invoice_date DESC,i.id DESC`,
          [companyId, status, q]
        );

        res.json(rows);
      } catch (e) {
        console.error(e);
        res.status(500).json({
          error: "Erreur chargement factures."
        });
      }
    }
  );

  router.post(
    "/cement/invoices/:id/payments",
    authenticateToken,
    cementModuleGuard,
    perm("create"),
    async (req, res) => {
      const client = await pool.connect();

      try {
        const companyId = companyOf(req);
        const amount = positive(req.body?.amount);
        /* « banque » exige une banque explicite : jamais de choix automatique. */
        const method = txt(req.body?.payment_method).toLowerCase();
        const bankId = Number(req.body?.bank_id) || null;

        if (amount <= 0) {
          return res.status(400).json({
            error: "Montant paiement invalide."
          });
        }
        if ((method === "banque" || method === "bank") && !bankId) {
          return res.status(400).json({
            error: "Sélectionnez la banque qui reçoit le paiement.",
            code: "BANK_REQUIRED"
          });
        }

        await client.query("BEGIN");

        const invoice = (
          await client.query(
            `SELECT *
             FROM cement_invoices
             WHERE id=$1 AND company_id=$2
             FOR UPDATE`,
            [req.params.id, companyId]
          )
        ).rows[0];

        if (!invoice) {
          await client.query("ROLLBACK");
          return res.status(404).json({
            error: "Facture introuvable."
          });
        }

        const remaining = Number(invoice.remaining_amount || 0);

        if (remaining <= 0) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: "Facture déjà entièrement payée."
          });
        }

        if (amount > remaining) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Le paiement dépasse le reste à payer."
          });
        }

        const paymentNumber = await nextNumber(
          client,
          companyId,
          "PAY-CIM"
        );

        const payment = (
          await client.query(
            `INSERT INTO cement_payments (
               company_id,
               invoice_id,
               payment_number,
               payment_date,
               amount,
               payment_method,
               reference,
               notes,
               created_by,
               bank_id
             )
             VALUES(
               $1,$2,$3,
               COALESCE($4,CURRENT_DATE),
               $5,$6,$7,$8,$9,$10
             )
             RETURNING *`,
            [
              companyId,
              invoice.id,
              paymentNumber,
              req.body?.payment_date || null,
              amount,
              bankId ? "banque" : (txt(req.body?.payment_method) || "especes"),
              txt(req.body?.reference) || null,
              txt(req.body?.notes) || null,
              req.user.id,
              bankId
            ]
          )
        ).rows[0];

        /* Solde reconstruit depuis la SOMME réelle des paiements (comme le
           Sable) : « ancien + montant » dérive au moindre incident. */
        const newPaid = Number((await client.query(
          `SELECT COALESCE(SUM(amount),0) AS total FROM cement_payments
            WHERE company_id=$1 AND invoice_id=$2`,
          [companyId, invoice.id]
        )).rows[0].total);

        const newRemaining =
          Math.max(
            Number(invoice.total_amount || 0) - newPaid,
            0
          );

        const newStatus =
          newRemaining <= 0
            ? "PAYEE"
            : "PARTIELLEMENT_PAYEE";

        await client.query(
          `UPDATE cement_invoices
           SET
             paid_amount=$3,
             remaining_amount=$4,
             status=$5,
             updated_at=NOW()
           WHERE id=$1 AND company_id=$2`,
          [
            invoice.id,
            companyId,
            newPaid,
            newRemaining,
            newStatus
          ]
        );

        if (invoice.sale_id) {
          await client.query(
            `UPDATE cement_sales
             SET
               paid_amount=$3,
               remaining_amount=$4,
               status=$5,
               updated_at=NOW()
             WHERE id=$1 AND company_id=$2`,
            [
              invoice.sale_id,
              companyId,
              newPaid,
              newRemaining,
              newRemaining <= 0
                ? "PAYEE"
                : "PARTIELLEMENT_PAYEE"
            ]
          );
        }

        await audit(
          client,
          req,
          "PAYMENT",
          "cement_invoice",
          invoice.id,
          invoice.invoice_number,
          {
            paid_amount: invoice.paid_amount,
            remaining_amount: invoice.remaining_amount
          },
          {
            paid_amount: newPaid,
            remaining_amount: newRemaining,
            payment_number: paymentNumber
          }
        );

        /* Argent + transaction + écritures dans CETTE transaction : un échec
           ici annule aussi le paiement et la mise à jour de la facture. */
        const { transaction, destination } = await recordSalePaymentAccounting(client, {
          companyId, module: "cement", payment, amount,
          invoiceNumber: invoice.invoice_number,
          partnerName: txt(req.body?.partner_name) || null,
          bankId, userId: req.user.id, accounting,
        });
        await client.query(
          `UPDATE cement_payments SET accounting_transaction_id=$1 WHERE id=$2 AND company_id=$3`,
          [transaction.id, payment.id, companyId]
        );

        await client.query("COMMIT");

        res.status(201).json({
          success: true,
          payment: { ...payment, accounting_transaction_id: transaction.id },
          invoice: {
            ...invoice,
            paid_amount: newPaid,
            remaining_amount: newRemaining,
            status: newStatus
          },
          accounting_transaction: transaction,
          destination
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(e);

        if (e && e.httpStatus) {
          return res.status(e.httpStatus).json({ error: e.message, code: e.code });
        }
        res.status(500).json({
          error: "Erreur paiement facture ciment."
        });
      } finally {
        client.release();
      }
    }
  );


  // ============================================================
  // CEMENT_DOCS_REPORTS_PHASE
  // Proformas + Bons de livraison + Rapports
  // ============================================================

  router.get("/cement/proformas", authenticateToken, cementModuleGuard, perm("view"), async (req,res) => {
    try {
      const companyId = companyOf(req);
      const q = txt(req.query.q);

      const { rows } = await pool.query(
        `SELECT p.*, c.name AS registered_customer_name
         FROM cement_proformas p
         LEFT JOIN cement_customers c
           ON c.id=p.customer_id AND c.company_id=p.company_id
         WHERE p.company_id=$1
           AND (
             $2='' OR
             p.proforma_number ILIKE '%'||$2||'%' OR
             p.customer_name ILIKE '%'||$2||'%' OR
             p.destination ILIKE '%'||$2||'%'
           )
         ORDER BY p.proforma_date DESC,p.id DESC`,
        [companyId,q]
      );

      res.json(rows);
    } catch(e) {
      console.error(e);
      res.status(500).json({error:"Erreur chargement proformas."});
    }
  });

  router.get("/cement/proformas/:id", authenticateToken, cementModuleGuard, perm("view"), async (req,res) => {
    try {
      const companyId = companyOf(req);

      const proforma = (
        await pool.query(
          `SELECT *
           FROM cement_proformas
           WHERE id=$1 AND company_id=$2`,
          [req.params.id,companyId]
        )
      ).rows[0];

      if(!proforma) {
        return res.status(404).json({error:"Proforma introuvable."});
      }

      const lines = await pool.query(
        `SELECT *
         FROM cement_proforma_lines
         WHERE proforma_id=$1 AND company_id=$2
         ORDER BY sort_order,id`,
        [proforma.id,companyId]
      );

      res.json({...proforma,lines:lines.rows});
    } catch(e) {
      console.error(e);
      res.status(500).json({error:"Erreur détail proforma."});
    }
  });

  router.post("/cement/proformas", authenticateToken, cementModuleGuard, perm("create"), async (req,res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      const b = req.body || {};
      const lines = Array.isArray(b.lines) ? b.lines : [];

      if(!lines.length) {
        return res.status(400).json({error:"Ajoutez au moins une ligne."});
      }

      await client.query("BEGIN");

      let customer = null;

      if(b.customer_id) {
        customer = (
          await client.query(
            `SELECT *
             FROM cement_customers
             WHERE id=$1 AND company_id=$2`,
            [b.customer_id,companyId]
          )
        ).rows[0];
      }

      const customerName =
        txt(b.customer_name) ||
        txt(customer?.name);

      if(!customerName) {
        await client.query("ROLLBACK");
        return res.status(400).json({error:"Client obligatoire."});
      }

      let subtotal = 0;

      const normalized = lines.map((line,i) => {
        const qty = Math.max(Number(line.quantity || 0),0);
        const price = Math.max(Number(line.unit_price || 0),0);
        const total = qty * price;
        subtotal += total;

        return {
          line_type: txt(line.line_type || "AUTRE"),
          description: txt(line.description),
          quantity: qty,
          unit: txt(line.unit || "unité"),
          unit_price: price,
          line_total: total,
          sort_order: Number(line.sort_order ?? i)
        };
      });

      const discount = Math.max(Number(b.discount || 0),0);
      const taxAmount = Math.max(Number(b.tax_amount || 0),0);
      const totalAmount = Math.max(subtotal - discount + taxAmount,0);

      const number = await nextNumber(client,companyId,"PRO-CIM");

      const proforma = (
        await client.query(
          `INSERT INTO cement_proformas(
             company_id,customer_id,proforma_number,proforma_date,valid_until,
             customer_name,customer_phone,customer_address,destination,
             subtotal,discount,tax_amount,total_amount,status,notes,created_by
           )
           VALUES(
             $1,$2,$3,CURRENT_DATE,$4,$5,$6,$7,$8,
             $9,$10,$11,$12,'BROUILLON',$13,$14
           )
           RETURNING *`,
          [
            companyId,
            b.customer_id || null,
            number,
            b.valid_until || null,
            customerName,
            txt(b.customer_phone) || txt(customer?.phone) || null,
            txt(b.customer_address) || txt(customer?.address) || null,
            txt(b.destination) || null,
            subtotal,
            discount,
            taxAmount,
            totalAmount,
            txt(b.notes) || null,
            req.user.id
          ]
        )
      ).rows[0];

      for(const line of normalized) {
        await client.query(
          `INSERT INTO cement_proforma_lines(
             company_id,proforma_id,line_type,description,quantity,unit,
             unit_price,line_total,sort_order
           )
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            companyId,
            proforma.id,
            line.line_type,
            line.description,
            line.quantity,
            line.unit,
            line.unit_price,
            line.line_total,
            line.sort_order
          ]
        );
      }

      await client.query("COMMIT");

      res.status(201).json({
        ...proforma,
        lines: normalized
      });
    } catch(e) {
      await client.query("ROLLBACK").catch(()=>{});
      console.error(e);
      res.status(500).json({error:"Erreur création proforma."});
    } finally {
      client.release();
    }
  });

  router.post("/cement/proformas/:id/validate", authenticateToken, cementModuleGuard, perm("validate"), async (req,res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      await client.query("BEGIN");

      const p = (
        await client.query(
          `SELECT *
           FROM cement_proformas
           WHERE id=$1 AND company_id=$2
           FOR UPDATE`,
          [req.params.id,companyId]
        )
      ).rows[0];

      if(!p) {
        await client.query("ROLLBACK");
        return res.status(404).json({error:"Proforma introuvable."});
      }

      if(p.status !== "BROUILLON") {
        await client.query("ROLLBACK");
        return res.status(409).json({error:"Proforma déjà traitée."});
      }

      const { rows } = await client.query(
        `UPDATE cement_proformas
         SET status='VALIDEE',
             validated_by=$3,
             validated_at=NOW(),
             updated_at=NOW()
         WHERE id=$1 AND company_id=$2
         RETURNING *`,
        [p.id,companyId,req.user.id]
      );

      await client.query("COMMIT");
      res.json(rows[0]);
    } catch(e) {
      await client.query("ROLLBACK").catch(()=>{});
      console.error(e);
      res.status(500).json({error:"Erreur validation proforma."});
    } finally {
      client.release();
    }
  });

  router.get("/cement/deliveries", authenticateToken, cementModuleGuard, perm("view"), async (req,res) => {
    try {
      const companyId = companyOf(req);
      const q = txt(req.query.q);

      const { rows } = await pool.query(
        `SELECT
           d.*,
           s.sale_number,
           s.customer_name,
           s.customer_phone,
           s.customer_address,
           s.cement_type,
           s.strength,
           s.tonnage,
           s.unit_price,
           s.transport_price
         FROM cement_deliveries d
         JOIN cement_sales s
           ON s.id=d.sale_id AND s.company_id=d.company_id
         WHERE d.company_id=$1
           AND (
             $2='' OR
             d.delivery_number ILIKE '%'||$2||'%' OR
             s.sale_number ILIKE '%'||$2||'%' OR
             s.customer_name ILIKE '%'||$2||'%' OR
             d.destination ILIKE '%'||$2||'%'
           )
         ORDER BY d.delivery_date DESC,d.id DESC`,
        [companyId,q]
      );

      res.json(rows);
    } catch(e) {
      console.error(e);
      res.status(500).json({error:"Erreur chargement bons de livraison."});
    }
  });

  router.get("/cement/deliveries/:id", authenticateToken, cementModuleGuard, perm("view"), async (req,res) => {
    try {
      const companyId = companyOf(req);

      const row = (
        await pool.query(
          `SELECT
             d.*,
             s.sale_number,
             s.customer_name,
             s.customer_phone,
             s.customer_address,
             s.customer_nif,
             s.customer_rccm,
             s.cement_type,
             s.strength,
             s.tonnage,
             s.unit_price,
             s.transport_price,
             s.total_amount
           FROM cement_deliveries d
           JOIN cement_sales s
             ON s.id=d.sale_id AND s.company_id=d.company_id
           WHERE d.id=$1 AND d.company_id=$2`,
          [req.params.id,companyId]
        )
      ).rows[0];

      if(!row) {
        return res.status(404).json({error:"Bon de livraison introuvable."});
      }

      res.json(row);
    } catch(e) {
      console.error(e);
      res.status(500).json({error:"Erreur détail bon de livraison."});
    }
  });

  router.get("/cement/reports/summary", authenticateToken, cementModuleGuard, perm("view"), async (req,res) => {
    try {
      const companyId = companyOf(req);
      const from = req.query.from || null;
      const to = req.query.to || null;

      const totals = (
        await pool.query(
          `SELECT
             COUNT(*)::int AS sales_count,
             COALESCE(SUM(tonnage),0) AS tonnage,
             COALESCE(SUM(total_amount),0) AS revenue,
             COALESCE(SUM(paid_amount),0) AS paid,
             COALESCE(SUM(remaining_amount),0) AS remaining,
             COALESCE(SUM(transport_total),0) AS transport_total
           FROM cement_sales
           WHERE company_id=$1
             AND status <> 'ANNULEE'
             AND ($2::date IS NULL OR sale_date >= $2::date)
             AND ($3::date IS NULL OR sale_date <= $3::date)`,
          [companyId,from,to]
        )
      ).rows[0];

      const destinations = await pool.query(
        `SELECT
           destination,
           COUNT(*)::int AS sales_count,
           COALESCE(SUM(tonnage),0) AS tonnage,
           COALESCE(SUM(total_amount),0) AS amount
         FROM cement_sales
         WHERE company_id=$1
           AND status <> 'ANNULEE'
           AND ($2::date IS NULL OR sale_date >= $2::date)
           AND ($3::date IS NULL OR sale_date <= $3::date)
         GROUP BY destination
         ORDER BY amount DESC`,
        [companyId,from,to]
      );

      const customers = await pool.query(
        `SELECT
           customer_name,
           COUNT(*)::int AS sales_count,
           COALESCE(SUM(tonnage),0) AS tonnage,
           COALESCE(SUM(total_amount),0) AS amount,
           COALESCE(SUM(remaining_amount),0) AS remaining
         FROM cement_sales
         WHERE company_id=$1
           AND status <> 'ANNULEE'
           AND ($2::date IS NULL OR sale_date >= $2::date)
           AND ($3::date IS NULL OR sale_date <= $3::date)
         GROUP BY customer_name
         ORDER BY amount DESC`,
        [companyId,from,to]
      );

      res.json({
        period:{from,to},
        totals,
        destinations:destinations.rows,
        customers:customers.rows
      });
    } catch(e) {
      console.error(e);
      res.status(500).json({error:"Erreur génération rapport ciment."});
    }
  });


  /* Détail d'une facture ciment. Manquait alors que les BL et les ventes
     avaient déjà leur route :id — la page facture devait sinon charger toute la
     liste puis filtrer côté client. Lecture seule : ne crée jamais de document,
     la validation de la vente s'en est déjà chargée.
     Les colonnes DATE partent en TEXTE pour ne pas repasser par UTC (sinon le
     document imprimé affiche la veille en soirée). */
  /* Banques disponibles pour encaisser — route métier, distincte de la
     comptabilité : un encaisseur Ciment n'a pas besoin de accounting.view. */
  router.get("/cement/payment-destinations", authenticateToken, cementModuleGuard, perm("view"), async (req,res) => {
    try {
      res.json({ banks: await listActiveBanks(pool, companyOf(req)) });
    } catch (e) {
      console.error("GET cement payment-destinations:", e);
      res.status(500).json({ error: "Erreur chargement des banques." });
    }
  });

  router.get("/cement/invoices/:id", authenticateToken, cementModuleGuard, perm("view"), async (req,res) => {
    try {
      const companyId = companyOf(req);
      const row = (
        await pool.query(
          `SELECT
             i.*,
             i.invoice_date::text AS invoice_date,
             i.due_date::text AS due_date,
             s.sale_number, s.sale_date::text AS sale_date,
             s.customer_name, s.customer_phone, s.customer_address,
             s.customer_nif, s.customer_rccm,
             s.cement_type, s.strength, s.tonnage, s.unit_price,
             s.transport_price, s.transport_mode, s.transport_total,
             s.cement_subtotal, s.discount, s.tax_amount,
             s.destination AS sale_destination,
             c.name AS customer_full_name
           FROM cement_invoices i
           LEFT JOIN cement_sales s ON s.id=i.sale_id AND s.company_id=i.company_id
           LEFT JOIN cement_customers c ON c.id=i.customer_id AND c.company_id=i.company_id
           WHERE i.id=$1 AND i.company_id=$2`,
          [req.params.id,companyId]
        )
      ).rows[0];

      if(!row) {
        return res.status(404).json({error:"Facture introuvable."});
      }

      const payments = (
        await pool.query(
          `SELECT id, payment_number, payment_date::text AS payment_date, amount, payment_method
             FROM cement_payments
            WHERE company_id=$1 AND invoice_id=$2
            ORDER BY payment_date, id`,
          [companyId, row.id]
        )
      ).rows;

      res.json({ invoice: row, payments, operation: "Vente de ciment" });
    } catch(e) {
      console.error("GET cement invoice:",e);
      res.status(500).json({error:"Erreur lecture de la facture."});
    }
  });

  return router;
};

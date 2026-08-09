const express = require("express");

module.exports = function createSandSalesRouter({
  pool,
  authenticateToken,
  getEffectiveCompanyId,
  requirePermission,
  requireCompanyModule
}) {
  const router = express.Router();

  const companyOf = (req) =>
    Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);

  const perm = (action) =>
    requirePermission("sand", action);

  /* Le module n'est plus lié en dur à une entreprise : il est accordé par la
     configuration de modules de l'entreprise (company_modules) combinée au
     RBAC `sand`. L'isolation reste assurée par company_id sur chaque requête. */
  const sandModuleGuard = requireCompanyModule("sand");

  // ==========================================================
  // PRODUITS SABLE
  // ==========================================================

  router.get(
    "/sand/products",
    authenticateToken,
    sandModuleGuard,
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
    sandModuleGuard,
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
    sandModuleGuard,
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
    sandModuleGuard,
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
    sandModuleGuard,
    perm("view"),
    async (req, res) => {
      try {
        const { rows } = await pool.query(
          /* Client et Site viennent de la vente / de la fiche client : sans ces
             jointures, les colonnes « Client » et « Site » de l'état restaient
             vides. Mêmes jointures que /sand/invoices/unpaid. */
          `SELECT i.*,
                  s.destination AS site,
                  s.quantity_m3,
                  COALESCE(c.name, s.customer_name) AS client_name
           FROM sand_invoices i
           LEFT JOIN sand_sales s ON s.id = i.sale_id AND s.company_id = i.company_id
           LEFT JOIN sand_customers c ON c.id = i.customer_id AND c.company_id = i.company_id
           WHERE i.company_id=$1
           ORDER BY i.invoice_date DESC,i.id DESC`,
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
    sandModuleGuard,
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
    sandModuleGuard,
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
    sandModuleGuard,
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
    sandModuleGuard,
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
    sandModuleGuard,
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
    sandModuleGuard,
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
    sandModuleGuard,
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
    sandModuleGuard,
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

  // ==========================================================
  // SAND_READ_DETAIL_PAYMENTS_V1 (P0-2)
  // Détail vente / impayés / paiements idempotents / BL.
  // Le tarif commercial de référence (10 m³ = 170 000 F) vit dans sand_prices ;
  // sand_sales ne stocke que le prix au m³ dérivé. Toute route servant un
  // document DOIT donc rejoindre sand_prices, sinon la colonne « Prix 10 m³ »
  // est impossible à restituer.
  // ==========================================================

  const OPERATION_LABEL = "Vente de sable";

  /* Bloc tarifaire d'affichage : on retrouve le palier commercial appliqué à la
     vente. unit_price_m3 vient de la vente (valeur réellement facturée) ;
     quantity_reference / reference_price viennent du tarif de la destination. */
  async function pricingFor(runner, companyId, sale) {
    const unitPriceM3 = Number(sale.unit_price || 0);
    const { rows } = await runner.query(
      `SELECT quantity_reference, price
         FROM sand_prices
        WHERE company_id=$1
          AND ($2::int IS NULL OR sand_product_id=$2)
          AND LOWER(destination)=LOWER(COALESCE($3,''))
          AND status='ACTIF'
        ORDER BY id DESC LIMIT 1`,
      [companyId, sale.sand_product_id || null, sale.destination || ""]
    );
    const t = rows[0];
    const qtyRef = t ? Number(t.quantity_reference) : 10;
    return {
      quantity_reference: qtyRef,
      // Prix du palier réellement facturé : on le reconstruit depuis le prix au
      // m³ de la vente pour rester cohérent même si le tarif a changé depuis.
      reference_price: Number((unitPriceM3 * qtyRef).toFixed(2)),
      unit_price_m3: unitPriceM3,
      destination: sale.destination || null,
      label: `Prix ${qtyRef} m³`,
    };
  }

  // ---------------- B. DÉTAIL D'UNE VENTE ----------------
  router.get(
    "/sand/sales/:id",
    authenticateToken,
    sandModuleGuard,
    perm("view"),
    async (req, res) => {
      try {
        const companyId = companyOf(req);
        const sale = (await pool.query(
          `SELECT *, sale_date::text AS sale_date FROM sand_sales WHERE id=$1 AND company_id=$2`,
          [req.params.id, companyId]
        )).rows[0];
        // Hors périmètre : 404, on ne révèle pas l'existence de la vente.
        if (!sale) return res.status(404).json({ error: "Vente introuvable." });

        const invoice = (await pool.query(
          `SELECT *, invoice_date::text AS invoice_date, due_date::text AS due_date
             FROM sand_invoices WHERE sale_id=$1 AND company_id=$2 ORDER BY id DESC LIMIT 1`,
          [sale.id, companyId]
        )).rows[0] || null;
        const delivery = (await pool.query(
          `SELECT *, delivery_date::text AS delivery_date
             FROM sand_deliveries WHERE sale_id=$1 AND company_id=$2 ORDER BY id DESC LIMIT 1`,
          [sale.id, companyId]
        )).rows[0] || null;

        res.json({
          sale,
          invoice,
          delivery,
          operation: OPERATION_LABEL,
          pricing: await pricingFor(pool, companyId, sale),
        });
      } catch (e) {
        console.error("GET sand sale:", e);
        res.status(500).json({ error: "Erreur lecture de la vente." });
      }
    }
  );

  // ---------------- C. FACTURES IMPAYÉES ----------------
  router.get(
    "/sand/invoices/unpaid",
    authenticateToken,
    sandModuleGuard,
    perm("view"),
    async (req, res) => {
      try {
        const companyId = companyOf(req);
        const { rows } = await pool.query(
          `SELECT i.*, i.invoice_date::text AS invoice_date, i.due_date::text AS due_date,
                  s.destination AS site, s.quantity_m3, s.customer_name,
                  COALESCE(c.name, s.customer_name) AS client_name
             FROM sand_invoices i
             LEFT JOIN sand_sales s ON s.id = i.sale_id AND s.company_id = i.company_id
             LEFT JOIN sand_customers c ON c.id = i.customer_id AND c.company_id = i.company_id
            WHERE i.company_id = $1
              AND COALESCE(i.remaining_amount, 0) > 0
            ORDER BY i.invoice_date DESC, i.id DESC`,
          [companyId]
        );
        // « Opération » porte le libellé métier, pas la référence technique.
        res.json(rows.map((r) => ({ ...r, operation: OPERATION_LABEL })));
      } catch (e) {
        console.error("GET sand unpaid:", e);
        res.status(500).json({ error: "Erreur lecture des impayés." });
      }
    }
  );

  // ---------------- D. PAIEMENT (IDEMPOTENT) ----------------
  router.post(
    "/sand/invoices/:id/payments",
    authenticateToken,
    sandModuleGuard,
    perm("create"),
    async (req, res) => {
      const client = await pool.connect();
      try {
        const companyId = companyOf(req);
        const amount = Number(req.body?.amount);
        const idemKey = String(req.headers["idempotency-key"] || req.body?.idempotency_key || "").trim() || null;
        if (!(amount > 0)) return res.status(400).json({ error: "Montant de paiement invalide." });

        await client.query("BEGIN");

        // Verrou de ligne : deux requêtes simultanées sont sérialisées ici.
        const invoice = (await client.query(
          `SELECT * FROM sand_invoices WHERE id=$1 AND company_id=$2 FOR UPDATE`,
          [req.params.id, companyId]
        )).rows[0];
        if (!invoice) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Facture introuvable." });
        }

        // Clé déjà utilisée pour CETTE facture : on renvoie le paiement existant
        // au lieu d'en créer un second (réponse perdue, double-clic, retry).
        if (idemKey) {
          const prev = (await client.query(
            `SELECT * FROM sand_payments WHERE company_id=$1 AND invoice_id=$2 AND idempotency_key=$3`,
            [companyId, invoice.id, idemKey]
          )).rows[0];
          if (prev) {
            await client.query("COMMIT");
            return res.status(200).json({ payment: prev, invoice, replayed: true });
          }
        }

        const remaining = Number(invoice.remaining_amount || 0);
        if (remaining <= 0) {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "Facture déjà soldée.", code: "ALREADY_SETTLED" });
        }
        if (amount > remaining) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            error: `Montant (${amount}) supérieur au reste dû (${remaining}).`,
            code: "OVER_REMAINING",
          });
        }

        const paymentNumber = await nextSandNumber(client, companyId, "PAY");
        const payment = (await client.query(
          `INSERT INTO sand_payments
             (company_id, invoice_id, payment_number, payment_date, amount,
              payment_method, reference, notes, created_by, idempotency_key)
           VALUES ($1,$2,$3,COALESCE($4::date,CURRENT_DATE),$5,$6,$7,$8,$9,$10)
           RETURNING *`,
          [companyId, invoice.id, paymentNumber, req.body?.payment_date || null, amount,
           req.body?.payment_method || "especes", req.body?.reference || null,
           req.body?.notes || null, req.user.id, idemKey]
        )).rows[0];

        /* Solde RECONSTRUIT depuis la somme réelle des paiements — jamais
           « paid_amount + amount », qui dériverait au moindre incident. */
        const updated = (await client.query(
          `UPDATE sand_invoices i
              SET paid_amount = p.total,
                  remaining_amount = GREATEST(i.total_amount - p.total, 0),
                  status = CASE WHEN p.total >= i.total_amount THEN 'PAYEE'
                                WHEN p.total > 0 THEN 'PARTIELLEMENT_PAYEE'
                                ELSE 'IMPAYEE' END,
                  updated_at = NOW()
             FROM (SELECT COALESCE(SUM(amount),0) AS total
                     FROM sand_payments
                    WHERE company_id=$1 AND invoice_id=$2) p
            WHERE i.id=$2 AND i.company_id=$1
            RETURNING i.*`,
          [companyId, invoice.id]
        )).rows[0];

        await client.query("COMMIT");
        res.status(201).json({ payment, invoice: updated, replayed: false });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        // Course perdue sur la clé d'idempotence : l'autre requête a gagné.
        if (e && e.code === "23505") {
          return res.status(409).json({ error: "Paiement déjà enregistré.", code: "DUPLICATE_PAYMENT" });
        }
        console.error("POST sand payment:", e);
        res.status(500).json({ error: "Erreur enregistrement du paiement." });
      } finally { client.release(); }
    }
  );

  // ---------------- E. DÉTAIL D'UN BON DE LIVRAISON ----------------
  router.get(
    "/sand/deliveries/:id",
    authenticateToken,
    sandModuleGuard,
    perm("view"),
    async (req, res) => {
      try {
        const companyId = companyOf(req);
        // AUCUN montant sur le BL : on ne sélectionne que le nécessaire.
        const { rows } = await pool.query(
          `SELECT d.*, d.delivery_date::text AS delivery_date, s.sale_number, s.customer_name, s.customer_address,
                  s.quantity_m3 AS sale_quantity_m3, s.product_name
             FROM sand_deliveries d
             LEFT JOIN sand_sales s ON s.id = d.sale_id AND s.company_id = d.company_id
            WHERE d.id=$1 AND d.company_id=$2`,
          [req.params.id, companyId]
        );
        if (!rows[0]) return res.status(404).json({ error: "Bon de livraison introuvable." });
        res.json({ delivery: rows[0], operation: OPERATION_LABEL });
      } catch (e) {
        console.error("GET sand delivery:", e);
        res.status(500).json({ error: "Erreur lecture du bon de livraison." });
      }
    }
  );

  // ---------------- F. DÉTAIL D'UNE PROFORMA ----------------
  router.get(
    "/sand/proformas/:id",
    authenticateToken,
    sandModuleGuard,
    perm("view"),
    async (req, res) => {
      try {
        const companyId = companyOf(req);
        const proforma = (await pool.query(
          `SELECT *, proforma_date::text AS proforma_date, valid_until::text AS valid_until
             FROM sand_proformas WHERE id=$1 AND company_id=$2`,
          [req.params.id, companyId]
        )).rows[0];
        if (!proforma) return res.status(404).json({ error: "Proforma introuvable." });

        const lines = (await pool.query(
          `SELECT * FROM sand_proforma_lines
            WHERE proforma_id=$1 AND company_id=$2
            ORDER BY sort_order NULLS LAST, id`,
          [proforma.id, companyId]
        )).rows;

        // Palier commercial de la destination, pour la colonne « Prix 10 m³ ».
        const tariff = (await pool.query(
          `SELECT quantity_reference, price FROM sand_prices
            WHERE company_id=$1 AND LOWER(destination)=LOWER(COALESCE($2,'')) AND status='ACTIF'
            ORDER BY id DESC LIMIT 1`,
          [companyId, proforma.destination || ""]
        )).rows[0];
        const qtyRef = tariff ? Number(tariff.quantity_reference) : 10;

        res.json({
          proforma,
          lines,
          operation: OPERATION_LABEL,
          pricing: {
            quantity_reference: qtyRef,
            reference_price: tariff ? Number(tariff.price) : null,
            unit_price_m3: tariff && qtyRef > 0 ? Number(tariff.price) / qtyRef : null,
            destination: proforma.destination || null,
            label: `Prix ${qtyRef} m³`,
          },
        });
      } catch (e) {
        console.error("GET sand proforma:", e);
        res.status(500).json({ error: "Erreur lecture de la proforma." });
      }
    }
  );

  // ---------------- G. CRÉATION D'UNE PROFORMA ----------------
  router.post(
    "/sand/proformas",
    authenticateToken,
    sandModuleGuard,
    perm("create"),
    async (req, res) => {
      const client = await pool.connect();
      try {
        const companyId = companyOf(req);
        const b = req.body || {};
        const quantity = Number(b.quantity_m3 || 0);
        const destination = String(b.destination || "").trim();
        if (!(quantity > 0)) return res.status(400).json({ error: "Quantité (m³) invalide." });
        if (!destination) return res.status(400).json({ error: "Destination obligatoire." });

        await client.query("BEGIN");

        // Client optionnel, mais s'il est fourni il doit appartenir à l'entreprise.
        let customer = null;
        if (b.customer_id) {
          customer = (await client.query(
            `SELECT * FROM sand_customers WHERE id=$1 AND company_id=$2`,
            [b.customer_id, companyId]
          )).rows[0];
          if (!customer) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "Client introuvable." });
          }
        }

        // Prix : palier de la destination, sauf prix imposé explicitement.
        const tariff = (await client.query(
          `SELECT quantity_reference, price, transport_price FROM sand_prices
            WHERE company_id=$1 AND LOWER(destination)=LOWER($2) AND status='ACTIF'
            ORDER BY id DESC LIMIT 1`,
          [companyId, destination]
        )).rows[0];

        const qtyRef = tariff ? Number(tariff.quantity_reference || 10) : 10;
        let unitPriceM3 = Number(b.unit_price || 0);
        if (!unitPriceM3 && tariff) unitPriceM3 = Number(tariff.price) / (qtyRef || 1);
        if (!(unitPriceM3 > 0)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Aucun prix valide pour cette destination." });
        }

        const subtotal = Number((quantity * unitPriceM3).toFixed(2));
        const discount = Math.max(Number(b.discount || 0), 0);
        const taxAmount = Math.max(Number(b.tax_amount || 0), 0);
        const total = Math.max(subtotal - discount + taxAmount, 0);

        const number = await nextSandNumber(client, companyId, "PRF");
        const proforma = (await client.query(
          `INSERT INTO sand_proformas
             (company_id, customer_id, proforma_number, proforma_date, valid_until,
              customer_name, customer_phone, customer_address, destination,
              subtotal, discount, tax_amount, total_amount, status, notes, created_by)
           VALUES ($1,$2,$3,COALESCE($4::date,CURRENT_DATE),$5::date,$6,$7,$8,$9,
                   $10,$11,$12,$13,'BROUILLON',$14,$15)
           RETURNING *`,
          [companyId, customer?.id || null, number, b.proforma_date || null, b.valid_until || null,
           customer?.name || b.customer_name || null, customer?.phone || b.customer_phone || null,
           customer?.address || b.customer_address || null, destination,
           subtotal, discount, taxAmount, total, b.notes || null, req.user.id]
        )).rows[0];

        // Ligne unique « Sable » : le métier n'a qu'un article.
        await client.query(
          `INSERT INTO sand_proforma_lines
             (company_id, proforma_id, line_type, description, quantity, unit, unit_price, line_total, sort_order)
           VALUES ($1,$2,'SABLE','Sable',$3,'m3',$4,$5,1)`,
          [companyId, proforma.id, quantity, unitPriceM3, subtotal]
        );

        await client.query("COMMIT");
        res.status(201).json({
          proforma,
          pricing: {
            quantity_reference: qtyRef,
            reference_price: Number((unitPriceM3 * qtyRef).toFixed(2)),
            unit_price_m3: unitPriceM3,
            destination,
            label: `Prix ${qtyRef} m³`,
          },
        });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("POST sand proforma:", e);
        res.status(500).json({ error: "Erreur création de la proforma." });
      } finally { client.release(); }
    }
  );

  // ---------------- H. VALIDATION D'UNE PROFORMA ----------------
  router.post(
    "/sand/proformas/:id/validate",
    authenticateToken,
    sandModuleGuard,
    perm("validate"),
    async (req, res) => {
      const client = await pool.connect();
      try {
        const companyId = companyOf(req);
        await client.query("BEGIN");
        const cur = (await client.query(
          `SELECT * FROM sand_proformas WHERE id=$1 AND company_id=$2 FOR UPDATE`,
          [req.params.id, companyId]
        )).rows[0];
        if (!cur) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Proforma introuvable." });
        }
        // Anti double-validation : même garde que la validation de vente.
        if (cur.status !== "BROUILLON") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: `Proforma déjà traitée (${cur.status}).`, code: "ALREADY_VALIDATED" });
        }
        const proforma = (await client.query(
          `UPDATE sand_proformas
              SET status='VALIDEE', validated_by=$3, validated_at=NOW(), updated_at=NOW()
            WHERE id=$1 AND company_id=$2 RETURNING *`,
          [cur.id, companyId, req.user.id]
        )).rows[0];
        await client.query("COMMIT");
        res.json({ success: true, proforma });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("VALIDATE sand proforma:", e);
        res.status(500).json({ error: "Erreur validation de la proforma." });
      } finally { client.release(); }
    }
  );

  // ---------------- I. TABLEAU DE BORD SABLE ----------------
  router.get(
    "/sand/dashboard",
    authenticateToken,
    sandModuleGuard,
    perm("view"),
    async (req, res) => {
      try {
        const companyId = companyOf(req);
        const sales = (await pool.query(
          `SELECT COUNT(*)::int AS sales_count,
                  COALESCE(SUM(quantity_m3),0)::numeric AS total_m3,
                  COALESCE(SUM(total_amount),0)::numeric AS total_sales
             FROM sand_sales WHERE company_id=$1 AND status <> 'ANNULEE'`,
          [companyId]
        )).rows[0];
        const inv = (await pool.query(
          `SELECT COUNT(*)::int AS invoices_count,
                  COALESCE(SUM(total_amount),0)::numeric AS total_invoiced,
                  COALESCE(SUM(paid_amount),0)::numeric AS total_paid,
                  COALESCE(SUM(remaining_amount),0)::numeric AS total_remaining,
                  COUNT(*) FILTER (WHERE COALESCE(remaining_amount,0) > 0)::int AS unpaid_count
             FROM sand_invoices WHERE company_id=$1`,
          [companyId]
        )).rows[0];
        const recent = (await pool.query(
          `SELECT id, sale_number, customer_name, destination, quantity_m3, total_amount, sale_date, status
             FROM sand_sales WHERE company_id=$1 ORDER BY sale_date DESC, id DESC LIMIT 10`,
          [companyId]
        )).rows;
        res.json({ operation: OPERATION_LABEL, sales, invoices: inv, recent_sales: recent });
      } catch (e) {
        console.error("GET sand dashboard:", e);
        res.status(500).json({ error: "Erreur tableau de bord sable." });
      }
    }
  );

  // ---------------- J. RAPPORT / ÉTAT AGRÉGÉ ----------------
  router.get(
    "/sand/reports/summary",
    authenticateToken,
    sandModuleGuard,
    perm("view"),
    async (req, res) => {
      try {
        const companyId = companyOf(req);
        // Tous les filtres sont paramétrés : company_id est TOUJOURS le premier.
        const p = [companyId];
        let where = "i.company_id = $1";
        const push = (sql, val) => { p.push(val); where += ` AND ${sql.replace("$?", "$" + p.length)}`; };
        if (req.query.date_from) push("i.invoice_date >= $?::date", req.query.date_from);
        if (req.query.date_to) push("i.invoice_date <= $?::date", req.query.date_to);
        if (req.query.customer_id) push("i.customer_id = $?::int", req.query.customer_id);
        if (req.query.site || req.query.destination) push("LOWER(COALESCE(s.destination,'')) = LOWER($?)", req.query.site || req.query.destination);
        if (req.query.status) push("i.status = $?", req.query.status);

        const base = `FROM sand_invoices i
                      LEFT JOIN sand_sales s ON s.id = i.sale_id AND s.company_id = i.company_id
                      WHERE ${where}`;

        const summary = (await pool.query(
          `SELECT COUNT(*)::int AS invoices_count,
                  COUNT(DISTINCT i.sale_id)::int AS sales_count,
                  COALESCE(SUM(s.quantity_m3),0)::numeric AS total_m3,
                  COALESCE(SUM(i.total_amount),0)::numeric AS total_invoiced,
                  COALESCE(SUM(i.paid_amount),0)::numeric AS total_paid,
                  COALESCE(SUM(i.remaining_amount),0)::numeric AS total_remaining,
                  COUNT(*) FILTER (WHERE COALESCE(i.remaining_amount,0) > 0)::int AS unpaid_count,
                  COUNT(*) FILTER (WHERE COALESCE(i.remaining_amount,0) <= 0)::int AS paid_count,
                  COUNT(*) FILTER (WHERE COALESCE(i.paid_amount,0) > 0
                                     AND COALESCE(i.remaining_amount,0) > 0)::int AS partial_count
           ${base}`, p
        )).rows[0];

        const agg = `COUNT(*)::int AS invoices_count,
                     COALESCE(SUM(i.total_amount),0)::numeric AS total_invoiced,
                     COALESCE(SUM(i.paid_amount),0)::numeric AS total_paid,
                     COALESCE(SUM(i.remaining_amount),0)::numeric AS total_remaining`;
        const [byCustomer, bySite, byStatus, byPeriod] = await Promise.all([
          pool.query(`SELECT COALESCE(i.customer_id,0) AS customer_id,
                             COALESCE(MAX(s.customer_name),'—') AS customer_name, ${agg}
                      ${base} GROUP BY 1 ORDER BY total_invoiced DESC`, p),
          pool.query(`SELECT COALESCE(s.destination,'—') AS site, ${agg}
                      ${base} GROUP BY 1 ORDER BY total_invoiced DESC`, p),
          pool.query(`SELECT i.status, ${agg} ${base} GROUP BY 1 ORDER BY 1`, p),
          pool.query(`SELECT TO_CHAR(i.invoice_date,'YYYY-MM') AS period, ${agg}
                      ${base} GROUP BY 1 ORDER BY 1`, p),
        ]);

        res.json({
          operation: OPERATION_LABEL,
          filters: {
            date_from: req.query.date_from || null, date_to: req.query.date_to || null,
            customer_id: req.query.customer_id || null,
            site: req.query.site || req.query.destination || null,
            status: req.query.status || null,
          },
          summary,
          breakdowns: {
            by_customer: byCustomer.rows, by_site: bySite.rows,
            by_status: byStatus.rows, by_period: byPeriod.rows,
          },
        });
      } catch (e) {
        console.error("GET sand report:", e);
        res.status(500).json({ error: "Erreur génération du rapport." });
      }
    }
  );

  // ---------------- K. ÉTAT SUR FACTURES SÉLECTIONNÉES ----------------
  router.post(
    "/sand/reports/statement",
    authenticateToken,
    sandModuleGuard,
    perm("view"),
    async (req, res) => {
      try {
        const companyId = companyOf(req);
        const ids = [...new Set((req.body?.invoice_ids || [])
          .map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0))];
        if (ids.length === 0) return res.status(400).json({ error: "Aucune facture sélectionnée." });

        /* Le filtre company_id est dans la requête : une facture d'une autre
           entreprise n'est simplement jamais renvoyée. On compare ensuite le
           nombre obtenu au nombre demandé pour refuser explicitement la
           sélection plutôt que de produire un état silencieusement tronqué. */
        const { rows } = await pool.query(
          `SELECT i.id, i.invoice_number, i.invoice_date::text AS invoice_date, i.total_amount, i.paid_amount,
                  i.remaining_amount, i.status, i.operation_reference,
                  COALESCE(s.destination,'—') AS site,
                  COALESCE(c.name, s.customer_name, '—') AS client_name,
                  s.quantity_m3
             FROM sand_invoices i
             LEFT JOIN sand_sales s ON s.id = i.sale_id AND s.company_id = i.company_id
             LEFT JOIN sand_customers c ON c.id = i.customer_id AND c.company_id = i.company_id
            WHERE i.company_id = $1 AND i.id = ANY($2::int[])
            ORDER BY i.invoice_date, i.id`,
          [companyId, ids]
        );
        if (rows.length !== ids.length) {
          const found = new Set(rows.map((r) => Number(r.id)));
          return res.status(404).json({
            error: "Certaines factures n'appartiennent pas à votre entreprise ou n'existent pas.",
            code: "INVOICES_OUT_OF_SCOPE",
            rejected_ids: ids.filter((id) => !found.has(id)),
          });
        }

        const company = (await pool.query(`SELECT id, name FROM companies WHERE id=$1`, [companyId])).rows[0] || null;
        const sum = (k) => Number(rows.reduce((a, r) => a + Number(r[k] || 0), 0).toFixed(2));
        const dates = rows.map((r) => r.invoice_date).filter(Boolean).sort();

        res.json({
          company,
          operation: OPERATION_LABEL,
          period: { from: dates[0] || null, to: dates[dates.length - 1] || null },
          invoices_count: rows.length,
          clients: [...new Set(rows.map((r) => r.client_name))],
          sites: [...new Set(rows.map((r) => r.site))],
          totals: {
            total_invoiced: sum("total_amount"),
            total_paid: sum("paid_amount"),
            total_remaining: sum("remaining_amount"),
            total_m3: sum("quantity_m3"),
          },
          lines: rows.map((r) => ({
            invoice_number: r.invoice_number, invoice_date: r.invoice_date,
            operation: OPERATION_LABEL, client: r.client_name, site: r.site,
            quantity_m3: r.quantity_m3, amount: r.total_amount,
            paid: r.paid_amount, remaining: r.remaining_amount, status: r.status,
          })),
        });
      } catch (e) {
        console.error("POST sand statement:", e);
        res.status(500).json({ error: "Erreur génération de l'état." });
      }
    }
  );

  // ---------------- DÉTAIL D'UNE FACTURE ----------------
  router.get(
    "/sand/invoices/:id",
    authenticateToken,
    sandModuleGuard,
    perm("view"),
    async (req, res) => {
      try {
        const companyId = companyOf(req);
        const invoice = (await pool.query(
          `SELECT i.*, s.sale_number, s.quantity_m3, s.unit_price, s.sand_product_id,
                  s.destination AS sale_destination, s.notes AS sale_notes,
                  s.customer_address AS sale_customer_address,
                  COALESCE(c.name, s.customer_name) AS client_name,
                  COALESCE(c.address, s.customer_address) AS client_address
             FROM sand_invoices i
             LEFT JOIN sand_sales s ON s.id = i.sale_id AND s.company_id = i.company_id
             LEFT JOIN sand_customers c ON c.id = i.customer_id AND c.company_id = i.company_id
            WHERE i.id=$1 AND i.company_id=$2`,
          [req.params.id, companyId]
        )).rows[0];
        if (!invoice) return res.status(404).json({ error: "Facture introuvable." });

        res.json({
          invoice,
          operation: OPERATION_LABEL,
          // Palier commercial : « Prix 10 m³ », jamais le prix au m³.
          pricing: await pricingFor(pool, companyId, {
            unit_price: invoice.unit_price,
            sand_product_id: invoice.sand_product_id,
            destination: invoice.sale_destination || invoice.destination,
          }),
        });
      } catch (e) {
        console.error("GET sand invoice:", e);
        res.status(500).json({ error: "Erreur lecture de la facture." });
      }
    }
  );


  return router;
};

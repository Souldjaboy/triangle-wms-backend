const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const QRCode = require("qrcode");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  if (req.url.startsWith("/api/")) {
    req.url = req.url.slice(4);
  }

  next();
});

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    const uniqueName =
      Date.now() + "-" + file.originalname.replace(/\s+/g, "-");
    cb(null, uniqueName);
  }
});

const upload = multer({ storage });

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL
    })
  : new Pool({
      user: "souleymanediallo",
      host: "localhost",
      database: "triangle_wms_db",
      password: "",
      port: 5432
    });

const JWT_SECRET = "triangle_wms_secret_key";

function getCompanyFilter(req) {
  const companyId = req.headers["x-company-id"];
  const isSuperAdmin = req.headers["x-super-admin"] === "true";

  return {
    companyId,
    isSuperAdmin
  };
}

function normalizeRole(role) {
  return String(role || "").toLowerCase();
}

function isAdminUser(user) {
  const role = normalizeRole(user?.role);
  return (
    user?.is_super_admin === true || role === "admin" || role === "super_admin"
  );
}

function authorizeRoles(...roles) {
  return (req, res, next) => {
    const allowed = roles.map(normalizeRole);
    const userRole = normalizeRole(req.user?.role);

    if (req.user?.is_super_admin === true || allowed.includes(userRole)) {
      return next();
    }

    return res.status(403).json({
      error: "Accès refusé : vous n'avez pas l'autorisation."
    });
  };
}

function getUserCompanyId(req) {
  return req.user?.company_id || null;
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];

  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      error: "Token manquant"
    });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({
        error: "Token invalide"
      });
    }

    req.user = user;

    next();
  });
}

async function getCompanyPlanLimits(companyId) {
  const result = await pool.query(
    `SELECT 
      sp.*
     FROM subscriptions s
     LEFT JOIN subscription_plans sp 
     ON s.plan_id = sp.id
     WHERE s.company_id = $1
     ORDER BY s.id DESC
     LIMIT 1`,
    [companyId]
  );

  return result.rows[0] || null;
}

async function logActivity(user_name, user_role, action, module, details) {
  try {
    await pool.query(
      `INSERT INTO user_activities
      (user_name, user_role, action, module, details)
      VALUES ($1, $2, $3, $4, $5)`,
      [
        user_name || "Système",
        user_role || "Non défini",
        action,
        module,
        details || ""
      ]
    );
  } catch (error) {
    console.error("Erreur activité :", error);
  }
}

async function ensureDefaultSubscriptionPlans() {
  const defaultPlans = [
    {
      name: "Starter",
      price_monthly: 5000,
      max_users: 3,
      max_warehouses: 1,
      max_products: 200,
      max_movements_monthly: 500,
      trial_days: 15
    },
    {
      name: "Standard",
      price_monthly: 10000,
      max_users: 10,
      max_warehouses: 3,
      max_products: 1000,
      max_movements_monthly: 3000,
      trial_days: 15
    },
    {
      name: "Premium",
      price_monthly: 15000,
      max_users: 0,
      max_warehouses: 0,
      max_products: 0,
      max_movements_monthly: 0,
      trial_days: 15
    }
  ];

  for (const plan of defaultPlans) {
    await pool.query(
      `INSERT INTO subscription_plans
       (
         name,
         price_monthly,
         max_users,
         max_warehouses,
         max_products,
         max_movements_monthly,
         trial_days,
         modules,
         can_use_reports,
         can_use_qr,
         can_use_advanced_inventory,
         can_use_documents,
         can_use_chat,
         can_use_ai
       )
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,true,true,true,true,true,true
       WHERE NOT EXISTS (
         SELECT 1 FROM subscription_plans WHERE name=$1
       )`,
      [
        plan.name,
        plan.price_monthly,
        plan.max_users,
        plan.max_warehouses,
        plan.max_products,
        plan.max_movements_monthly,
        plan.trial_days,
        "all"
      ]
    );
  }
}

app.get("/", (req, res) => {
  res.send("Triangle WMS Backend sécurisé OK");
});

/* UPLOAD LOGO */
app.post("/upload-logo", upload.single("logo"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Aucun fichier reçu" });
    }

    const logoUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

    res.json({
      message: "Logo uploadé avec succès",
      logo_url: logoUrl
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur upload logo" });
  }
});

/* UPLOAD PHOTO UTILISATEUR */
app.post("/upload-user-photo", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Aucune photo reçue" });
    }

    const photoUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

    res.json({
      message: "Photo utilisateur uploadée avec succès",
      profile_image_url: photoUrl
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur upload photo utilisateur" });
  }
});

/* PARAMÈTRES ENTREPRISE */
app.get("/company-settings", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM company_settings ORDER BY id ASC LIMIT 1"
    );

    res.json(result.rows[0] || null);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture paramètres entreprise" });
  }
});

app.put("/company-settings", async (req, res) => {
  try {
    const { company_name, address, phone, email, website, logo_url, slogan } =
      req.body;

    const existing = await pool.query(
      "SELECT id FROM company_settings ORDER BY id ASC LIMIT 1"
    );

    if (existing.rows.length === 0) {
      const created = await pool.query(
        `INSERT INTO company_settings
        (company_name, address, phone, email, website, logo_url, slogan)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING *`,
        [company_name, address, phone, email, website, logo_url, slogan]
      );

      return res.json(created.rows[0]);
    }

    const id = existing.rows[0].id;

    const updated = await pool.query(
      `UPDATE company_settings
       SET company_name=$1,
           address=$2,
           phone=$3,
           email=$4,
           website=$5,
           logo_url=$6,
           slogan=$7,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$8
       RETURNING *`,
      [company_name, address, phone, email, website, logo_url, slogan, id]
    );

    await logActivity(
      "Administrateur",
      "admin",
      "Modification paramètres entreprise",
      "Paramètres",
      `Paramètres entreprise modifiés : ${company_name}`
    );

    res.json(updated.rows[0]);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ error: "Erreur modification paramètres entreprise" });
  }
});

/* REGISTER SAAS - AVEC PLAN CHOISI */
app.post("/register-saas", async (req, res) => {
  try {
    const {
      company_name,
      business_type,
      responsible_name,
      email,
      phone,
      address,
      password,
      plan_id,
      plan_name,
      plan_price
    } = req.body;

    if (!company_name || !responsible_name || !email || !password) {
      return res.status(400).json({
        error: "Informations obligatoires manquantes."
      });
    }

    await ensureDefaultSubscriptionPlans();

    let planResult;

    if (Number.isInteger(Number(plan_id))) {
      planResult = await pool.query(
        `
        SELECT *
        FROM subscription_plans
        WHERE id = $1
        LIMIT 1
        `,
        [Number(plan_id)]
      );
    } else {
      planResult = { rows: [] };
    }

    if (planResult.rows.length === 0 && plan_name) {
      planResult = await pool.query(
        `
        SELECT *
        FROM subscription_plans
        WHERE LOWER(name) = LOWER($1)
        LIMIT 1
        `,
        [plan_name]
      );
    }

    if (planResult.rows.length === 0 && plan_price) {
      planResult = await pool.query(
        `
        SELECT *
        FROM subscription_plans
        WHERE price_monthly = $1
        ORDER BY id ASC
        LIMIT 1
        `,
        [Number(plan_price)]
      );
    }

    if (planResult.rows.length === 0) {
      return res.status(404).json({
        error: "Plan introuvable"
      });
    }

    const plan = planResult.rows[0];

    const existingUser = await pool.query(
      `
      SELECT id
      FROM users
      WHERE email = $1
      LIMIT 1
      `,
      [email]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        error: "Cet email existe déjà."
      });
    }

    const companyResult = await pool.query(
      `
      INSERT INTO companies
      (
        name,
        business_type,
        responsible_name,
        email,
        phone,
        address,
        plan_id,
        subscription_status,
        trial_ends_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW() + ($9 || ' days')::interval)
      RETURNING *
      `,
      [
        company_name,
        business_type || "",
        responsible_name,
        email,
        phone || "",
        address || "",
        plan.id,
        "trial",
        Number(plan.trial_days || 15)
      ]
    );

    const company = companyResult.rows[0];

    const userResult = await pool.query(
      `
      INSERT INTO users
      (
        fullname,
        email,
        password,
        role,
        company_id,
        is_super_admin,
        badge_code
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
      `,
      [
        responsible_name,
        email,
        password,
        "admin",
        company.id,
        false,
        `TRIANGLE-EMP-${company.id}-${Date.now()}`
      ]
    );

    const user = userResult.rows[0];

    await pool.query(
      `
      INSERT INTO subscriptions
      (
        company_id,
        plan_id,
        start_date,
        end_date,
        status,
        payment_status
      )
      VALUES ($1,$2,NOW(),NOW() + ($3 || ' days')::interval,$4,$5)
      `,
      [
        company.id,
        plan.id,
        Number(plan.trial_days || 15),
        "trial",
        "free_trial"
      ]
    );

    res.status(201).json({
      success: true,
      message: "Entreprise créée avec succès. Essai gratuit activé.",
      company,
      user,
      plan
    });
  } catch (error) {
    console.error("ERREUR REGISTER SAAS :", error);

    res.status(500).json({
      error: error.message || "Erreur création entreprise SaaS",
      code: error.code || "",
      detail: error.detail || "",
      table: error.table || "",
      column: error.column || ""
    });
  }
});

/* LOGIN SAAS */
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      `SELECT 
        u.*,
        c.name AS company_name,
        c.status AS company_status,
        s.status AS subscription_status,
        s.end_date AS subscription_end_date,
        sp.name AS plan_name
       FROM users u
       LEFT JOIN companies c ON u.company_id = c.id
       LEFT JOIN subscriptions s ON c.id = s.company_id
       LEFT JOIN subscription_plans sp ON s.plan_id = sp.id
       WHERE u.email = $1
       ORDER BY s.id DESC
       LIMIT 1`,
      [email]
    );

    const user = result.rows[0];

    if (!user) return res.status(401).json({ error: "Email incorrect" });

    if (user.is_active === false) {
      return res.status(403).json({ error: "Compte désactivé" });
    }

    if (password !== user.password) {
      return res.status(401).json({ error: "Mot de passe incorrect" });
    }

    if (!user.is_super_admin) {
      if (user.company_status === "suspended") {
        return res.status(403).json({
          error: "Entreprise suspendue. Veuillez contacter l’administration."
        });
      }

      if (
        user.subscription_status === "expired" ||
        user.subscription_status === "suspended" ||
        user.subscription_status === "cancelled"
      ) {
        return res.status(403).json({
          error: "Abonnement inactif. Veuillez renouveler votre abonnement."
        });
      }
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
        company_id: user.company_id,
        is_super_admin: user.is_super_admin || false
      },
      JWT_SECRET,
      { expiresIn: "1d" }
    );

    await logActivity(
      user.fullname,
      user.role,
      "Connexion utilisateur",
      "Authentification",
      `${user.fullname} s'est connecté`
    );

    res.json({
      message: "Connexion réussie",
      token,
      user: {
        id: user.id,
        fullname: user.fullname,
        email: user.email,
        role: user.role,
        company_id: user.company_id,
        company_name: user.company_name || "",
        company_status: user.company_status || "",
        is_super_admin: user.is_super_admin || false,
        subscription_status: user.subscription_status || "",
        subscription_end_date: user.subscription_end_date || "",
        plan_name: user.plan_name || "",
        profile_image_url: user.profile_image_url || ""
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur login SaaS" });
  }
});

/* UTILISATEURS */
app.get("/users", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    const values = [];
    let companyFilter = "";

    if (!isSuperAdmin) {
      values.push(companyId);
      companyFilter = "WHERE u.company_id = $1";
    }

    const result = await pool.query(
      `SELECT
         u.id,
         u.fullname,
         u.email,
         u.role,
         u.is_active,
         u.profile_image_url,
         u.badge_code,
         u.created_at,
         u.schedule_group_id,
         COALESCE(s.schedule_group, sg.name, '') AS schedule_group,
         COALESCE(s.salary_type, u.payment_type, '') AS salary_type,
         COALESCE(s.hourly_rate, u.hourly_rate, 0) AS hourly_rate,
         COALESCE(s.daily_salary, u.daily_rate, 0) AS daily_rate,
         COALESCE(s.monthly_salary, 0) AS monthly_salary,
         COALESCE(s.start_time, sg.start_time) AS start_time,
         COALESCE(s.end_time, sg.end_time) AS end_time
       FROM users u
       LEFT JOIN attendance_settings s ON s.user_id = u.id
       LEFT JOIN schedule_groups sg ON sg.id = u.schedule_group_id
       ${companyFilter}
       ORDER BY u.id DESC`,
      values
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture utilisateurs" });
  }
});

/* CREATE USER AVEC BADGE + PARAMÈTRES POINTAGE AUTOMATIQUES */
app.post(
  "/users",
  authenticateToken,
  authorizeRoles("admin", "super_admin"),
  async (req, res) => {
    try {
      const { fullname, email, password, role, phone, company_id } = req.body;
      const assignedCompanyId =
        req.user.is_super_admin === true
          ? company_id || req.user.company_id || null
          : req.user.company_id;

      const userResult = await pool.query(
        `
      INSERT INTO users
      (
        fullname,
        email,
        password,
        role,
        phone,
        company_id,
        is_super_admin
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
      `,
        [
          fullname,
          email,
          password || "123456",
          role || "magasinier",
          phone || "",
          assignedCompanyId,
          false
        ]
      );

      const user = userResult.rows[0];

      const badgeCode = `TRIANGLE-EMP-${user.id}`;

      const updatedUser = await pool.query(
        `
      UPDATE users
      SET badge_code = $1
      WHERE id = $2
      RETURNING *
      `,
        [badgeCode, user.id]
      );

      await pool.query(
        `
      INSERT INTO attendance_settings
      (
        user_id,
        schedule_group,
        salary_type,
        hourly_rate,
        daily_salary,
        monthly_salary,
        start_time,
        end_time
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (user_id) DO NOTHING
      `,
        [user.id, "Standard", "horaire", 1000, 8000, 200000, "08:00", "17:00"]
      );

      res.status(201).json(updatedUser.rows[0]);
    } catch (error) {
      console.error("ERREUR CREATE USER :", error);
      res.status(500).json({
        error: "Erreur création utilisateur"
      });
    }
  }
);

/* PRODUITS SAAS */
app.get("/products", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    let query = `
      SELECT products.*, locations.emplacement_code
      FROM products
      LEFT JOIN locations 
      ON products.location_id = locations.id
    `;

    let values = [];

    if (!isSuperAdmin) {
      query += ` WHERE products.company_id = $1 `;
      values.push(companyId);
    }

    query += ` ORDER BY products.id DESC`;

    const result = await pool.query(query, values);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur récupération produits SaaS"
    });
  }
});

app.post("/products", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    if (!isSuperAdmin) {
      const limits = await getCompanyPlanLimits(companyId);

      const countResult = await pool.query(
        "SELECT COUNT(*) FROM products WHERE company_id = $1",
        [companyId]
      );

      const currentProducts = Number(countResult.rows[0].count);
      const maxProducts = Number(limits?.max_products || 0);

      if (maxProducts > 0 && currentProducts >= maxProducts) {
        return res.status(403).json({
          error:
            "Limite produits atteinte pour votre formule. Veuillez passer à une formule supérieure."
        });
      }
    }

    const {
      reference,
      name,
      category,
      stock,
      warehouse,
      status,
      unit,
      weight,
      dimensions,
      barcode,
      description,
      is_active,
      location_id,
      location_code,
      minimum_stock,
      image_url,
      user_name,
      user_role
    } = req.body;

    const result = await pool.query(
      `INSERT INTO products
  (
    reference,
    name,
    category,
    stock,
    warehouse,
    status,
    unit,
    weight,
    dimensions,
    barcode,
    description,
    is_active,
    location_id,
    location_code,
    minimum_stock,
    image_url,
    company_id
  )
  VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,
    $9,$10,$11,$12,$13,$14,$15,$16,$17
  )
  RETURNING *`,
      [
        reference,
        name,
        category,
        Number(stock || 0),
        warehouse,
        status || "Disponible",
        unit || "pièce",
        Number(weight || 0),
        dimensions || "",
        barcode || "",
        description || "",
        is_active !== false,
        location_id || null,
        location_code || "",
        Number(minimum_stock || 5),
        image_url || "",
        companyId
      ]
    );

    await logActivity(
      user_name,
      user_role,
      "Ajout produit",
      "Produits",
      `Produit ajouté : ${reference} - ${name}`
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur ajout produit" });
  }
});

app.put("/products/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      reference,
      name,
      category,
      stock,
      warehouse,
      status,
      unit,
      weight,
      dimensions,
      barcode,
      description,
      is_active,
      location_id,
      location_code,
      minimum_stock,
      image_url,
      user_name,
      user_role
    } = req.body;

    const result = await pool.query(
      `UPDATE products
       SET reference=$1, name=$2, category=$3, stock=$4, warehouse=$5,
           status=$6, unit=$7, weight=$8, dimensions=$9, barcode=$10,
           description=$11, is_active=$12, location_id=$13, location_code=$14,
           minimum_stock=$15, image_url=$16
       WHERE id=$17
       RETURNING *`,
      [
        reference,
        name,
        category,
        Number(stock || 0),
        warehouse,
        status,
        unit || "pièce",
        Number(weight || 0),
        dimensions || "",
        barcode || "",
        description || "",
        is_active !== false,
        location_id || null,
        location_code || "",
        Number(minimum_stock || 5),
        image_url || "",
        id
      ]
    );

    await logActivity(
      user_name,
      user_role,
      "Modification produit",
      "Produits",
      `Produit modifié : ${reference} - ${name}`
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur modification produit" });
  }
});

app.delete("/products/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM products WHERE id=$1", [req.params.id]);

    await logActivity(
      "Administrateur",
      "admin",
      "Suppression produit",
      "Produits",
      `Produit supprimé ID : ${req.params.id}`
    );

    res.json({ message: "Produit supprimé" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur suppression produit" });
  }
});

/* MOUVEMENTS STOCK SAAS */
app.get("/stock-movements", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    let query = `
      SELECT * FROM stock_movements
    `;

    let values = [];

    if (!isSuperAdmin) {
      query += ` WHERE company_id = $1 `;
      values.push(companyId);
    }

    query += ` ORDER BY id DESC`;

    const result = await pool.query(query, values);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur mouvements stock SaaS"
    });
  }
});

app.post("/stock-movements", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    const {
      type,
      product_reference,
      product_name,
      quantity,
      source_warehouse,
      destination_warehouse,
      reason,
      user_name,
      user_role
    } = req.body;

    const productCheck = await pool.query(
      `SELECT *
       FROM products
       WHERE reference=$1
       ${isSuperAdmin ? "" : "AND company_id=$2"}
       LIMIT 1`,
      isSuperAdmin ? [product_reference] : [product_reference, companyId]
    );

    if (productCheck.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Produit introuvable pour cette entreprise" });
    }

    const product = productCheck.rows[0];

    const result = await pool.query(
      `INSERT INTO stock_movements
      (type, product_reference, product_name, quantity, source_warehouse,
       destination_warehouse, reason, status, company_id, created_by, created_by_name, created_by_role)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *`,
      [
        type,
        product_reference,
        product_name || product.name,
        Number(quantity),
        source_warehouse || product.warehouse || "",
        destination_warehouse,
        reason,
        "En attente",
        companyId,
        req.user.id,
        user_name || req.user.email || "Utilisateur",
        user_role || req.user.role || "Non défini"
      ]
    );

    if (type === "Inventaire") {
      const systemStock = Number(product?.stock || 0);
      const realStock = Number(quantity || 0);
      const difference = realStock - systemStock;

      await pool.query(
        `INSERT INTO inventory_history
        (product_reference, product_name, system_stock, real_stock, difference,
         warehouse, location_code, user_name, user_role, status, observation, company_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          product_reference,
          product_name || product.name,
          systemStock,
          realStock,
          difference,
          source_warehouse || product?.warehouse || "",
          product?.location_code || "",
          user_name || "Magasinier",
          user_role || "magasinier",
          "En attente",
          reason || "",
          companyId
        ]
      );
    }

    await logActivity(
      user_name,
      user_role,
      "Création mouvement stock",
      "Stocks",
      `${type} créée pour ${product_reference}`
    );

    const adminUsers = await pool.query(
      `SELECT id FROM users
       WHERE company_id=$1
       AND (role='admin' OR role='super_admin' OR is_super_admin=true)`,
      [companyId]
    );

    for (const admin of adminUsers.rows) {
      if (admin.id !== req.user.id) {
        await pool.query(
          `INSERT INTO notifications
           (user_id, title, message, type, company_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            admin.id,
            "Mouvement stock à valider",
            `${req.user.email || "Un utilisateur"} a créé une demande ${type} pour ${product_reference}.`,
            "stock",
            companyId
          ]
        );
      }
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur création mouvement" });
  }
});

app.put(
  "/stock-movements/:id/validate",
  authenticateToken,
  async (req, res) => {
    try {
      const { id } = req.params;
      const companyId = req.user.company_id;
      const isSuperAdmin = req.user.is_super_admin === true;

      const movementResult = await pool.query(
        `SELECT * FROM stock_movements
       WHERE id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}`,
        isSuperAdmin ? [id] : [id, companyId]
      );

      const movement = movementResult.rows[0];

      if (!movement)
        return res.status(404).json({ error: "Mouvement introuvable" });

      if (movement.status !== "En attente") {
        return res.status(400).json({ error: "Mouvement déjà traité" });
      }

      if (movement.type === "Entrée") {
        await pool.query(
          `UPDATE products SET stock = stock + $1
         WHERE reference = $2 ${isSuperAdmin ? "" : "AND company_id=$3"}`,
          isSuperAdmin
            ? [movement.quantity, movement.product_reference]
            : [movement.quantity, movement.product_reference, companyId]
        );
      }

      if (movement.type === "Sortie") {
        await pool.query(
          `UPDATE products SET stock = GREATEST(stock - $1, 0)
         WHERE reference = $2 ${isSuperAdmin ? "" : "AND company_id=$3"}`,
          isSuperAdmin
            ? [movement.quantity, movement.product_reference]
            : [movement.quantity, movement.product_reference, companyId]
        );
      }

      if (movement.type === "Transfert") {
        await pool.query(
          `UPDATE products SET warehouse = $1
         WHERE reference = $2 ${isSuperAdmin ? "" : "AND company_id=$3"}`,
          isSuperAdmin
            ? [movement.destination_warehouse || "", movement.product_reference]
            : [
                movement.destination_warehouse || "",
                movement.product_reference,
                companyId
              ]
        );
      }

      if (movement.type === "Inventaire") {
        await pool.query(
          `UPDATE products SET stock = $1
         WHERE reference = $2 ${isSuperAdmin ? "" : "AND company_id=$3"}`,
          isSuperAdmin
            ? [movement.quantity, movement.product_reference]
            : [movement.quantity, movement.product_reference, companyId]
        );

        await pool.query(
          `UPDATE inventory_history
         SET status='Validé'
         WHERE product_reference=$1 AND status='En attente'
         ${isSuperAdmin ? "" : "AND company_id=$2"}`,
          isSuperAdmin
            ? [movement.product_reference]
            : [movement.product_reference, companyId]
        );
      }

      const updated = await pool.query(
        `UPDATE stock_movements
       SET status='Validé', validated_by=$1, validated_at=CURRENT_TIMESTAMP
       WHERE id=$2 ${isSuperAdmin ? "" : "AND company_id=$3"}
       RETURNING *`,
        isSuperAdmin ? [req.user.id, id] : [req.user.id, id, companyId]
      );

      await logActivity(
        "Administrateur",
        "admin",
        "Validation mouvement stock",
        "Stocks",
        `${movement.type} validé pour ${movement.product_reference}`
      );

      if (movement.created_by) {
        await pool.query(
          `INSERT INTO notifications
         (user_id, title, message, type, company_id)
         VALUES ($1,$2,$3,$4,$5)`,
          [
            movement.created_by,
            "Mouvement stock validé",
            `Votre demande ${movement.type} pour ${movement.product_reference} a été validée.`,
            "stock",
            movement.company_id || companyId
          ]
        );
      }

      res.json(updated.rows[0]);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur validation mouvement" });
    }
  }
);

app.put("/stock-movements/:id/reject", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    const movementResult = await pool.query(
      `SELECT * FROM stock_movements
       WHERE id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}`,
      isSuperAdmin ? [req.params.id] : [req.params.id, companyId]
    );

    const movement = movementResult.rows[0];

    const updated = await pool.query(
      `UPDATE stock_movements
       SET status='Refusé', validated_by=$1, validated_at=CURRENT_TIMESTAMP
       WHERE id=$2 ${isSuperAdmin ? "" : "AND company_id=$3"}
       RETURNING *`,
      isSuperAdmin
        ? [req.user.id, req.params.id]
        : [req.user.id, req.params.id, companyId]
    );

    if (movement?.type === "Inventaire") {
      await pool.query(
        `UPDATE inventory_history
         SET status='Refusé'
         WHERE product_reference=$1 AND status='En attente'
         ${isSuperAdmin ? "" : "AND company_id=$2"}`,
        isSuperAdmin
          ? [movement.product_reference]
          : [movement.product_reference, companyId]
      );
    }

    await logActivity(
      "Administrateur",
      "admin",
      "Refus mouvement stock",
      "Stocks",
      `Mouvement refusé ID : ${req.params.id}`
    );

    if (movement?.created_by) {
      await pool.query(
        `INSERT INTO notifications
         (user_id, title, message, type, company_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          movement.created_by,
          "Mouvement stock refusé",
          `Votre demande ${movement.type} pour ${movement.product_reference} a été refusée.`,
          "stock",
          movement.company_id || companyId
        ]
      );
    }

    res.json(updated.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur refus mouvement" });
  }
});

/* DOCUMENTS SAAS */
app.get("/documents", async (req, res) => {
  try {
    const { companyId, isSuperAdmin } = getCompanyFilter(req);

    let query = `
      SELECT * FROM documents
    `;

    let values = [];

    if (!isSuperAdmin) {
      query += ` WHERE company_id = $1 `;
      values.push(companyId);
    }

    query += ` ORDER BY id DESC`;

    const result = await pool.query(query, values);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur lecture documents SaaS"
    });
  }
});

app.get("/documents/:id", async (req, res) => {
  try {
    const documentResult = await pool.query(
      "SELECT * FROM documents WHERE id=$1",
      [req.params.id]
    );

    const itemsResult = await pool.query(
      "SELECT * FROM document_items WHERE document_id=$1 ORDER BY id ASC",
      [req.params.id]
    );

    res.json({
      document: documentResult.rows[0],
      items: itemsResult.rows
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur détail document" });
  }
});

app.post("/documents", async (req, res) => {
  try {
    const {
      document_type,
      client_name,
      client_phone,
      client_address,
      observation,
      created_by,
      items
    } = req.body;

    const prefix =
      document_type === "Facture"
        ? "FAC"
        : document_type === "Proforma"
          ? "PRO"
          : document_type === "Bon de réception"
            ? "BR"
            : "BL";

    const document_number = `${prefix}-${Date.now()}`;

    const total_amount = (items || []).reduce((sum, item) => {
      return sum + Number(item.quantity || 0) * Number(item.unit_price || 0);
    }, 0);

    const documentResult = await pool.query(
      `INSERT INTO documents
      (
        document_type,
        document_number,
        client_name,
        client_phone,
        client_address,
        total_amount,
        observation,
        created_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [
        document_type,
        document_number,
        client_name,
        client_phone,
        client_address,
        total_amount,
        observation,
        created_by || "Administrateur"
      ]
    );

    const document = documentResult.rows[0];

    for (const item of items || []) {
      const total_price =
        Number(item.quantity || 0) * Number(item.unit_price || 0);

      await pool.query(
        `INSERT INTO document_items
        (
          document_id,
          product_reference,
          product_name,
          quantity,
          unit_price,
          total_price
        )
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          document.id,
          item.product_reference,
          item.product_name,
          Number(item.quantity || 0),
          Number(item.unit_price || 0),
          total_price
        ]
      );
    }

    await logActivity(
      "Administrateur",
      "admin",
      "Création document",
      "Documents",
      `${document_type} créé : ${document_number}`
    );

    res.status(201).json(document);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur création document" });
  }
});

app.delete("/documents/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM documents WHERE id=$1", [req.params.id]);

    await logActivity(
      "Administrateur",
      "admin",
      "Suppression document",
      "Documents",
      `Document supprimé ID : ${req.params.id}`
    );

    res.json({ message: "Document supprimé" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur suppression document" });
  }
});

/* GÉNÉRER DOCUMENT DEPUIS MOUVEMENT STOCK */
app.post("/documents/from-movement/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      document_type,
      client_name,
      client_phone,
      client_address,
      created_by
    } = req.body;

    const movementResult = await pool.query(
      "SELECT * FROM stock_movements WHERE id=$1",
      [id]
    );

    const movement = movementResult.rows[0];

    if (!movement) {
      return res.status(404).json({
        error: "Mouvement introuvable"
      });
    }

    if (movement.status !== "Validé") {
      return res.status(400).json({
        error: "Le mouvement doit être validé avant de générer un document"
      });
    }

    let finalType = document_type;

    if (!finalType) {
      if (movement.type === "Entrée") {
        finalType = "Bon de réception";
      } else if (movement.type === "Sortie") {
        finalType = "Bon de livraison";
      } else if (movement.type === "Transfert") {
        finalType = "Bon de transfert";
      } else if (movement.type === "Inventaire") {
        finalType = "Fiche inventaire";
      } else {
        finalType = "Document stock";
      }
    }

    const prefix =
      finalType === "Facture"
        ? "FAC"
        : finalType === "Proforma"
          ? "PRO"
          : finalType === "Bon de réception"
            ? "BR"
            : finalType === "Bon de sortie"
              ? "BS"
              : finalType === "Bon de transfert"
                ? "BT"
                : finalType === "Fiche inventaire"
                  ? "INV"
                  : "BL";

    const document_number = `${prefix}-${Date.now()}`;

    const documentResult = await pool.query(
      `INSERT INTO documents
      (
        document_type,
        document_number,
        client_name,
        client_phone,
        client_address,
        total_amount,
        observation,
        created_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [
        finalType,
        document_number,
        client_name || "",
        client_phone || "",
        client_address || "",
        0,
        `Document généré depuis mouvement stock ID ${movement.id} - ${movement.type}`,
        created_by || "Administrateur"
      ]
    );

    const document = documentResult.rows[0];

    await pool.query(
      `INSERT INTO document_items
      (
        document_id,
        product_reference,
        product_name,
        quantity,
        unit_price,
        total_price
      )
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        document.id,
        movement.product_reference,
        movement.product_name,
        Number(movement.quantity || 0),
        0,
        0
      ]
    );

    await logActivity(
      "Administrateur",
      "admin",
      "Document généré depuis mouvement",
      "Documents",
      `${finalType} généré : ${document_number}`
    );

    res.status(201).json(document);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur génération document depuis mouvement"
    });
  }
});

/* HISTORIQUE INVENTAIRE SAAS */
app.get("/inventory-history", async (req, res) => {
  try {
    const { companyId, isSuperAdmin } = getCompanyFilter(req);

    let query = `
      SELECT * FROM inventory_history
    `;

    let values = [];

    if (!isSuperAdmin) {
      query += ` WHERE company_id = $1 `;
      values.push(companyId);
    }

    query += ` ORDER BY id DESC`;

    const result = await pool.query(query, values);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur historique inventaire SaaS"
    });
  }
});

/* ENTREPÔTS SAAS JWT */
app.get("/warehouses", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    let query = `
      SELECT * FROM warehouses
    `;

    let values = [];

    if (!isSuperAdmin) {
      query += ` WHERE company_id = $1 `;
      values.push(companyId);
    }

    query += ` ORDER BY id DESC`;

    const result = await pool.query(query, values);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur lecture entrepôts SaaS"
    });
  }
});

app.post("/warehouses", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    if (!isSuperAdmin) {
      const limits = await getCompanyPlanLimits(companyId);

      const countResult = await pool.query(
        "SELECT COUNT(*) FROM warehouses WHERE company_id = $1",
        [companyId]
      );

      const currentWarehouses = Number(countResult.rows[0].count);
      const maxWarehouses = Number(limits?.max_warehouses || 0);

      if (maxWarehouses > 0 && currentWarehouses >= maxWarehouses) {
        return res.status(403).json({
          error:
            "Limite entrepôts atteinte pour votre formule. Veuillez passer à une formule supérieure."
        });
      }
    }

    const { code, name, location, manager, racks_count, status } = req.body;

    const result = await pool.query(
      `INSERT INTO warehouses
      (
        code,
        name,
        location,
        manager,
        racks_count,
        status,
        company_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *`,
      [
        code,
        name,
        location || "",
        manager || "",
        Number(racks_count || 0),
        status || "Actif",
        companyId
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur ajout entrepôt"
    });
  }
});

app.put("/warehouses/:id", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    const { id } = req.params;
    const { code, name, location, manager, racks_count, status } = req.body;

    let query = `
      UPDATE warehouses
      SET code=$1, name=$2, location=$3, manager=$4, racks_count=$5, status=$6
      WHERE id=$7
    `;

    const values = [
      code,
      name,
      location || "",
      manager || "",
      Number(racks_count || 0),
      status || "Actif",
      id
    ];

    if (!isSuperAdmin) {
      query += ` AND company_id=$8`;
      values.push(companyId);
    }

    query += ` RETURNING *`;

    const result = await pool.query(query, values);

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur modification entrepôt" });
  }
});

app.delete("/warehouses/:id", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    let query = "DELETE FROM warehouses WHERE id=$1";
    const values = [req.params.id];

    if (!isSuperAdmin) {
      query += " AND company_id=$2";
      values.push(companyId);
    }

    query += " RETURNING *";

    const result = await pool.query(query, values);

    res.json({
      message: "Entrepôt supprimé",
      warehouse: result.rows[0]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur suppression entrepôt" });
  }
});
/* EMPLACEMENTS */
app.get("/locations", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT locations.*, warehouses.name AS warehouse_name
       FROM locations
       LEFT JOIN warehouses ON locations.warehouse_id = warehouses.id
       ORDER BY locations.id DESC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture emplacements" });
  }
});

app.post("/locations", async (req, res) => {
  try {
    const { warehouse_id, zone, rayon, etagere, status } = req.body;

    const warehouseResult = await pool.query(
      "SELECT * FROM warehouses WHERE id=$1",
      [warehouse_id]
    );

    const warehouse = warehouseResult.rows[0];

    if (!warehouse)
      return res.status(404).json({ error: "Entrepôt introuvable" });

    const emplacement_code = `${warehouse.code}-${zone}-${rayon}-${etagere}`;
    const qr_code = await QRCode.toDataURL(emplacement_code);

    const result = await pool.query(
      `INSERT INTO locations
      (warehouse_id, warehouse_code, zone, rayon, etagere, emplacement_code, qr_code, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [
        warehouse_id,
        warehouse.code,
        zone,
        rayon,
        etagere,
        emplacement_code,
        qr_code,
        status || "Disponible"
      ]
    );

    await logActivity(
      "Administrateur",
      "admin",
      "Création emplacement",
      "Emplacements",
      `Emplacement créé : ${emplacement_code}`
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur ajout emplacement" });
  }
});

app.delete("/locations/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM locations WHERE id=$1", [req.params.id]);

    await logActivity(
      "Administrateur",
      "admin",
      "Suppression emplacement",
      "Emplacements",
      `Emplacement supprimé ID : ${req.params.id}`
    );

    res.json({ message: "Emplacement supprimé" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur suppression emplacement" });
  }
});

/* ACTIVITÉS */
app.get("/activities", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM user_activities ORDER BY id DESC"
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture activités" });
  }
});

/* ALERTES */
app.get("/alerts", async (req, res) => {
  try {
    const stockFaible = await pool.query(
      `SELECT reference, name, stock, minimum_stock, warehouse, location_code
       FROM products
       WHERE stock > 0 AND stock <= minimum_stock
       ORDER BY stock ASC`
    );

    const rupture = await pool.query(
      `SELECT reference, name, stock, minimum_stock, warehouse, location_code
       FROM products
       WHERE stock <= 0
       ORDER BY name ASC`
    );

    const validations = await pool.query(
      `SELECT id, type, product_reference, product_name, quantity, status, created_at
       FROM stock_movements
       WHERE status = 'En attente'
       ORDER BY id DESC`
    );

    const refuses = await pool.query(
      `SELECT id, type, product_reference, product_name, quantity, status, created_at
       FROM stock_movements
       WHERE status = 'Refusé'
       ORDER BY id DESC`
    );

    res.json({
      stock_faible: stockFaible.rows,
      rupture_stock: rupture.rows,
      validations_en_attente: validations.rows,
      mouvements_refuses: refuses.rows,
      totals: {
        stock_faible: stockFaible.rows.length,
        rupture_stock: rupture.rows.length,
        validations_en_attente: validations.rows.length,
        mouvements_refuses: refuses.rows.length
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture alertes" });
  }
});

/* RECHERCHE GLOBALE INTELLIGENTE */
app.get("/search", async (req, res) => {
  try {
    const q = req.query.q;

    if (!q || String(q).trim() === "") {
      return res.json({
        products: [],
        movements: [],
        inventories: [],
        documents: [],
        locations: []
      });
    }

    const search = `%${String(q).trim()}%`;

    const products = await pool.query(
      `SELECT products.*, locations.emplacement_code
       FROM products
       LEFT JOIN locations ON products.location_id = locations.id
       WHERE products.reference ILIKE $1
          OR products.name ILIKE $1
          OR products.category ILIKE $1
          OR products.warehouse ILIKE $1
          OR products.location_code ILIKE $1
          OR locations.emplacement_code ILIKE $1
       ORDER BY products.id DESC`,
      [search]
    );

    const movements = await pool.query(
      `SELECT *
       FROM stock_movements
       WHERE product_reference ILIKE $1
          OR product_name ILIKE $1
          OR type ILIKE $1
          OR source_warehouse ILIKE $1
          OR destination_warehouse ILIKE $1
          OR reason ILIKE $1
          OR status ILIKE $1
       ORDER BY id DESC`,
      [search]
    );

    const inventories = await pool.query(
      `SELECT *
       FROM inventory_history
       WHERE product_reference ILIKE $1
          OR product_name ILIKE $1
          OR warehouse ILIKE $1
          OR location_code ILIKE $1
          OR user_name ILIKE $1
          OR status ILIKE $1
          OR observation ILIKE $1
       ORDER BY id DESC`,
      [search]
    );

    const documents = await pool.query(
      `SELECT *
       FROM documents
       WHERE document_type ILIKE $1
          OR document_number ILIKE $1
          OR client_name ILIKE $1
          OR client_phone ILIKE $1
          OR client_address ILIKE $1
          OR observation ILIKE $1
          OR created_by ILIKE $1
       ORDER BY id DESC`,
      [search]
    );

    const locations = await pool.query(
      `SELECT locations.*, warehouses.name AS warehouse_name
       FROM locations
       LEFT JOIN warehouses ON locations.warehouse_id = warehouses.id
       WHERE locations.emplacement_code ILIKE $1
          OR locations.warehouse_code ILIKE $1
          OR locations.zone ILIKE $1
          OR locations.rayon ILIKE $1
          OR locations.etagere ILIKE $1
          OR warehouses.name ILIKE $1
       ORDER BY locations.id DESC`,
      [search]
    );

    res.json({
      products: products.rows,
      movements: movements.rows,
      inventories: inventories.rows,
      documents: documents.rows,
      locations: locations.rows,
      totals: {
        products: products.rows.length,
        movements: movements.rows.length,
        inventories: inventories.rows.length,
        documents: documents.rows.length,
        locations: locations.rows.length
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur recherche globale"
    });
  }
});

/* CHAT INTERNE & NOTIFICATIONS */

/* CONVERSATIONS SAAS */
app.get("/chat/conversations/:userId", authenticateToken, async (req, res) => {
  try {
    const { userId } = req.params;

    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    let query = `
      SELECT c.*
      FROM conversations c
      INNER JOIN conversation_participants cp
      ON c.id = cp.conversation_id
      WHERE cp.user_id = $1
    `;

    let values = [userId];

    if (!isSuperAdmin) {
      query += ` AND c.company_id = $2 `;
      values.push(companyId);
    }

    query += ` ORDER BY c.id DESC`;

    const result = await pool.query(query, values);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur conversations SaaS"
    });
  }
});

app.post("/chat/conversations", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;

    const { title, type, created_by, participants } = req.body;

    const existingConversation = await pool.query(
      `
  SELECT c.*
  FROM conversations c
  INNER JOIN conversation_participants cp1
    ON c.id = cp1.conversation_id
  INNER JOIN conversation_participants cp2
    ON c.id = cp2.conversation_id
  WHERE cp1.user_id = $1
    AND cp2.user_id = $2
    AND c.type = 'private'
  LIMIT 1
  `,
      [created_by, participants[1]]
    );

    if (existingConversation.rows.length > 0) {
      return res.json(existingConversation.rows[0]);
    }

    const conversationResult = await pool.query(
      `INSERT INTO conversations
       (title, type, created_by, company_id)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [title, type || "private", created_by, companyId]
    );

    const conversation = conversationResult.rows[0];

    for (const userId of participants || []) {
      await pool.query(
        `INSERT INTO conversation_participants
         (conversation_id, user_id)
         VALUES ($1,$2)`,
        [conversation.id, userId]
      );
    }

    res.status(201).json(conversation);
  } catch (error) {
    console.error("ERREUR CREATION CONVERSATION :", error);
    res.status(500).json({
      error: "Erreur création conversation"
    });
  }
});

/* MESSAGES SAAS */
app.get(
  "/chat/messages/:conversationId",
  authenticateToken,
  async (req, res) => {
    try {
      const { conversationId } = req.params;

      const companyId = req.user.company_id;
      const isSuperAdmin = req.user.is_super_admin === true;

      let query = `
      SELECT 
        m.*, 
        u.fullname AS sender_name, 
        u.role AS sender_role, 
        u.profile_image_url
      FROM messages m
      LEFT JOIN users u ON m.sender_id = u.id
      WHERE m.conversation_id = $1
    `;

      let values = [conversationId];

      if (!isSuperAdmin) {
        query += ` AND m.company_id = $2 `;
        values.push(companyId);
      }

      query += ` ORDER BY m.id ASC`;

      const result = await pool.query(query, values);

      res.json(result.rows);
    } catch (error) {
      console.error(error);
      res.status(500).json({
        error: "Erreur lecture messages SaaS"
      });
    }
  }
);

app.post("/chat/messages", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;

    const {
      conversation_id,
      sender_id,
      receiver_id,
      content,
      message_type,
      audio_url
    } = req.body;

    const messageResult = await pool.query(
      `INSERT INTO messages
       (
        conversation_id,
        sender_id,
        receiver_id,
        content,
        message_type,
        audio_url,
        company_id
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        conversation_id,
        sender_id,
        receiver_id || null,
        content || "",
        message_type || "text",
        audio_url || "",
        companyId
      ]
    );

    const message = messageResult.rows[0];

    if (receiver_id) {
      await pool.query(
        `INSERT INTO notifications
         (user_id, title, message, type, company_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          receiver_id,
          "Nouveau message",
          message_type === "audio"
            ? "Vous avez reçu un message vocal."
            : "Vous avez reçu un nouveau message interne.",
          "message",
          companyId
        ]
      );
    }

    res.status(201).json(message);
  } catch (error) {
    console.error("ERREUR ENVOI MESSAGE :", error);
    res.status(500).json({
      error: "Erreur envoi message"
    });
  }
});

app.put("/chat/messages/:id/read", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    let query = `
      UPDATE messages
      SET is_read = true
      WHERE id = $1
    `;

    let values = [req.params.id];

    if (!isSuperAdmin) {
      query += ` AND company_id = $2 `;
      values.push(companyId);
    }

    query += ` RETURNING *`;

    const updated = await pool.query(query, values);

    res.json(updated.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur lecture message"
    });
  }
});

app.get("/notifications/:userId", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    let query = `
      SELECT *
      FROM notifications
      WHERE user_id = $1
    `;

    let values = [req.params.userId];

    if (!isSuperAdmin) {
      query += ` AND company_id = $2 `;
      values.push(companyId);
    }

    query += ` ORDER BY id DESC`;

    const result = await pool.query(query, values);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur lecture notifications"
    });
  }
});

app.put("/notifications/:id/read", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    let query = `
      UPDATE notifications
      SET is_read = true
      WHERE id = $1
    `;

    let values = [req.params.id];

    if (!isSuperAdmin) {
      query += ` AND company_id = $2 `;
      values.push(companyId);
    }

    query += ` RETURNING *`;

    const updated = await pool.query(query, values);

    res.json(updated.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur notification lue"
    });
  }
});
/* POINTAGE INTELLIGENT */
app.get("/attendance/schedule-groups", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM schedule_groups ORDER BY id ASC"
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture groupes horaires" });
  }
});

/* ATTENDANCE TODAY - AFFICHAGE POINTAGE */
app.get("/attendance/today", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id AS user_id,
        u.fullname,
        u.role,
        u.badge_code,

        s.schedule_group,
        s.salary_type,
        s.hourly_rate,
        s.daily_salary AS setting_daily_salary,
        s.monthly_salary,
        s.start_time,
        s.end_time,

        ar.id AS attendance_id,
        ar.work_date,
        ar.check_in,
        ar.break_out,
        ar.break_in,
        ar.check_out

      FROM users u
      LEFT JOIN attendance_settings s ON s.user_id = u.id
      LEFT JOIN attendance_records ar
        ON ar.user_id = u.id
        AND ar.work_date = CURRENT_DATE
      ORDER BY u.fullname ASC
    `);

    const records = result.rows.map((r) => {
      let status = "Absent";
      let late_minutes = 0;
      let worked_hours = 0;
      let calculated_salary = 0;

      if (r.check_in && !r.check_out) status = "Présent";
      if (r.break_out && !r.break_in) status = "En pause";
      if (r.check_out) status = "Terminé";

      if (r.check_in) {
        const check = new Date(r.check_in);
        const normal = new Date(r.check_in);
        const [h, m] = String(r.start_time || "08:00").split(":");
        normal.setHours(Number(h), Number(m), 0, 0);

        if (check > normal) {
          late_minutes = Math.round((check - normal) / 1000 / 60);
        }
      }

      if (r.check_in && r.check_out) {
        const start = new Date(r.check_in).getTime();
        const end = new Date(r.check_out).getTime();
        worked_hours = (end - start) / 1000 / 60 / 60;
      }

      if (r.salary_type === "horaire") {
        calculated_salary = Math.round(
          worked_hours * Number(r.hourly_rate || 0)
        );
      }

      if (r.salary_type === "journalier" && r.check_in) {
        calculated_salary = Number(r.setting_daily_salary || 0);
      }

      if (r.salary_type === "mensuel" && r.check_in) {
        calculated_salary = Math.round(Number(r.monthly_salary || 0) / 26);
      }

      return {
        ...r,
        id: r.attendance_id || r.user_id,
        status,
        late_minutes,
        worked_hours: worked_hours.toFixed(2),
        calculated_salary
      };
    });

    res.json(records);
  } catch (error) {
    console.error("ERREUR ATTENDANCE TODAY :", error);
    res.status(500).json({ error: "Erreur récupération pointage" });
  }
});
/* POINTAGES DU JOUR SAAS */
app.get("/attendance/today", async (req, res) => {
  try {
    const { companyId, isSuperAdmin } = getCompanyFilter(req);

    let query = `
      SELECT ar.*, u.fullname, u.email, u.role, u.profile_image_url
      FROM attendance_records ar
      LEFT JOIN users u ON ar.user_id = u.id
      WHERE ar.work_date = CURRENT_DATE
    `;

    let values = [];

    if (!isSuperAdmin) {
      query += ` AND u.company_id = $1 `;
      values.push(companyId);
    }

    query += ` ORDER BY ar.id DESC`;

    const result = await pool.query(query, values);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur lecture pointages SaaS"
    });
  }
});

app.get("/attendance/history/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *
       FROM attendance_history
       WHERE user_id = $1
       ORDER BY id DESC`,
      [req.params.userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur historique pointage" });
  }
});

app.post("/attendance/check", async (req, res) => {
  try {
    const { user_id, action_type, device_info, ip_address, location_info } =
      req.body;

    if (!user_id || !action_type) {
      return res.status(400).json({
        error: "Utilisateur et type d'action obligatoires"
      });
    }

    const existingResult = await pool.query(
      `SELECT *
       FROM attendance_records
       WHERE user_id=$1 AND work_date=CURRENT_DATE
       LIMIT 1`,
      [user_id]
    );

    let attendance = existingResult.rows[0];

    if (!attendance) {
      const created = await pool.query(
        `INSERT INTO attendance_records
        (user_id, work_date, status)
        VALUES ($1, CURRENT_DATE, 'Absent')
        RETURNING *`,
        [user_id]
      );

      attendance = created.rows[0];
    }

    let updateQuery = "";
    let status = attendance.status || "Absent";

    if (action_type === "ARRIVEE") {
      if (attendance.check_in) {
        return res.status(400).json({ error: "Arrivée déjà pointée" });
      }

      const now = new Date();
      const startLimit = new Date();
      startLimit.setHours(8, 0, 0, 0);

      const lateMinutes = Math.max(
        0,
        Math.round((now.getTime() - startLimit.getTime()) / 60000)
      );

      status = lateMinutes > 0 ? "En retard" : "Présent";

      updateQuery = `
        UPDATE attendance_records
        SET check_in=CURRENT_TIMESTAMP,
            status=$1,
            late_minutes=$2,
            updated_at=CURRENT_TIMESTAMP
        WHERE id=$3
        RETURNING *
      `;

      attendance = (
        await pool.query(updateQuery, [status, lateMinutes, attendance.id])
      ).rows[0];
    }

    if (action_type === "DEPART_PAUSE") {
      if (!attendance.check_in) {
        return res.status(400).json({ error: "Arrivée non pointée" });
      }

      if (attendance.break_out) {
        return res.status(400).json({ error: "Départ pause déjà pointé" });
      }

      attendance = (
        await pool.query(
          `UPDATE attendance_records
           SET break_out=CURRENT_TIMESTAMP,
               status='En pause',
               updated_at=CURRENT_TIMESTAMP
           WHERE id=$1
           RETURNING *`,
          [attendance.id]
        )
      ).rows[0];
    }

    if (action_type === "RETOUR_PAUSE") {
      if (!attendance.break_out) {
        return res.status(400).json({ error: "Départ pause non pointé" });
      }

      if (attendance.break_in) {
        return res.status(400).json({ error: "Retour pause déjà pointé" });
      }

      attendance = (
        await pool.query(
          `UPDATE attendance_records
           SET break_in=CURRENT_TIMESTAMP,
               status='Présent',
               updated_at=CURRENT_TIMESTAMP
           WHERE id=$1
           RETURNING *`,
          [attendance.id]
        )
      ).rows[0];
    }

    if (action_type === "DEBAUCHE") {
      if (!attendance.check_in) {
        return res.status(400).json({ error: "Arrivée non pointée" });
      }

      if (attendance.check_out) {
        return res.status(400).json({ error: "Débauche déjà pointée" });
      }

      const updated = await pool.query(
        `UPDATE attendance_records
         SET check_out=CURRENT_TIMESTAMP,
             status='Terminé',
             total_work_minutes = GREATEST(
               0,
               EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - check_in)) / 60
             ),
             updated_at=CURRENT_TIMESTAMP
         WHERE id=$1
         RETURNING *`,
        [attendance.id]
      );

      attendance = updated.rows[0];
    }

    await pool.query(
      `INSERT INTO attendance_history
       (user_id, action_type, device_info, ip_address, location_info)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        user_id,
        action_type,
        device_info || "",
        ip_address || "",
        location_info || ""
      ]
    );

    await logActivity(
      "Utilisateur",
      "pointage",
      `Pointage ${action_type}`,
      "Pointage",
      `Utilisateur ID ${user_id} a effectué : ${action_type}`
    );

    res.json(attendance);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur pointage" });
  }
});

/* PARAMÈTRES POINTAGE */
app.get("/attendance/settings/schedule-groups", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM schedule_groups ORDER BY id ASC"
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture groupes horaires" });
  }
});

app.post("/attendance/settings/schedule-groups", async (req, res) => {
  try {
    const { name, start_time, end_time, break_start, break_end } = req.body;

    const result = await pool.query(
      `INSERT INTO schedule_groups
      (name, start_time, end_time, break_start, break_end)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *`,
      [name, start_time, end_time, break_start || null, break_end || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur création groupe horaire" });
  }
});

app.put("/attendance/settings/schedule-groups/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, start_time, end_time, break_start, break_end } = req.body;

    const result = await pool.query(
      `UPDATE schedule_groups
       SET name=$1,
           start_time=$2,
           end_time=$3,
           break_start=$4,
           break_end=$5
       WHERE id=$6
       RETURNING *`,
      [name, start_time, end_time, break_start || null, break_end || null, id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur modification groupe horaire" });
  }
});

app.put("/attendance/settings/users/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      schedule_group_id,
      salary_type,
      hourly_rate,
      daily_rate,
      monthly_salary
    } = req.body;

    const groupResult = await pool.query(
      "SELECT * FROM schedule_groups WHERE id=$1 LIMIT 1",
      [schedule_group_id || null]
    );

    const group = groupResult.rows[0] || null;

    await pool.query(
      `UPDATE users
       SET schedule_group_id=$1,
           payment_type=$2,
           hourly_rate=$3,
           daily_rate=$4
       WHERE id=$5`,
      [
        schedule_group_id || null,
        salary_type || "horaire",
        Number(hourly_rate || 0),
        Number(daily_rate || 0),
        id
      ]
    );

    const settingsResult = await pool.query(
      `INSERT INTO attendance_settings
       (
         user_id,
         schedule_group,
         salary_type,
         hourly_rate,
         daily_salary,
         monthly_salary,
         start_time,
         end_time
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id)
       DO UPDATE SET
         schedule_group=EXCLUDED.schedule_group,
         salary_type=EXCLUDED.salary_type,
         hourly_rate=EXCLUDED.hourly_rate,
         daily_salary=EXCLUDED.daily_salary,
         monthly_salary=EXCLUDED.monthly_salary,
         start_time=EXCLUDED.start_time,
         end_time=EXCLUDED.end_time
       RETURNING *`,
      [
        id,
        group?.name || "Standard",
        salary_type || "horaire",
        Number(hourly_rate || 0),
        Number(daily_rate || 0),
        Number(monthly_salary || 0),
        group?.start_time || "08:00",
        group?.end_time || "17:00"
      ]
    );

    const userResult = await pool.query(
      `SELECT
         u.id,
         u.fullname,
         u.email,
         u.role,
         u.schedule_group_id,
         s.schedule_group,
         s.salary_type,
         s.hourly_rate,
         s.daily_salary AS daily_rate,
         s.monthly_salary,
         s.start_time,
         s.end_time
       FROM users u
       LEFT JOIN attendance_settings s ON s.user_id = u.id
       WHERE u.id=$1`,
      [id]
    );

    res.json({
      ...userResult.rows[0],
      attendance_settings: settingsResult.rows[0]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur paramètres utilisateur pointage" });
  }
});

/* LISTE GROUPES HORAIRES */
app.get("/attendance/groups", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *
       FROM schedule_groups
       ORDER BY id ASC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur lecture groupes horaires"
    });
  }
});

/* AJOUT GROUPE HORAIRE */
app.post("/attendance/groups", async (req, res) => {
  try {
    const { name, start_time, end_time, break_start, break_end } = req.body;

    const result = await pool.query(
      `INSERT INTO schedule_groups
      (
        name,
        start_time,
        end_time,
        break_start,
        break_end
      )
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *`,
      [name, start_time, end_time, break_start, break_end]
    );

    await logActivity(
      "Administrateur",
      "pointage",
      "Ajout groupe horaire",
      "Pointage",
      `Nouveau groupe : ${name}`
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur ajout groupe horaire"
    });
  }
});

/* MODIFICATION GROUPE */
app.put("/attendance/groups/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { name, start_time, end_time, break_start, break_end } = req.body;

    const result = await pool.query(
      `UPDATE schedule_groups
       SET
         name=$1,
         start_time=$2,
         end_time=$3,
         break_start=$4,
         break_end=$5
       WHERE id=$6
       RETURNING *`,
      [name, start_time, end_time, break_start, break_end, id]
    );

    await logActivity(
      "Administrateur",
      "pointage",
      "Modification groupe horaire",
      "Pointage",
      `Modification groupe : ${name}`
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur modification groupe"
    });
  }
});

/* SUPPRESSION GROUPE */
app.delete("/attendance/groups/:id", async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM schedule_groups
       WHERE id=$1`,
      [req.params.id]
    );

    await logActivity(
      "Administrateur",
      "pointage",
      "Suppression groupe horaire",
      "Pointage",
      `Suppression groupe ID : ${req.params.id}`
    );

    res.json({
      message: "Groupe supprimé"
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur suppression groupe"
    });
  }
});

/* AFFECTATION HORAIRE EMPLOYÉ */
app.put("/attendance/assign-user/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { schedule_group_id, hourly_rate, daily_rate, payment_type } =
      req.body;

    const result = await pool.query(
      `UPDATE users
       SET
         schedule_group_id=$1,
         hourly_rate=$2,
         daily_rate=$3,
         payment_type=$4
       WHERE id=$5
       RETURNING *`,
      [
        schedule_group_id,
        hourly_rate || 0,
        daily_rate || 0,
        payment_type || "horaire",
        id
      ]
    );

    await logActivity(
      "Administrateur",
      "pointage",
      "Affectation horaire employé",
      "Pointage",
      `Employé ID ${id} affecté au groupe ${schedule_group_id}`
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur affectation employé"
    });
  }
});

/* ASSISTANT IA OPENROUTER */
app.post("/ai/chat", async (req, res) => {
  try {
    const { message, user } = req.body;

    if (!message || String(message).trim() === "") {
      return res.status(400).json({
        error: "Message obligatoire"
      });
    }

    if (!process.env.OPENROUTER_API_KEY) {
      return res.status(500).json({
        error: "Clé OpenRouter manquante dans .env"
      });
    }

    const aiResponse = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:3000",
          "X-Title": "Triangle WMS Pro"
        },
        body: JSON.stringify({
          model: "openrouter/auto",
          messages: [
            {
              role: "system",
              content:
                "Tu es l'assistant IA officiel de Triangle WMS Pro. Tu aides les utilisateurs en français simple et professionnel. Tu es spécialisé en logistique, gestion de stock, entreposage, transport, inventaire, documents logistiques, pointage, RH, tableaux de bord et organisation opérationnelle. Tu dois répondre clairement, étape par étape, sans inventer de données internes si elles ne sont pas fournies."
            },
            {
              role: "user",
              content: `Utilisateur connecté : ${user?.fullname || "Utilisateur"} | Rôle : ${user?.role || "non défini"}\n\nQuestion : ${message}`
            }
          ]
        })
      }
    );

    const data = await aiResponse.json();

    if (!aiResponse.ok) {
      return res.status(500).json({
        error: "Erreur OpenRouter",
        details: data
      });
    }

    const answer =
      data?.choices?.[0]?.message?.content ||
      "Je n'ai pas pu générer une réponse.";

    res.json({
      answer
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur assistant IA"
    });
  }
});

/* PAIEMENT MANUEL SAAS */
app.post("/payments/manual", async (req, res) => {
  try {
    const {
      company_id,
      subscription_id,
      amount,
      payment_method,
      payment_reference,
      notes
    } = req.body;

    const result = await pool.query(
      `INSERT INTO payments
      (
        company_id,
        subscription_id,
        amount,
        currency,
        payment_method,
        payment_reference,
        status,
        notes,
        paid_at
      )
      VALUES ($1,$2,$3,'FCFA',$4,$5,'paid',$6,CURRENT_TIMESTAMP)
      RETURNING *`,
      [
        company_id,
        subscription_id || null,
        Number(amount || 0),
        payment_method,
        payment_reference || "",
        notes || ""
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur enregistrement paiement manuel"
    });
  }
});

/* RENOUVELLEMENT ABONNEMENT */
app.post("/subscriptions/renew", async (req, res) => {
  try {
    const { subscription_id, months } = req.body;

    const subscriptionResult = await pool.query(
      `SELECT * FROM subscriptions
       WHERE id = $1`,
      [subscription_id]
    );

    if (subscriptionResult.rows.length === 0) {
      return res.status(404).json({
        error: "Abonnement introuvable"
      });
    }

    await pool.query(
      `UPDATE subscriptions
       SET
         status = 'active',
         end_date = COALESCE(end_date, CURRENT_DATE)
         + ($1 || ' month')::INTERVAL
       WHERE id = $2`,
      [Number(months || 1), subscription_id]
    );

    res.json({
      message: "Abonnement renouvelé avec succès"
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur renouvellement abonnement"
    });
  }
});

/* UPLOAD AUDIO CHAT */
app.post("/chat/upload-audio", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "Aucun fichier audio reçu"
      });
    }

    const audioUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

    res.json({
      message: "Audio uploadé avec succès",
      audio_url: audioUrl
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur upload audio"
    });
  }
});

/* SUPER ADMIN SAAS */
app.get("/super-admin/overview", async (req, res) => {
  try {
    const totalCompanies = await pool.query("SELECT COUNT(*) FROM companies");
    const activeCompanies = await pool.query(
      "SELECT COUNT(*) FROM companies WHERE status='active'"
    );
    const suspendedCompanies = await pool.query(
      "SELECT COUNT(*) FROM companies WHERE status='suspended'"
    );
    const totalPlans = await pool.query(
      "SELECT COUNT(*) FROM subscription_plans"
    );
    const activeSubscriptions = await pool.query(
      "SELECT COUNT(*) FROM subscriptions WHERE status='active'"
    );
    const trialSubscriptions = await pool.query(
      "SELECT COUNT(*) FROM subscriptions WHERE status='trial'"
    );
    const totalPayments = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status='paid'"
    );

    res.json({
      total_companies: Number(totalCompanies.rows[0].count),
      active_companies: Number(activeCompanies.rows[0].count),
      suspended_companies: Number(suspendedCompanies.rows[0].count),
      total_plans: Number(totalPlans.rows[0].count),
      active_subscriptions: Number(activeSubscriptions.rows[0].count),
      trial_subscriptions: Number(trialSubscriptions.rows[0].count),
      total_revenue: Number(totalPayments.rows[0].total)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur overview super admin" });
  }
});

app.get("/super-admin/companies", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        c.*,
        s.status AS subscription_status,
        s.end_date,
        sp.name AS plan_name,
        sp.price_monthly
       FROM companies c
       LEFT JOIN subscriptions s ON c.id = s.company_id
       LEFT JOIN subscription_plans sp ON s.plan_id = sp.id
       ORDER BY c.id DESC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur liste entreprises" });
  }
});

app.put("/super-admin/companies/:id/status", async (req, res) => {
  try {
    const { status } = req.body;

    const result = await pool.query(
      `UPDATE companies
       SET status=$1,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$2
       RETURNING *`,
      [status, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur changement statut entreprise" });
  }
});

app.put("/super-admin/subscriptions/:companyId/renew", async (req, res) => {
  try {
    const { months, payment_mode } = req.body;

    const result = await pool.query(
      `UPDATE subscriptions
       SET status='active',
           start_date=CURRENT_DATE,
           end_date=CURRENT_DATE + ($1 || ' months')::interval,
           payment_mode=$2,
           is_payment_required=true
       WHERE company_id=$3
       RETURNING *`,
      [Number(months || 1), payment_mode || "manual", req.params.companyId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur renouvellement abonnement" });
  }
});

app.put("/super-admin/subscriptions/:companyId/free", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE subscriptions
       SET status='free',
           payment_mode='free',
           is_payment_required=false,
           end_date=NULL
       WHERE company_id=$1
       RETURNING *`,
      [req.params.companyId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur accès gratuit" });
  }
});

app.get("/super-admin/plans", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM subscription_plans ORDER BY id ASC"
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur plans SaaS" });
  }
});

/* PARTENAIRES SAAS : CLIENTS / FOURNISSEURS */
app.get("/partners", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    let query = `SELECT * FROM partners`;
    const values = [];

    if (!isSuperAdmin) {
      query += ` WHERE company_id = $1`;
      values.push(companyId);
    }

    query += ` ORDER BY id DESC`;

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture partenaires" });
  }
});

app.post("/partners", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;

    const {
      type,
      name,
      phone,
      email,
      address,
      city,
      country,
      contact_person,
      nif,
      rccm,
      notes,
      status
    } = req.body;

    const result = await pool.query(
      `INSERT INTO partners
      (
        company_id, type, name, phone, email, address, city, country,
        contact_person, nif, rccm, notes, status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *`,
      [
        companyId,
        type,
        name,
        phone || "",
        email || "",
        address || "",
        city || "",
        country || "",
        contact_person || "",
        nif || "",
        rccm || "",
        notes || "",
        status || "active"
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur ajout partenaire" });
  }
});

app.put("/partners/:id", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    const {
      type,
      name,
      phone,
      email,
      address,
      city,
      country,
      contact_person,
      nif,
      rccm,
      notes,
      status
    } = req.body;

    let query = `
      UPDATE partners
      SET type=$1, name=$2, phone=$3, email=$4, address=$5,
          city=$6, country=$7, contact_person=$8, nif=$9,
          rccm=$10, notes=$11, status=$12
      WHERE id=$13
    `;

    const values = [
      type,
      name,
      phone || "",
      email || "",
      address || "",
      city || "",
      country || "",
      contact_person || "",
      nif || "",
      rccm || "",
      notes || "",
      status || "active",
      req.params.id
    ];

    if (!isSuperAdmin) {
      query += ` AND company_id=$14`;
      values.push(companyId);
    }

    query += ` RETURNING *`;

    const result = await pool.query(query, values);

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur modification partenaire" });
  }
});

app.delete("/partners/:id", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    let query = `DELETE FROM partners WHERE id=$1`;
    const values = [req.params.id];

    if (!isSuperAdmin) {
      query += ` AND company_id=$2`;
      values.push(companyId);
    }

    query += ` RETURNING *`;

    const result = await pool.query(query, values);

    res.json({
      message: "Partenaire supprimé",
      partner: result.rows[0]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur suppression partenaire" });
  }
});

/* PLANS PUBLICS POUR INSCRIPTION */
app.get("/public/plans", async (req, res) => {
  try {
    await ensureDefaultSubscriptionPlans();

    const result = await pool.query(`
      SELECT
        id,
        name,
        price_monthly,
        max_users,
        max_warehouses,
        max_products,
        max_movements_monthly,
        trial_days,
        modules,
        can_use_reports,
        can_use_qr,
        can_use_advanced_inventory,
        can_use_documents,
        can_use_chat,
        can_use_ai
      FROM subscription_plans
      WHERE name IN ('Starter', 'Standard', 'Premium')
      ORDER BY price_monthly ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR PLANS PUBLICS :", error);
    res.status(500).json({ error: "Erreur récupération plans" });
  }
});

/* CREER PAIEMENT ABONNEMENT - VERSION PREPAREE */
app.post(
  "/payments/create-subscription-payment",
  authenticateToken,
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const { plan_id, payment_method } = req.body;

      const planResult = await pool.query(
        `SELECT * FROM subscription_plans WHERE id = $1`,
        [plan_id]
      );

      if (planResult.rows.length === 0) {
        return res.status(404).json({ error: "Plan introuvable" });
      }

      const plan = planResult.rows[0];

      const reference = `TRIANGLE-${companyId}-${Date.now()}`;

      await pool.query(
        `INSERT INTO subscriptions
       (company_id, plan_id, payment_provider, payment_status, payment_reference)
       VALUES ($1,$2,$3,$4,$5)`,
        [companyId, plan.id, payment_method || "manual", "pending", reference]
      );

      res.json({
        success: true,
        message: "Paiement préparé",
        provider: payment_method,
        reference,
        amount: plan.price_monthly,
        currency: "XOF",
        checkout_url: null
      });
    } catch (error) {
      console.error("ERREUR CREATION PAIEMENT :", error);
      res.status(500).json({ error: "Erreur création paiement" });
    }
  }
);

/* GESTION PLANS SAAS */
app.put("/super-admin/plans/:id", async (req, res) => {
  try {
    const {
      name,
      price_monthly,
      max_users,
      max_warehouses,
      max_products,
      max_movements_monthly,
      trial_days,
      modules,
      can_use_reports,
      can_use_qr,
      can_use_advanced_inventory,
      can_use_documents,
      can_use_chat,
      can_use_ai
    } = req.body;

    const result = await pool.query(
      `UPDATE subscription_plans
       SET
        name=$1,
        price_monthly=$2,
        max_users=$3,
        max_warehouses=$4,
        max_products=$5,
        max_movements_monthly=$6,
        trial_days=$7,
        modules=$8,
        can_use_reports=$9,
        can_use_qr=$10,
        can_use_advanced_inventory=$11,
        can_use_documents=$12,
        can_use_chat=$13,
        can_use_ai=$14
       WHERE id=$15
       RETURNING *`,
      [
        name,
        Number(price_monthly || 0),
        Number(max_users || 0),
        Number(max_warehouses || 0),
        Number(max_products || 0),
        Number(max_movements_monthly || 0),
        Number(trial_days || 15),
        modules || "",
        can_use_reports === true,
        can_use_qr === true,
        can_use_advanced_inventory === true,
        can_use_documents === true,
        can_use_chat === true,
        can_use_ai === true,
        req.params.id
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur modification plan SaaS"
    });
  }
});

/* SUPER ADMIN - GESTION UTILISATEURS */
app.get("/super-admin/users", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id,
        u.fullname,
        u.email,
        u.phone,
        u.role,
        u.is_active,
        u.is_super_admin,
        u.company_id,
        c.name AS company_name,
        u.created_at
      FROM users u
      LEFT JOIN companies c ON u.company_id = c.id
      ORDER BY u.id DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture utilisateurs super admin" });
  }
});

app.put("/super-admin/users/:id", async (req, res) => {
  try {
    const { fullname, email, phone, role, is_active, is_super_admin } =
      req.body;

    const result = await pool.query(
      `UPDATE users
       SET fullname=$1,
           email=$2,
           phone=$3,
           role=$4,
           is_active=$5,
           is_super_admin=$6
       WHERE id=$7
       RETURNING id, fullname, email, phone, role, is_active, is_super_admin`,
      [
        fullname,
        email,
        phone || "",
        role || "magasinier",
        is_active !== false,
        is_super_admin === true,
        req.params.id
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur modification utilisateur" });
  }
});

app.put("/super-admin/users/:id/password", async (req, res) => {
  try {
    const { password } = req.body;

    const result = await pool.query(
      `UPDATE users
       SET password=$1
       WHERE id=$2
       RETURNING id, fullname, email`,
      [password, req.params.id]
    );

    res.json({
      message: "Mot de passe modifié",
      user: result.rows[0]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur changement mot de passe" });
  }
});

/* DASHBOARD STATS */
app.get("/dashboard-stats", async (req, res) => {
  try {
    const totalProduits = await pool.query("SELECT COUNT(*) FROM products");
    const totalEntrepots = await pool.query("SELECT COUNT(*) FROM warehouses");
    const totalEmplacements = await pool.query(
      "SELECT COUNT(*) FROM locations"
    );
    const totalUsers = await pool.query("SELECT COUNT(*) FROM users");
    const totalInventaires = await pool.query(
      "SELECT COUNT(*) FROM inventory_history"
    );

    const mouvementsAttente = await pool.query(
      "SELECT COUNT(*) FROM stock_movements WHERE status='En attente'"
    );

    const stockFaible = await pool.query(
      "SELECT COUNT(*) FROM products WHERE stock > 0 AND stock <= minimum_stock"
    );

    const ruptureStock = await pool.query(
      "SELECT COUNT(*) FROM products WHERE stock <= 0"
    );

    const activitesRecentes = await pool.query(
      "SELECT * FROM user_activities ORDER BY id DESC LIMIT 5"
    );

    const derniersMouvements = await pool.query(
      "SELECT * FROM stock_movements ORDER BY id DESC LIMIT 5"
    );

    res.json({
      total_produits: Number(totalProduits.rows[0].count),
      total_entrepots: Number(totalEntrepots.rows[0].count),
      total_emplacements: Number(totalEmplacements.rows[0].count),
      total_utilisateurs: Number(totalUsers.rows[0].count),
      total_inventaires: Number(totalInventaires.rows[0].count),
      mouvements_attente: Number(mouvementsAttente.rows[0].count),
      alertes:
        Number(stockFaible.rows[0].count) + Number(ruptureStock.rows[0].count),
      stock_faible: Number(stockFaible.rows[0].count),
      rupture_stock: Number(ruptureStock.rows[0].count),
      activites_recentes: activitesRecentes.rows,
      derniers_mouvements: derniersMouvements.rows
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur dashboard stats" });
  }
});

/* ATTENDANCE TODAY - AFFICHAGE CORRIGÉ */
app.get("/attendance/today", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        u.id AS user_id,
        u.fullname,
        u.role,
        u.badge_code,

        s.schedule_group,
        s.salary_type,
        s.hourly_rate,
        s.daily_salary AS setting_daily_salary,
        s.monthly_salary,
        s.start_time,
        s.end_time,

        ar.id AS attendance_id,
        ar.work_date,
        ar.check_in,
        ar.break_out,
        ar.break_in,
        ar.check_out

      FROM users u

      LEFT JOIN attendance_settings s
      ON s.user_id = u.id

      LEFT JOIN attendance_records ar
      ON ar.user_id = u.id
      AND ar.work_date = CURRENT_DATE

      ORDER BY u.fullname ASC
    `);

    const records = result.rows.map((r) => {
      let computedStatus = "Absent";

      let late_minutes = 0;

      let worked_hours = 0;

      let calculated_salary = 0;

      if (r.check_in && !r.break_out && !r.check_out) {
        computedStatus = "Présent";
      }

      if (r.break_out && !r.break_in && !r.check_out) {
        computedStatus = "En pause";
      }

      if (r.check_out) {
        computedStatus = "Terminé";
      }

      if (r.check_in) {
        const check = new Date(r.check_in);

        const normal = new Date(r.check_in);

        const [h, m] = String(r.start_time || "08:00").split(":");

        normal.setHours(Number(h), Number(m), 0, 0);

        if (check > normal) {
          late_minutes = Math.round((check - normal) / 1000 / 60);
        }
      }

      if (r.check_in && r.check_out) {
        const start = new Date(r.check_in).getTime();

        const end = new Date(r.check_out).getTime();

        worked_hours = (end - start) / 1000 / 60 / 60;
      }

      if (r.salary_type === "horaire") {
        calculated_salary = Math.round(
          worked_hours * Number(r.hourly_rate || 0)
        );
      }

      if (r.salary_type === "journalier" && r.check_in) {
        calculated_salary = Number(r.setting_daily_salary || 0);
      }

      if (r.salary_type === "mensuel" && r.check_in) {
        calculated_salary = Math.round(Number(r.monthly_salary || 0) / 26);
      }

      return {
        ...r,

        status: computedStatus,

        id: r.attendance_id || r.user_id,

        late_minutes,

        worked_hours: worked_hours.toFixed(2),

        calculated_salary
      };
    });

    res.json(records);
  } catch (error) {
    console.error("ERREUR ATTENDANCE TODAY :", error);

    res.status(500).json({
      error: "Erreur récupération pointage"
    });
  }
});

/* DELETE COMPANY */
app.delete("/super-admin/companies/:id", async (req, res) => {
  try {
    const companyId = req.params.id;

    await pool.query(
      `
        DELETE FROM attendance_records
        WHERE user_id IN (
          SELECT id
          FROM users
          WHERE company_id = $1
        )
        `,
      [companyId]
    );

    await pool.query(
      `
        DELETE FROM users
        WHERE company_id = $1
        `,
      [companyId]
    );

    await pool.query(
      `
        DELETE FROM subscriptions
        WHERE company_id = $1
        `,
      [companyId]
    );

    await pool.query(
      `
        DELETE FROM companies
        WHERE id = $1
        `,
      [companyId]
    );

    res.json({
      success: true,
      message: "Entreprise supprimée"
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur suppression entreprise"
    });
  }
});

/* DELETE USER */
app.delete("/super-admin/users/:id", async (req, res) => {
  try {
    const userId = req.params.id;

    await pool.query(
      `
        DELETE FROM attendance_records
        WHERE user_id = $1
        `,
      [userId]
    );

    await pool.query(
      `
        DELETE FROM users
        WHERE id = $1
        `,
      [userId]
    );

    res.json({
      success: true,
      message: "Utilisateur supprimé"
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur suppression utilisateur"
    });
  }
});

/* DELETE PLAN */
app.delete("/super-admin/plans/:id", async (req, res) => {
  try {
    await pool.query(
      `
        DELETE FROM subscription_plans
        WHERE id = $1
        `,
      [req.params.id]
    );

    res.json({
      success: true,
      message: "Plan supprimé"
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur suppression plan"
    });
  }
});

/* SUPER ADMIN - GET COMPANIES */
app.get("/super-admin/companies", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM companies
      ORDER BY id DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur récupération entreprises"
    });
  }
});

/* SUPER ADMIN - GET USERS */
app.get("/super-admin/users", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM users
      ORDER BY id DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur récupération utilisateurs"
    });
  }
});

/* SUPER ADMIN - GET PLANS */
app.get("/super-admin/plans", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM subscription_plans
      ORDER BY id DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur récupération plans"
    });
  }
});

/* SUPER ADMIN - CREATE PLAN */
app.post("/super-admin/plans", async (req, res) => {
  try {
    const {
      name,
      price_monthly,
      max_users,
      max_warehouses,
      max_products,
      trial_days
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO subscription_plans
      (
        name,
        price_monthly,
        max_users,
        max_warehouses,
        max_products,
        trial_days
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
      `,
      [name, price_monthly, max_users, max_warehouses, max_products, trial_days]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur création plan"
    });
  }
});

/* SUPER ADMIN - UPDATE PLAN */
app.put("/super-admin/plans/:id", async (req, res) => {
  try {
    const {
      name,
      price_monthly,
      max_users,
      max_warehouses,
      max_products,
      max_movements_monthly,
      trial_days,
      modules,
      can_use_reports,
      can_use_qr,
      can_use_advanced_inventory,
      can_use_documents,
      can_use_chat,
      can_use_ai
    } = req.body;

    const result = await pool.query(
      `
      UPDATE subscription_plans
      SET
        name = $1,
        price_monthly = $2,
        max_users = $3,
        max_warehouses = $4,
        max_products = $5,
        max_movements_monthly = $6,
        trial_days = $7,
        modules = $8,
        can_use_reports = $9,
        can_use_qr = $10,
        can_use_advanced_inventory = $11,
        can_use_documents = $12,
        can_use_chat = $13,
        can_use_ai = $14
      WHERE id = $15
      RETURNING *
      `,
      [
        name,
        Number(price_monthly || 0),
        Number(max_users || 0),
        Number(max_warehouses || 0),
        Number(max_products || 0),
        Number(max_movements_monthly || 0),
        Number(trial_days || 15),
        modules || "",
        can_use_reports === true,
        can_use_qr === true,
        can_use_advanced_inventory === true,
        can_use_documents === true,
        can_use_chat === true,
        can_use_ai === true,
        req.params.id
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR MODIFICATION PLAN :", error);
    res.status(500).json({
      error: "Erreur modification plan"
    });
  }
});

/* SUPER ADMIN - UPDATE COMPANY STATUS */
app.put("/super-admin/companies/:id/status", async (req, res) => {
  try {
    const companyId = req.params.id;

    const { status } = req.body;

    const result = await pool.query(
      `
        UPDATE companies
        SET subscription_status = $1
        WHERE id = $2
        RETURNING *
        `,
      [status, companyId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur changement statut"
    });
  }
});

/* SUPER ADMIN - FREE ACCESS */
app.put("/super-admin/subscriptions/:companyId/free", async (req, res) => {
  try {
    const companyId = req.params.companyId;

    await pool.query(
      `
        UPDATE companies
        SET
          subscription_status = 'active',
          trial_ends_at = NOW() + interval '30 days'
        WHERE id = $1
        `,
      [companyId]
    );

    res.json({
      success: true,
      message: "Accès gratuit accordé"
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur accès gratuit"
    });
  }
});

/* SUPER ADMIN - RENEW SUBSCRIPTION */
app.put("/super-admin/subscriptions/:companyId/renew", async (req, res) => {
  try {
    const companyId = req.params.companyId;

    const months = Number(req.body.months || 1);

    await pool.query(
      `
        UPDATE companies
        SET
          subscription_status = 'active',
          trial_ends_at =
            COALESCE(
              trial_ends_at,
              NOW()
            ) + ($1 || ' month')::interval
        WHERE id = $2
        `,
      [months, companyId]
    );

    res.json({
      success: true,
      message: "Abonnement renouvelé"
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur renouvellement"
    });
  }
});

/* CINETPAY PAYMENT */

const axios = require("axios");

app.post("/payments/create", async (req, res) => {
  try {
    const {
      company_id,
      plan_id,
      amount,
      customer_name,
      customer_email,
      customer_phone
    } = req.body;

    const transaction_id = "TRX-" + Date.now();

    const response = await axios.post(
      "https://api-checkout.cinetpay.com/v2/payment",
      {
        apikey: process.env.CINETPAY_API_KEY,

        site_id: process.env.CINETPAY_SITE_ID,

        transaction_id,

        amount,

        currency: "XOF",

        description: "Abonnement Triangle WMS Pro",

        customer_name,

        customer_email,

        customer_phone_number: customer_phone,

        notify_url: "http://localhost:5050/payments/notify",

        return_url: "http://localhost:3000/payment-success",

        channels: "ALL"
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error("PAYMENT ERROR :", error.response?.data || error);

    res.status(500).json({
      error: "Erreur paiement"
    });
  }
});

/* ATTENDANCE QR SCAN */
app.post("/attendance/scan", async (req, res) => {
  try {
    const { badge_code, action_type } = req.body;

    if (!badge_code) {
      return res.status(400).json({
        error: "Badge QR manquant"
      });
    }

    const userResult = await pool.query(
      `
      SELECT *
      FROM users
      WHERE badge_code = $1
      LIMIT 1
      `,
      [badge_code]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        error: "Employé introuvable"
      });
    }

    const user = userResult.rows[0];

    await pool.query(
      `
      INSERT INTO attendance_settings
      (
        user_id,
        schedule_group,
        salary_type,
        hourly_rate,
        daily_salary,
        monthly_salary,
        start_time,
        end_time
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (user_id)
      DO NOTHING
      `,
      [user.id, "Standard", "horaire", 1000, 8000, 200000, "08:00", "17:00"]
    );

    const existing = await pool.query(
      `
        SELECT *
        FROM attendance_records
        WHERE user_id = $1
        AND work_date = CURRENT_DATE
        LIMIT 1
        `,
      [user.id]
    );

    let result;
    let action = "";

    if (action_type === "checkin") {
      if (existing.rows.length === 0) {
        result = await pool.query(
          `
          INSERT INTO attendance_records
          (
            user_id,
            work_date,
            check_in,
            status
          )
          VALUES
          (
            $1,
            CURRENT_DATE,
            NOW(),
            'Présent'
          )
          RETURNING *
          `,
          [user.id]
        );
      } else {
        result = await pool.query(
          `
          UPDATE attendance_records
          SET status = CASE
              WHEN check_out IS NOT NULL THEN 'Terminé'
              WHEN break_out IS NOT NULL AND break_in IS NULL THEN 'En pause'
              ELSE 'Présent'
            END,
            updated_at = CURRENT_TIMESTAMP
          WHERE user_id = $1
          AND work_date = CURRENT_DATE
          RETURNING *
          `,
          [user.id]
        );
      }

      action = "Début travail";
    } else if (action_type === "pause_start") {
      if (existing.rows.length === 0 || !existing.rows[0].check_in) {
        return res.status(400).json({ error: "Début travail non pointé" });
      }

      if (existing.rows[0].break_out) {
        return res.status(400).json({ error: "Début pause déjà pointé" });
      }

      result = await pool.query(
        `
        UPDATE attendance_records
        SET break_out = NOW(),
            status = 'En pause',
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1
        AND work_date = CURRENT_DATE
        RETURNING *
        `,
        [user.id]
      );

      action = "Début pause";
    } else if (action_type === "pause_end") {
      if (existing.rows.length === 0 || !existing.rows[0].break_out) {
        return res.status(400).json({ error: "Début pause non pointé" });
      }

      if (existing.rows[0].break_in) {
        return res.status(400).json({ error: "Fin pause déjà pointée" });
      }

      result = await pool.query(
        `
        UPDATE attendance_records
        SET break_in = NOW(),
            status = 'Présent',
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1
        AND work_date = CURRENT_DATE
        RETURNING *
        `,
        [user.id]
      );

      action = "Fin pause";
    } else if (action_type === "checkout") {
      if (existing.rows.length === 0 || !existing.rows[0].check_in) {
        return res.status(400).json({ error: "Début travail non pointé" });
      }

      if (existing.rows[0].check_out) {
        return res.status(400).json({ error: "Fin travail déjà pointée" });
      }

      result = await pool.query(
        `
        UPDATE attendance_records
        SET check_out = NOW(),
            status = 'Terminé',
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = $1
        AND work_date = CURRENT_DATE
        RETURNING *
        `,
        [user.id]
      );

      action = "Fin travail";
    } else {
      return res.status(400).json({
        error: "Action invalide"
      });
    }

    res.json({
      success: true,
      user,
      attendance: result.rows[0],
      action
    });
  } catch (error) {
    console.error("ERREUR ATTENDANCE SCAN :", error);

    res.status(500).json({
      error: "Erreur scan QR"
    });
  }
});
app.listen(5050, () => {
  console.log("Backend sécurisé démarré sur le port 5050");
});

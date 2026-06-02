const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const QRCode = require("qrcode");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
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

const productUploadDir = path.join(__dirname, "uploads", "products");

if (!fs.existsSync(productUploadDir)) {
  fs.mkdirSync(productUploadDir, { recursive: true });
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

const productImageStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, productUploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const baseName = path
      .basename(file.originalname || "product", ext)
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-_]/g, "");
    cb(null, `${Date.now()}-${baseName || "product"}${ext}`);
  }
});

const uploadProductImage = multer({
  storage: productImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const allowed = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
    if (!allowed.has(file.mimetype)) {
      return cb(new Error("Format image non autorisé. Utilisez jpg, jpeg, png ou webp."));
    }

    cb(null, true);
  }
});

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
const SUPER_ADMIN_EMAILS = new Set([
  "diallogcif@gmail.com"
]);

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

function canValidateStockMovement(user) {
  const role = normalizeRole(user?.role);
  return (
    user?.is_super_admin === true ||
    role === "admin" ||
    role === "super_admin" ||
    role === "chef_entrepot" ||
    role === "chef d'entrepôt" ||
    role === "chef d'entrepot"
  );
}

function isReadOnlyRole(user) {
  const role = normalizeRole(user?.role);
  return role === "direction" || role === "client";
}

function canViewAllSalaries(user) {
  const role = normalizeRole(user?.role);
  return user?.is_super_admin === true || role === "super_admin" || role === "direction";
}

function canCreateMeeting(user) {
  const role = normalizeRole(user?.role);
  return (
    user?.is_super_admin === true ||
    role === "super_admin" ||
    role === "admin" ||
    role === "responsable_entrepot" ||
    role === "chef_entrepot" ||
    role === "direction"
  );
}

function canUsePos(user) {
  const role = normalizeRole(user?.role);
  return (
    user?.is_super_admin === true ||
    role === "super_admin" ||
    role === "admin" ||
    role === "caissier" ||
    role === "vendeur"
  );
}

function canAdjustPosPrice(user) {
  const role = normalizeRole(user?.role);
  return user?.is_super_admin === true || role === "super_admin" || role === "admin";
}

function getEffectivePosPrice(product) {
  const candidates = [
    product.sale_price,
    product.pharmacy_price,
    product.wholesale_price,
    product.price
  ];

  for (const candidate of candidates) {
    const value = Number(candidate || 0);
    if (value > 0) return value;
  }

  return 0;
}

function normalizeProductLookupCode(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\/[^/]+\/scan\/product\//i, "")
    .replace(/^Ref\s*[-_]*\s*/i, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
}

function optionalNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function paymentCryptoKey() {
  return crypto
    .createHash("sha256")
    .update(process.env.PAYMENT_SETTINGS_SECRET || process.env.JWT_SECRET || "triangle-wms-payment-secret")
    .digest();
}

function encryptPaymentSecret(value) {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", paymentCryptoKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decryptPaymentSecret(value) {
  if (!value || !String(value).includes(":")) return "";
  try {
    const [ivHex, tagHex, encryptedHex] = String(value).split(":");
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      paymentCryptoKey(),
      Buffer.from(ivHex, "hex")
    );
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedHex, "hex")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    return "";
  }
}

function maskSecret(value) {
  if (!value) return "";
  return "••••••••";
}

function isExternalPaymentMethod(method) {
  return ["Carte bancaire", "Orange Money", "Moov Money", "Wave", "Virement"].includes(String(method || ""));
}

function providerKeyFromMethod(method) {
  const normalized = String(method || "").toLowerCase();
  if (normalized.includes("carte")) return "card";
  if (normalized.includes("orange")) return "orange_money";
  if (normalized.includes("moov")) return "moov_money";
  if (normalized.includes("wave")) return "wave";
  if (normalized.includes("virement")) return "bank_transfer";
  if (normalized.includes("chèque") || normalized.includes("cheque")) return "check";
  if (normalized.includes("mixte")) return "mixed";
  if (normalized.includes("crédit") || normalized.includes("credit")) return "customer_credit";
  return "cash";
}

function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (Number(value) * Math.PI) / 180;
  const earthRadiusMeters = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMeters * c;
}

function productQrUrl(req, product) {
  const forwardedProto = req.get("x-forwarded-proto") || req.protocol;
  const host = req.get("host");
  const baseUrl =
    process.env.FRONTEND_PUBLIC_URL ||
    process.env.NEXT_PUBLIC_FRONTEND_URL ||
    process.env.PUBLIC_BASE_URL ||
    `${host?.includes("trianglewmspro.com") ? "https" : forwardedProto}://${host}`;
  const code = encodeURIComponent(product.reference || product.barcode || product.id);
  return `${baseUrl.replace(/\/$/, "")}/scan/product/${code}`;
}

function stripSalaryFields(row, requester) {
  const canSeeSalary =
    canViewAllSalaries(requester) || Number(row.id || row.user_id) === Number(requester?.id);

  if (canSeeSalary) return row;

  const sanitized = { ...row };
  delete sanitized.hourly_rate;
  delete sanitized.daily_rate;
  delete sanitized.daily_salary;
  delete sanitized.setting_daily_salary;
  delete sanitized.monthly_salary;
  delete sanitized.salary;
  delete sanitized.salary_amount;
  delete sanitized.calculated_salary;
  sanitized.salary_type = sanitized.salary_type ? "masqué" : sanitized.salary_type;
  return sanitized;
}

function publicUploadUrl(req, filename) {
  const forwardedProto = req.get("x-forwarded-proto") || req.protocol;
  const host = req.get("host");
  const baseUrl =
    process.env.PUBLIC_BASE_URL ||
    `${host?.includes("trianglewmspro.com") ? "https" : forwardedProto}://${host}`;

  return `${baseUrl.replace(/\/$/, "")}/api/uploads/${filename}`;
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

async function createNotification({
  user_id,
  title,
  message,
  type,
  company_id,
  status = "unread",
  priority = "normal",
  related_entity_type = "",
  related_entity_id = null,
  action_url = "",
  created_by = null,
  assigned_to = null,
  warehouse_id = null
}) {
  await pool.query(
    `INSERT INTO notifications
     (user_id, title, message, type, company_id, status, priority,
      related_entity_type, related_entity_id, action_url, created_by,
      assigned_to, warehouse_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      user_id,
      title,
      message,
      type,
      company_id,
      status,
      priority,
      related_entity_type,
      related_entity_id,
      action_url,
      created_by,
      assigned_to,
      warehouse_id
    ]
  );
}

async function ensureDefaultSubscriptionPlans() {
  const defaultPlans = [
    {
      name: "Essentiel",
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
       SELECT
         $1::varchar,
         $2::numeric,
         $3::integer,
         $4::integer,
         $5::integer,
         $6::integer,
         $7::integer,
         $8::text,
         true,
         true,
         true,
         true,
         true,
         true
       WHERE NOT EXISTS (
         SELECT 1 FROM subscription_plans WHERE name=$1::varchar
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

    const logoUrl = publicUploadUrl(req, req.file.filename);

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

    const photoUrl = publicUploadUrl(req, req.file.filename);

    res.json({
      message: "Photo utilisateur uploadée avec succès",
      profile_image_url: photoUrl
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur upload photo utilisateur" });
  }
});

app.post(
  "/upload-product-image",
  authenticateToken,
  uploadProductImage.single("image"),
  async (req, res) => {
    try {
      if (isReadOnlyRole(req.user)) {
        return res.status(403).json({ error: "Accès lecture seule." });
      }

      if (!req.file) {
        return res.status(400).json({ error: "Aucune image reçue" });
      }

      const imageUrl = publicUploadUrl(req, `products/${req.file.filename}`);

      res.status(201).json({
        message: "Image produit uploadée avec succès",
        image_url: imageUrl
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: error.message || "Erreur upload image produit" });
    }
  }
);

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

app.put(
  "/company-settings",
  authenticateToken,
  authorizeRoles("admin", "super_admin"),
  async (req, res) => {
  try {
    if (isReadOnlyRole(req.user)) {
      return res.status(403).json({ error: "Vous avez un accès lecture seule." });
    }

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
    const normalizedEmail = String(email || "").trim().toLowerCase();

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

    const isSuperAdmin =
      user.is_super_admin === true ||
      user.is_super_admin === "true" ||
      user.is_super_admin === 1 ||
      String(user.role || "").toLowerCase() === "super_admin" ||
      SUPER_ADMIN_EMAILS.has(normalizedEmail) ||
      SUPER_ADMIN_EMAILS.has(String(user.email || "").trim().toLowerCase());

    if (!isSuperAdmin) {
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
        is_super_admin: isSuperAdmin
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
        role: isSuperAdmin ? "super_admin" : user.role,
        company_id: user.company_id,
        company_name: user.company_name || "",
        company_status: user.company_status || "",
        is_super_admin: isSuperAdmin,
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

    res.json(result.rows.map((row) => stripSalaryFields(row, req.user)));
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

app.put(
  "/users/:id",
  authenticateToken,
  authorizeRoles("admin", "super_admin"),
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const isSuperAdmin = req.user.is_super_admin === true;
      const { id } = req.params;
      const { fullname, email, password, role, phone, is_active } = req.body;

      const values = [
        fullname,
        email,
        role || "magasinier",
        phone || "",
        is_active !== false,
      ];

      let query = `
        UPDATE users
        SET fullname=$1,
            email=$2,
            role=$3,
            phone=$4,
            is_active=$5
      `;

      if (password && String(password).trim() !== "") {
        values.push(password);
        query += `, password=$${values.length}`;
      }

      values.push(id);
      query += ` WHERE id=$${values.length}`;

      if (!isSuperAdmin) {
        values.push(companyId);
        query += ` AND company_id=$${values.length}`;
      }

      query += ` RETURNING id, fullname, email, role, phone, is_active, badge_code, profile_image_url, company_id`;

      const result = await pool.query(query, values);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Utilisateur introuvable" });
      }

      res.json(result.rows[0]);
    } catch (error) {
      console.error("ERREUR UPDATE USER :", error);
      res.status(500).json({
        error: error.message || "Erreur modification utilisateur"
      });
    }
  }
);

app.delete(
  "/users/:id",
  authenticateToken,
  authorizeRoles("admin", "super_admin"),
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const isSuperAdmin = req.user.is_super_admin === true;
      const { id } = req.params;

      if (Number(req.user.id) === Number(id)) {
        return res.status(400).json({
          error: "Vous ne pouvez pas supprimer votre propre compte."
        });
      }

      const values = [id];
      let filter = "WHERE id=$1";

      if (!isSuperAdmin) {
        values.push(companyId);
        filter += " AND company_id=$2";
      }

      await pool.query(
        `DELETE FROM attendance_settings WHERE user_id=$1`,
        [id]
      );
      await pool.query(
        `DELETE FROM attendance_records WHERE user_id=$1`,
        [id]
      );
      await pool.query(
        `DELETE FROM attendance_history WHERE user_id=$1`,
        [id]
      );

      const result = await pool.query(
        `DELETE FROM users ${filter} RETURNING id, fullname, email`,
        values
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Utilisateur introuvable" });
      }

      res.json({
        message: "Utilisateur supprimé",
        user: result.rows[0]
      });
    } catch (error) {
      console.error("ERREUR DELETE USER :", error);
      res.status(500).json({
        error: error.message || "Erreur suppression utilisateur"
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
    if (isReadOnlyRole(req.user)) {
      return res.status(403).json({ error: "Accès lecture seule." });
    }

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

app.put(
  "/products/:id",
  authenticateToken,
  authorizeRoles("admin", "super_admin"),
  async (req, res) => {
  try {
    if (isReadOnlyRole(req.user)) {
      return res.status(403).json({ error: "Accès lecture seule." });
    }

    const { id } = req.params;
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

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

    const values = [
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
    ];

    let query = `
      UPDATE products
      SET reference=$1, name=$2, category=$3, stock=$4, warehouse=$5,
          status=$6, unit=$7, weight=$8, dimensions=$9, barcode=$10,
          description=$11, is_active=$12, location_id=$13, location_code=$14,
          minimum_stock=$15, image_url=$16
      WHERE id=$17
    `;

    if (!isSuperAdmin) {
      values.push(companyId);
      query += ` AND company_id=$${values.length}`;
    }

    query += ` RETURNING *`;

    const result = await pool.query(
      query,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Produit introuvable" });
    }

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

app.delete(
  "/products/:id",
  authenticateToken,
  authorizeRoles("admin", "super_admin"),
  async (req, res) => {
  try {
    if (isReadOnlyRole(req.user)) {
      return res.status(403).json({ error: "Accès lecture seule." });
    }

    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;
    const values = [req.params.id];
    let query = "DELETE FROM products WHERE id=$1";

    if (!isSuperAdmin) {
      values.push(companyId);
      query += " AND company_id=$2";
    }

    query += " RETURNING id";

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Produit introuvable" });
    }

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
    if (isReadOnlyRole(req.user)) {
      return res.status(403).json({ error: "Accès lecture seule." });
    }

    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    const {
      type,
      product_reference,
      product_name,
      quantity,
      source_warehouse,
      destination_warehouse,
      location_code,
      warehouse_id,
      location_id,
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
       destination_warehouse, reason, status, company_id, created_by,
       created_by_name, created_by_role, location_code, warehouse_id,
       approval_status, original_quantity, final_quantity, product_id, location_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
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
        user_role || req.user.role || "Non défini",
        location_code || product.location_code || "",
        warehouse_id || null,
        "En attente",
        Number(quantity),
        Number(quantity),
        product.id,
        location_id || product.location_id || null
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
        await createNotification({
          user_id: admin.id,
          title: "Mouvement stock à valider",
          message: `${
            req.user.email || "Un utilisateur"
          } a créé une demande ${type} pour ${product_reference}.`,
          type:
            type === "Transfert"
              ? "transfer_pending"
              : type === "Inventaire"
              ? "inventory_adjustment_pending"
              : "stock_movement_pending",
          company_id: companyId,
          priority: "high",
          related_entity_type: "stock_movement",
          related_entity_id: result.rows[0].id,
          action_url: `/stocks?movement=${result.rows[0].id}`,
          created_by: req.user.id,
          assigned_to: admin.id,
          warehouse_id: warehouse_id || null
        });
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
      if (!canValidateStockMovement(req.user)) {
        return res.status(403).json({
          error: "Accès refusé : vous ne pouvez pas valider ce mouvement."
        });
      }

      const { id } = req.params;
      const companyId = req.user.company_id;
      const isSuperAdmin = req.user.is_super_admin === true;
      const { final_quantity, correction_note } = req.body || {};

      const movementResult = await pool.query(
        `SELECT * FROM stock_movements
       WHERE id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}`,
        isSuperAdmin ? [id] : [id, companyId]
      );

      const movement = movementResult.rows[0];

      if (!movement)
        return res.status(404).json({ error: "Mouvement introuvable" });

      if (Number(movement.created_by) === Number(req.user.id)) {
        return res.status(403).json({
          error: "Vous ne pouvez pas valider votre propre demande."
        });
      }

      if (movement.status !== "En attente") {
        return res.status(400).json({ error: "Mouvement déjà traité" });
      }

      const approvedQuantity =
        final_quantity !== undefined && final_quantity !== null
          ? Number(final_quantity)
          : Number(movement.quantity);

      if (movement.type === "Entrée") {
        await pool.query(
          `UPDATE products SET stock = stock + $1
         WHERE reference = $2 ${isSuperAdmin ? "" : "AND company_id=$3"}`,
          isSuperAdmin
            ? [approvedQuantity, movement.product_reference]
            : [approvedQuantity, movement.product_reference, companyId]
        );
      }

      if (movement.type === "Sortie") {
        await pool.query(
          `UPDATE products SET stock = GREATEST(stock - $1, 0)
         WHERE reference = $2 ${isSuperAdmin ? "" : "AND company_id=$3"}`,
          isSuperAdmin
            ? [approvedQuantity, movement.product_reference]
            : [approvedQuantity, movement.product_reference, companyId]
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
            ? [approvedQuantity, movement.product_reference]
            : [approvedQuantity, movement.product_reference, companyId]
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
       SET status='Validé',
           approval_status='Validé',
           final_quantity=$1,
           validated_by=$2,
           validated_at=CURRENT_TIMESTAMP,
           modified_by=CASE WHEN $3::boolean THEN $2 ELSE modified_by END,
           modified_at=CASE WHEN $3::boolean THEN CURRENT_TIMESTAMP ELSE modified_at END,
           correction_note=$4
       WHERE id=$5 ${isSuperAdmin ? "" : "AND company_id=$6"}
       RETURNING *`,
        isSuperAdmin
          ? [
              approvedQuantity,
              req.user.id,
              approvedQuantity !== Number(movement.quantity),
              correction_note || "",
              id
            ]
          : [
              approvedQuantity,
              req.user.id,
              approvedQuantity !== Number(movement.quantity),
              correction_note || "",
              id,
              companyId
            ]
      );

      await logActivity(
        "Administrateur",
        "admin",
        "Validation mouvement stock",
        "Stocks",
        `${movement.type} validé pour ${movement.product_reference}`
      );

      if (movement.created_by) {
        await createNotification({
          user_id: movement.created_by,
          title: "Mouvement stock validé",
          message: `Votre demande ${movement.type} pour ${movement.product_reference} a été validée.`,
          type: "stock_movement_validated",
          company_id: movement.company_id || companyId,
          priority: "normal",
          related_entity_type: "stock_movement",
          related_entity_id: Number(id),
          action_url: `/stocks?movement=${id}`,
          created_by: req.user.id,
          assigned_to: movement.created_by,
          warehouse_id: movement.warehouse_id || null
        });
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
    if (!canValidateStockMovement(req.user)) {
      return res.status(403).json({
        error: "Accès refusé : vous ne pouvez pas refuser ce mouvement."
      });
    }

    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;
    const { rejection_reason } = req.body || {};

    const movementResult = await pool.query(
      `SELECT * FROM stock_movements
       WHERE id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}`,
      isSuperAdmin ? [req.params.id] : [req.params.id, companyId]
    );

    const movement = movementResult.rows[0];

    if (!movement)
      return res.status(404).json({ error: "Mouvement introuvable" });

    if (Number(movement.created_by) === Number(req.user.id)) {
      return res.status(403).json({
        error: "Vous ne pouvez pas refuser votre propre demande."
      });
    }

    const updated = await pool.query(
      `UPDATE stock_movements
       SET status='Refusé',
           approval_status='Refusé',
           rejection_reason=$1,
           validated_by=$2,
           validated_at=CURRENT_TIMESTAMP
       WHERE id=$3 ${isSuperAdmin ? "" : "AND company_id=$4"}
       RETURNING *`,
      isSuperAdmin
        ? [rejection_reason || "", req.user.id, req.params.id]
        : [rejection_reason || "", req.user.id, req.params.id, companyId]
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
      await createNotification({
        user_id: movement.created_by,
        title: "Mouvement stock refusé",
        message: `Votre demande ${movement.type} pour ${movement.product_reference} a été refusée.`,
        type: "stock_movement_rejected",
        company_id: movement.company_id || companyId,
        priority: "high",
        related_entity_type: "stock_movement",
        related_entity_id: Number(req.params.id),
        action_url: `/stocks?movement=${req.params.id}`,
        created_by: req.user.id,
        assigned_to: movement.created_by,
        warehouse_id: movement.warehouse_id || null
      });
    }

    res.json(updated.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur refus mouvement" });
  }
});

/* POS / CAISSE */
app.get("/pos/products/search", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;
    const q = String(req.query.q || "").trim();
    const search = `%${q}%`;
    const normalizedSearch = normalizeProductLookupCode(q);

    const result = await pool.query(
      `SELECT products.*, locations.emplacement_code, locations.rayon_code,
              locations.case_code, locations.level_code, locations.bin_code,
              locations.warehouse_code
       FROM products
       LEFT JOIN locations ON products.location_id = locations.id
       WHERE products.is_active IS NOT FALSE
       ${q ? `AND (
          products.name ILIKE $1
          OR products.reference ILIKE $1
          OR products.barcode ILIKE $1
          OR products.sku ILIKE $1
          OR products.qr_code ILIKE $1
          OR regexp_replace(lower(regexp_replace(COALESCE(products.reference,''), '^ref\\s*[-_]*\\s*', '', 'i')), '[^a-z0-9]', '', 'g') = $2
          OR regexp_replace(lower(COALESCE(products.barcode,'')), '[^a-z0-9]', '', 'g') = $2
          OR regexp_replace(lower(COALESCE(products.sku,'')), '[^a-z0-9]', '', 'g') = $2
          OR regexp_replace(lower(COALESCE(products.qr_code,'')), '[^a-z0-9]', '', 'g') = $2
       )` : ""}
       ${isSuperAdmin ? "" : `AND products.company_id = $${q ? 3 : 1}`}
       ORDER BY products.name ASC
       LIMIT 40`,
      isSuperAdmin
        ? q
          ? [search, normalizedSearch]
          : []
        : q
          ? [search, normalizedSearch, companyId]
          : [companyId]
    );

    res.json(
      result.rows.map((product) => ({
        ...product,
        qr_url: productQrUrl(req, product),
        effective_sale_price: getEffectivePosPrice(product)
      }))
    );
  } catch (error) {
    console.error("ERREUR POS SEARCH :", error);
    res.status(500).json({ error: "Erreur recherche produits POS" });
  }
});

app.get("/pos/settings", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const result = await pool.query(
      `INSERT INTO pos_settings (company_id, default_tax_rate)
       VALUES ($1, 18)
       ON CONFLICT (company_id) DO UPDATE SET company_id=EXCLUDED.company_id
       RETURNING *`,
      [companyId || null]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR POS SETTINGS :", error);
    res.status(500).json({ error: "Erreur paramètres POS" });
  }
});

app.put(
  "/pos/settings",
  authenticateToken,
  authorizeRoles("admin", "super_admin"),
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const {
        pos_enabled,
        default_tax_rate,
        currency,
        receipt_format,
        printer_name,
        allowed_payment_methods,
        max_discount_rate
      } = req.body;
      const taxRate =
        default_tax_rate === "" || default_tax_rate === null || default_tax_rate === undefined
          ? 18
          : Number(default_tax_rate);

      const result = await pool.query(
        `INSERT INTO pos_settings
         (company_id, pos_enabled, default_tax_rate, currency, receipt_format,
          printer_name, allowed_payment_methods, max_discount_rate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (company_id)
         DO UPDATE SET
           pos_enabled=EXCLUDED.pos_enabled,
           default_tax_rate=EXCLUDED.default_tax_rate,
           currency=EXCLUDED.currency,
           receipt_format=EXCLUDED.receipt_format,
           printer_name=EXCLUDED.printer_name,
           allowed_payment_methods=EXCLUDED.allowed_payment_methods,
           max_discount_rate=EXCLUDED.max_discount_rate,
           updated_at=CURRENT_TIMESTAMP
         RETURNING *`,
        [
          companyId || null,
          pos_enabled !== false,
          taxRate,
          currency || "FCFA",
          receipt_format || "80mm",
          printer_name || "",
          allowed_payment_methods || "",
          Number(max_discount_rate || 0)
        ]
      );

      res.json(result.rows[0]);
    } catch (error) {
      console.error("ERREUR UPDATE POS SETTINGS :", error);
      res.status(500).json({ error: "Erreur modification paramètres POS" });
    }
  }
);

app.put(
  "/pos/products/:id/settings",
  authenticateToken,
  authorizeRoles("admin", "super_admin"),
  async (req, res) => {
    try {
      const companyId = req.user.company_id;
      const isSuperAdmin = req.user.is_super_admin === true;
      const {
        purchase_price,
        sale_price,
        wholesale_price,
        pharmacy_price,
        tax_rate,
        max_discount_rate,
        barcode,
        qr_code,
        lot_number,
        manufacture_date,
        expiration_date,
        supplier_id,
        category,
        subcategory,
        blocked_for_sale,
        expiration_tracking_enabled,
        batch_tracking_enabled
      } = req.body;
      const valuesBase = [
        optionalNumber(purchase_price),
        optionalNumber(sale_price),
        optionalNumber(wholesale_price),
        optionalNumber(pharmacy_price),
        optionalNumber(tax_rate),
        optionalNumber(max_discount_rate),
        barcode === undefined ? null : String(barcode),
        qr_code === undefined ? null : String(qr_code),
        lot_number === undefined ? null : String(lot_number),
        manufacture_date || null,
        expiration_date || null,
        supplier_id || null,
        category === undefined ? null : String(category),
        subcategory === undefined ? null : String(subcategory),
        blocked_for_sale === true,
        expiration_tracking_enabled === true,
        batch_tracking_enabled === true,
        req.params.id
      ];

      const result = await pool.query(
        `UPDATE products
         SET purchase_price=COALESCE($1, purchase_price),
             sale_price=COALESCE($2, sale_price),
             wholesale_price=COALESCE($3, wholesale_price),
             pharmacy_price=COALESCE($4, pharmacy_price),
             margin=(COALESCE($2, sale_price) - COALESCE($1, purchase_price)),
             tax_rate=COALESCE($5, tax_rate),
             max_discount_rate=COALESCE($6, max_discount_rate),
             barcode=COALESCE($7, barcode),
             qr_code=COALESCE(NULLIF($8, ''), qr_code),
             lot_number=COALESCE($9, lot_number),
             manufacture_date=$10,
             expiration_date=$11,
             supplier_id=COALESCE($12, supplier_id),
             category=COALESCE($13, category),
             subcategory=COALESCE($14, subcategory),
             blocked_for_sale=$15,
             expiration_tracking_enabled=$16,
             batch_tracking_enabled=$17,
             updated_at=CURRENT_TIMESTAMP
         WHERE id=$18 ${isSuperAdmin ? "" : "AND company_id=$19"}
         RETURNING *`,
        isSuperAdmin
          ? valuesBase
          : [...valuesBase, companyId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Produit introuvable" });
      }

      res.json({
        ...result.rows[0],
        qr_url: productQrUrl(req, result.rows[0]),
        effective_sale_price: getEffectivePosPrice(result.rows[0])
      });
    } catch (error) {
      console.error("ERREUR POS PRODUCT SETTINGS :", error);
      res.status(500).json({ error: "Erreur paramètres produit POS" });
    }
  }
);

app.get("/pos/alerts", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;
    const values = isSuperAdmin ? [] : [companyId];
    const companyClause = isSuperAdmin ? "" : "AND company_id=$1";

    const lowStock = await pool.query(
      `SELECT 'stock_faible' AS type, id, reference, name, stock, minimum_stock
       FROM products
       WHERE stock > 0 AND stock <= minimum_stock ${companyClause}`,
      values
    );
    const outStock = await pool.query(
      `SELECT 'rupture' AS type, id, reference, name, stock, minimum_stock
       FROM products
       WHERE stock <= 0 ${companyClause}`,
      values
    );
    const noPrice = await pool.query(
      `SELECT 'prix_non_configure' AS type, id, reference, name, sale_price
       FROM products
       WHERE COALESCE(sale_price,0) <= 0 ${companyClause}`,
      values
    );
    const blocked = await pool.query(
      `SELECT 'produit_bloque' AS type, id, reference, name
       FROM products
       WHERE blocked_for_sale = true ${companyClause}`,
      values
    );
    const batches = await pool.query(
      `SELECT CASE
          WHEN expiration_date < CURRENT_DATE THEN 'lot_expire'
          WHEN expiration_date <= CURRENT_DATE + INTERVAL '7 days' THEN 'expire_7_jours'
          WHEN expiration_date <= CURRENT_DATE + INTERVAL '30 days' THEN 'expire_30_jours'
          WHEN expiration_date <= CURRENT_DATE + INTERVAL '90 days' THEN 'expire_90_jours'
          ELSE 'lot'
        END AS type,
        id, lot_number, product_id, quantity_remaining, expiration_date
       FROM product_batches
       WHERE expiration_date IS NOT NULL
       AND expiration_date <= CURRENT_DATE + INTERVAL '90 days'
       ${companyClause}`,
      values
    );

    res.json([
      ...lowStock.rows,
      ...outStock.rows,
      ...noPrice.rows,
      ...blocked.rows,
      ...batches.rows
    ]);
  } catch (error) {
    console.error("ERREUR POS ALERTS :", error);
    res.status(500).json({ error: "Erreur alertes POS" });
  }
});

app.get("/pos/payment-settings", authenticateToken, async (req, res) => {
  try {
    if (!canAdjustPosPrice(req.user)) {
      return res.status(403).json({ error: "Accès admin requis." });
    }

    const companyId = req.user.company_id;
    const result = await pool.query(
      `SELECT id, company_id, provider_key, provider, public_key,
              secret_key_encrypted, client_id, client_secret_encrypted,
              merchant_id, merchant_number, merchant_account,
              orange_money_account, moov_money_account, wave_account,
              webhook_secret_encrypted, currency, mode, webhook_url,
              is_active, connection_status, last_checked_at, updated_at
       FROM payment_settings
       WHERE company_id=$1
       ORDER BY provider_key ASC`,
      [companyId || null]
    );

    res.json(
      result.rows.map((row) => ({
        ...row,
        secret_key: maskSecret(row.secret_key_encrypted),
        client_secret: maskSecret(row.client_secret_encrypted),
        webhook_secret: maskSecret(row.webhook_secret_encrypted),
        secret_key_encrypted: undefined,
        client_secret_encrypted: undefined,
        webhook_secret_encrypted: undefined
      }))
    );
  } catch (error) {
    console.error("ERREUR PAYMENT SETTINGS :", error);
    res.status(500).json({ error: "Erreur paramètres paiement" });
  }
});

app.put("/pos/payment-settings", authenticateToken, async (req, res) => {
  try {
    if (!canAdjustPosPrice(req.user)) {
      return res.status(403).json({ error: "Accès admin requis." });
    }

    const companyId = req.user.company_id;
    const {
      provider_key,
      provider,
      public_key,
      secret_key,
      client_id,
      client_secret,
      merchant_id,
      merchant_number,
      merchant_account,
      orange_money_account,
      moov_money_account,
      wave_account,
      webhook_secret,
      currency = "FCFA",
      mode = "test",
      webhook_url,
      is_active
    } = req.body;

    if (!provider_key) {
      return res.status(400).json({ error: "Fournisseur obligatoire." });
    }

    const existing = await pool.query(
      `SELECT secret_key_encrypted, client_secret_encrypted,
              webhook_secret_encrypted
       FROM payment_settings
       WHERE company_id=$1 AND provider_key=$2
       LIMIT 1`,
      [companyId || null, provider_key]
    );
    const secretValue =
      secret_key && secret_key !== "••••••••"
        ? encryptPaymentSecret(secret_key)
        : existing.rows[0]?.secret_key_encrypted || "";
    const clientSecretValue =
      client_secret && client_secret !== "••••••••"
        ? encryptPaymentSecret(client_secret)
        : existing.rows[0]?.client_secret_encrypted || "";
    const webhookSecretValue =
      webhook_secret && webhook_secret !== "••••••••"
        ? encryptPaymentSecret(webhook_secret)
        : existing.rows[0]?.webhook_secret_encrypted || "";

    const result = await pool.query(
      `INSERT INTO payment_settings
       (company_id, provider_key, provider, public_key, secret_key_encrypted,
        client_id, client_secret_encrypted, merchant_id, merchant_number,
        merchant_account, orange_money_account, moov_money_account,
        wave_account, webhook_secret_encrypted, currency, mode, webhook_url, is_active,
        created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)
       ON CONFLICT (company_id, provider_key)
       DO UPDATE SET
         provider=EXCLUDED.provider,
         public_key=EXCLUDED.public_key,
         secret_key_encrypted=EXCLUDED.secret_key_encrypted,
         client_id=EXCLUDED.client_id,
         client_secret_encrypted=EXCLUDED.client_secret_encrypted,
         merchant_id=EXCLUDED.merchant_id,
         merchant_number=EXCLUDED.merchant_number,
         merchant_account=EXCLUDED.merchant_account,
         orange_money_account=EXCLUDED.orange_money_account,
         moov_money_account=EXCLUDED.moov_money_account,
         wave_account=EXCLUDED.wave_account,
         webhook_secret_encrypted=EXCLUDED.webhook_secret_encrypted,
         currency=EXCLUDED.currency,
         mode=EXCLUDED.mode,
         webhook_url=EXCLUDED.webhook_url,
         is_active=EXCLUDED.is_active,
         updated_by=EXCLUDED.updated_by,
         updated_at=CURRENT_TIMESTAMP
       RETURNING id, company_id, provider_key, provider, public_key,
                 client_id, merchant_id, merchant_number, merchant_account,
                 orange_money_account, moov_money_account, wave_account,
                 currency, mode, webhook_url, is_active,
                 connection_status, last_checked_at, updated_at`,
      [
        companyId || null,
        provider_key,
        provider || provider_key,
        public_key || "",
        secretValue,
        client_id || "",
        clientSecretValue,
        merchant_id || "",
        merchant_number || "",
        merchant_account || "",
        orange_money_account || "",
        moov_money_account || "",
        wave_account || "",
        webhookSecretValue,
        currency || "FCFA",
        mode === "production" ? "production" : "test",
        webhook_url || "",
        is_active === true,
        req.user.id
      ]
    );

    res.json({ ...result.rows[0], secret_key: maskSecret(secretValue) });
  } catch (error) {
    console.error("ERREUR UPDATE PAYMENT SETTINGS :", error);
    res.status(500).json({ error: "Erreur sauvegarde paramètres paiement" });
  }
});

app.post("/pos/payment-settings/test", authenticateToken, async (req, res) => {
  try {
    if (!canAdjustPosPrice(req.user)) {
      return res.status(403).json({ error: "Accès admin requis." });
    }

    const { provider_key } = req.body;
    const companyId = req.user.company_id;

    const result = await pool.query(
      `UPDATE payment_settings
       SET connection_status='OK',
           last_checked_at=CURRENT_TIMESTAMP,
           updated_at=CURRENT_TIMESTAMP
       WHERE company_id=$1 AND provider_key=$2
       RETURNING provider_key, connection_status, last_checked_at`,
      [companyId || null, provider_key]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Paramètres fournisseur introuvables." });
    }

    res.json({
      ...result.rows[0],
      message: "Connexion sandbox OK. Les API production seront branchées avec les identifiants officiels."
    });
  } catch (error) {
    console.error("ERREUR TEST PAYMENT SETTINGS :", error);
    res.status(500).json({ error: "Erreur test connexion paiement" });
  }
});

app.get("/products/:id/batches", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    const result = await pool.query(
      `SELECT *
       FROM product_batches
       WHERE product_id=$1
       ${isSuperAdmin ? "" : "AND company_id=$2"}
       ORDER BY expiration_date ASC NULLS LAST, received_at ASC NULLS LAST, id ASC`,
      isSuperAdmin ? [req.params.id] : [req.params.id, companyId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR LOTS PRODUIT :", error);
    res.status(500).json({ error: "Erreur lecture lots produit" });
  }
});

app.post("/products/:id/batches", authenticateToken, async (req, res) => {
  try {
    if (isReadOnlyRole(req.user)) {
      return res.status(403).json({ error: "Vous avez un accès lecture seule." });
    }

    const companyId = req.user.company_id;
    const {
      lot_number,
      supplier_id,
      quantity_initial,
      purchase_price,
      sale_price,
      expiration_date,
      warehouse_id,
      location_id,
      status
    } = req.body;

    const result = await pool.query(
      `INSERT INTO product_batches
       (company_id, lot_number, product_id, supplier_id, quantity_initial,
        quantity_remaining, purchase_price, sale_price, expiration_date,
        warehouse_id, location_id, status)
       VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        companyId,
        lot_number,
        req.params.id,
        supplier_id || null,
        Number(quantity_initial || 0),
        Number(purchase_price || 0),
        Number(sale_price || 0),
        expiration_date || null,
        warehouse_id || null,
        location_id || null,
        status || "active"
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR AJOUT LOT :", error);
    res.status(500).json({ error: "Erreur ajout lot produit" });
  }
});

async function finalizePaidPosSale(client, saleId, user = {}) {
  const saleResult = await client.query("SELECT * FROM sales WHERE id=$1 FOR UPDATE", [saleId]);
  const sale = saleResult.rows[0];

  if (!sale) {
    throw new Error("Vente introuvable.");
  }

  const existingFinalReceipt = await client.query(
    "SELECT * FROM receipts WHERE sale_id=$1 ORDER BY id DESC LIMIT 1",
    [sale.id]
  );

  if (sale.status === "validée" && sale.payment_status === "paid" && existingFinalReceipt.rows[0]) {
    return { sale, items: [], receipt: existingFinalReceipt.rows[0], already_finalized: true };
  }

  const itemsResult = await client.query(
    "SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY id ASC",
    [sale.id]
  );
  const saleItems = [];

  for (const item of itemsResult.rows) {
    const productResult = await client.query(
      `SELECT *
       FROM products
       WHERE id=$1 AND company_id=$2
       FOR UPDATE`,
      [item.product_id, sale.company_id]
    );
    const product = productResult.rows[0];

    if (!product) {
      throw new Error(`Produit introuvable pour la vente ${sale.sale_number}.`);
    }

    const quantity = Number(item.quantity || 0);

    if (Number(product.stock || 0) < quantity) {
      throw new Error(`Stock insuffisant pour ${product.reference}.`);
    }

    let batch = null;
    if (product.batch_tracking_enabled || product.expiration_tracking_enabled) {
      const batchResult = await client.query(
        `SELECT *
         FROM product_batches
         WHERE product_id=$1
           AND company_id=$2
           AND quantity_remaining >= $3
           AND status='active'
           AND (expiration_date IS NULL OR expiration_date >= CURRENT_DATE)
         ORDER BY expiration_date ASC NULLS LAST, received_at ASC NULLS LAST, id ASC
         LIMIT 1
         FOR UPDATE`,
        [product.id, sale.company_id, quantity]
      );
      batch = batchResult.rows[0] || null;

      if (!batch && product.batch_tracking_enabled) {
        throw new Error(`Aucun lot disponible pour ${product.reference}.`);
      }

      if (batch) {
        await client.query(
          `UPDATE product_batches
           SET quantity_remaining = quantity_remaining - $1,
               updated_at=CURRENT_TIMESTAMP
           WHERE id=$2`,
          [quantity, batch.id]
        );

        await client.query(
          `UPDATE sale_items
           SET batch_id=$1, lot_number=$2
           WHERE id=$3`,
          [batch.id, batch.lot_number || "", item.id]
        );
      }
    }

    await client.query(
      `UPDATE products
       SET stock = stock - $1,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$2`,
      [quantity, product.id]
    );

    await client.query(
      `INSERT INTO stock_movements
       (type, product_reference, product_name, quantity, source_warehouse,
        destination_warehouse, reason, status, company_id, created_by,
        created_by_name, created_by_role, location_code, warehouse_id,
        approval_status, original_quantity, final_quantity, product_id, location_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Validé',$8,$9,$10,$11,$12,$13,'Validé',$4,$4,$14,$15)`,
      [
        "Sortie",
        product.reference,
        product.name,
        quantity,
        product.warehouse || "",
        "",
        `Vente POS ${sale.sale_number}`,
        sale.company_id,
        user.id || sale.created_by || null,
        user.email || sale.created_by_name || "Caissier",
        user.role || sale.created_by_role || "caissier",
        product.location_code || "",
        sale.warehouse_id || product.warehouse_id || null,
        product.id,
        product.location_id || null
      ]
    );

    saleItems.push({ ...item, batch_id: batch?.id || item.batch_id, lot_number: batch?.lot_number || item.lot_number });
  }

  const receiptNumber = `REC-${new Date().getFullYear()}-${String(sale.id).padStart(6, "0")}`;
  const companySettingsResult = await client.query(
    "SELECT * FROM company_settings ORDER BY id ASC LIMIT 1"
  );

  const updatedSaleResult = await client.query(
    `UPDATE sales
     SET payment_status='paid',
         status='validée',
         amount_paid=total_amount,
         amount_due=0,
         updated_at=CURRENT_TIMESTAMP
     WHERE id=$1
     RETURNING *`,
    [sale.id]
  );
  const updatedSale = updatedSaleResult.rows[0];

  const existingReceipt = await client.query(
    "SELECT * FROM receipts WHERE sale_id=$1 ORDER BY id DESC LIMIT 1",
    [sale.id]
  );

  let receipt = existingReceipt.rows[0] || null;
  if (!receipt) {
    const receiptResult = await client.query(
      `INSERT INTO receipts
       (company_id, sale_id, receipt_number, receipt_data, total_amount,
        payment_method, payment_status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'paid',$7)
       RETURNING *`,
      [
        sale.company_id,
        sale.id,
        receiptNumber,
        JSON.stringify({
          sale: updatedSale,
          items: saleItems,
          company_settings: companySettingsResult.rows[0] || null
        }),
        Number(sale.total_amount || 0),
        sale.payment_method,
        user.id || sale.created_by || null
      ]
    );
    receipt = receiptResult.rows[0];

    await client.query(
      `INSERT INTO documents
       (document_type, document_number, client_name, total_amount,
        observation, created_by, company_id, related_entity_type,
        related_entity_id, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        "Reçu POS",
        receiptNumber,
        sale.customer_name || "",
        Number(sale.total_amount || 0),
        `Reçu généré depuis vente POS ${sale.sale_number}`,
        user.email || sale.created_by_name || "Caissier",
        sale.company_id,
        "sale",
        sale.id,
        "Validé"
      ]
    );
  }

  await client.query(
    `INSERT INTO payments
     (company_id, amount, currency, payment_method, payment_reference,
      status, notes, paid_at, sale_id, receipt_id, payment_status)
     VALUES ($1,$2,'FCFA',$3,$4,'paid',$5,CURRENT_TIMESTAMP,$6,$7,'paid')`,
    [
      sale.company_id,
      Number(sale.total_amount || 0),
      sale.payment_method,
      sale.payment_reference || sale.sale_number,
      `Paiement POS ${sale.sale_number}`,
      sale.id,
      receipt?.id || null
    ]
  );

  return {
    sale: updatedSale,
    items: saleItems,
    receipt,
    company_settings: companySettingsResult.rows[0] || null
  };
}

app.post("/pos/sales", authenticateToken, async (req, res) => {
  const client = await pool.connect();

  try {
    if (!canUsePos(req.user)) {
      return res.status(403).json({ error: "Accès POS refusé." });
    }

    const companyId = req.user.company_id;
    const {
      customer_name,
      customer_phone,
      items = [],
      discount_amount = 0,
      tax_enabled = false,
      payment_method = "Espèces",
      payment_status = "payé",
      warehouse_id = null,
      amount_received = 0,
      change_due = 0,
      remaining_amount = 0,
      mixed_payments = []
    } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Panier vide." });
    }

    await client.query("BEGIN");

    const settingsResult = await client.query(
      `INSERT INTO pos_settings (company_id, default_tax_rate)
       VALUES ($1, 18)
       ON CONFLICT (company_id) DO UPDATE SET company_id=EXCLUDED.company_id
       RETURNING *`,
      [companyId || null]
    );
    const posSettings = settingsResult.rows[0] || {};
    let subtotal = 0;
    let taxAmount = 0;
    const saleYear = new Date().getFullYear();
    const saleCountResult = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM sales
       WHERE company_id=$1 AND EXTRACT(YEAR FROM created_at)=$2`,
      [companyId, saleYear]
    );
    const saleNumber = `VENTE-${saleYear}-${String(Number(saleCountResult.rows[0]?.count || 0) + 1).padStart(6, "0")}`;

    const isPendingPosPaymentMethod = (method) =>
      isExternalPaymentMethod(method) || method === "Virement";
    const isMixedPayment = payment_method === "Paiement mixte";
    const mixedPaymentRows = Array.isArray(mixed_payments)
      ? mixed_payments
          .map((row) => ({
            method: row.method || "Espèces",
            amount: Number(row.amount || 0),
            reference: row.reference || "",
          }))
          .filter((row) => row.amount > 0)
      : [];
    const mixedHasPendingPayment = mixedPaymentRows.some((row) =>
      isPendingPosPaymentMethod(row.method)
    );
    const providerKey = providerKeyFromMethod(payment_method);
    const requestedPaymentStatus = isMixedPayment
      ? mixedHasPendingPayment
        ? "en attente"
        : payment_status
      : isExternalPaymentMethod(payment_method)
      ? "en attente"
      : payment_status;
    const shouldFinalizeImmediately = requestedPaymentStatus === "payé";

    const saleResult = await client.query(
      `INSERT INTO sales
       (company_id, warehouse_id, sale_number, customer_name, customer_phone,
        subtotal, discount_amount, tax_amount, total_amount, payment_method,
        payment_status, status, created_by, created_by_name, created_by_role)
       VALUES ($1,$2,$3,$4,$5,0,$6,0,0,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        companyId,
        warehouse_id,
        saleNumber,
        customer_name || "",
        customer_phone || "",
        Number(discount_amount || 0),
        payment_method,
        requestedPaymentStatus,
        requestedPaymentStatus === "payé" ? "validée" : "en attente",
        req.user.id,
        req.user.email || "Utilisateur",
        req.user.role || ""
      ]
    );

    const sale = saleResult.rows[0];
    const saleItems = [];

    for (const item of items) {
      const productResult = await client.query(
        `SELECT *
         FROM products
         WHERE id=$1 AND company_id=$2
         FOR UPDATE`,
        [item.product_id, companyId]
      );

      const product = productResult.rows[0];

      if (!product) {
        throw new Error("Produit introuvable dans cette entreprise.");
      }

      if (product.blocked_for_sale) {
        throw new Error(`Produit bloqué à la vente : ${product.reference}.`);
      }

      const quantity = Number(item.quantity || 1);
      const expectedPrice = getEffectivePosPrice(product);
      const unitPrice = Number(item.unit_price ?? expectedPrice);
      const itemDiscount = Number(item.discount_amount || 0);

      if (!canAdjustPosPrice(req.user)) {
        if (unitPrice !== expectedPrice || itemDiscount > 0) {
          throw new Error("Vous n'avez pas le droit de modifier le prix ou la remise.");
        }
      }

      if (Number(product.stock || 0) < quantity) {
        throw new Error(`Stock insuffisant pour ${product.reference}.`);
      }

      if (product.expiration_date && new Date(product.expiration_date) < new Date()) {
        throw new Error(`Produit expiré : ${product.reference}.`);
      }

      let batch = null;

      if (shouldFinalizeImmediately && (product.batch_tracking_enabled || product.expiration_tracking_enabled)) {
        const batchResult = await client.query(
          `SELECT *
           FROM product_batches
           WHERE product_id=$1
             AND company_id=$2
             AND quantity_remaining >= $3
             AND status='active'
             AND (expiration_date IS NULL OR expiration_date >= CURRENT_DATE)
           ORDER BY expiration_date ASC NULLS LAST, received_at ASC NULLS LAST, id ASC
           LIMIT 1
           FOR UPDATE`,
          [product.id, companyId, quantity]
        );

        batch = batchResult.rows[0] || null;

        if (!batch && product.batch_tracking_enabled) {
          throw new Error(`Aucun lot disponible pour ${product.reference}.`);
        }

        if (batch) {
          await client.query(
            `UPDATE product_batches
             SET quantity_remaining = quantity_remaining - $1,
                 updated_at=CURRENT_TIMESTAMP
             WHERE id=$2`,
            [quantity, batch.id]
          );
        }
      }

      const taxRate = Number(product.tax_rate || posSettings.default_tax_rate || 18);
      const lineTax = tax_enabled ? (unitPrice * quantity * taxRate) / 100 : 0;
      const lineTotal = unitPrice * quantity - itemDiscount + lineTax;
      subtotal += unitPrice * quantity - itemDiscount;
      taxAmount += lineTax;

      if (shouldFinalizeImmediately) {
        await client.query(
          `UPDATE products
           SET stock = stock - $1,
               updated_at=CURRENT_TIMESTAMP
           WHERE id=$2`,
          [quantity, product.id]
        );
      }

      const itemResult = await client.query(
        `INSERT INTO sale_items
         (sale_id, company_id, product_id, product_reference, product_name,
          barcode, lot_number, batch_id, quantity, unit_price, discount_amount,
          tax_rate, total_price, warehouse_id, location_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING *`,
        [
          sale.id,
          companyId,
          product.id,
          product.reference,
          product.name,
          product.barcode || "",
          batch?.lot_number || product.lot_number || "",
          batch?.id || null,
          quantity,
          unitPrice,
          itemDiscount,
          taxRate,
          lineTotal,
          warehouse_id || product.warehouse_id || null,
          product.location_id || null
        ]
      );

      saleItems.push(itemResult.rows[0]);

      if (shouldFinalizeImmediately) {
        await client.query(
          `INSERT INTO stock_movements
           (type, product_reference, product_name, quantity, source_warehouse,
            destination_warehouse, reason, status, company_id, created_by,
            created_by_name, created_by_role, location_code, warehouse_id,
            approval_status, original_quantity, final_quantity, product_id, location_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'Validé',$8,$9,$10,$11,$12,$13,'Validé',$4,$4,$14,$15)`,
          [
            "Sortie",
            product.reference,
            product.name,
            quantity,
            product.warehouse || "",
            "",
            `Vente POS ${saleNumber}`,
            companyId,
            req.user.id,
            req.user.email || "Caissier",
            req.user.role || "caissier",
            product.location_code || "",
            warehouse_id || product.warehouse_id || null,
            product.id,
            product.location_id || null
          ]
        );
      }
    }

    const totalAmount = Math.max(subtotal - Number(discount_amount || 0) + taxAmount, 0);
    const confirmedPaidAmount = isMixedPayment
      ? mixedPaymentRows
          .filter((row) => !isPendingPosPaymentMethod(row.method))
          .reduce((sum, row) => sum + Number(row.amount || 0), 0)
      : shouldFinalizeImmediately
        ? Math.min(Number(amount_received || totalAmount), totalAmount)
        : 0;
    const dueAmount = shouldFinalizeImmediately
      ? 0
      : Math.max(remaining_amount || totalAmount - confirmedPaidAmount, 0);

    const updatedSale = await client.query(
      `UPDATE sales
       SET subtotal=$1,
           tax_amount=$2,
           total_amount=$3,
           amount_paid=$4,
           amount_due=$5,
           change_due=$6,
           provider=$7,
           payment_status=$8,
           status=$9,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$10
       RETURNING *`,
      [
        subtotal,
        taxAmount,
        totalAmount,
        confirmedPaidAmount,
        dueAmount,
        Number(change_due || 0),
        providerKey,
        requestedPaymentStatus,
        requestedPaymentStatus === "payé" ? "validée" : "en attente",
        sale.id
      ]
    );

    let paymentTransaction = null;
    let paymentReference = "";
    const rowsToCreate = isMixedPayment && mixedPaymentRows.length > 0
      ? mixedPaymentRows
      : [{ method: payment_method, amount: totalAmount, reference: "" }];

    for (let index = 0; index < rowsToCreate.length; index += 1) {
      const row = rowsToCreate[index];
      const rowProviderKey = providerKeyFromMethod(row.method);
      const rowStatus = isPendingPosPaymentMethod(row.method)
        ? "en attente"
        : requestedPaymentStatus === "payé"
          ? "paid"
          : requestedPaymentStatus;
      const transactionReference = row.reference || `${rowProviderKey.toUpperCase()}-${saleNumber}-${index + 1}`;

      const transactionResult = await client.query(
        `INSERT INTO payment_transactions
         (company_id, sale_id, provider_key, payment_method, amount, currency,
          status, provider_reference, external_reference, phone_number,
          request_payload, response_payload, provider_response, created_by)
         VALUES ($1,$2,$3,$4,$5,'FCFA',$6,$7,$8,$9,$10,$11,$11,$12)
         RETURNING *`,
        [
          companyId,
          sale.id,
          rowProviderKey,
          row.method,
          Number(row.amount || 0),
          rowStatus,
          transactionReference,
          saleNumber,
          customer_phone || "",
          JSON.stringify({ sale_id: sale.id, payment_method: row.method, amount: row.amount }),
          JSON.stringify({
            sandbox: isPendingPosPaymentMethod(row.method),
            message: isPendingPosPaymentMethod(row.method)
              ? "Transaction sandbox créée. Simulez le résultat dans Paiements POS."
              : "Paiement manuel enregistré."
          }),
          req.user.id
        ]
      );

      const createdTransaction = transactionResult.rows[0];
      if (!paymentTransaction || createdTransaction.status === "en attente") {
        paymentTransaction = createdTransaction;
        paymentReference = transactionReference;
      }

      await client.query(
        `INSERT INTO sale_payments
         (company_id, sale_id, transaction_id, payment_method, amount, currency,
          status, created_by)
         VALUES ($1,$2,$3,$4,$5,'FCFA',$6,$7)`,
        [
          companyId,
          sale.id,
          createdTransaction.id,
          row.method,
          Number(row.amount || 0),
          rowStatus,
          req.user.id
        ]
      );
    }

    await client.query(
      `UPDATE sales
       SET transaction_id=$1, payment_reference=$2
       WHERE id=$3`,
      [paymentTransaction?.id || null, paymentReference || saleNumber, sale.id]
    );

    const companySettingsResult = await client.query(
      "SELECT * FROM company_settings ORDER BY id ASC LIMIT 1"
    );
    let receipt = null;

    if (shouldFinalizeImmediately) {
      const receiptNumber = `REC-${saleYear}-${String(sale.id).padStart(6, "0")}`;
      const receiptResult = await client.query(
        `INSERT INTO receipts
         (company_id, sale_id, receipt_number, receipt_data, total_amount,
          payment_method, payment_status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          companyId,
          sale.id,
          receiptNumber,
          JSON.stringify({
            sale: updatedSale.rows[0],
            items: saleItems,
            company_settings: companySettingsResult.rows[0] || null
          }),
          totalAmount,
          payment_method,
          requestedPaymentStatus,
          req.user.id
        ]
      );
      receipt = receiptResult.rows[0];

      await client.query(
        `INSERT INTO documents
         (document_type, document_number, client_name, total_amount,
          observation, created_by, company_id, related_entity_type,
          related_entity_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          "Reçu POS",
          receiptNumber,
          customer_name || "",
          totalAmount,
          `Reçu généré depuis vente POS ${saleNumber}`,
          req.user.email || "Caissier",
          companyId,
          "sale",
          sale.id,
          "Validé"
        ]
      );

      await client.query(
        `INSERT INTO payments
         (company_id, amount, currency, payment_method, payment_reference,
          status, notes, paid_at, sale_id, receipt_id, payment_status)
         VALUES ($1,$2,'FCFA',$3,$4,$5,$6,CURRENT_TIMESTAMP,$7,$8,$5)`,
        [
          companyId,
          totalAmount,
          payment_method,
          saleNumber,
          requestedPaymentStatus,
          `Paiement POS ${saleNumber}`,
          sale.id,
          receipt.id
        ]
      );
    }

    await client.query("COMMIT");

    res.status(201).json({
      sale: updatedSale.rows[0],
      items: saleItems,
      receipt,
      company_settings: companySettingsResult.rows[0] || null,
      payment_transaction: paymentTransaction,
      payment_required: requestedPaymentStatus !== "payé"
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("ERREUR POS SALE :", error);
    res.status(500).json({ error: error.message || "Erreur validation vente POS" });
  } finally {
    client.release();
  }
});

app.get("/pos/sales", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;
    const {
      q = "",
      date_from,
      date_to,
      payment_method,
      status,
      product = "",
      cashier = "",
      cash_register_id
    } = req.query;
    const values = [];

    let query = `SELECT DISTINCT sales.*
                 FROM sales
                 LEFT JOIN sale_items ON sale_items.sale_id = sales.id
                 WHERE 1=1`;

    if (!isSuperAdmin) {
      values.push(companyId);
      query += ` AND company_id=$${values.length}`;
    }

    if (q) {
      values.push(`%${String(q)}%`);
      query += ` AND (sales.sale_number ILIKE $${values.length}
                      OR sales.customer_name ILIKE $${values.length}
                      OR sales.created_by_name ILIKE $${values.length}
                      OR sale_items.product_name ILIKE $${values.length}
                      OR sale_items.product_reference ILIKE $${values.length})`;
    }

    if (product) {
      values.push(`%${String(product)}%`);
      query += ` AND (sale_items.product_name ILIKE $${values.length}
                      OR sale_items.product_reference ILIKE $${values.length}
                      OR sale_items.barcode ILIKE $${values.length})`;
    }

    if (cashier) {
      values.push(`%${String(cashier)}%`);
      query += ` AND sales.created_by_name ILIKE $${values.length}`;
    }

    if (cash_register_id) {
      values.push(cash_register_id);
      query += ` AND sales.cash_register_id=$${values.length}`;
    }

    if (date_from) {
      values.push(date_from);
      query += ` AND DATE(sales.created_at) >= $${values.length}`;
    }

    if (date_to) {
      values.push(date_to);
      query += ` AND DATE(sales.created_at) <= $${values.length}`;
    }

    if (payment_method) {
      values.push(payment_method);
      query += ` AND sales.payment_method=$${values.length}`;
    }

    if (status) {
      values.push(status);
      query += ` AND LOWER(sales.status)=LOWER($${values.length})`;
    }

    query += ` ORDER BY sales.id DESC LIMIT 300`;

    const result = await pool.query(query, values);

    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR POS SALES :", error);
    res.status(500).json({ error: "Erreur lecture ventes POS" });
  }
});

app.get("/pos/sales/:id", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    const saleResult = await pool.query(
      `SELECT *
       FROM sales
       WHERE id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}`,
      isSuperAdmin ? [req.params.id] : [req.params.id, companyId]
    );

    if (saleResult.rows.length === 0) {
      return res.status(404).json({ error: "Vente introuvable" });
    }

    const itemsResult = await pool.query(
      "SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY id ASC",
      [req.params.id]
    );
    const receiptResult = await pool.query(
      "SELECT * FROM receipts WHERE sale_id=$1 ORDER BY id DESC LIMIT 1",
      [req.params.id]
    );
    const companySettingsResult = await pool.query(
      "SELECT * FROM company_settings ORDER BY id ASC LIMIT 1"
    );

    res.json({
      sale: saleResult.rows[0],
      items: itemsResult.rows,
      receipt: receiptResult.rows[0] || null,
      company_settings: companySettingsResult.rows[0] || null
    });
  } catch (error) {
    console.error("ERREUR POS SALE DETAIL :", error);
    res.status(500).json({ error: "Erreur détail vente POS" });
  }
});

app.post("/pos/sales/:id/cancel", authenticateToken, async (req, res) => {
  const client = await pool.connect();

  try {
    if (!canAdjustPosPrice(req.user)) {
      return res.status(403).json({ error: "Seul un admin peut annuler une vente." });
    }

    const companyId = req.user.company_id;
    const { reason } = req.body;

    await client.query("BEGIN");

    const saleResult = await client.query(
      "SELECT * FROM sales WHERE id=$1 AND company_id=$2 FOR UPDATE",
      [req.params.id, companyId]
    );
    const sale = saleResult.rows[0];

    if (!sale) throw new Error("Vente introuvable");
    if (sale.status === "annulée") throw new Error("Vente déjà annulée");

    const itemsResult = await client.query("SELECT * FROM sale_items WHERE sale_id=$1", [sale.id]);

    for (const item of itemsResult.rows) {
      await client.query("UPDATE products SET stock = stock + $1 WHERE id=$2", [
        item.quantity,
        item.product_id
      ]);

      if (item.batch_id) {
        await client.query(
          "UPDATE product_batches SET quantity_remaining = quantity_remaining + $1 WHERE id=$2",
          [item.quantity, item.batch_id]
        );
      }
    }

    const updated = await client.query(
      `UPDATE sales
       SET status='annulée', cancelled_by=$1, cancelled_at=CURRENT_TIMESTAMP,
           cancel_reason=$2
       WHERE id=$3
       RETURNING *`,
      [req.user.id, reason || "", sale.id]
    );

    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("ERREUR ANNULATION POS :", error);
    res.status(500).json({ error: "Erreur annulation vente" });
  } finally {
    client.release();
  }
});

app.get("/pos/receipts/:id", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM receipts WHERE id=$1",
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Reçu introuvable" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR RECU POS :", error);
    res.status(500).json({ error: "Erreur lecture reçu" });
  }
});

app.get("/pos/reports/daily", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    const sales = await pool.query(
      `SELECT COUNT(*)::int AS sales_count,
              COALESCE(SUM(total_amount),0)::numeric AS revenue
       FROM sales
       WHERE DATE(created_at)=$1
       ${isSuperAdmin ? "" : "AND company_id=$2"}`,
      isSuperAdmin ? [date] : [date, companyId]
    );

    const payments = await pool.query(
      `SELECT payment_method, COUNT(*)::int AS count,
              COALESCE(SUM(total_amount),0)::numeric AS total
       FROM sales
       WHERE DATE(created_at)=$1
       ${isSuperAdmin ? "" : "AND company_id=$2"}
       GROUP BY payment_method
       ORDER BY total DESC`,
      isSuperAdmin ? [date] : [date, companyId]
    );

    res.json({
      date,
      totals: sales.rows[0],
      payments: payments.rows
    });
  } catch (error) {
    console.error("ERREUR RAPPORT POS DAILY :", error);
    res.status(500).json({ error: "Erreur rapport POS journalier" });
  }
});

app.post("/pos/payments", authenticateToken, async (req, res) => {
  try {
    if (!canUsePos(req.user)) {
      return res.status(403).json({ error: "Accès POS refusé." });
    }

    const {
      sale_id,
      amount,
      payment_method = "Espèces",
      payment_status = "payé",
      notes = ""
    } = req.body;

    const result = await pool.query(
      `INSERT INTO payments
       (company_id, amount, currency, payment_method, status, notes,
        paid_at, sale_id, payment_status)
       VALUES ($1,$2,'FCFA',$3,$4,$5,CURRENT_TIMESTAMP,$6,$4)
       RETURNING *`,
      [
        req.user.company_id || null,
        Number(amount || 0),
        payment_method,
        payment_status,
        notes,
        sale_id || null
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR POS PAYMENT :", error);
    res.status(500).json({ error: "Erreur paiement POS" });
  }
});

app.get("/payments", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;
    const result = await pool.query(
      `SELECT pt.*, s.sale_number, s.customer_name
       FROM payment_transactions pt
       LEFT JOIN sales s ON s.id = pt.sale_id
       WHERE 1=1 ${isSuperAdmin ? "" : "AND pt.company_id=$1"}
       ORDER BY pt.id DESC
       LIMIT 200`,
      isSuperAdmin ? [] : [companyId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR LECTURE PAIEMENTS :", error);
    res.status(500).json({ error: "Erreur lecture paiements" });
  }
});

app.get("/payments/:id", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;
    const result = await pool.query(
      `SELECT pt.*, s.sale_number, s.customer_name
       FROM payment_transactions pt
       LEFT JOIN sales s ON s.id = pt.sale_id
       WHERE pt.id=$1 ${isSuperAdmin ? "" : "AND pt.company_id=$2"}`,
      isSuperAdmin ? [req.params.id] : [req.params.id, companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Paiement introuvable" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR DETAIL PAIEMENT :", error);
    res.status(500).json({ error: "Erreur détail paiement" });
  }
});

app.post("/payments/initiate", authenticateToken, async (req, res) => {
  try {
    if (!canUsePos(req.user)) {
      return res.status(403).json({ error: "Accès POS refusé." });
    }

    const {
      sale_id = null,
      payment_method = "Carte bancaire",
      amount = 0,
      currency = "FCFA",
      customer_name = "",
      customer_phone = ""
    } = req.body;
    const providerKey = providerKeyFromMethod(payment_method);
    const providerReference = `MOCK-${providerKey.toUpperCase()}-${Date.now()}`;

    const result = await pool.query(
      `INSERT INTO payment_transactions
       (company_id, sale_id, provider_key, payment_method, amount, currency,
        status, provider_reference, external_reference, phone_number,
        request_payload, response_payload, provider_response, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10,$11,$11,$12)
       RETURNING *`,
      [
        req.user.company_id || null,
        sale_id,
        providerKey,
        payment_method,
        Number(amount || 0),
        currency || "FCFA",
        providerReference,
        providerReference,
        customer_phone || "",
        JSON.stringify({ sale_id, payment_method, amount, customer_name, customer_phone }),
        JSON.stringify({
          sandbox: true,
          message: "Paiement sandbox initié. Utilisez confirmer pour simuler le fournisseur."
        }),
        req.user.id
      ]
    );

    res.status(201).json({
      transaction: result.rows[0],
      status: "en attente",
      provider_reference: providerReference,
      sandbox: true,
      message: "Paiement initié en mode sandbox."
    });
  } catch (error) {
    console.error("ERREUR INIT PAIEMENT :", error);
    res.status(500).json({ error: "Erreur initiation paiement" });
  }
});

app.post("/payments/confirm", authenticateToken, async (req, res) => {
  const { status = "payé" } = req.body;
  const nextStatus =
    status === "échoué" || status === "failed" || status === "fail"
      ? "failed"
      : "paid";

  return updateSandboxPayment(req, res, nextStatus);
});

async function updateSandboxPayment(req, res, nextStatus) {
  const client = await pool.connect();

  try {
    const { transaction_id, provider_reference } = req.body;
    await client.query("BEGIN");

    const transactionResult = await client.query(
      `SELECT *
       FROM payment_transactions
       WHERE ($1::int IS NOT NULL AND id=$1)
          OR ($2::text <> '' AND provider_reference=$2)
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [transaction_id || null, provider_reference || ""]
    );

    if (transactionResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Transaction introuvable" });
    }

    const transaction = transactionResult.rows[0];

    await client.query(
      `UPDATE payment_transactions
       SET status=$1,
           paid_at=CASE WHEN $1='paid' THEN CURRENT_TIMESTAMP ELSE paid_at END,
           response_payload=$2,
           provider_response=$2,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$3`,
      [
        nextStatus,
        JSON.stringify({ sandbox: true, status: nextStatus, confirmed_by: req.user.id }),
        transaction.id
      ]
    );

    await client.query(
      `UPDATE sale_payments SET status=$1 WHERE transaction_id=$2`,
      [nextStatus, transaction.id]
    );

    let sale = null;
    let receipt = null;
    let items = [];
    let companySettings = null;

    if (transaction.sale_id) {
      if (nextStatus === "paid") {
        const paymentTotals = await client.query(
          `SELECT s.total_amount,
                  COALESCE(SUM(CASE WHEN sp.status IN ('paid','payé') THEN sp.amount ELSE 0 END), 0)::numeric AS paid_amount
           FROM sales s
           LEFT JOIN sale_payments sp ON sp.sale_id=s.id
           WHERE s.id=$1
           GROUP BY s.id`,
          [transaction.sale_id]
        );
        const totalAmount = Number(paymentTotals.rows[0]?.total_amount || 0);
        const paidAmount = Number(paymentTotals.rows[0]?.paid_amount || 0);

        if (paidAmount >= totalAmount) {
          const finalized = await finalizePaidPosSale(client, transaction.sale_id, req.user);
          sale = finalized.sale || null;
          receipt = finalized.receipt || null;
          items = finalized.items || [];
          companySettings = finalized.company_settings || null;
        } else {
          const saleResult = await client.query(
            `UPDATE sales
             SET payment_status='en attente',
                 status='en attente',
                 amount_paid=$1,
                 amount_due=GREATEST(total_amount - $1, 0),
                 updated_at=CURRENT_TIMESTAMP
             WHERE id=$2
             RETURNING *`,
            [paidAmount, transaction.sale_id]
          );
          sale = saleResult.rows[0] || null;
        }
      } else {
        const saleResult = await client.query(
          `UPDATE sales
           SET payment_status=$1,
               status='en attente',
               updated_at=CURRENT_TIMESTAMP
           WHERE id=$2
           RETURNING *`,
          [nextStatus, transaction.sale_id]
        );
        sale = saleResult.rows[0] || null;
      }
    }

    await client.query("COMMIT");

    res.json({
      ok: true,
      status: nextStatus,
      transaction_id: transaction.id,
      provider_reference: transaction.provider_reference,
      sale,
      receipt,
      items,
      company_settings: companySettings
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("ERREUR SANDBOX PAIEMENT :", error);
    res.status(500).json({ error: "Erreur sandbox paiement" });
  } finally {
    client.release();
  }
}

app.post("/payments/sandbox/success", authenticateToken, async (req, res) => {
  return updateSandboxPayment(req, res, "paid");
});

app.post("/payments/sandbox/fail", authenticateToken, async (req, res) => {
  return updateSandboxPayment(req, res, "failed");
});

async function handlePaymentWebhook(req, res, providerKey) {
  try {
    const payload = req.body || {};
    const reference =
      payload.provider_reference ||
      payload.payment_reference ||
      payload.reference ||
      payload.transaction_id ||
      payload.external_reference ||
      "";
    const status =
      payload.status === "paid" || payload.status === "success" || payload.status === "payé"
        ? "payé"
        : payload.status || "en attente";

    const transactionResult = await pool.query(
      `SELECT *
       FROM payment_transactions
       WHERE provider_key=$1
       AND (
         provider_reference=$2
         OR external_reference=$2
         OR CAST(id AS TEXT)=$2
       )
       ORDER BY id DESC
       LIMIT 1`,
      [providerKey, String(reference)]
    );

    if (transactionResult.rows.length === 0) {
      return res.status(404).json({ error: "Transaction introuvable" });
    }

    const transaction = transactionResult.rows[0];

    await pool.query(
      `UPDATE payment_transactions
       SET status=$1,
           response_payload=$2,
           paid_at=CASE WHEN $1='payé' THEN CURRENT_TIMESTAMP ELSE paid_at END,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$3`,
      [status, JSON.stringify(payload), transaction.id]
    );

    await pool.query(
      `UPDATE sale_payments
       SET status=$1
       WHERE transaction_id=$2`,
      [status, transaction.id]
    );

    const saleUpdate = await pool.query(
      `UPDATE sales
       SET payment_status=$1,
           status=CASE WHEN $1='payé' THEN 'validée' ELSE status END,
           amount_paid=CASE WHEN $1='payé' THEN total_amount ELSE amount_paid END,
           amount_due=CASE WHEN $1='payé' THEN 0 ELSE amount_due END,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$2
       RETURNING *`,
      [status, transaction.sale_id]
    );

    if (status === "payé" && saleUpdate.rows[0]) {
      await createNotification({
        user_id: saleUpdate.rows[0].created_by,
        title: "Paiement POS confirmé",
        message: `Paiement confirmé pour ${saleUpdate.rows[0].sale_number}.`,
        type: "payment_validated",
        company_id: saleUpdate.rows[0].company_id,
        related_entity_type: "sale",
        related_entity_id: saleUpdate.rows[0].id,
        action_url: `/pos/recus?sale=${saleUpdate.rows[0].id}`,
        created_by: saleUpdate.rows[0].created_by
      });
    }

    res.json({ ok: true, status, sale: saleUpdate.rows[0] || null });
  } catch (error) {
    console.error("ERREUR WEBHOOK PAIEMENT :", error);
    res.status(500).json({ error: "Erreur webhook paiement" });
  }
}

app.post("/payments/webhook/card", async (req, res) => {
  await handlePaymentWebhook(req, res, "card");
});

app.post("/payments/webhook/orange-money", async (req, res) => {
  await handlePaymentWebhook(req, res, "orange_money");
});

app.post("/payments/webhook/moov-money", async (req, res) => {
  await handlePaymentWebhook(req, res, "moov_money");
});

app.post("/payments/webhook/wave", async (req, res) => {
  await handlePaymentWebhook(req, res, "wave");
});

app.get("/pos/reports/products", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    const result = await pool.query(
      `SELECT product_reference, product_name,
              SUM(quantity)::int AS quantity_sold,
              COALESCE(SUM(total_price),0)::numeric AS total
       FROM sale_items
       ${isSuperAdmin ? "" : "WHERE company_id=$1"}
       GROUP BY product_reference, product_name
       ORDER BY quantity_sold DESC
       LIMIT 50`,
      isSuperAdmin ? [] : [companyId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR RAPPORT POS PRODUITS :", error);
    res.status(500).json({ error: "Erreur rapport produits POS" });
  }
});

app.get("/pos/reports/payments", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    const result = await pool.query(
      `SELECT payment_method, payment_status,
              COUNT(*)::int AS count,
              COALESCE(SUM(total_amount),0)::numeric AS total
       FROM sales
       ${isSuperAdmin ? "" : "WHERE company_id=$1"}
       GROUP BY payment_method, payment_status
       ORDER BY total DESC`,
      isSuperAdmin ? [] : [companyId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR RAPPORT POS PAIEMENTS :", error);
    res.status(500).json({ error: "Erreur rapport paiements POS" });
  }
});

app.get("/super-admin/modules", authenticateToken, async (req, res) => {
  try {
    if (req.user.is_super_admin !== true && normalizeRole(req.user.role) !== "super_admin") {
      return res.status(403).json({ error: "Accès super admin requis." });
    }

    const moduleKeys = [
      "pos",
      "ventes",
      "achats",
      "pointage",
      "inventaire",
      "ia",
      "reunions",
      "documents",
      "rapports",
      "transport",
      "crm"
    ];

    const companiesResult = await pool.query(
      "SELECT id, name FROM companies ORDER BY id ASC"
    );
    const modulesResult = await pool.query(
      "SELECT * FROM company_modules ORDER BY company_id ASC, module_key ASC"
    );

    res.json({
      module_keys: moduleKeys,
      companies: companiesResult.rows.map((company) => ({
        ...company,
        modules: moduleKeys.reduce((acc, key) => {
          const configured = modulesResult.rows.find(
            (item) => Number(item.company_id) === Number(company.id) && item.module_key === key
          );
          acc[key] = configured ? configured.is_enabled === true : true;
          return acc;
        }, {})
      }))
    });
  } catch (error) {
    console.error("ERREUR SUPER ADMIN MODULES :", error);
    res.status(500).json({ error: "Erreur lecture modules" });
  }
});

app.put("/super-admin/modules/company/:companyId", authenticateToken, async (req, res) => {
  try {
    if (req.user.is_super_admin !== true && normalizeRole(req.user.role) !== "super_admin") {
      return res.status(403).json({ error: "Accès super admin requis." });
    }

    const { modules = {} } = req.body;
    const saved = [];

    for (const [moduleKey, isEnabled] of Object.entries(modules)) {
      const result = await pool.query(
        `INSERT INTO company_modules
         (company_id, module_key, is_enabled, updated_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (company_id, module_key)
         DO UPDATE SET
           is_enabled=EXCLUDED.is_enabled,
           updated_by=EXCLUDED.updated_by,
           updated_at=CURRENT_TIMESTAMP
         RETURNING *`,
        [req.params.companyId, moduleKey, isEnabled === true, req.user.id]
      );

      saved.push(result.rows[0]);
    }

    res.json(saved);
  } catch (error) {
    console.error("ERREUR UPDATE MODULES :", error);
    res.status(500).json({ error: "Erreur modification modules" });
  }
});

/* DOCUMENTS SAAS */
app.get("/documents", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

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

app.post("/documents", authenticateToken, async (req, res) => {
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
        created_by,
        company_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        document_type,
        document_number,
        client_name,
        client_phone,
        client_address,
        total_amount,
        observation,
        created_by || req.user.fullname || req.user.email || "Utilisateur",
        req.user.company_id || null
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
app.post("/documents/from-movement/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const {
      document_type,
      client_name,
      client_phone,
      client_address,
      created_by
    } = req.body;

    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    const movementResult = await pool.query(
      `SELECT * FROM stock_movements
       WHERE id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}`,
      isSuperAdmin ? [id] : [id, companyId]
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
        created_by,
        company_id,
        related_entity_type,
        related_entity_id,
        warehouse_id,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *`,
      [
        finalType,
        document_number,
        client_name || "",
        client_phone || "",
        client_address || "",
        0,
        `Document généré depuis mouvement stock ID ${movement.id} - ${movement.type}`,
        created_by || req.user.fullname || req.user.email || "Utilisateur",
        movement.company_id || companyId,
        "stock_movement",
        movement.id,
        movement.warehouse_id || null,
        "Validé"
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
app.get("/locations", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    const result = await pool.query(
      `SELECT
        locations.*,
        warehouses.name AS warehouse_name,
        COALESCE(locations.product_reference, products.reference, '') AS product_reference,
        COALESCE(locations.product_name, products.name, '') AS product_name
       FROM locations
       LEFT JOIN warehouses ON locations.warehouse_id = warehouses.id
       LEFT JOIN products ON locations.product_id = products.id
       ${isSuperAdmin ? "" : "WHERE locations.company_id=$1"}
       ORDER BY locations.id DESC`
      , isSuperAdmin ? [] : [companyId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture emplacements" });
  }
});

app.post("/locations", authenticateToken, async (req, res) => {
  try {
    const {
      warehouse_id,
      zone,
      rayon,
      etagere,
      status,
      product_id,
      product_reference,
      product_name,
      rayon_code,
      case_code,
      level_code,
      bin_code,
      bin_mode,
      bin_group,
      company_id
    } = req.body;

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
      (
        warehouse_id,
        warehouse_code,
        zone,
        rayon,
        etagere,
        emplacement_code,
        qr_code,
        status,
        product_id,
        product_reference,
        product_name,
        rayon_code,
        case_code,
        level_code,
        bin_code,
        bin_mode,
        bin_group,
        company_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING *`,
      [
        warehouse_id,
        warehouse.code,
        zone,
        rayon,
        etagere,
        emplacement_code,
        qr_code,
        status || "Disponible",
        product_id || null,
        product_reference || "",
        product_name || "",
        rayon_code || zone || "",
        case_code || rayon || "",
        level_code || etagere || "",
        bin_code || "",
        bin_mode || "single",
        bin_group || "",
        company_id || req.user.company_id || warehouse.company_id || null
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

app.delete("/locations/:id", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;
    const values = [req.params.id];
    let query = "DELETE FROM locations WHERE id=$1";

    if (!isSuperAdmin) {
      values.push(companyId);
      query += " AND company_id=$2";
    }

    await pool.query(query, values);

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

app.get("/scan/resolve/:code", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;
    let code = decodeURIComponent(req.params.code || "").trim();

    try {
      const parsedUrl = new URL(code);
      const productMatch = parsedUrl.pathname.match(/\/scan\/product\/([^/]+)/);
      code = parsedUrl.searchParams.get("location") || (productMatch ? productMatch[1] : code);
      code = decodeURIComponent(code);
    } catch {}

    code = code.replace(/^Ref\s+/i, "").trim();
    const normalizedCode = normalizeProductLookupCode(code);

    const values = isSuperAdmin ? [code] : [code, companyId];

    const locationResult = await pool.query(
      `SELECT locations.*, warehouses.name AS warehouse_name
       FROM locations
       LEFT JOIN warehouses ON locations.warehouse_id = warehouses.id
       WHERE locations.emplacement_code=$1 ${
         isSuperAdmin ? "" : "AND locations.company_id=$2"
       }
       LIMIT 1`,
      values
    );

    if (locationResult.rows.length > 0) {
      const location = locationResult.rows[0];

      const productsResult = await pool.query(
        `SELECT *
         FROM products
         WHERE (
           location_id=$1
           OR location_code=$2
           OR reference=$3
         )
         ${isSuperAdmin ? "" : "AND company_id=$4"}
         ORDER BY id DESC`,
        isSuperAdmin
          ? [location.id, location.emplacement_code, location.product_reference || ""]
          : [
              location.id,
              location.emplacement_code,
              location.product_reference || "",
              companyId
            ]
      );

      const movementsResult = await pool.query(
        `SELECT *
         FROM stock_movements
         WHERE (
           location_code=$1
           OR reason ILIKE $2
           OR product_reference = ANY($3::text[])
         )
         ${isSuperAdmin ? "" : "AND company_id=$4"}
         ORDER BY id DESC
         LIMIT 20`,
        isSuperAdmin
          ? [
              location.emplacement_code,
              `%${location.emplacement_code}%`,
              productsResult.rows.map((product) => product.reference)
            ]
          : [
              location.emplacement_code,
              `%${location.emplacement_code}%`,
              productsResult.rows.map((product) => product.reference),
              companyId
            ]
      );

      return res.json({
        type: "location",
        code,
        location,
        products: productsResult.rows,
        movements: movementsResult.rows,
        alerts: productsResult.rows
          .filter(
            (product) =>
              Number(product.stock || 0) <= Number(product.minimum_stock || 0)
          )
          .map((product) => ({
            product_reference: product.reference,
            product_name: product.name,
            stock: product.stock,
            minimum_stock: product.minimum_stock,
            type: Number(product.stock || 0) <= 0 ? "out_of_stock" : "low_stock"
          }))
      });
    }

    const productValues = isSuperAdmin ? [code, normalizedCode] : [code, normalizedCode, companyId];
    const productResult = await pool.query(
      `SELECT products.*, locations.emplacement_code, locations.rayon_code,
              locations.case_code, locations.level_code, locations.bin_code,
              locations.bin_mode, locations.warehouse_code
       FROM products
       LEFT JOIN locations ON products.location_id = locations.id
       WHERE (
         products.reference ILIKE $1
         OR products.barcode ILIKE $1
         OR products.sku ILIKE $1
         OR products.qr_code ILIKE $1
         OR regexp_replace(lower(regexp_replace(COALESCE(products.reference,''), '^ref\\s*[-_]*\\s*', '', 'i')), '[^a-z0-9]', '', 'g') = $2
         OR regexp_replace(lower(COALESCE(products.barcode,'')), '[^a-z0-9]', '', 'g') = $2
         OR regexp_replace(lower(COALESCE(products.sku,'')), '[^a-z0-9]', '', 'g') = $2
         OR regexp_replace(lower(COALESCE(products.qr_code,'')), '[^a-z0-9]', '', 'g') = $2
       )
       ${isSuperAdmin ? "" : "AND products.company_id=$3"}
       LIMIT 1`,
      productValues
    );

    if (productResult.rows.length > 0) {
      const product = productResult.rows[0];
      const batchesResult = await pool.query(
        `SELECT *
         FROM product_batches
         WHERE product_id=$1
         ${isSuperAdmin ? "" : "AND company_id=$2"}
         ORDER BY expiration_date ASC NULLS LAST, received_at ASC NULLS LAST, id ASC
         LIMIT 20`,
        isSuperAdmin ? [product.id] : [product.id, companyId]
      );
      const movementsResult = await pool.query(
        `SELECT *
         FROM stock_movements
         WHERE product_reference=$1
         ${isSuperAdmin ? "" : "AND company_id=$2"}
         ORDER BY id DESC
         LIMIT 20`,
        isSuperAdmin ? [product.reference] : [product.reference, companyId]
      );

      return res.json({
        type: "product",
        code,
        product: {
          ...product,
          qr_url: productQrUrl(req, product),
          effective_sale_price: getEffectivePosPrice(product)
        },
        batches: batchesResult.rows,
        movements: movementsResult.rows,
        alerts:
          Number(product.stock || 0) <= Number(product.minimum_stock || 0)
            ? [
                {
                  product_reference: product.reference,
                  product_name: product.name,
                  stock: product.stock,
                  minimum_stock: product.minimum_stock,
                  type:
                    Number(product.stock || 0) <= 0
                      ? "out_of_stock"
                      : "low_stock"
                }
              ]
            : []
      });
    }

    const userResult = await pool.query(
      `SELECT id, fullname, email, role, badge_code, company_id
       FROM users
       WHERE (badge_code=$1 OR CAST(id AS TEXT)=$1)
       ${isSuperAdmin ? "" : "AND company_id=$2"}
       LIMIT 1`,
      values
    );

    if (userResult.rows.length > 0) {
      const employee = userResult.rows[0];
      const todayResult = await pool.query(
        `SELECT *
         FROM attendance_records
         WHERE user_id=$1 AND work_date=CURRENT_DATE
         LIMIT 1`,
        [employee.id]
      );
      const historyResult = await pool.query(
        `SELECT *
         FROM attendance_history
         WHERE user_id=$1
         ORDER BY id DESC
         LIMIT 10`,
        [employee.id]
      );

      return res.json({
        type: "employee",
        code,
        employee,
        today: todayResult.rows[0] || null,
        history: historyResult.rows
      });
    }

    res.status(404).json({
      error: "QR code introuvable",
      code
    });
  } catch (error) {
    console.error("ERREUR RESOLUTION SCAN :", error);
    res.status(500).json({ error: "Erreur résolution QR code" });
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
app.get("/alerts", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    const stockFaible = await pool.query(
      `SELECT reference, name, stock, minimum_stock, warehouse, location_code
       FROM products
       WHERE stock > 0 AND stock <= minimum_stock
       ${isSuperAdmin ? "" : "AND company_id=$1"}
       ORDER BY stock ASC`
      , isSuperAdmin ? [] : [companyId]
    );

    const rupture = await pool.query(
      `SELECT reference, name, stock, minimum_stock, warehouse, location_code
       FROM products
       WHERE stock <= 0
       ${isSuperAdmin ? "" : "AND company_id=$1"}
       ORDER BY name ASC`
      , isSuperAdmin ? [] : [companyId]
    );

    const validations = await pool.query(
      `SELECT id, type, product_reference, product_name, quantity, status,
              location_code, source_warehouse, destination_warehouse, created_at
       FROM stock_movements
       WHERE status = 'En attente'
       ${isSuperAdmin ? "" : "AND company_id=$1"}
       ORDER BY id DESC`
      , isSuperAdmin ? [] : [companyId]
    );

    const refuses = await pool.query(
      `SELECT id, type, product_reference, product_name, quantity, status,
              location_code, source_warehouse, destination_warehouse, created_at
       FROM stock_movements
       WHERE status = 'Refusé'
       ${isSuperAdmin ? "" : "AND company_id=$1"}
       ORDER BY id DESC`
      , isSuperAdmin ? [] : [companyId]
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
         (user_id, title, message, type, company_id, related_entity_type,
          related_entity_id, action_url, created_by, assigned_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          receiver_id,
          message_type === "audio" ? "Nouveau vocal" : "Nouveau message",
          message_type === "audio"
            ? "Vous avez reçu un message vocal."
            : "Vous avez reçu un nouveau message interne.",
          message_type === "audio" ? "chat_audio" : "chat_message",
          companyId,
          "conversation",
          conversation_id,
          `/chat?conversation=${conversation_id}`,
          sender_id,
          receiver_id
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
    const requestedUserId = Number(req.params.userId);

    if (!isSuperAdmin && requestedUserId !== Number(req.user.id)) {
      return res.status(403).json({
        error: "Accès refusé aux notifications d'un autre utilisateur."
      });
    }

    let query = `
      SELECT *
      FROM notifications
      WHERE (user_id = $1 OR assigned_to = $1)
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
      SET is_read = true, status = 'read'
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

app.post("/meetings", authenticateToken, async (req, res) => {
  try {
    if (!canCreateMeeting(req.user)) {
      return res.status(403).json({
        error: "Vous n'avez pas l'autorisation de créer une réunion."
      });
    }

    const companyId = req.user.company_id;
    const { title, conversation_id, participants = [] } = req.body;
    const roomName = `triangle-wms-${companyId || "global"}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    const meetingUrl = `https://meet.jit.si/${roomName}`;

    const meetingResult = await pool.query(
      `INSERT INTO meetings
       (title, room_name, meeting_url, conversation_id, created_by, company_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        title || "Réunion Triangle WMS",
        roomName,
        meetingUrl,
        conversation_id || null,
        req.user.id,
        companyId || null
      ]
    );

    const meeting = meetingResult.rows[0];
    const participantIds = Array.from(
      new Set([req.user.id, ...participants.map((id) => Number(id)).filter(Boolean)])
    );

    for (const participantId of participantIds) {
      await pool.query(
        `INSERT INTO meeting_participants (meeting_id, user_id)
         VALUES ($1,$2)
         ON CONFLICT (meeting_id, user_id) DO NOTHING`,
        [meeting.id, participantId]
      );

      if (participantId !== Number(req.user.id)) {
        await createNotification({
          user_id: participantId,
          title: "Invitation réunion",
          message: `${req.user.email || "Un utilisateur"} vous invite à une réunion.`,
          type: "meeting_invitation",
          company_id: companyId,
          priority: "high",
          related_entity_type: "meeting",
          related_entity_id: meeting.id,
          action_url: meetingUrl,
          created_by: req.user.id,
          assigned_to: participantId
        });
      }
    }

    res.status(201).json({
      ...meeting,
      participants: participantIds
    });
  } catch (error) {
    console.error("ERREUR CREATION REUNION :", error);
    res.status(500).json({ error: "Erreur création réunion" });
  }
});

app.get("/meetings", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    const result = await pool.query(
      `SELECT m.*
       FROM meetings m
       LEFT JOIN meeting_participants mp ON mp.meeting_id = m.id
       WHERE ($1::boolean = true OR m.company_id=$2)
       AND ($1::boolean = true OR mp.user_id=$3 OR m.created_by=$3)
       ORDER BY m.id DESC`,
      [isSuperAdmin, companyId, req.user.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR LECTURE REUNIONS :", error);
    res.status(500).json({ error: "Erreur lecture réunions" });
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
app.get("/attendance/today", authenticateToken, async (req, res) => {
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

    res.json(records.map((row) => stripSalaryFields(row, req.user)));
  } catch (error) {
    console.error("ERREUR ATTENDANCE TODAY :", error);
    res.status(500).json({ error: "Erreur récupération pointage" });
  }
});
/* POINTAGES DU JOUR SAAS */
app.get("/attendance/today", authenticateToken, async (req, res) => {
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

app.get("/attendance/history/:userId", authenticateToken, async (req, res) => {
  try {
    const requestedUserId = Number(req.params.userId);
    const role = normalizeRole(req.user.role);

    if (
      requestedUserId !== Number(req.user.id) &&
      !canViewAllSalaries(req.user) &&
      role !== "admin" &&
      role !== "responsable_entrepot" &&
      role !== "chef_entrepot"
    ) {
      return res.status(403).json({ error: "Accès refusé." });
    }

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

app.post("/attendance/check", authenticateToken, async (req, res) => {
  try {
    const { user_id, action_type, device_info, ip_address, location_info } =
      req.body;

    if (!user_id || !action_type) {
      return res.status(400).json({
        error: "Utilisateur et type d'action obligatoires"
      });
    }

    if (Number(user_id) !== Number(req.user.id) && !canViewAllSalaries(req.user)) {
      return res.status(403).json({ error: "Accès refusé." });
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

app.put(
  "/attendance/settings/users/:id",
  authenticateToken,
  authorizeRoles("admin", "super_admin"),
  async (req, res) => {
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

    const canEditSalary = canViewAllSalaries(req.user);

    await pool.query(
      `UPDATE users
       SET schedule_group_id=$1,
           payment_type=CASE WHEN $6::boolean THEN $2 ELSE payment_type END,
           hourly_rate=CASE WHEN $6::boolean THEN $3 ELSE hourly_rate END,
           daily_rate=CASE WHEN $6::boolean THEN $4 ELSE daily_rate END
       WHERE id=$5`,
      [
        schedule_group_id || null,
        salary_type || "horaire",
        Number(hourly_rate || 0),
        Number(daily_rate || 0),
        id,
        canEditSalary
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
         salary_type=CASE WHEN $9::boolean THEN EXCLUDED.salary_type ELSE attendance_settings.salary_type END,
         hourly_rate=CASE WHEN $9::boolean THEN EXCLUDED.hourly_rate ELSE attendance_settings.hourly_rate END,
         daily_salary=CASE WHEN $9::boolean THEN EXCLUDED.daily_salary ELSE attendance_settings.daily_salary END,
         monthly_salary=CASE WHEN $9::boolean THEN EXCLUDED.monthly_salary ELSE attendance_settings.monthly_salary END,
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
        group?.end_time || "17:00",
        canEditSalary
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
      ...stripSalaryFields(userResult.rows[0], req.user),
      attendance_settings: settingsResult.rows[0]
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur paramètres utilisateur pointage" });
  }
});

app.get("/attendance/settings/gps", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `INSERT INTO attendance_gps_settings
       (id, gps_required, site_name, allowed_radius_meters,
        allow_remote_attendance, kiosk_mode, employee_scanner_access)
       VALUES (1, false, '', 100, false, true, false)
       ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id
       RETURNING *`
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture paramètres GPS pointage" });
  }
});

app.put(
  "/attendance/settings/gps",
  authenticateToken,
  authorizeRoles("admin", "super_admin"),
  async (req, res) => {
    try {
      const {
        gps_required,
        site_name,
        site_latitude,
        site_longitude,
        allowed_radius_meters,
        allow_remote_attendance,
        kiosk_mode,
        employee_scanner_access
      } = req.body;

      const result = await pool.query(
        `INSERT INTO attendance_gps_settings
         (id, gps_required, site_name, site_latitude, site_longitude,
          allowed_radius_meters, allow_remote_attendance, kiosk_mode,
          employee_scanner_access, updated_by)
         VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id)
         DO UPDATE SET
           gps_required=EXCLUDED.gps_required,
           site_name=EXCLUDED.site_name,
           site_latitude=EXCLUDED.site_latitude,
           site_longitude=EXCLUDED.site_longitude,
           allowed_radius_meters=EXCLUDED.allowed_radius_meters,
           allow_remote_attendance=EXCLUDED.allow_remote_attendance,
           kiosk_mode=EXCLUDED.kiosk_mode,
           employee_scanner_access=EXCLUDED.employee_scanner_access,
           updated_by=EXCLUDED.updated_by,
           updated_at=CURRENT_TIMESTAMP
         RETURNING *`,
        [
          gps_required === true,
          site_name || "",
          site_latitude === "" || site_latitude === null || site_latitude === undefined
            ? null
            : Number(site_latitude),
          site_longitude === "" || site_longitude === null || site_longitude === undefined
            ? null
            : Number(site_longitude),
          Number(allowed_radius_meters || 100),
          allow_remote_attendance === true,
          kiosk_mode !== false,
          employee_scanner_access === true,
          req.user.id
        ]
      );

      res.json(result.rows[0]);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur sauvegarde paramètres GPS pointage" });
    }
  }
);

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

function assistantScope(user, values) {
  const isSuperAdmin =
    user?.is_super_admin === true ||
    user?.is_super_admin === "true" ||
    user?.is_super_admin === 1 ||
    String(user?.role || "").toLowerCase() === "super_admin";
  const companyId = user?.company_id || null;

  if (isSuperAdmin || !companyId) {
    return "";
  }

  values.push(companyId);
  return `company_id=$${values.length}`;
}

function chooseAssistantTools(message) {
  const text = String(message || "").toLowerCase();
  const tools = new Set();

  if (/produit|products?/.test(text)) tools.add("get_products");
  if (/stock|reste|rupture|faible/.test(text)) tools.add("get_stock");
  if (/mouvement|entrée|sortie|transfert|dernier/.test(text)) tools.add("get_last_movement");
  if (/vente|caisse|pos|vendu|aujourd/.test(text)) tools.add("get_sales_today");
  if (/alerte|rupture|faible/.test(text)) tools.add("get_alerts");
  if (/utilisateur|employé|user|personnel/.test(text)) tools.add("get_users");
  if (/inventaire/.test(text)) tools.add("get_inventory");
  if (/document|reçu|bon|rapport/.test(text)) tools.add("get_documents");
  if (/entrepôt|entrepot|warehouse/.test(text)) tools.add("get_warehouses");
  if (/emplacement|location|rayon|bin/.test(text)) tools.add("get_locations");

  if (/combien de produits|nombre de produits/.test(text)) tools.add("get_products");
  if (/combien de stock|stock total|stock reste/.test(text)) tools.add("get_stock");
  if (/dernier mouvement/.test(text)) tools.add("get_last_movement");

  if (tools.size === 0) {
    tools.add("get_stock");
    tools.add("get_last_movement");
    tools.add("get_alerts");
  }

  return Array.from(tools);
}

async function runAssistantTool(toolName, user) {
  const values = [];
  const scope = assistantScope(user, values);
  const where = scope ? `WHERE ${scope}` : "";
  const andScope = scope ? `AND ${scope}` : "";

  if (toolName === "get_products") {
    const summary = await pool.query(
      `SELECT COUNT(*)::int AS total FROM products ${where}`,
      values
    );
    const rows = await pool.query(
      `SELECT id, reference, name, category, stock, minimum_stock, warehouse,
              location_code, sale_price, created_at
       FROM products ${where}
       ORDER BY id DESC
       LIMIT 20`,
      values
    );
    return { summary: summary.rows[0], rows: rows.rows };
  }

  if (toolName === "get_stock") {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS total_products,
              COALESCE(SUM(stock),0)::numeric AS total_stock,
              COUNT(*) FILTER (WHERE stock <= 0)::int AS out_of_stock,
              COUNT(*) FILTER (WHERE stock > 0 AND stock <= minimum_stock)::int AS low_stock
       FROM products ${where}`,
      values
    );
    return result.rows[0];
  }

  if (toolName === "get_last_movement") {
    const result = await pool.query(
      `SELECT id, type, product_reference, product_name, quantity, status,
              created_by_name, created_by_role, source_warehouse,
              destination_warehouse, created_at
       FROM stock_movements ${where}
       ORDER BY created_at DESC NULLS LAST, id DESC
       LIMIT 5`,
      values
    );
    return result.rows;
  }

  if (toolName === "get_sales_today") {
    const result = await pool.query(
      `SELECT id, sale_number, customer_name, total_amount, amount_paid,
              amount_due, payment_method, payment_status, status,
              created_by_name, created_at
       FROM sales
       WHERE DATE(created_at)=CURRENT_DATE ${andScope}
       ORDER BY id DESC
       LIMIT 50`,
      values
    );
    const total = await pool.query(
      `SELECT COUNT(*)::int AS sales_count,
              COALESCE(SUM(total_amount),0)::numeric AS total_amount,
              COALESCE(SUM(amount_paid),0)::numeric AS amount_paid,
              COALESCE(SUM(amount_due),0)::numeric AS amount_due
       FROM sales
       WHERE DATE(created_at)=CURRENT_DATE ${andScope}`,
      values
    );
    return { summary: total.rows[0], rows: result.rows };
  }

  if (toolName === "get_alerts") {
    const result = await pool.query(
      `SELECT id, reference, name, stock, minimum_stock,
              CASE
                WHEN stock <= 0 THEN 'rupture'
                WHEN stock <= minimum_stock THEN 'stock faible'
                ELSE 'ok'
              END AS alert_type
       FROM products
       WHERE (stock <= 0 OR stock <= minimum_stock) ${andScope}
       ORDER BY stock ASC, id DESC
       LIMIT 30`,
      values
    );
    return result.rows;
  }

  if (toolName === "get_users") {
    const result = await pool.query(
      `SELECT id, fullname, email, role, is_active, company_id, warehouse_id,
              created_at
       FROM users ${where}
       ORDER BY id DESC
       LIMIT 50`,
      values
    );
    return result.rows;
  }

  if (toolName === "get_inventory") {
    const result = await pool.query(
      `SELECT id, product_reference, product_name, old_quantity, new_quantity,
              difference, status, created_by_name, created_at
       FROM inventory_history ${where}
       ORDER BY created_at DESC NULLS LAST, id DESC
       LIMIT 50`,
      values
    );
    return result.rows;
  }

  if (toolName === "get_documents") {
    const result = await pool.query(
      `SELECT id, document_type, document_number, client_name, total_amount,
              status, created_by, created_at
       FROM documents ${where}
       ORDER BY created_at DESC NULLS LAST, id DESC
       LIMIT 50`,
      values
    );
    return result.rows;
  }

  if (toolName === "get_warehouses") {
    const result = await pool.query(
      `SELECT id, name, code, location, manager, status, created_at
       FROM warehouses ${where}
       ORDER BY id DESC
       LIMIT 50`,
      values
    );
    return result.rows;
  }

  if (toolName === "get_locations") {
    const result = await pool.query(
      `SELECT id, emplacement_code, warehouse_id, warehouse_code, rayon_code,
              case_code, level_code, bin_code, product_reference,
              product_name, status, created_at
       FROM locations ${where}
       ORDER BY id DESC
       LIMIT 50`,
      values
    );
    return result.rows;
  }

  return null;
}

function buildLocalAssistantAnswer(message, toolResults) {
  const lines = ["Voici les informations WMS trouvées :"];

  for (const item of toolResults) {
    if (item.tool === "get_products") {
      lines.push(`- Produits : ${item.data?.summary?.total || 0} produit(s).`);
    } else if (item.tool === "get_stock") {
      lines.push(
        `- Stock total : ${Number(item.data?.total_stock || 0).toLocaleString("fr-FR", { maximumFractionDigits: 0 })}. Ruptures : ${item.data?.out_of_stock || 0}. Stocks faibles : ${item.data?.low_stock || 0}.`
      );
    } else if (item.tool === "get_last_movement") {
      const first = Array.isArray(item.data) ? item.data[0] : null;
      lines.push(
        first
          ? `- Dernier mouvement : ${first.type || "-"} ${first.product_reference || ""} (${first.quantity || 0}) le ${first.created_at ? new Date(first.created_at).toLocaleString("fr-FR") : "-"}`
          : "- Aucun mouvement trouvé."
      );
    } else if (item.tool === "get_sales_today") {
      lines.push(
        `- Ventes aujourd’hui : ${item.data?.summary?.sales_count || 0} vente(s), total ${Number(item.data?.summary?.total_amount || 0).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} FCFA.`
      );
    } else if (item.tool === "get_alerts") {
      lines.push(`- Alertes stock : ${Array.isArray(item.data) ? item.data.length : 0} élément(s).`);
    } else if (item.tool === "get_users") {
      lines.push(`- Utilisateurs : ${Array.isArray(item.data) ? item.data.length : 0} affiché(s).`);
    } else if (item.tool === "get_inventory") {
      lines.push(`- Inventaires : ${Array.isArray(item.data) ? item.data.length : 0} ligne(s) récente(s).`);
    } else if (item.tool === "get_documents") {
      lines.push(`- Documents : ${Array.isArray(item.data) ? item.data.length : 0} document(s) récent(s).`);
    } else if (item.tool === "get_warehouses") {
      lines.push(`- Entrepôts : ${Array.isArray(item.data) ? item.data.length : 0} affiché(s).`);
    } else if (item.tool === "get_locations") {
      lines.push(`- Emplacements : ${Array.isArray(item.data) ? item.data.length : 0} affiché(s).`);
    }
  }

  lines.push("");
  lines.push(`Question : ${message}`);
  return lines.join("\n");
}

app.post("/assistant/query", authenticateToken, async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || String(message).trim() === "") {
      return res.status(400).json({ error: "Message obligatoire" });
    }

    const selectedTools = chooseAssistantTools(message);
    const toolResults = [];

    for (const tool of selectedTools) {
      const data = await runAssistantTool(tool, req.user);
      toolResults.push({ tool, data });
    }

    if (!process.env.OPENROUTER_API_KEY) {
      return res.json({
        answer: buildLocalAssistantAnswer(message, toolResults),
        tools_used: selectedTools,
        data: toolResults
      });
    }

    const aiResponse = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://trianglewmspro.com",
          "X-Title": "Triangle WMS Pro"
        },
        body: JSON.stringify({
          model: "openrouter/auto",
          messages: [
            {
              role: "system",
              content:
                "Tu es l'assistant IA connecté au WMS Triangle WMS Pro. Réponds en français simple et professionnel. Utilise uniquement les données fournies par les outils internes. Si une liste est longue, résume les éléments importants. Ne dis jamais que tu n'as pas accès aux données quand des résultats d'outils sont fournis."
            },
            {
              role: "user",
              content: `Question utilisateur : ${message}\n\nOutils exécutés : ${selectedTools.join(", ")}\n\nRésultats JSON :\n${JSON.stringify(toolResults, null, 2)}`
            }
          ]
        })
      }
    );

    const payload = await aiResponse.json();

    if (!aiResponse.ok) {
      return res.json({
        answer: buildLocalAssistantAnswer(message, toolResults),
        tools_used: selectedTools,
        data: toolResults,
        warning: "OpenRouter indisponible, réponse locale générée depuis les données WMS."
      });
    }

    res.json({
      answer:
        payload?.choices?.[0]?.message?.content ||
        buildLocalAssistantAnswer(message, toolResults),
      tools_used: selectedTools,
      data: toolResults
    });
  } catch (error) {
    console.error("ERREUR ASSISTANT QUERY :", error);
    res.status(500).json({ error: "Erreur assistant IA connecté WMS" });
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
      return res.json({
        answer:
          "Assistant IA non configuré. Ajoutez OPENROUTER_API_KEY dans le fichier .env. En attendant, je peux vous conseiller de vérifier les produits, stocks, mouvements, alertes, documents et rapports depuis le menu Triangle WMS Pro."
      });
    }

    const companyId = user?.company_id || null;
    const isSuperAdmin = user?.is_super_admin === true;
    const contextValues = isSuperAdmin || !companyId ? [] : [companyId];
    const companyClause = isSuperAdmin || !companyId ? "" : "WHERE company_id=$1";
    const movementClause = isSuperAdmin || !companyId ? "" : "WHERE company_id=$1";
    const productStats = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(stock),0)::int AS stock_total,
              COUNT(*) FILTER (WHERE stock <= minimum_stock)::int AS alertes
       FROM products ${companyClause}`,
      contextValues
    );
    const movementStats = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='En attente')::int AS en_attente
       FROM stock_movements ${movementClause}`,
      contextValues
    );

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
              content: `Utilisateur connecté : ${user?.fullname || "Utilisateur"} | Rôle : ${user?.role || "non défini"}\nContexte WMS réel résumé : produits=${productStats.rows[0]?.total || 0}, stock_total=${productStats.rows[0]?.stock_total || 0}, alertes_stock=${productStats.rows[0]?.alertes || 0}, mouvements=${movementStats.rows[0]?.total || 0}, mouvements_en_attente=${movementStats.rows[0]?.en_attente || 0}.\n\nQuestion : ${message}`
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
app.post("/chat/upload-audio", authenticateToken, upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "Aucun fichier audio reçu"
      });
    }

    const audioUrl = publicUploadUrl(req, req.file.filename);

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
      WHERE name IN ('Essentiel', 'Starter', 'Standard', 'Premium')
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
    const totalStock = await pool.query(
      "SELECT COALESCE(SUM(stock), 0) AS total FROM products"
    );
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
      total_stock: Number(totalStock.rows[0].total),
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

    res.json(records.map((row) => stripSalaryFields(row, req.user)));
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
    const { badge_code, action_type, latitude, longitude, accuracy } = req.body;

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

    const gpsSettingsResult = await pool.query(
      `INSERT INTO attendance_gps_settings
       (id, gps_required, site_name, allowed_radius_meters,
        allow_remote_attendance, kiosk_mode, employee_scanner_access)
       VALUES (1, false, '', 100, false, true, false)
       ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id
       RETURNING *`
    );
    const gpsSettings = gpsSettingsResult.rows[0] || {};
    const gpsRequired = gpsSettings.gps_required === true;
    const allowRemoteAttendance = gpsSettings.allow_remote_attendance === true;
    const lat = latitude === "" || latitude === null || latitude === undefined ? null : Number(latitude);
    const lon = longitude === "" || longitude === null || longitude === undefined ? null : Number(longitude);
    const gpsAccuracy = accuracy === "" || accuracy === null || accuracy === undefined ? null : Number(accuracy);
    const siteLat = gpsSettings.site_latitude === null || gpsSettings.site_latitude === undefined ? null : Number(gpsSettings.site_latitude);
    const siteLon = gpsSettings.site_longitude === null || gpsSettings.site_longitude === undefined ? null : Number(gpsSettings.site_longitude);
    const allowedRadius = Number(gpsSettings.allowed_radius_meters || 100);

    if (gpsRequired && (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon))) {
      return res.status(403).json({
        error: "Pointage refusé : localisation obligatoire."
      });
    }

    if (gpsRequired && (siteLat === null || siteLon === null || !Number.isFinite(siteLat) || !Number.isFinite(siteLon))) {
      return res.status(403).json({
        error: "Pointage refusé : impossible d’obtenir votre position."
      });
    }

    let distanceMeters = null;
    let isInsideZone = null;

    if (
      lat !== null &&
      lon !== null &&
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      siteLat !== null &&
      siteLon !== null &&
      Number.isFinite(siteLat) &&
      Number.isFinite(siteLon)
    ) {
      distanceMeters = calculateDistanceMeters(siteLat, siteLon, lat, lon);
      isInsideZone = distanceMeters <= allowedRadius;
    }

    if (gpsRequired && !allowRemoteAttendance && !isInsideZone) {
      return res.status(403).json({
        error: "Pointage refusé : vous êtes hors de la zone autorisée.",
        distance_meters: distanceMeters,
        allowed_radius_meters: allowedRadius
      });
    }

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

    const updatedAttendance = await pool.query(
      `UPDATE attendance_records
       SET latitude=$1,
           longitude=$2,
           accuracy=$3,
           distance_meters=$4,
           is_inside_zone=$5,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$6
       RETURNING *`,
      [
        lat,
        lon,
        gpsAccuracy,
        distanceMeters,
        isInsideZone,
        result.rows[0].id
      ]
    );

    await pool.query(
      `INSERT INTO attendance_history
       (user_id, action_type, device_info, location_info,
        latitude, longitude, accuracy, distance_meters, is_inside_zone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        user.id,
        action_type,
        "QR",
        lat !== null && lon !== null ? `${lat},${lon}` : "",
        lat,
        lon,
        gpsAccuracy,
        distanceMeters,
        isInsideZone
      ]
    );

    res.json({
      success: true,
      user,
      attendance: updatedAttendance.rows[0] || result.rows[0],
      action,
      gps: {
        gps_required: gpsRequired,
        site_name: gpsSettings.site_name || "",
        distance_meters: distanceMeters,
        allowed_radius_meters: allowedRadius,
        is_inside_zone: isInsideZone,
        allow_remote_attendance: allowRemoteAttendance
      }
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

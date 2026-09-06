const express = require("express");
const cors = require("cors");
const { Pool, types: pgTypes } = require("pg");

/* Les colonnes DATE (OID 1082) sont renvoyées en TEXTE brut « AAAA-MM-JJ ».
   Par défaut le pilote les convertit en objet Date, sérialisé ensuite en
   horodatage UTC : « 2026-08-09 » devenait « 2026-08-08T22:00:00.000Z » et les
   documents imprimés affichaient LA VEILLE en soirée. Ce bug est apparu trois
   fois (bon de réception, état sable, bon de livraison ciment) ; on le traite
   ici à la source plutôt que requête par requête.
   Une DATE n'a ni heure ni fuseau : la garder en texte est aussi plus juste.
   Les colonnes TIMESTAMP ne sont pas concernées. */
pgTypes.setTypeParser(1082, (value) => value);

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const QRCode = require("qrcode");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
/* Entreprise d'appartenance et badge : une seule règle, côté serveur. */
const companyContext = require("./services/company-context");
const accesSocietes = require("./services/acces-societes");
const identifiants = require("./services/identifiants");
const stockLocations = require("./services/stock-locations");
const locationHierarchy = require("./services/location-hierarchy");
const documentDates = require("./services/document-dates");
require("dotenv").config();

let webPush = null;
try {
  webPush = require("web-push");
} catch (error) {
  webPush = null;
}

const app = express();

const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.PUBLIC_BASE_URL,
  "https://trianglewmspro.com",
  "https://www.trianglewmspro.com",
  "https://malilinkglobal.com",
  "https://www.malilinkglobal.com",
  "https://hafiyalab.com",
  "https://www.hafiyalab.com",
  "https://afia.trianglewmspro.com",
  "https://malilink.trianglewmspro.com",
  "http://localhost:3000"
].filter(Boolean);

app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=(self)");
  next();
});

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origine CORS non autorisée"));
    },
    credentials: true
  })
);

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  if (req.url.startsWith("/api/")) {
    req.url = req.url.slice(4);
  }

  next();
});

app.use(requireTenant);

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

const productUploadDir = path.join(__dirname, "uploads", "products");
const laboratoryUploadDir = path.join(__dirname, "uploads", "laboratory");

if (!fs.existsSync(productUploadDir)) {
  fs.mkdirSync(productUploadDir, { recursive: true });
}

if (!fs.existsSync(laboratoryUploadDir)) {
  fs.mkdirSync(laboratoryUploadDir, { recursive: true });
}

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const baseName = path
      .basename(file.originalname || "upload", ext)
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-_]/g, "");
    const uniqueName = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${baseName || "upload"}${ext}`;
    cb(null, uniqueName);
  }
});

const allowedUploadMimeTypes = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "application/pdf",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/wav",
  "audio/webm",
  "audio/ogg"
]);

const blockedUploadExtensions = new Set([
  ".php",
  ".exe",
  ".js",
  ".mjs",
  ".cjs",
  ".sh",
  ".bat",
  ".cmd",
  ".ps1",
  ".html",
  ".htm",
  ".svg"
]);

function secureUploadFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || "").toLowerCase();

  if (blockedUploadExtensions.has(ext)) {
    return cb(new Error("Type de fichier interdit pour des raisons de sécurité."));
  }

  if (!allowedUploadMimeTypes.has(file.mimetype)) {
    return cb(new Error("Format de fichier non autorisé."));
  }

  cb(null, true);
}

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: secureUploadFileFilter
});

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

const laboratoryResultStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, laboratoryUploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const baseName = path
      .basename(file.originalname || "resultat-laboratoire", ext)
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-_]/g, "");
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}-${baseName || "resultat"}${ext}`);
  }
});

const uploadLaboratoryResult = multer({
  storage: laboratoryResultStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const allowed = new Set(["application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp"]);
    if (!allowed.has(file.mimetype)) {
      return cb(new Error("Format résultat non autorisé. Utilisez PDF, JPG, PNG ou WEBP."));
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

const JWT_SECRET = process.env.JWT_SECRET || "triangle_wms_secret_key";
const BCRYPT_ROUNDS = 12;

if (!process.env.JWT_SECRET && process.env.NODE_ENV === "production") {
  console.warn("AVERTISSEMENT SECURITE: JWT_SECRET absent du fichier .env.");
}

const SUPER_ADMIN_EMAILS = new Set([
  "diallogcif@gmail.com"
]);

const VALID_TENANTS = new Set(["triangle", "malilink", "hafiya"]);

function normalizeTenantId(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  return VALID_TENANTS.has(normalized) ? normalized : "";
}

function getTenantFromRequest(req) {
  const rawHeaderTenant =
    req?.headers?.["x-tenant-id"] ||
    req?.headers?.["x-app-product"] ||
    req?.headers?.["x-product-id"] ||
    req?.query?.tenant_id;
  const headerTenant = normalizeTenantId(rawHeaderTenant);

  if (headerTenant) return headerTenant;
  if (rawHeaderTenant) return "__invalid__";

  const host = String(
    req?.headers?.host ||
      req?.headers?.["x-forwarded-host"] ||
      req?.hostname ||
      ""
  )
    .split(",")[0]
    .split(":")[0]
    .toLowerCase();

  if (host.includes("malilinkglobal.com") || host.includes("malilink.trianglewmspro.com")) {
    return "malilink";
  }
  if (host.includes("hafiyalab.com") || host.includes("afia.trianglewmspro.com")) {
    return "hafiya";
  }
  return normalizeTenantId(process.env.DEFAULT_TENANT_ID) || "triangle";
}

function requireTenant(req, res, next) {
  const tenantId = getTenantFromRequest(req);
  if (!VALID_TENANTS.has(tenantId)) {
    return res.status(400).json({ error: "Tenant invalide." });
  }

  req.tenant_id = tenantId;
  res.locals.tenant_id = tenantId;
  next();
}

function parseCookieHeader(req) {
  return String(req?.headers?.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex === -1) return cookies;
      const key = decodeURIComponent(part.slice(0, separatorIndex).trim());
      const value = decodeURIComponent(part.slice(separatorIndex + 1).trim());
      cookies[key] = value;
      return cookies;
    }, {});
}

function getAuthTokenFromRequest(req) {
  const authHeader = req?.headers?.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : "";
  if (bearerToken) return bearerToken;

  const cookies = parseCookieHeader(req);
  return cookies.auth_token || cookies.triangle_auth_token || "";
}

function setSecureAuthCookies(req, res, token, tenantId) {
  const secure =
    req?.secure === true ||
    String(req?.headers?.["x-forwarded-proto"] || "").includes("https") ||
    process.env.NODE_ENV === "production";
  const options = {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: 24 * 60 * 60 * 1000
  };

  res.cookie("auth_token", token, options);
  res.cookie("tenant_id", tenantId, options);
}

async function companyBelongsToTenant(companyId, tenantId) {
  if (!companyId || !tenantId) return true;
  if (!(await columnExists("companies", "tenant_id"))) return true;

  const result = await pool.query(
    "SELECT tenant_id FROM companies WHERE id=$1 LIMIT 1",
    [companyId]
  );
  const companyTenant = normalizeTenantId(result.rows[0]?.tenant_id) || "triangle";
  return companyTenant === tenantId;
}

function getCompanyFilter(req) {
  const userIsSuperAdmin =
    req.user?.is_super_admin === true ||
    normalizeRole(req.user?.role) === "super_admin";
  const companyId = userIsSuperAdmin
    ? getEffectiveCompanyId(req)
    : req.user?.company_id || null;

  return {
    companyId,
    isSuperAdmin: userIsSuperAdmin,
    shouldFilterByCompany: !userIsSuperAdmin || Boolean(companyId)
  };
}

function isSuperAdminUser(user) {
  return user?.is_super_admin === true || normalizeRole(user?.role) === "super_admin";
}

function getRequestedActiveCompanyId(req) {
  const raw =
    req?.headers?.["x-active-company-id"] ||
    req?.headers?.["x-company-id"] ||
    req?.body?.company_id ||
    req?.body?.active_company_id ||
    req?.query?.active_company_id;
  const numeric = Number(raw);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

/**
 * SOCIÉTÉS QU'UN COMPTE NON SUPER ADMIN PEUT ATTEINDRE.
 *
 * Rempli par `authenticateToken` à partir de `user_company_access`
 * (migration 079). Absent ou vide, on retombe sur le comportement d'avant :
 * la seule société d'origine. Une liste manquante ne doit jamais élargir.
 */
function societesHabilitees(user) {
  const liste = Array.isArray(user?.societes_autorisees) ? user.societes_autorisees : [];
  return liste.map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * La bascule demandée est-elle légitime pour ce compte ?
 *
 * Volontairement plus stricte que pour un super admin : on n'accepte QUE
 * l'en-tête ou le paramètre d'URL, jamais `req.body.company_id`. Le corps
 * d'une requête décrit une donnée — un employé, un document — et porte
 * couramment un `company_id` qui ne demande aucune bascule. L'accorder ici
 * ferait écrire un comptable habilité dans l'autre société sans qu'il l'ait
 * demandé.
 */
function societeDemandeeAutorisee(req) {
  const habilitees = societesHabilitees(req.user);
  if (!habilitees.length) return null;
  const brut =
    req?.headers?.["x-active-company-id"] ||
    req?.headers?.["x-company-id"] ||
    req?.query?.active_company_id;
  const demande = Number(brut);
  if (!Number.isInteger(demande) || demande <= 0) return null;
  return habilitees.includes(demande) ? demande : null;
}

function getEffectiveCompanyId(req, fallback = null) {
  if (isSuperAdminUser(req.user)) {
    return getRequestedActiveCompanyId(req) || Number(req.user?.company_id || 0) || fallback || null;
  }
  return (
    societeDemandeeAutorisee(req) || Number(req.user?.company_id || 0) || fallback || null
  );
}

/**
 * L'ENTREPRISE ADMINISTRÉE, SANS LIRE LE CORPS DE LA REQUÊTE.
 *
 * `getRequestedActiveCompanyId` accepte `req.body.company_id`. C'est commode
 * pour un super admin qui bascule d'entreprise, mais sur une route d'écriture
 * le danger est réel : `company_id` est aussi un nom de champ de données. Un
 * corps qui décrit un emplacement et porte « company_id: 2 » ne demande pas à
 * changer d'entreprise — il décrit un emplacement. La route le redirigeait
 * pourtant vers la société 2.
 *
 * La bascule reste possible, mais seulement là où elle est INTENTIONNELLE :
 * l'en-tête `x-active-company-id` ou le paramètre d'URL. Le corps ne décide
 * plus de la société dans laquelle on écrit.
 */
function getEffectiveCompanyIdStrict(req, fallback = null) {
  if (isSuperAdminUser(req.user)) {
    const entete =
      req?.headers?.["x-active-company-id"] ||
      req?.headers?.["x-company-id"] ||
      req?.query?.active_company_id;
    const demande = Number(entete);
    const explicite = Number.isInteger(demande) && demande > 0 ? demande : null;
    return explicite || Number(req.user?.company_id || 0) || fallback || null;
  }
  /* Un compte habilité (079) bascule aux mêmes conditions : en-tête ou
     paramètre d'URL, jamais le corps. */
  return (
    societeDemandeeAutorisee(req) || Number(req.user?.company_id || 0) || fallback || null
  );
}

async function getCompanySettingsForCompany(clientOrPool, companyId) {
  const result = await clientOrPool.query(
    `SELECT *
     FROM company_settings
     WHERE ($1::int IS NULL OR company_id=$1)
     ORDER BY CASE WHEN company_id=$1 THEN 0 ELSE 1 END, id ASC
     LIMIT 1`,
    [companyId || null]
  );

  return result.rows[0] || null;
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

function canAccessAdminSettings(user) {
  const role = normalizeRole(user?.role);
  return user?.is_super_admin === true || role === "super_admin" || role === "admin";
}

function canAccessDirectionModule(user) {
  const role = normalizeRole(user?.role);
  return (
    canAccessAdminSettings(user) ||
    role === "directeur" ||
    role === "direction"
  );
}


/* Numéro de document COURT et lisible : PREFIX-AAMMJJ-NNN (ex. BR-260801-001).
   L'implémentation vit dans services/numerotation-documents.js, pour que les
   scripts de correction appellent la MÊME série au lieu d'en réinventer une
   parallèle — ce qui distribuerait des numéros que l'application redonnerait
   ensuite à d'autres bons. */
const { nextShortDocumentNumber: numeroterDocument } =
  require("./services/numerotation-documents");

async function nextShortDocumentNumber(prefix, companyId, client = pool) {
  return numeroterDocument(prefix, companyId, client);
}

const rbacTriangle = require("./rbac-triangle");
const permissionsService = require("./services/permissions");
/* Le garde de TOUTES les routes vient du centre des droits, pas de l'ancien
   moteur. Celui-ci ne lisait que `user_permissions` : une permission accordée
   dans le nouvel écran — écrite dans `user_permission_overrides` — restait
   invisible pour lui, et l'employé se voyait refuser ce qu'on venait de lui
   donner. Le nouveau moteur consulte les deux, l'ancien modèle servant de
   repli, si bien qu'aucun compte configuré autrefois ne perd son accès. */
const requirePermission = permissionsService.creerRequirePermission(pool);

/* Repli historique (utilisé UNIQUEMENT si aucune permission explicite n'est
   configurée pour l'utilisateur). `responsable_entrepot` est ajouté : ce rôle
   figure dans l'écran Permissions et devait pouvoir valider. */
function canValidateStockMovement(user) {
  const role = normalizeRole(user?.role);
  return (
    user?.is_super_admin === true ||
    role === "admin" ||
    role === "super_admin" ||
    role === "chef_entrepot" ||
    role === "chef d'entrepôt" ||
    role === "chef d'entrepot" ||
    role === "responsable_entrepot" ||
    role === "responsable d'entrepôt" ||
    role === "responsable d'entrepot"
  );
}

/**
 * Validation d'un mouvement : la table `user_permissions` est la SOURCE DE
 * VÉRITÉ (case « Valider » du module stock). Si aucune ligne explicite n'existe
 * pour cet utilisateur, on retombe sur les rôles historiques ci-dessus.
 * Corrige le bug : une case cochée n'était jamais consultée par le backend.
 */
async function canValidateStockMovementAsync(user) {
  if (rbacTriangle.isSuperAdmin(user)) return true;
  const perms = await rbacTriangle.loadUserPermissions(pool, user?.id);
  const row = perms.get("stock") || null;
  if (row && row.can_validate === true) return true;   // case cochée = autorisé
  if (row && row.can_validate === false) return false;  // case décochée = refusé
  return canValidateStockMovement(user);                // aucune config -> repli rôle
}

function isReadOnlyRole(user) {
  const role = normalizeRole(user?.role);
  return role === "direction" || role === "client";
}

function canViewAllSalaries(user) {
  const role = normalizeRole(user?.role);
  return user?.is_super_admin === true || role === "super_admin" || role === "comptable";
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

function canManageCaisses(user) {
  const role = normalizeRole(user?.role);
  return user?.is_super_admin === true || role === "super_admin" || role === "admin";
}

function canViewAccounting(user) {
  const role = normalizeRole(user?.role);
  return (
    user?.is_super_admin === true ||
    role === "super_admin" ||
    role === "admin" ||
    role === "comptable" ||
    role === "direction" ||
    role === "directeur"
  );
}

function canManageAccounting(user) {
  const role = normalizeRole(user?.role);
  return (
    user?.is_super_admin === true ||
    role === "super_admin" ||
    role === "admin" ||
    role === "comptable"
  );
}

function canApproveAccounting(user) {
  const role = normalizeRole(user?.role);
  return (
    user?.is_super_admin === true ||
    role === "super_admin" ||
    role === "admin" ||
    role === "direction" ||
    role === "directeur"
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

function isBcryptHash(value) {
  return /^\$2[aby]\$\d{2}\$/.test(String(value || ""));
}

function validatePasswordStrength(password) {
  const value = String(password || "");
  if (value.length < 8) {
    return "Le mot de passe doit contenir au moins 8 caractères.";
  }

  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    return "Le mot de passe doit contenir au moins une lettre et un chiffre.";
  }

  return "";
}

async function hashPassword(password) {
  return bcrypt.hash(String(password), BCRYPT_ROUNDS);
}

async function verifyPassword(inputPassword, storedPassword) {
  if (isBcryptHash(storedPassword)) {
    return bcrypt.compare(String(inputPassword || ""), storedPassword);
  }

  return String(inputPassword || "") === String(storedPassword || "");
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

function socialTokenCryptoKey() {
  return crypto
    .createHash("sha256")
    .update(process.env.SOCIAL_AUTH_SECRET || process.env.JWT_SECRET || "triangle-wms-social-secret")
    .digest();
}

function encryptSocialToken(value) {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", socialTokenCryptoKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function socialProviderConfig(provider) {
  const appUrl = publicAppUrl();
  const callbackUrl = `${appUrl}/api/auth/social/${provider}/callback`;
  const configs = {
    google: {
      label: "Google",
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      scope: "profile email",
      callbackUrl
    },
    facebook: {
      label: "Facebook",
      clientId: process.env.FACEBOOK_CLIENT_ID,
      clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
      authUrl: "https://www.facebook.com/v19.0/dialog/oauth",
      tokenUrl: "https://graph.facebook.com/v19.0/oauth/access_token",
      userInfoUrl: "https://graph.facebook.com/me?fields=id,first_name,last_name,name,email,picture",
      scope: "public_profile email",
      callbackUrl
    },
    instagram: {
      label: "Instagram",
      clientId: process.env.INSTAGRAM_CLIENT_ID,
      clientSecret: process.env.INSTAGRAM_CLIENT_SECRET,
      authUrl: process.env.INSTAGRAM_AUTH_URL || "",
      tokenUrl: process.env.INSTAGRAM_TOKEN_URL || "",
      userInfoUrl: process.env.INSTAGRAM_USERINFO_URL || "",
      scope: "user_profile",
      callbackUrl
    },
    tiktok: {
      label: "TikTok",
      clientId: process.env.TIKTOK_CLIENT_ID,
      clientSecret: process.env.TIKTOK_CLIENT_SECRET,
      authUrl: process.env.TIKTOK_AUTH_URL || "",
      tokenUrl: process.env.TIKTOK_TOKEN_URL || "",
      userInfoUrl: process.env.TIKTOK_USERINFO_URL || "",
      scope: "user.info.basic",
      callbackUrl
    }
  };

  return configs[provider] || null;
}

function socialProviderEnabled(provider) {
  const config = socialProviderConfig(provider);
  return Boolean(config?.clientId && config?.clientSecret && config?.authUrl && config?.tokenUrl && config?.userInfoUrl);
}

function normalizeSocialProfile(provider, rawProfile) {
  if (provider === "google") {
    return {
      provider_user_id: String(rawProfile.sub || ""),
      email: rawProfile.email || "",
      email_verified: rawProfile.email_verified === true,
      name: rawProfile.name || [rawProfile.given_name, rawProfile.family_name].filter(Boolean).join(" "),
      first_name: rawProfile.given_name || "",
      last_name: rawProfile.family_name || "",
      avatar_url: rawProfile.picture || ""
    };
  }

  if (provider === "facebook") {
    return {
      provider_user_id: String(rawProfile.id || ""),
      email: rawProfile.email || "",
      email_verified: Boolean(rawProfile.email),
      name: rawProfile.name || [rawProfile.first_name, rawProfile.last_name].filter(Boolean).join(" "),
      first_name: rawProfile.first_name || "",
      last_name: rawProfile.last_name || "",
      avatar_url: rawProfile.picture?.data?.url || ""
    };
  }

  return {
    provider_user_id: String(rawProfile.id || rawProfile.sub || rawProfile.open_id || rawProfile.union_id || ""),
    email: rawProfile.email || "",
    email_verified: Boolean(rawProfile.email_verified || rawProfile.email),
    name: rawProfile.name || rawProfile.display_name || rawProfile.username || "",
    first_name: rawProfile.first_name || "",
    last_name: rawProfile.last_name || "",
    avatar_url: rawProfile.picture || rawProfile.avatar_url || ""
  };
}

async function buildLoginResponseForUser(userId) {
  const result = await pool.query(
    `SELECT u.*,
            c.name AS company_name,
            c.status AS company_status,
            c.subscription_status AS company_subscription_status,
            c.subscription_expires_at AS company_subscription_expires_at,
            c.trial_end_date AS company_trial_end_date,
            s.status AS subscription_status,
            s.end_date AS subscription_end_date,
            sp.name AS plan_name
     FROM users u
     LEFT JOIN companies c ON u.company_id=c.id
     LEFT JOIN subscriptions s ON c.id=s.company_id
     LEFT JOIN subscription_plans sp ON s.plan_id=sp.id
     WHERE u.id=$1
     ORDER BY s.id DESC
     LIMIT 1`,
    [userId]
  );
  const user = result.rows[0];
  if (!user) return null;

  const normalizedEmail = String(user.email || "").trim().toLowerCase();
  const isSuperAdmin =
    user.is_super_admin === true ||
    normalizeRole(user.role) === "super_admin" ||
    SUPER_ADMIN_EMAILS.has(normalizedEmail);

  const subscriptionStatus =
    user.subscription_status || user.company_subscription_status || "";

  const token = jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: isSuperAdmin ? "super_admin" : user.role,
      company_id: user.company_id,
      is_super_admin: isSuperAdmin,
      subscription_status: subscriptionStatus
    },
    JWT_SECRET,
    { expiresIn: "1d" }
  );

  const companyModules = isSuperAdmin
    ? await getCompanyModules(null)
    : await getCompanyModules(user.company_id);

  return {
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
      subscription_status: subscriptionStatus,
      subscription_end_date: user.subscription_end_date || "",
      trial_end_date: user.company_trial_end_date || "",
      subscription_expires_at: user.company_subscription_expires_at || "",
      plan_name: user.plan_name || "",
      profile_image_url: user.profile_image_url || "",
      force_password_change: user.force_password_change === true,
      modules: companyModules
    }
  };
}

function isExternalPaymentMethod(method) {
  return ["Carte bancaire", "Orange Money", "Moov Money", "Wave", "Virement"].includes(String(method || ""));
}

function toBooleanFlag(value, defaultValue = false) {
  if (value === true || value === false) return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["oui", "true", "1", "yes", "actif", "active"].includes(normalized)) return true;
  if (["non", "false", "0", "no", "inactif", "inactive"].includes(normalized)) return false;
  return defaultValue;
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

function canManageAttendanceSites(user) {
  const role = normalizeRole(user?.role);
  return user?.is_super_admin === true || role === "super_admin" || role === "admin";
}

function normalizeAttendanceGpsStatus(value) {
  const status = String(value || "").toLowerCase();
  if (status === "mobile") return "mobile";
  if (status.includes("hors")) return "hors_zone";
  if (status.includes("refus")) return "refusé";
  if (status.includes("autor")) return "hors_zone_autorisé";
  return status || "accepté";
}

async function getAllowedAttendanceSitesForUser(user) {
  const companyId = user.company_id || null;
  const assignedResult = await pool.query(
    `SELECT s.*
     FROM attendance_sites s
     INNER JOIN employee_attendance_sites eas
       ON eas.attendance_site_id=s.id
     WHERE eas.user_id=$1
       AND s.actif=true
       AND ($2::int IS NULL OR s.company_id=$2 OR s.company_id IS NULL)
     ORDER BY s.nom_du_site ASC`,
    [user.id, companyId]
  );

  if (assignedResult.rows.length > 0) return assignedResult.rows;

  if (user.primary_attendance_site_id) {
    const primaryResult = await pool.query(
      `SELECT *
       FROM attendance_sites
       WHERE id=$1
         AND actif=true
         AND ($2::int IS NULL OR company_id=$2 OR company_id IS NULL)
       LIMIT 1`,
      [user.primary_attendance_site_id, companyId]
    );
    if (primaryResult.rows.length > 0) return primaryResult.rows;
  }

  return [];
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

async function authenticateToken(req, res, next) {
  const token = getAuthTokenFromRequest(req);
  if (!token) {
    return res.status(401).json({
      error: "Token manquant"
    });
  }

  try {
    const user = jwt.verify(token, JWT_SECRET);
    const requestTenant = getTenantFromRequest(req);
    const tokenTenant = normalizeTenantId(user.tenant_id);

    if (tokenTenant && tokenTenant !== requestTenant) {
      return res.status(403).json({
        error: "Accès refusé : ce compte n’appartient pas à cette version."
      });
    }

    if (!(await companyBelongsToTenant(user.company_id, requestTenant))) {
      return res.status(403).json({
        error: "Accès refusé : entreprise non autorisée pour ce tenant."
      });
    }

    /* Les sociétés atteignables sont résolues ici, une fois, plutôt qu'à
       chaque appel de getEffectiveCompanyId — qui est synchrone et appelé des
       dizaines de fois par requête. En cas d'incident base, on n'élargit
       jamais : la liste vide ramène au comportement d'avant (la seule société
       d'origine). */
    let societesAutorisees = [];
    try {
      societesAutorisees = await accesSocietes.societesAccessibles(
        pool, user, requestTenant || null
      );
    } catch (e) {
      console.error("Sociétés accessibles : lecture impossible —", e.message);
      societesAutorisees = [];
    }

    req.user = {
      ...user,
      tenant_id: tokenTenant || requestTenant,
      societes_autorisees: societesAutorisees
    };
    req.tenant_id = requestTenant;

    next();
  } catch (err) {
    return res.status(403).json({
      error: "Token invalide"
    });
  }
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

async function logAudit(req, action, entityType = "", entityId = null, details = {}) {
  try {
    const user = req?.user || {};
    await pool.query(
      `INSERT INTO audit_logs
       (user_id, user_email, user_role, company_id, action, entity_type, entity_id, ip_address, user_agent, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        user.id || null,
        user.email || "",
        user.role || "",
        getEffectiveCompanyId(req || {}) || user.company_id || null,
        action,
        entityType,
        entityId,
        req?.ip || req?.headers?.["x-forwarded-for"] || "",
        typeof req?.get === "function" ? req.get("user-agent") || "" : req?.headers?.["user-agent"] || "",
        JSON.stringify(details || {})
      ]
    );
  } catch (error) {
    console.error("Erreur audit log :", error.message || error);
  }
}

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashVerificationSecret(value) {
  return crypto
    .createHash("sha256")
    .update(`${String(value || "")}:${process.env.JWT_SECRET || JWT_SECRET}`)
    .digest("hex");
}

function supportWhatsAppUrl() {
  const number = String(process.env.SUPPORT_WHATSAPP_NUMBER || "").replace(/[^0-9]/g, "");
  if (!number) return "";
  const text = encodeURIComponent("Bonjour Triangle WMS Pro, j'ai besoin d'aide");
  return `https://wa.me/${number}?text=${text}`;
}

function publicAppUrl() {
  return String(process.env.APP_URL || process.env.PUBLIC_BASE_URL || process.env.FRONTEND_URL || "https://trianglewmspro.com").replace(/\/$/, "");
}

async function createVerificationCode({ companyId, userId, targetType, targetValue }) {
  const code = generateOtpCode();
  const token = crypto.randomBytes(24).toString("hex");
  const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
  const tokenHash = hashVerificationSecret(token);

  await pool.query(
    `UPDATE verification_codes
     SET used_at=NOW()
     WHERE used_at IS NULL
       AND ($1::int IS NULL OR user_id=$1)
       AND target_type=$2
       AND LOWER(target_value)=LOWER($3)`,
    [userId || null, targetType, targetValue]
  );

  await pool.query(
    `INSERT INTO verification_codes
     (company_id, user_id, target_type, target_value, code_hash, token_hash, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW() + INTERVAL '10 minutes')`,
    [companyId || null, userId || null, targetType, targetValue, codeHash, tokenHash]
  );

  return {
    code,
    token,
    verify_url: `${publicAppUrl()}/verify-${targetType}?token=${token}`
  };
}

/* Un seul endroit décide si l'on sait envoyer un SMS. Le mode « sandbox »
   n'envoie rien : promettre un SMS qui ne partira pas enfermerait dehors la
   personne qui l'attend. */
function smsServiceConfigure() {
  return (process.env.SMS_PROVIDER || "sandbox") !== "sandbox"
      && Boolean(process.env.SMS_API_KEY);
}

async function sendVerificationMessage({ targetType, targetValue, code, verifyUrl }) {
  if (targetType === "email") {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return {
        sent: false,
        provider: "smtp",
        message: "SMTP non configuré. Configurez SMTP pour envoyer le code OTP réel."
      };
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: targetValue,
      subject: "Code de vérification Triangle WMS Pro",
      text: `Votre code de vérification Triangle WMS Pro est : ${code}. Il expire dans 10 minutes.\n\nLien sécurisé : ${verifyUrl}`,
      html: `
        <div style="font-family:Arial,sans-serif;color:#111">
          <h2>Vérification Triangle WMS Pro</h2>
          <p>Votre code de vérification est :</p>
          <p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>
          <p>Ce code expire dans 10 minutes.</p>
          <p><a href="${escapeHtml(verifyUrl)}">Valider directement mon compte</a></p>
        </div>
      `
    });

    return { sent: true, provider: process.env.EMAIL_PROVIDER || "smtp", message: "Code OTP envoyé par email." };
  }

  if (!smsServiceConfigure()) {
    return {
      sent: false,
      provider: process.env.SMS_PROVIDER || "sms",
      message: "Provider SMS non configuré. Configurez Twilio, Africa's Talking, Orange API ou MTN API."
    };
  }

  console.log("SMS OTP prêt à envoyer :", { targetValue });
  return { sent: false, provider: process.env.SMS_PROVIDER, message: "Provider SMS préparé." };
}

async function sendPasswordResetMessage({ targetType, targetValue, code, resetUrl }) {
  if (targetType === "email") {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return {
        sent: false,
        provider: "smtp",
        message: "SMTP non configuré. Configurez SMTP pour envoyer le code de réinitialisation."
      };
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: targetValue,
      subject: "Réinitialisation mot de passe Triangle WMS Pro",
      text: `Votre code de réinitialisation Triangle WMS Pro est : ${code}. Il expire dans 15 minutes.\n\nLien sécurisé : ${resetUrl}`,
      html: `
        <div style="font-family:Arial,sans-serif;color:#111">
          <h2>Réinitialisation mot de passe</h2>
          <p>Votre code de réinitialisation est :</p>
          <p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>
          <p>Ce code expire dans 15 minutes.</p>
          <p><a href="${escapeHtml(resetUrl)}">Créer un nouveau mot de passe</a></p>
        </div>
      `
    });

    return { sent: true, provider: process.env.EMAIL_PROVIDER || "smtp", message: "Code envoyé par email." };
  }

  return {
    sent: false,
    provider: process.env.SMS_PROVIDER || "sms",
    message: "SMS/WhatsApp non configuré. Utilisez un email ou configurez un provider SMS."
  };
}

async function activateVerifiedAccount({ companyId, userId, targetType }) {
  const userColumn = targetType === "phone" ? "phone_verified" : "email_verified";
  const companyColumn = targetType === "phone" ? "phone_verified" : "email_verified";
  const usersHasVerificationStatus = await columnExists("users", "verification_status");
  const companiesHasVerificationStatus = await columnExists("companies", "verification_status");
  const usersHasVerifiedAt = await columnExists("users", "verified_at");
  const companiesHasVerifiedAt = await columnExists("companies", "verified_at");

  await pool.query(
    `UPDATE users
     SET ${userColumn}=true,
         account_status='active',
         verification_required=false,
         ${usersHasVerificationStatus ? "verification_status='verified'," : ""}
         ${usersHasVerifiedAt ? "verified_at=COALESCE(verified_at, CURRENT_TIMESTAMP)," : ""}
         invitation_status=CASE WHEN invitation_status='pending_verification' THEN 'active' ELSE invitation_status END,
         updated_at=CURRENT_TIMESTAMP
     WHERE id=$1`,
    [userId]
  );

  await pool.query(
    `UPDATE companies
     SET ${companyColumn}=true,
         account_status='active',
         ${companiesHasVerificationStatus ? "verification_status='verified'," : ""}
         ${companiesHasVerifiedAt ? "verified_at=COALESCE(verified_at, CURRENT_TIMESTAMP)," : ""}
         subscription_status=COALESCE(NULLIF(subscription_status,''), 'trial'),
         updated_at=CURRENT_TIMESTAMP
     WHERE id=$1`,
    [companyId]
  );
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

const COMPANY_MODULE_KEYS = [
  "dashboard",
  "recherche",
  "assistant_ia",
  "super_admin",
  "chat",
  "notifications",
  "produits",
  "partenaires",
  "stock",
  "mouvements",
  "entrepots",
  "emplacements",
  "scanner",
  "pos",
  "marketplace",
  "commandes_recues",
  "ventes",
  "paiements",
  "recus",
  "achats",
  "fournisseurs",
  "clients",
  "pointage",
  "pointage_qr",
  "parametres_pointage",
  "inventaire",
  "ia",
  "reunions",
  "comptabilite",
  "documents",
  "rapports",
  "alertes",
  "activites",
  "utilisateurs",
  "badges",
  "parametres",
  "transport",
  "crm",
  "automobile",
  "immobilier",
  "hotel",
  "restaurant",
  "laboratoire",
  "electronique",
  "telephones",
  "informatique",
  "beaute",
  "maison_meubles",
  "services",
  // Modules métier vendus séparément (Vente de ciment / Vente de sable).
  "cement",
  "sand"
];

/* Modules « opt-in » : contrairement aux modules généraux, ils ne sont PAS
   accordés par défaut. getCompanyModules() considère qu'un module non
   configuré est actif ; ce serait une régression de sécurité ici (le Sable
   deviendrait accessible à toutes les entreprises). Pour ceux-ci on exige donc
   une ligne company_modules explicitement activée. */
const OPT_IN_MODULE_KEYS = new Set(["cement", "sand"]);

async function isCompanyModuleEnabled(companyId, moduleKey) {
  if (!companyId) return false;
  /* La table de PRODUCTION n'a que « is_enabled » — il n'existe pas de colonne
     « enabled ». Lire les deux faisait échouer la requête en production. */
  const { rows } = await pool.query(
    `SELECT is_enabled FROM company_modules WHERE company_id=$1 AND module_key=$2 LIMIT 1`,
    [companyId, moduleKey]
  );
  const row = rows[0];
  if (row) return row.is_enabled === true;
  // Non configuré : refusé pour un module opt-in, autorisé pour les autres.
  return !OPT_IN_MODULE_KEYS.has(moduleKey);
}

/* Middleware : le module doit être activé pour l'entreprise EFFECTIVE (donc en
   tenant compte de x-active-company-id pour un super-admin qui bascule).
   Il se combine avec requirePermission() — module activé ET permission RBAC. */
function requireCompanyModule(moduleKey) {
  return async function companyModuleGuard(req, res, next) {
    try {
      const companyId = getEffectiveCompanyId(req, req.user?.company_id);
      if (!companyId) {
        return res.status(403).json({ error: "Aucune entreprise active.", code: "NO_ACTIVE_COMPANY" });
      }
      if (await isCompanyModuleEnabled(companyId, moduleKey)) return next();
      return res.status(403).json({
        error: "Ce module n'est pas activé pour votre entreprise.",
        code: "MODULE_NOT_ENABLED",
        module: moduleKey,
      });
    } catch (error) {
      console.error("requireCompanyModule:", error.message || error);
      return res.status(500).json({ error: "Erreur de vérification du module." });
    }
  };
}

async function getCompanyModules(companyId) {
  const moduleKeys = COMPANY_MODULE_KEYS;

  if (!companyId) {
    return moduleKeys.reduce((acc, key) => {
      acc[key] = true;
      return acc;
    }, {});
  }

  let result = { rows: [] };

  try {
    result = await pool.query(
      `SELECT module_key, is_enabled
       FROM company_modules
       WHERE company_id=$1`,
      [companyId]
    );
  } catch (error) {
    console.error("Erreur lecture modules entreprise :", error.message || error);
  }

  return moduleKeys.reduce((acc, key) => {
    const configured = result.rows.find((item) => item.module_key === key);
    acc[key] = configured ? configured.is_enabled === true : true;
    return acc;
  }, {});
}

async function tableExists(tableName) {
  const result = await pool.query("SELECT to_regclass($1) AS table_name", [
    `public.${tableName}`
  ]);
  return Boolean(result.rows[0]?.table_name);
}

async function columnExists(tableName, columnName) {
  const result = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name=$1
       AND column_name=$2
     LIMIT 1`,
    [tableName, columnName]
  );
  return result.rows.length > 0;
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
      max_products: 2000,
      max_movements_monthly: 3000,
      trial_days: 15
    },
    {
      name: "Premium",
      price_monthly: 15000,
      max_users: 30,
      max_warehouses: 10,
      max_products: 10000,
      max_movements_monthly: 20000,
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

  await pool.query(`
    UPDATE subscription_plans
    SET
      max_users = CASE
        WHEN LOWER(name)='premium' AND COALESCE(max_users,0) <= 0 THEN 30
        WHEN LOWER(name)='standard' AND COALESCE(max_users,0) <= 0 THEN 10
        WHEN LOWER(name) IN ('essentiel','starter') AND COALESCE(max_users,0) <= 0 THEN 3
        ELSE max_users
      END,
      max_warehouses = CASE
        WHEN LOWER(name)='premium' AND COALESCE(max_warehouses,0) <= 0 THEN 10
        WHEN LOWER(name)='standard' AND COALESCE(max_warehouses,0) <= 0 THEN 3
        WHEN LOWER(name) IN ('essentiel','starter') AND COALESCE(max_warehouses,0) <= 0 THEN 1
        ELSE max_warehouses
      END,
      max_products = CASE
        WHEN LOWER(name)='premium' AND COALESCE(max_products,0) <= 0 THEN 10000
        WHEN LOWER(name)='standard' AND COALESCE(max_products,0) < 2000 THEN 2000
        WHEN LOWER(name) IN ('essentiel','starter') AND COALESCE(max_products,0) < 300 THEN 300
        ELSE max_products
      END,
      max_movements_monthly = CASE
        WHEN LOWER(name)='premium' AND COALESCE(max_movements_monthly,0) <= 0 THEN 20000
        WHEN LOWER(name)='standard' AND COALESCE(max_movements_monthly,0) <= 0 THEN 3000
        WHEN LOWER(name) IN ('essentiel','starter') AND COALESCE(max_movements_monthly,0) <= 0 THEN 500
        ELSE max_movements_monthly
      END,
      max_modules_allowed = CASE
        WHEN LOWER(name)='premium' AND COALESCE(max_modules_allowed,0) <= 0 THEN 999
        WHEN LOWER(name)='standard' AND COALESCE(max_modules_allowed,0) <= 0 THEN 12
        WHEN LOWER(name) IN ('essentiel','starter') AND COALESCE(max_modules_allowed,0) <= 0 THEN 5
        ELSE max_modules_allowed
      END
    WHERE LOWER(name) IN ('essentiel','starter','standard','premium')
  `);
}

app.get("/", (req, res) => {
  res.send("Triangle WMS Backend sécurisé OK");
});

/* UPLOAD LOGO */
app.post(
  "/upload-logo",
  authenticateToken,
  authorizeRoles("admin", "super_admin"),
  upload.single("logo"),
  async (req, res) => {
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
  }
);

/* UPLOAD PHOTO UTILISATEUR */
app.post("/upload-user-photo", authenticateToken, upload.single("photo"), async (req, res) => {
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

app.get("/company-settings/current", authenticateToken, async (req, res) => {
  try {
    const companyId = getEffectiveCompanyId(req);

    if (!companyId && isSuperAdminUser(req.user)) {
      return res.json({
        company_name: "Plateforme globale",
        logo_url: "",
        plan_name: "Administrateur système",
        subscription_status: "Illimité",
        is_platform: true
      });
    }

    const settingsResult = await pool.query(
      `SELECT cs.*, c.name AS registered_company_name
       FROM company_settings cs
       LEFT JOIN companies c ON c.id=cs.company_id
       WHERE cs.company_id=$1 OR cs.company_id IS NULL
       ORDER BY CASE WHEN cs.company_id=$1 THEN 0 ELSE 1 END, cs.id ASC
       LIMIT 1`,
      [companyId]
    );
    const companyResult = await pool.query(
      `SELECT c.*, s.status AS subscription_status, sp.name AS plan_name
       FROM companies c
       LEFT JOIN subscriptions s ON s.company_id=c.id
       LEFT JOIN subscription_plans sp ON sp.id=s.plan_id
       WHERE c.id=$1
       ORDER BY s.id DESC
       LIMIT 1`,
      [companyId]
    );
    const settings = settingsResult.rows[0] || {};
    const company = companyResult.rows[0] || {};

    res.json({
      ...settings,
      company_id: companyId,
      company_name: settings.company_name || company.name || "Triangle WMS Pro",
      logo_url: settings.logo_url || "",
      plan_name: company.plan_name || "",
      subscription_status: company.subscription_status || ""
    });
  } catch (error) {
    console.error("ERREUR COMPANY SETTINGS CURRENT :", error);
    res.status(500).json({ error: "Erreur identité entreprise" });
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
    const companyId = getEffectiveCompanyId(req);

    const existing = await pool.query(
      `SELECT id FROM company_settings
       WHERE company_id=$1 OR ($1::int IS NULL AND company_id IS NULL)
       ORDER BY id ASC LIMIT 1`,
      [companyId]
    );

    if (existing.rows.length === 0) {
      const created = await pool.query(
        `INSERT INTO company_settings
        (company_id, company_name, address, phone, email, website, logo_url, slogan)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *`,
        [companyId, company_name, address, phone, email, website, logo_url, slogan]
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
      plan_price,
      selected_modules = {}
    } = req.body;

    const cleanEmail = String(email || "").trim().toLowerCase();
    const cleanPhone = String(phone || "").trim();

    if (!company_name || !responsible_name || !password || (!cleanEmail && !cleanPhone)) {
      return res.status(400).json({
        error: "Nom entreprise, responsable, mot de passe et au moins un contact email ou téléphone sont obligatoires."
      });
    }

    const passwordError = validatePasswordStrength(password);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
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
    const requestedModules =
      Array.isArray(selected_modules)
        ? selected_modules.reduce((acc, key) => {
            acc[key] = true;
            return acc;
          }, {})
        : selected_modules && typeof selected_modules === "object"
          ? selected_modules
          : {};
    const enabledModuleCount = Object.values(requestedModules).filter((value) => value === true).length;
    const maxModulesAllowed = Number(plan.max_modules_allowed || 0);

    if (maxModulesAllowed > 0 && maxModulesAllowed < 999 && enabledModuleCount > maxModulesAllowed) {
      return res.status(400).json({
        error: `Le plan ${plan.name} autorise ${maxModulesAllowed} modules maximum.`
      });
    }

    const existingUser = await pool.query(
      `
      SELECT id
      FROM users
      WHERE LOWER(email) = LOWER($1)
         OR ($2 <> '' AND regexp_replace(COALESCE(phone,''), '[^0-9+]', '', 'g') = regexp_replace($2, '[^0-9+]', '', 'g'))
      LIMIT 1
      `,
      [cleanEmail || `phone-${cleanPhone}@pending.trianglewmspro.local`, cleanPhone]
    );

    if (existingUser.rows.length > 0) {
      return res.status(400).json({
        error: "Cet email ou téléphone existe déjà."
      });
    }

    const trialDays = Number(plan.trial_days || 15);
    const generatedEmail = cleanEmail || `phone-${crypto.randomBytes(8).toString("hex")}@pending.trianglewmspro.local`;

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
        trial_ends_at,
        email_verified,
        phone_verified,
        account_status,
        trial_start_date,
        trial_end_date,
        subscription_plan,
        subscription_expires_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW() + ($9 || ' days')::interval,$10,$11,$12,NOW(),NOW() + ($9 || ' days')::interval,$13,NOW() + ($9 || ' days')::interval)
      RETURNING *
      `,
      [
        company_name,
        business_type || "",
        responsible_name,
        cleanEmail,
        cleanPhone,
        address || "",
        plan.id,
        "trial",
        trialDays,
        false,
        false,
        "pending_verification",
        plan.name || plan_name || ""
      ]
    );

    const company = companyResult.rows[0];
    const hashedPassword = await hashPassword(password);

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
        badge_code,
        phone,
        email_verified,
        phone_verified,
        account_status,
        invitation_status,
        verification_required
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
      `,
      [
        responsible_name,
        generatedEmail,
        hashedPassword,
        "admin",
        company.id,
        false,
        /* Premier compte d'une entreprise qui vient d'être créée : son
           badge porte déjà son préfixe, pas celui d'une autre société. */
        `${companyContext.prefixeDepuisNom(company.name, company.id)}-EMP-001`,
        cleanPhone,
        false,
        false,
        "pending_verification",
        "pending_verification",
        true
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

    const targetType = cleanEmail ? "email" : "phone";
    const targetValue = cleanEmail || cleanPhone;
    const verification = await createVerificationCode({
      companyId: company.id,
      userId: user.id,
      targetType,
      targetValue
    });
    const delivery = await sendVerificationMessage({
      targetType,
      targetValue,
      code: verification.code,
      verifyUrl: verification.verify_url
    });

    for (const moduleKey of COMPANY_MODULE_KEYS) {
      const requestedKey =
        moduleKey === "crm" &&
        Object.prototype.hasOwnProperty.call(requestedModules, "partenaires")
          ? "partenaires"
          : moduleKey;
      const isEnabled =
        Object.prototype.hasOwnProperty.call(requestedModules, requestedKey)
          ? requestedModules[requestedKey] === true
          : true;

      await pool.query(
        `INSERT INTO company_modules
         (company_id, module_key, is_enabled, updated_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (company_id, module_key)
         DO UPDATE SET
           is_enabled=EXCLUDED.is_enabled,
           updated_by=EXCLUDED.updated_by,
           updated_at=CURRENT_TIMESTAMP`,
        [company.id, moduleKey, isEnabled, user.id]
      );
    }

    res.status(201).json({
      success: true,
      message: "Entreprise créée. Vérification obligatoire avant accès complet.",
      company,
      user,
      plan,
      verification: {
        required: true,
        target_type: targetType,
        target_value: targetValue,
        delivery,
        verify_url: verification.verify_url
      }
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

app.post("/password-reset/request", async (req, res) => {
  try {
    const identifier = String(req.body?.identifier || "").trim();
    const accountType = String(req.body?.account_type || "auto").toLowerCase();

    if (!identifier) {
      return res.status(400).json({ error: "Email ou téléphone obligatoire." });
    }

    const usersHasPhone = await columnExists("users", "phone");
    const looksLikeEmail = identifier.includes("@");
    const normalizedPhone = identifier.replace(/[^0-9+]/g, "");
    const targetType = looksLikeEmail ? "email" : "phone";
    const targetValue = looksLikeEmail ? identifier.toLowerCase() : normalizedPhone;

    if (targetType === "phone" && (!usersHasPhone || normalizedPhone.length < 6)) {
      return res.status(400).json({ error: "Téléphone invalide." });
    }

    const result = await pool.query(
      `SELECT id, email, phone, role, company_id, is_active
       FROM users
       WHERE ${looksLikeEmail ? "LOWER(email)=LOWER($1)" : "regexp_replace(COALESCE(phone,''), '[^0-9+]', '', 'g')=$1"}
       ORDER BY id DESC
       LIMIT 1`,
      [targetValue]
    );
    const user = result.rows[0];
    const genericMessage = "Si ce compte existe, un code de réinitialisation a été envoyé.";

    if (!user) {
      return res.json({ success: true, message: genericMessage });
    }

    const role = normalizeRole(user.role);
    if (accountType === "client" && role !== "customer") {
      return res.json({ success: true, message: genericMessage });
    }
    if (accountType === "enterprise" && role === "customer") {
      return res.json({ success: true, message: genericMessage });
    }
    if (user.is_active === false) {
      return res.status(403).json({ error: "Compte désactivé. Contactez un administrateur." });
    }

    const code = generateOtpCode();
    const token = crypto.randomBytes(24).toString("hex");
    const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
    const tokenHash = hashVerificationSecret(token);

    await pool.query(
      `UPDATE password_reset_codes
       SET used_at=NOW()
       WHERE used_at IS NULL AND user_id=$1`,
      [user.id]
    );

    const created = await pool.query(
      `INSERT INTO password_reset_codes
       (user_id, company_id, target_type, target_value, code_hash, token_hash, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW() + INTERVAL '15 minutes')
       RETURNING id`,
      [user.id, user.company_id || null, targetType, targetValue, codeHash, tokenHash]
    );

    const resetUrl = `${publicAppUrl()}/mot-de-passe-oublie?token=${token}`;
    const delivery = await sendPasswordResetMessage({
      targetType,
      targetValue,
      code,
      resetUrl
    });

    if (!delivery.sent) {
      return res.status(503).json({
        error: delivery.message,
        provider: delivery.provider
      });
    }

    await logAudit(
      { ...req, user: { id: user.id, company_id: user.company_id, role: user.role, email: user.email } },
      "password_reset_requested",
      "password_reset_code",
      created.rows[0].id,
      { target_type: targetType, provider: delivery.provider }
    );

    res.json({
      success: true,
      message: delivery.message || genericMessage,
      target_type: targetType,
      target_value: targetValue,
      token_hint: token ? "" : undefined
    });
  } catch (error) {
    console.error("ERREUR PASSWORD RESET REQUEST :", error);
    res.status(500).json({ error: "Erreur demande réinitialisation mot de passe" });
  }
});

app.post("/password-reset/confirm", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      token = "",
      code = "",
      identifier = "",
      new_password = "",
      confirm_password = ""
    } = req.body || {};

    if (!token && !code) {
      return res.status(400).json({ error: "Code ou lien sécurisé obligatoire." });
    }
    if (String(new_password) !== String(confirm_password)) {
      return res.status(400).json({ error: "Les deux mots de passe ne correspondent pas." });
    }
    const passwordError = validatePasswordStrength(new_password);
    if (passwordError) return res.status(400).json({ error: passwordError });

    const values = [];
    let filter = "used_at IS NULL AND expires_at > NOW()";

    if (token) {
      values.push(hashVerificationSecret(token));
      filter += ` AND token_hash=$${values.length}`;
    } else {
      const normalizedIdentifier = String(identifier || "").trim();
      if (!normalizedIdentifier) {
        return res.status(400).json({ error: "Email ou téléphone obligatoire avec le code." });
      }
      const targetValue = normalizedIdentifier.includes("@")
        ? normalizedIdentifier.toLowerCase()
        : normalizedIdentifier.replace(/[^0-9+]/g, "");
      values.push(targetValue);
      filter += ` AND LOWER(target_value)=LOWER($${values.length})`;
    }

    const result = await client.query(
      `SELECT pr.*, u.email, u.role
       FROM password_reset_codes pr
       JOIN users u ON u.id=pr.user_id
       WHERE ${filter}
       ORDER BY pr.id DESC
       LIMIT 1`,
      values
    );
    const reset = result.rows[0];

    if (!reset) {
      return res.status(400).json({ error: "Code expiré ou introuvable." });
    }

    if (Number(reset.attempts || 0) >= 5) {
      return res.status(429).json({ error: "Trop de tentatives. Demandez un nouveau code." });
    }

    if (code) {
      const validCode = await bcrypt.compare(String(code || ""), reset.code_hash);
      if (!validCode) {
        await client.query("UPDATE password_reset_codes SET attempts=attempts+1 WHERE id=$1", [reset.id]);
        return res.status(400).json({ error: "Code incorrect." });
      }
    }

    await client.query("BEGIN");
    await client.query("UPDATE users SET password=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2", [
      await hashPassword(new_password),
      reset.user_id
    ]);
    await client.query("UPDATE password_reset_codes SET used_at=NOW() WHERE id=$1", [reset.id]);
    await client.query(
      "UPDATE password_reset_codes SET used_at=NOW() WHERE used_at IS NULL AND user_id=$1 AND id<>$2",
      [reset.user_id, reset.id]
    );
    await client.query("COMMIT");

    await logAudit(
      { ...req, user: { id: reset.user_id, company_id: reset.company_id, role: reset.role, email: reset.email } },
      "password_reset_confirmed",
      "user",
      reset.user_id,
      { target_type: reset.target_type }
    );

    res.json({
      success: true,
      message: "Mot de passe réinitialisé. Vous pouvez vous connecter."
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("ERREUR PASSWORD RESET CONFIRM :", error);
    res.status(500).json({ error: "Erreur confirmation réinitialisation mot de passe" });
  } finally {
    client.release();
  }
});

/* LOGIN SAAS */
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const loginIdentifier = String(email || "").trim();
    const normalizedEmail = loginIdentifier.toLowerCase();

    if (!loginIdentifier || !password) {
      return res.status(400).json({ error: "Identifiant et mot de passe obligatoires" });
    }

    /* Un seul flux pour les deux identifiants : on reconnaît la forme, on
       normalise le numéro, et la recherche porte sur la colonne qui convient.
       Sans normalisation, « 76 32 77 99 » et « +22376327799 » désignent le
       même abonné mais ne trouvent pas le même compte. */
    const usersHasPhone = await columnExists("users", "phone_normalise");
    const looksLikeEmail = identifiants.estEmail(loginIdentifier);
    const normalizedPhone = identifiants.normaliserTelephone(loginIdentifier);
    const canSearchPhone = usersHasPhone && !looksLikeEmail && normalizedPhone !== "";

    const result = await pool.query(
      `SELECT 
        u.*,
        c.name AS company_name,
        c.status AS company_status,
        c.account_status AS company_account_status,
        c.email_verified AS company_email_verified,
        c.phone_verified AS company_phone_verified,
        c.trial_end_date AS company_trial_end_date,
        c.subscription_expires_at AS company_subscription_expires_at,
        s.status AS subscription_status,
        s.end_date AS subscription_end_date,
        sp.name AS plan_name
       FROM users u
       LEFT JOIN companies c ON u.company_id = c.id
       LEFT JOIN subscriptions s ON c.id = s.company_id
       LEFT JOIN subscription_plans sp ON s.plan_id = sp.id
       WHERE LOWER(u.email) = LOWER($1)
          ${canSearchPhone ? "OR u.phone_normalise = $2" : ""}
       ORDER BY s.id DESC
       LIMIT 1`,
      canSearchPhone ? [loginIdentifier, normalizedPhone] : [loginIdentifier]
    );

    const user = result.rows[0];

    if (!user) return res.status(401).json({ error: "Identifiant incorrect" });

    const tenantId = getTenantFromRequest(req);

    if (!(await companyBelongsToTenant(user.company_id, tenantId))) {
      return res.status(403).json({
        error: "Accès refusé : ce compte n’appartient pas à cette version."
      });
    }

    if (user.is_active === false) {
      return res.status(403).json({ error: "Compte désactivé" });
    }

    const passwordMatches = await verifyPassword(password, user.password);

    if (!passwordMatches) {
      return res.status(401).json({ error: "Mot de passe incorrect" });
    }

    if (!isBcryptHash(user.password)) {
      await pool.query("UPDATE users SET password=$1 WHERE id=$2", [
        await hashPassword(password),
        user.id
      ]);
    }

    const isSuperAdmin =
      user.is_super_admin === true ||
      user.is_super_admin === "true" ||
      user.is_super_admin === 1 ||
      String(user.role || "").toLowerCase() === "super_admin" ||
      SUPER_ADMIN_EMAILS.has(normalizedEmail) ||
      SUPER_ADMIN_EMAILS.has(String(user.email || "").trim().toLowerCase());

    const isCustomerAccount = normalizeRole(user.role) === "customer";

    /* Le super-administrateur peut dispenser un compte de vérification :
       quelqu'un qui n'a pas d'adresse email n'a rien à vérifier par email, et
       lui réclamer une confirmation qu'il ne recevra jamais revient à lui
       fermer la porte. Le réglage est vide sur tout l'existant, donc rien ne
       change pour les comptes déjà en service. */
    const dispenseDeVerification = String(user.verification_mode || "") === "none";

    if (!isSuperAdmin && !dispenseDeVerification) {
      const userVerified = user.email_verified === true || user.phone_verified === true;
      const companyVerified =
        isCustomerAccount ||
        user.company_email_verified === true ||
        user.company_phone_verified === true;
      const accountPending =
        String(user.account_status || "").toLowerCase() === "pending_verification" ||
        (!isCustomerAccount && String(user.company_account_status || "").toLowerCase() === "pending_verification") ||
        user.verification_required === true;

      if (!userVerified || !companyVerified || accountPending) {
        return res.status(403).json({
          error: "Vérification obligatoire avant connexion complète.",
          code: "verification_required",
          redirect: "/verification-required",
          user_id: user.id,
          company_id: user.company_id,
          target_type: user.email && !String(user.email).includes("@pending.trianglewmspro.local") ? "email" : "phone",
          target_value: user.email && !String(user.email).includes("@pending.trianglewmspro.local") ? user.email : user.phone
        });
      }

      if (!isCustomerAccount && user.company_status === "suspended") {
        return res.status(403).json({
          error: "Entreprise suspendue. Veuillez contacter l’administration."
        });
      }

      const subscriptionEnd =
        user.company_subscription_expires_at ||
        user.company_trial_end_date ||
        user.subscription_end_date;
      if (!isCustomerAccount && subscriptionEnd && new Date(subscriptionEnd).getTime() < Date.now()) {
        await pool.query(
          "UPDATE companies SET subscription_status='expired' WHERE id=$1",
          [user.company_id]
        ).catch(() => {});
        return res.status(403).json({
          error: "Votre essai gratuit ou abonnement est terminé.",
          code: "subscription_expired",
          redirect: "/abonnement-expire"
        });
      }

      if (
        !isCustomerAccount &&
        (
          user.subscription_status === "expired" ||
          user.subscription_status === "suspended" ||
          user.subscription_status === "cancelled"
        )
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
        tenant_id: tenantId,
        is_super_admin: isSuperAdmin,
        subscription_status: user.subscription_status || ""
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
    await logAudit(
      { ...req, user: { id: user.id, email: user.email, role: user.role, company_id: user.company_id } },
      "login",
      "user",
      user.id,
      { email: user.email }
    );

    const companyModules = isSuperAdmin ? await getCompanyModules(null) : await getCompanyModules(user.company_id);

    setSecureAuthCookies(req, res, token, tenantId);

    res.json({
      message: "Connexion réussie",
      token,
      user: {
        id: user.id,
        fullname: user.fullname,
        email: user.email,
        role: isSuperAdmin ? "super_admin" : user.role,
        company_id: user.company_id,
        tenant_id: tenantId,
        company_name: user.company_name || "",
        company_status: user.company_status || "",
        is_super_admin: isSuperAdmin,
        subscription_status: user.subscription_status || "",
        subscription_end_date: user.subscription_end_date || "",
        trial_end_date: user.company_trial_end_date || "",
        subscription_expires_at: user.company_subscription_expires_at || "",
        plan_name: user.plan_name || "",
        profile_image_url: user.profile_image_url || "",
        force_password_change: user.force_password_change === true,
        modules: companyModules
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur login SaaS" });
  }
});

app.get("/support/config", async (req, res) => {
  res.json({
    whatsapp_url: supportWhatsAppUrl(),
    whatsapp_enabled: Boolean(supportWhatsAppUrl())
  });
});

app.get("/auth/social/providers", async (req, res) => {
  const providers = ["google", "facebook", "instagram", "tiktok"].map((provider) => {
    const config = socialProviderConfig(provider);
    return {
      provider,
      label: config?.label || provider,
      enabled: socialProviderEnabled(provider),
      scopes: config?.scope || ""
    };
  });

  providers.push({
    provider: "whatsapp",
    label: "WhatsApp",
    enabled: true,
    scopes: "phone_otp",
    otp_only: true
  });

  res.json({ providers });
});

app.get("/auth/social/:provider/start", async (req, res) => {
  try {
    const provider = String(req.params.provider || "").toLowerCase();
    const mode = String(req.query.mode || "login");

    if (provider === "whatsapp") {
      return res.redirect(`${publicAppUrl()}/verify-phone`);
    }

    const config = socialProviderConfig(provider);
    if (!config || !socialProviderEnabled(provider)) {
      return res.redirect(`${publicAppUrl()}/login?social_error=${encodeURIComponent("Provider OAuth non configuré")}`);
    }

    const state = jwt.sign(
      {
        provider,
        mode: mode === "register" ? "register" : "login",
        nonce: crypto.randomBytes(12).toString("hex")
      },
      JWT_SECRET,
      { expiresIn: "10m" }
    );

    const authUrl = new URL(config.authUrl);
    authUrl.searchParams.set("client_id", config.clientId);
    authUrl.searchParams.set("redirect_uri", config.callbackUrl);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", config.scope);
    authUrl.searchParams.set("state", state);
    if (provider === "google") {
      authUrl.searchParams.set("access_type", "offline");
      authUrl.searchParams.set("prompt", "select_account");
    }

    res.redirect(authUrl.toString());
  } catch (error) {
    console.error("ERREUR SOCIAL START :", error);
    res.redirect(`${publicAppUrl()}/login?social_error=${encodeURIComponent("Erreur démarrage OAuth")}`);
  }
});

app.get("/auth/social/:provider/callback", async (req, res) => {
  try {
    const provider = String(req.params.provider || "").toLowerCase();
    const { code, state } = req.query;
    const config = socialProviderConfig(provider);

    if (!code || !state || !config || !socialProviderEnabled(provider)) {
      return res.redirect(`${publicAppUrl()}/login?social_error=${encodeURIComponent("OAuth incomplet ou non configuré")}`);
    }

    let statePayload;
    try {
      statePayload = jwt.verify(String(state), JWT_SECRET);
    } catch {
      return res.redirect(`${publicAppUrl()}/login?social_error=${encodeURIComponent("Session OAuth expirée")}`);
    }

    if (statePayload.provider !== provider) {
      return res.redirect(`${publicAppUrl()}/login?social_error=${encodeURIComponent("Provider OAuth invalide")}`);
    }

    const tokenResponse = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.callbackUrl,
        grant_type: "authorization_code",
        code: String(code)
      })
    });
    const tokenPayload = await tokenResponse.json().catch(() => ({}));

    if (!tokenResponse.ok || !tokenPayload.access_token) {
      return res.redirect(`${publicAppUrl()}/login?social_error=${encodeURIComponent("Impossible de récupérer le profil social")}`);
    }

    const profileUrl = new URL(config.userInfoUrl);
    const profileHeaders = {};
    if (provider === "facebook") {
      profileUrl.searchParams.set("access_token", tokenPayload.access_token);
    } else {
      profileHeaders.Authorization = `Bearer ${tokenPayload.access_token}`;
    }

    const profileResponse = await fetch(profileUrl.toString(), { headers: profileHeaders });
    const rawProfile = await profileResponse.json().catch(() => ({}));

    if (!profileResponse.ok) {
      return res.redirect(`${publicAppUrl()}/login?social_error=${encodeURIComponent("Profil social inaccessible")}`);
    }

    const profile = normalizeSocialProfile(provider, rawProfile);
    if (!profile.provider_user_id) {
      return res.redirect(`${publicAppUrl()}/login?social_error=${encodeURIComponent("Identifiant social manquant")}`);
    }

    let userId = null;
    const existingSocial = await pool.query(
      "SELECT user_id FROM social_accounts WHERE provider=$1 AND provider_user_id=$2 LIMIT 1",
      [provider, profile.provider_user_id]
    );

    if (existingSocial.rows[0]) {
      userId = existingSocial.rows[0].user_id;
    } else if (profile.email) {
      const existingUser = await pool.query(
        "SELECT id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1",
        [profile.email]
      );
      if (existingUser.rows[0]) userId = existingUser.rows[0].id;
    }

    if (!userId) {
      await ensureDefaultSubscriptionPlans();
      const planResult = await pool.query(
        "SELECT * FROM subscription_plans ORDER BY price_monthly ASC, id ASC LIMIT 1"
      );
      const plan = planResult.rows[0] || {};
      const displayName = profile.name || `${provider} utilisateur`;
      const generatedEmail =
        profile.email ||
        `${provider}-${profile.provider_user_id}@social.trianglewmspro.local`;
      const randomPassword = await hashPassword(crypto.randomBytes(24).toString("hex"));

      const companyResult = await pool.query(
        `INSERT INTO companies
         (name, responsible_name, email, phone, plan_id, subscription_status,
          trial_ends_at, email_verified, phone_verified, account_status,
          trial_start_date, trial_end_date, subscription_plan, subscription_expires_at)
         VALUES ($1,$2,$3,'',$4,'trial',NOW() + INTERVAL '15 days',$5,false,'active',
                 NOW(),NOW() + INTERVAL '15 days',$6,NOW() + INTERVAL '15 days')
         RETURNING *`,
        [
          `Entreprise de ${displayName}`,
          displayName,
          profile.email || "",
          plan.id || null,
          profile.email_verified === true,
          plan.name || "Trial"
        ]
      );
      const company = companyResult.rows[0];
      const userResult = await pool.query(
        `INSERT INTO users
         (fullname, email, password, role, company_id, is_super_admin,
          profile_image_url, email_verified, phone_verified, account_status,
          invitation_status, verification_required, badge_code)
         VALUES ($1,$2,$3,'admin',$4,false,$5,$6,false,'active','active',false,$7)
         RETURNING id`,
        [
          displayName,
          generatedEmail,
          randomPassword,
          company.id,
          profile.avatar_url || "",
          profile.email_verified === true,
          `TRIANGLE-SOCIAL-${company.id}-${Date.now()}`
        ]
      );
      userId = userResult.rows[0].id;

      await pool.query(
        `INSERT INTO subscriptions
         (company_id, plan_id, start_date, end_date, status, payment_status)
         VALUES ($1,$2,NOW(),NOW() + INTERVAL '15 days','trial','free_trial')`,
        [company.id, plan.id || null]
      );
    }

    await pool.query(
      `INSERT INTO social_accounts
       (user_id, provider, provider_user_id, email, phone, avatar_url, scopes_granted,
        access_token_encrypted, refresh_token_encrypted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (provider, provider_user_id)
       DO UPDATE SET
         user_id=EXCLUDED.user_id,
         email=EXCLUDED.email,
         phone=EXCLUDED.phone,
         avatar_url=EXCLUDED.avatar_url,
         scopes_granted=EXCLUDED.scopes_granted,
         access_token_encrypted=EXCLUDED.access_token_encrypted,
         refresh_token_encrypted=EXCLUDED.refresh_token_encrypted,
         updated_at=CURRENT_TIMESTAMP`,
      [
        userId,
        provider,
        profile.provider_user_id,
        profile.email || "",
        "",
        profile.avatar_url || "",
        config.scope,
        encryptSocialToken(tokenPayload.access_token),
        encryptSocialToken(tokenPayload.refresh_token || "")
      ]
    );

    if (profile.email_verified && profile.email) {
      await pool.query(
        `UPDATE users
         SET email_verified=true,
             account_status='active',
             verification_required=false,
             profile_image_url=COALESCE(NULLIF(profile_image_url,''), $2)
         WHERE id=$1`,
        [userId, profile.avatar_url || ""]
      );
    }

    await logAudit(
      { ...req, user: { id: userId, role: "social_auth", company_id: null } },
      "social_login",
      "social_account",
      userId,
      { provider, scopes: config.scope }
    );

    const loginPayload = await buildLoginResponseForUser(userId);
    if (!loginPayload) {
      return res.redirect(`${publicAppUrl()}/login?social_error=${encodeURIComponent("Compte Triangle introuvable")}`);
    }

    const encoded = Buffer.from(JSON.stringify(loginPayload)).toString("base64url");
    res.redirect(`${publicAppUrl()}/social-auth?payload=${encoded}`);
  } catch (error) {
    console.error("ERREUR SOCIAL CALLBACK :", error);
    res.redirect(`${publicAppUrl()}/login?social_error=${encodeURIComponent("Erreur connexion sociale")}`);
  }
});

app.delete("/auth/social/:provider", authenticateToken, async (req, res) => {
  try {
    const provider = String(req.params.provider || "").toLowerCase();
    await pool.query(
      "DELETE FROM social_accounts WHERE user_id=$1 AND provider=$2",
      [req.user.id, provider]
    );
    await logAudit(req, "unlink_social_account", "social_account", req.user.id, { provider });
    res.json({ success: true, message: "Compte social délié." });
  } catch (error) {
    console.error("ERREUR UNLINK SOCIAL :", error);
    res.status(500).json({ error: "Erreur suppression liaison sociale" });
  }
});

app.post("/support/contact", async (req, res) => {
  try {
    const { name, entreprise, company_id, user_id, email, phone, message, page_actuelle, source_page } = req.body;

    if (!message || String(message).trim().length < 3) {
      return res.status(400).json({ error: "Message support obligatoire." });
    }

    const result = await pool.query(
      `INSERT INTO support_requests
       (company_id, user_id, name, email, phone, message, source_page, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'nouveau')
       RETURNING *`,
      [
        optionalNumber(company_id),
        optionalNumber(user_id),
        name || entreprise || "",
        email || "",
        phone || "",
        message,
        source_page || page_actuelle || ""
      ]
    );

    res.status(201).json({
      success: true,
      request: result.rows[0],
      whatsapp_url: supportWhatsAppUrl()
    });
  } catch (error) {
    console.error("ERREUR SUPPORT CONTACT :", error);
    res.status(500).json({ error: "Erreur demande support" });
  }
});

app.post("/verification/verify", async (req, res) => {
  try {
    const { code, token, target_type, target_value, user_id } = req.body;

    if (!code && !token) {
      return res.status(400).json({ error: "Code ou token obligatoire." });
    }

    const values = [];
    let filter = "used_at IS NULL AND expires_at > NOW()";

    if (token) {
      values.push(hashVerificationSecret(token));
      filter += ` AND token_hash=$${values.length}`;
    } else {
      if (target_type) {
        values.push(target_type);
        filter += ` AND target_type=$${values.length}`;
      }
      if (target_value) {
        values.push(target_value);
        filter += ` AND target_value=$${values.length}`;
      }
      if (user_id) {
        values.push(Number(user_id));
        filter += ` AND user_id=$${values.length}`;
      }
    }

    const result = await pool.query(
      `SELECT * FROM verification_codes
       WHERE ${filter}
       ORDER BY id DESC
       LIMIT 1`,
      values
    );

    const verification = result.rows[0];

    if (!verification) {
      return res.status(400).json({ error: "Code expiré ou introuvable." });
    }

    if (Number(verification.attempts || 0) >= 5) {
      return res.status(429).json({ error: "Trop de tentatives. Demandez un nouveau code." });
    }

    if (code) {
      const validCode = await bcrypt.compare(String(code || ""), verification.code_hash);
      if (!validCode) {
        await pool.query(
          "UPDATE verification_codes SET attempts=attempts+1 WHERE id=$1",
          [verification.id]
        );
        return res.status(400).json({ error: "Code incorrect." });
      }
    }

    await pool.query(
      "UPDATE verification_codes SET used_at=NOW() WHERE id=$1",
      [verification.id]
    );
    await activateVerifiedAccount({
      companyId: verification.company_id,
      userId: verification.user_id,
      targetType: verification.target_type
    });

    await logAudit(
      { ...req, user: { id: verification.user_id, company_id: verification.company_id, role: "verification" } },
      `verify_${verification.target_type}`,
      "verification_code",
      verification.id,
      { target_type: verification.target_type }
    );

    const loginPayload = verification.user_id
      ? await buildLoginResponseForUser(verification.user_id)
      : null;
    const verifiedRole = normalizeRole(loginPayload?.user?.role);

    res.json({
      success: true,
      message: "Vérification réussie. Vous pouvez vous connecter.",
      redirect: loginPayload?.token
        ? (verifiedRole === "customer" ? "/client/dashboard" : "/dashboard")
        : "/login",
      token: loginPayload?.token,
      user: loginPayload?.user
    });
  } catch (error) {
    console.error("ERREUR VERIFICATION :", error);
    res.status(500).json({ error: "Erreur vérification" });
  }
});

app.post("/verification/resend", async (req, res) => {
  try {
    const { target_type, target_value, user_id } = req.body;
    const targetType = target_type === "phone" ? "phone" : "email";
    const targetValue = String(target_value || "").trim();

    if (!targetValue && !user_id) {
      return res.status(400).json({ error: "Contact ou utilisateur obligatoire." });
    }

    const userResult = await pool.query(
      `SELECT id, company_id, email, phone
       FROM users
       WHERE ($1::int IS NOT NULL AND id=$1)
          OR ($2 <> '' AND LOWER(email)=LOWER($2))
          OR ($3 <> '' AND regexp_replace(COALESCE(phone,''), '[^0-9+]', '', 'g') = regexp_replace($3, '[^0-9+]', '', 'g'))
       LIMIT 1`,
      [
        optionalNumber(user_id),
        targetType === "email" ? targetValue : "",
        targetType === "phone" ? targetValue : ""
      ]
    );

    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: "Utilisateur introuvable." });

    const finalTargetValue = targetType === "phone" ? user.phone : user.email;
    const verification = await createVerificationCode({
      companyId: user.company_id,
      userId: user.id,
      targetType,
      targetValue: finalTargetValue
    });
    const delivery = await sendVerificationMessage({
      targetType,
      targetValue: finalTargetValue,
      code: verification.code,
      verifyUrl: verification.verify_url
    });

    res.json({
      success: true,
      message: "Nouveau code généré.",
      target_type: targetType,
      target_value: finalTargetValue,
      delivery
    });
  } catch (error) {
    console.error("ERREUR RESEND VERIFICATION :", error);
    res.status(500).json({ error: "Erreur renvoi code" });
  }
});

app.put("/me/password", authenticateToken, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    const passwordError = validatePasswordStrength(new_password);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }

    const userResult = await pool.query(
      "SELECT id, password FROM users WHERE id=$1 LIMIT 1",
      [req.user.id]
    );
    const user = userResult.rows[0];

    if (!user) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    const passwordMatches = await verifyPassword(current_password, user.password);
    if (!passwordMatches) {
      return res.status(401).json({ error: "Mot de passe actuel incorrect" });
    }

    await pool.query(
      `UPDATE users
       SET password=$1,
           force_password_change=false,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$2`,
      [await hashPassword(new_password), req.user.id]
    );

    await logAudit(req, "change_password", "user", req.user.id, {});

    res.json({ message: "Mot de passe modifié" });
  } catch (error) {
    console.error("ERREUR ME PASSWORD :", error);
    res.status(500).json({ error: "Erreur changement mot de passe" });
  }
});

/* UTILISATEURS */
app.get("/users", authenticateToken, async (req, res) => {
  try {
    const role = normalizeRole(req.user?.role);
    if (role === "customer" || role === "client") {
      return res.status(403).json({ error: "Accès refusé aux utilisateurs internes." });
    }

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

app.get("/modules", authenticateToken, async (req, res) => {
  try {
    if (!canAccessAdminSettings(req.user)) {
      return res.status(403).json({ error: "Accès refusé : réservé à l’administrateur" });
    }

    const result = await pool.query(
      `SELECT module_key, module_name, description, is_active
       FROM modules
       WHERE is_active=true
       ORDER BY module_name ASC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR MODULES :", error);
    res.status(500).json({ error: "Erreur lecture modules" });
  }
});

app.get("/users/:id/permissions", authenticateToken, async (req, res) => {
  try {
    if (!canAccessAdminSettings(req.user)) {
      return res.status(403).json({ error: "Accès refusé : réservé à l’administrateur" });
    }

    const userResult = await pool.query("SELECT id, company_id FROM users WHERE id=$1", [req.params.id]);
    const targetUser = userResult.rows[0];

    if (!targetUser) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    if (req.user.is_super_admin !== true && Number(targetUser.company_id) !== Number(req.user.company_id)) {
      return res.status(403).json({ error: "Accès refusé : utilisateur hors entreprise" });
    }

    const result = await pool.query(
      `SELECT up.*, m.module_name, m.description
       FROM user_permissions up
       LEFT JOIN modules m ON m.module_key=up.module_key
       WHERE up.user_id=$1
       ORDER BY up.module_key ASC`,
      [req.params.id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR USER PERMISSIONS :", error);
    res.status(500).json({ error: "Erreur lecture permissions utilisateur" });
  }
});

app.put("/users/:id/permissions", authenticateToken, async (req, res) => {
  try {
    if (!canAccessAdminSettings(req.user)) {
      return res.status(403).json({ error: "Accès refusé : réservé à l’administrateur" });
    }

    const { permissions = [] } = req.body;
    const userResult = await pool.query("SELECT id, company_id FROM users WHERE id=$1", [req.params.id]);
    const targetUser = userResult.rows[0];

    if (!targetUser) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    if (req.user.is_super_admin !== true && Number(targetUser.company_id) !== Number(req.user.company_id)) {
      return res.status(403).json({ error: "Accès refusé : utilisateur hors entreprise" });
    }

    const saved = [];

    for (const permission of permissions) {
      const result = await pool.query(
        `INSERT INTO user_permissions
         (user_id, module_key, can_view, can_create, can_edit, can_delete, can_validate, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (user_id, module_key)
         DO UPDATE SET
           can_view=EXCLUDED.can_view,
           can_create=EXCLUDED.can_create,
           can_edit=EXCLUDED.can_edit,
           can_delete=EXCLUDED.can_delete,
           can_validate=EXCLUDED.can_validate,
           updated_by=EXCLUDED.updated_by,
           updated_at=CURRENT_TIMESTAMP
         RETURNING *`,
        [
          req.params.id,
          permission.module_key,
          permission.can_view === true,
          permission.can_create === true,
          permission.can_edit === true,
          permission.can_delete === true,
          permission.can_validate === true,
          req.user.id || null
        ]
      );

      saved.push(result.rows[0]);
    }

    res.json(saved);
  } catch (error) {
    console.error("ERREUR UPDATE USER PERMISSIONS :", error);
    res.status(500).json({ error: "Erreur sauvegarde permissions utilisateur" });
  }
});

app.put("/users/:id/caisse", authenticateToken, async (req, res) => {
  try {
    if (!canManageCaisses(req.user)) {
      return res.status(403).json({ error: "Accès refusé : réservé à l’administrateur" });
    }

    const { caisse_id } = req.body;
    const userResult = await pool.query("SELECT id, company_id FROM users WHERE id=$1", [req.params.id]);
    const targetUser = userResult.rows[0];

    if (!targetUser) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    if (req.user.is_super_admin !== true && Number(targetUser.company_id) !== Number(req.user.company_id)) {
      return res.status(403).json({ error: "Accès refusé : utilisateur hors entreprise" });
    }

    if (caisse_id) {
      const caisseResult = await pool.query(
        `SELECT id FROM caisses
         WHERE id=$1 AND actif=true
         ${req.user.is_super_admin === true ? "" : "AND company_id=$2"}`,
        req.user.is_super_admin === true ? [caisse_id] : [caisse_id, req.user.company_id]
      );

      if (!caisseResult.rows[0]) {
        return res.status(404).json({ error: "Caisse introuvable" });
      }
    }

    const result = await pool.query(
      `UPDATE users
       SET caisse_id=$1, updated_at=CURRENT_TIMESTAMP
       WHERE id=$2
       RETURNING id, fullname, email, role, caisse_id`,
      [caisse_id || null, req.params.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR USER CAISSE :", error);
    res.status(500).json({ error: "Erreur affectation caisse utilisateur" });
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
      const requestedRole = normalizeRole(role || "magasinier");

      if (requestedRole === "super_admin" && req.user.is_super_admin !== true) {
        return res.status(403).json({
          error: "Action interdite : rôle Super Admin réservé"
        });
      }

      /* Un compte a besoin d'UN moyen d'être reconnu, pas des deux. Tout le
         monde n'a pas d'adresse email ; le téléphone en tient lieu. */
      const identite = identifiants.lireIdentifiants({ email, phone });

      if (identite.telephoneIllisible) {
        return res.status(400).json({
          error: "Ce numéro de téléphone n'est pas exploitable. Exemples acceptés : "
               + "76327799, 76 32 77 99, +22376327799, 0022376327799.",
          code: "PHONE_INVALID",
        });
      }
      if (!identite.email && !identite.telephone) {
        return res.status(400).json({
          error: "Indiquez au moins une adresse email ou un numéro de téléphone.",
          code: "IDENTIFIER_REQUIRED",
        });
      }

      /* Un identifiant déjà pris désigne quelqu'un d'autre : on refuse avant
         d'écrire, plutôt que de laisser l'index trancher par une erreur
         technique que personne ne sait lire. */
      if (identite.emailNormalise) {
        const { rows } = await pool.query(
          `SELECT id FROM users WHERE lower(email) = $1 LIMIT 1`,
          [identite.emailNormalise]
        );
        if (rows.length) {
          return res.status(409).json({
            error: "Cette adresse email est déjà utilisée par un autre compte.",
            code: "EMAIL_TAKEN",
          });
        }
      }
      if (identite.telephone) {
        const { rows } = await pool.query(
          `SELECT id FROM users WHERE phone_normalise = $1 LIMIT 1`,
          [identite.telephone]
        );
        if (rows.length) {
          return res.status(409).json({
            error: "Ce numéro de téléphone est déjà utilisé par un autre compte.",
            code: "PHONE_TAKEN",
          });
        }
      }

      /* Dispenser de vérification, c'est ouvrir un compte sans preuve que
         la personne contrôle l'adresse ou le numéro. Seul un
         super-administrateur peut le décider — jamais l'intéressé. */
      const modeDemande = String(req.body?.verification_mode || "").trim().toLowerCase();
      let verificationMode = null;
      if (modeDemande) {
        if (!["none", "email", "phone"].includes(modeDemande)) {
          return res.status(400).json({
            error: "Mode de vérification inconnu.", code: "VERIFICATION_MODE_INVALID",
          });
        }
        if (req.user.is_super_admin !== true) {
          return res.status(403).json({
            error: "Seul un super-administrateur peut choisir le mode de vérification.",
            code: "VERIFICATION_MODE_FORBIDDEN",
          });
        }
        if (modeDemande === "email" && !identite.email) {
          return res.status(400).json({
            error: "La vérification par email exige une adresse email.",
            code: "VERIFICATION_EMAIL_IMPOSSIBLE",
          });
        }
        if (modeDemande === "phone" && !smsServiceConfigure()) {
          return res.status(400).json({
            error: "Aucun service SMS n'est configuré : la vérification par téléphone "
                 + "ne peut pas être exigée. Choisissez l'email, ou aucune vérification.",
            code: "SMS_NOT_CONFIGURED",
          });
        }
        verificationMode = modeDemande;
      }

      const rawPassword = password || crypto.randomBytes(8).toString("base64");
      const passwordError = validatePasswordStrength(rawPassword);

      if (passwordError) {
        return res.status(400).json({ error: passwordError });
      }

      /* L'entreprise vient du contexte de travail authentifié, pas du corps
         de la requête. C'est ce qui manquait : un employé créé depuis
         FAT & MAT atterrissait dans Triangle parce que la route lisait
         `company_id` du navigateur, puis se rabattait sur la société du
         compte administrateur — jamais sur l'entreprise réellement active. */
      const contexteSociete = await companyContext.resoudreSociete(
        pool, req, getEffectiveCompanyId
      );
      if (!contexteSociete.companyId) {
        return res.status(409).json({
          error: contexteSociete.refus || "Entreprise indéterminée.",
          code: "COMPANY_CONTEXT_REQUIRED",
        });
      }
      const assignedCompanyId = contexteSociete.companyId;

      /* Affecter quelqu'un à un entrepôt d'une AUTRE entreprise lui ouvrirait
         une porte latérale : l'entrepôt doit appartenir à l'entreprise qui
         crée le compte. */
      let entrepotAffecte = null;
      if (req.body?.warehouse_id !== undefined && req.body?.warehouse_id !== null
          && String(req.body.warehouse_id).trim() !== "") {
        const demande = Number(req.body.warehouse_id);
        const { rows } = await pool.query(
          `SELECT id FROM warehouses WHERE id = $1 AND company_id = $2`,
          [demande, assignedCompanyId]
        );
        if (!rows.length) {
          return res.status(400).json({
            error: "Cet entrepôt n'appartient pas à l'entreprise de ce compte.",
            code: "WAREHOUSE_NOT_IN_COMPANY",
          });
        }
        entrepotAffecte = rows[0].id;
      }

      const userResult = await pool.query(
        `
      INSERT INTO users
      (
        fullname,
        email,
        password,
        role,
        phone,
        phone_normalise,
        company_id,
        is_super_admin,
        verification_mode,
        verification_mode_set_by,
        verification_mode_set_at,
        email_verified,
        phone_verified,
        warehouse_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
              CASE WHEN $9::text IS NULL THEN NULL ELSE now() END,
              $11,$12,$13)
      RETURNING *
      `,
        [
          fullname,
          identite.email,
          await hashPassword(rawPassword),
          requestedRole || "magasinier",
          phone || "",
          identite.telephone,
          assignedCompanyId,
          req.user.is_super_admin === true && requestedRole === "super_admin",
          verificationMode,
          verificationMode ? req.user.id : null,
          /* Dispensé de vérification, le compte est utilisable tout de suite :
             marquer vérifié ce que le super-administrateur a explicitement
             dispensé évite qu'un contrôle hérité le bloque quand même. */
          verificationMode === "none" && Boolean(identite.email),
          verificationMode === "none" && Boolean(identite.telephone),
          entrepotAffecte,
        ]
      );

      const user = userResult.rows[0];

      /* Le badge suit l'entreprise d'appartenance réelle. La séquence est
         incrémentée sous verrou dans la même transaction que l'écriture :
         deux créations simultanées obtiennent deux numéros distincts. */
      const clientBadge = await pool.connect();
      let updatedUser;
      try {
        await clientBadge.query("BEGIN");
        const badgeCode = await companyContext.prochainBadge(clientBadge, assignedCompanyId);
        updatedUser = await clientBadge.query(
          `UPDATE users SET badge_code = $1 WHERE id = $2 RETURNING *`,
          [badgeCode, user.id]
        );
        await clientBadge.query("COMMIT");
      } finally {
        clientBadge.release();
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
      ON CONFLICT (user_id) DO NOTHING
      `,
        [user.id, "Standard", "horaire", 1000, 8000, 200000, "08:00", "17:00"]
      );

      /* L'empreinte du mot de passe n'a rien à faire dans une réponse : elle
         se retrouverait dans les journaux du navigateur et les outils réseau.
         Elle ne sert qu'à la vérification, côté serveur. */
      const { password: _empreinte, ...compteCree } = updatedUser.rows[0];
      res.status(201).json(compteCree);
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
      const requestedRole = normalizeRole(role || "magasinier");

      if (requestedRole === "super_admin" && !isSuperAdmin) {
        return res.status(403).json({
          error: "Action interdite : rôle Super Admin réservé"
        });
      }

      const values = [
        fullname,
        email,
        requestedRole || "magasinier",
        phone || "",
        is_active !== false,
      ];

      let query = `
        UPDATE users
        SET fullname=$1,
            email=$2,
            role=$3,
            phone=$4,
            is_active=$5,
            is_super_admin=${isSuperAdmin ? "$6" : "is_super_admin"}
      `;

      if (isSuperAdmin) {
        values.push(requestedRole === "super_admin");
      }

      if (password && String(password).trim() !== "") {
        const passwordError = validatePasswordStrength(password);
        if (passwordError) {
          return res.status(400).json({ error: passwordError });
        }

        values.push(await hashPassword(password));
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

app.post(
  "/users/:id/reset-password",
  authenticateToken,
  authorizeRoles("admin", "super_admin"),
  async (req, res) => {
    try {
      if (!canAccessAdminSettings(req.user)) {
        return res.status(403).json({ error: "Accès administrateur requis." });
      }

      const tempPassword = `Triangle-${crypto.randomBytes(4).toString("hex")}-2026`;
      const hashedPassword = await hashPassword(tempPassword);
      const companyId = getEffectiveCompanyId(req, req.user.company_id);
      const isSuperAdmin = isSuperAdminUser(req.user);

      const result = await pool.query(
        `UPDATE users
         SET password=$1,
             force_password_change=true,
             updated_at=CURRENT_TIMESTAMP
         WHERE id=$2
         ${isSuperAdmin ? "" : "AND company_id=$3"}
         RETURNING id, fullname, email, role, company_id`,
        isSuperAdmin ? [hashedPassword, req.params.id] : [hashedPassword, req.params.id, companyId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Utilisateur introuvable" });
      }

      await logAudit(
        req,
        "reset_password",
        "user",
        req.params.id,
        { target_email: result.rows[0].email }
      );

      let email_sent = false;
      let email_message = "SMTP non configuré : communiquez le mot de passe temporaire manuellement.";

      if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && result.rows[0].email) {
        try {
          const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT || 587),
            secure: Number(process.env.SMTP_PORT || 587) === 465,
            auth: {
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASS
            }
          });

          await transporter.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: result.rows[0].email,
            subject: "Réinitialisation mot de passe Triangle WMS Pro",
            html: `
              <p>Bonjour ${result.rows[0].fullname || ""},</p>
              <p>Votre mot de passe temporaire Triangle WMS Pro est :</p>
              <p style="font-size:18px;font-weight:bold">${tempPassword}</p>
              <p>Connectez-vous puis modifiez votre mot de passe.</p>
            `
          });
          email_sent = true;
          email_message = "Email de réinitialisation envoyé.";
        } catch (mailError) {
          console.error("ERREUR EMAIL RESET PASSWORD :", mailError);
          email_message = "SMTP configuré mais l’envoi email a échoué.";
        }
      }

      res.json({
        message: email_message,
        user: result.rows[0],
        temporary_password: tempPassword,
        email_sent
      });
    } catch (error) {
      console.error("ERREUR RESET PASSWORD :", error);
      res.status(500).json({ error: "Erreur réinitialisation mot de passe" });
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
    const isSuperAdmin = req.user.is_super_admin === true;
    const companyId = isSuperAdmin ? getEffectiveCompanyId(req) : req.user.company_id;

    let query = `
      SELECT products.*, locations.emplacement_code, c.name AS company_name
      FROM products
      LEFT JOIN locations 
      ON products.location_id = locations.id
      LEFT JOIN companies c ON c.id=products.company_id
    `;

    let values = [];

    if (!isSuperAdmin || companyId) {
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

    const companyId = getEffectiveCompanyId(req, req.user.company_id);
    const isSuperAdmin = req.user.is_super_admin === true;

    if (!companyId) {
      return res.status(400).json({ error: "Sélectionnez une entreprise active avant de créer un produit." });
    }

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
      purchase_price,
      sale_price,
      rental_price,
      daily_price,
      monthly_price,
      is_sellable,
      is_rentable,
      is_durable,
      product_type,
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
    purchase_price,
    sale_price,
    rental_price,
    daily_price,
    monthly_price,
    is_sellable,
    is_rentable,
    is_durable,
    product_type,
    company_id
  )
  VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,
    $9,$10,$11,$12,$13,$14,$15,$16,
    $17,$18,$19,$20,$21,$22,$23,$24,$25,$26
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
        Number(purchase_price || 0),
        Number(sale_price || 0),
        Number(rental_price || 0),
        Number(daily_price || 0),
        Number(monthly_price || 0),
        is_sellable !== false,
        is_rentable === true,
        is_durable === true,
        product_type || "stock_normal",
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
    const companyId = getEffectiveCompanyId(req, req.user.company_id);
    const isSuperAdmin = req.user.is_super_admin === true;

    if (!companyId) {
      return res.status(400).json({ error: "Sélectionnez une entreprise active avant de modifier un produit." });
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
      purchase_price,
      sale_price,
      rental_price,
      daily_price,
      monthly_price,
      is_sellable,
      is_rentable,
      is_durable,
      product_type,
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
      Number(purchase_price || 0),
      Number(sale_price || 0),
      Number(rental_price || 0),
      Number(daily_price || 0),
      Number(monthly_price || 0),
      is_sellable !== false,
      is_rentable === true,
      is_durable === true,
      product_type || "stock_normal",
      id
    ];

    let query = `
      UPDATE products
      SET reference=$1, name=$2, category=$3, stock=$4, warehouse=$5,
          status=$6, unit=$7, weight=$8, dimensions=$9, barcode=$10,
          description=$11, is_active=$12, location_id=$13, location_code=$14,
          minimum_stock=$15, image_url=$16, purchase_price=$17,
          sale_price=$18, rental_price=$19, daily_price=$20,
          monthly_price=$21, is_sellable=$22, is_rentable=$23,
          is_durable=$24, product_type=$25
      WHERE id=$26
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

    const companyId = getEffectiveCompanyId(req, req.user.company_id);
    const isSuperAdmin = req.user.is_super_admin === true;
    if (!companyId) {
      return res.status(400).json({ error: "Sélectionnez une entreprise active avant de créer un mouvement stock." });
    }

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
      partner_id = null,
      partner_name = "",
      partner_type = "",
      apply_price = false,
      unit_price = 0,
      reason,
      user_name,
      user_role
    } = req.body;

    const productCheck = await pool.query(
      `SELECT *
       FROM products
       WHERE reference=$1
       AND company_id=$2
       LIMIT 1`,
      [product_reference, companyId]
    );

    if (productCheck.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Produit introuvable pour cette entreprise" });
    }

    const product = productCheck.rows[0];
    const priceApplied = apply_price === true || apply_price === "true";
    const movementUnitPrice = priceApplied ? Number(unit_price || 0) : 0;
    const movementTotalAmount = priceApplied
      ? Number(quantity || 0) * movementUnitPrice
      : 0;

    const result = await pool.query(
      `INSERT INTO stock_movements
      (type, product_reference, product_name, quantity, source_warehouse,
       destination_warehouse, reason, status, company_id, created_by,
       created_by_name, created_by_role, location_code, warehouse_id,
       approval_status, original_quantity, final_quantity, product_id, location_id,
       partner_id, partner_name, partner_type, apply_price, unit_price, total_amount)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
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
        location_id || product.location_id || null,
        partner_id || null,
        partner_name || "",
        partner_type || "",
        priceApplied,
        movementUnitPrice,
        movementTotalAmount
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
      if (!(await canValidateStockMovementAsync(req.user))) {
        return res.status(403).json({
          error: "Accès refusé : vous ne pouvez pas valider ce mouvement."
        });
      }

      const { id } = req.params;
      const companyId = getEffectiveCompanyId(req, req.user.company_id);
      const isSuperAdmin = req.user.is_super_admin === true;
      if (!companyId) {
        return res.status(400).json({ error: "Sélectionnez une entreprise active avant de valider un mouvement stock." });
      }
      const { final_quantity, correction_note } = req.body || {};

      /* Validation déléguée au service PARTAGÉ services/stock-operations.js,
         désormais commun aux routes manuelles et à l'import d'inventaire.
         Ce bloc appliquait auparavant le stock hors transaction, plafonnait les
         sorties par GREATEST(stock-q,0) — ce qui faisait disparaître le surplus
         sans trace — et validait en masse toutes les lignes partageant une
         product_reference. Les trois comportements sont supprimés. */
      const stockOps = require("./services/stock-operations");
      /* Un mouvement préparé au bac près porte un emplacement source ou
         destination. Sa validation doit passer par le moteur d'emplacement,
         qui met à jour la balance ET products.stock — le moteur global ne
         connaît pas les balances et laisserait la répartition incohérente. */
      {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          const prepare = await stockLocations.preparedMovement(c, companyId, Number(id));
          if (prepare) {
            const out = await stockLocations.validatePreparedMovement(c, {
              companyId, movementId: Number(id),
              user: { id: req.user.id, name: req.user.email, role: req.user.role },
            });
            await c.query("COMMIT");
            return res.json({
              message: "Mouvement validé.", movement: out.movement,
              stock_before: out.stockBefore, stock_after: out.stockAfter,
              par_emplacement: true,
            });
          }
          await c.query("ROLLBACK");
        } catch (e) {
          await c.query("ROLLBACK").catch(() => {});
          return res.status(e.httpStatus || 500)
            .json({ error: e.message || "Erreur de validation.", code: e.code });
        } finally { c.release(); }
      }
      const vClient = await pool.connect();
      let movement, updateResult;
      try {
        await vClient.query("BEGIN");
        const pre = await vClient.query(
          `SELECT * FROM stock_movements WHERE id=$1 AND company_id=$2`, [id, companyId]
        );
        movement = pre.rows[0];
        if (!movement) { await vClient.query("ROLLBACK"); vClient.release();
          return res.status(404).json({ error: "Mouvement introuvable" }); }

        const applied = await stockOps.validateMovement(vClient, {
          companyId, movementId: id, user: { id: req.user.id, name: req.user.email, role: req.user.role },
          finalQuantity: final_quantity !== undefined && final_quantity !== null ? Number(final_quantity) : null,
        });

        if (correction_note) {
          await vClient.query(
            `UPDATE stock_movements SET correction_note=$1, modified_by=$2, modified_at=CURRENT_TIMESTAMP
              WHERE id=$3 AND company_id=$4`,
            [correction_note, req.user.id, id, companyId]
          );
        }
        await vClient.query("COMMIT");
        updateResult = { rows: [applied.movement] };
      } catch (e) {
        await vClient.query("ROLLBACK").catch(() => {});
        vClient.release();
        if (e && e.httpStatus) {
          return res.status(e.httpStatus).json({ error: e.message, code: e.code, ...e.details });
        }
        throw e;
      }
      vClient.release();
      const approvedQuantity = Number(updateResult.rows[0].final_quantity);

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

      res.json(updateResult.rows[0]);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Erreur validation mouvement" });
    }
  }
);

app.put("/stock-movements/:id/reject", authenticateToken, async (req, res) => {
  try {
    if (!(await canValidateStockMovementAsync(req.user))) {
      return res.status(403).json({
        error: "Accès refusé : vous ne pouvez pas refuser ce mouvement."
      });
    }

    const companyId = getEffectiveCompanyId(req, req.user.company_id);
    const isSuperAdmin = req.user.is_super_admin === true;
    if (!companyId) {
      return res.status(400).json({ error: "Sélectionnez une entreprise active avant de refuser un mouvement stock." });
    }

    /* Refuser une sortie préparée au bac près doit LIBÉRER sa réservation :
       sans cela, la quantité resterait indisponible pour toujours. */
    {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const prepare = await stockLocations.preparedMovement(c, companyId, Number(req.params.id));
        if (prepare) {
          const out = await stockLocations.cancelPreparedMovement(c, {
            companyId, movementId: Number(req.params.id),
            reason: req.body?.rejection_reason || null,
            user: { id: req.user.id, name: req.user.email, role: req.user.role },
          });
          await c.query("COMMIT");
          return res.json({
            message: "Mouvement refusé.", movement: out.movement,
            reservation_liberee: out.released, par_emplacement: true,
          });
        }
        await c.query("ROLLBACK");
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        return res.status(e.httpStatus || 500)
          .json({ error: e.message || "Erreur de refus.", code: e.code });
      } finally { c.release(); }
    }
    const { rejection_reason } = req.body || {};

    const movementResult = await pool.query(
      `SELECT * FROM stock_movements
       WHERE id=$1 AND company_id=$2`,
      [req.params.id, companyId]
    );

    const movement = movementResult.rows[0];

    if (!movement)
      return res.status(404).json({ error: "Mouvement introuvable" });

    if (!isSuperAdmin && Number(movement.created_by) === Number(req.user.id)) {
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
       WHERE id=$3 AND company_id=$4
       RETURNING *`,
      [rejection_reason || "", req.user.id, req.params.id, companyId]
    );

    if (movement?.type === "Inventaire") {
      await pool.query(
        `UPDATE inventory_history
         SET status='Refusé'
         WHERE product_reference=$1 AND status='En attente'
         AND company_id=$2`,
        [movement.product_reference, companyId]
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
    const companyId = getEffectiveCompanyId(req);
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
    const companyId = getEffectiveCompanyId(req);
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
      const companyId = getEffectiveCompanyId(req);
      const {
        pos_enabled,
        default_tax_rate,
        currency,
        receipt_format,
        printer_name,
        allowed_payment_methods,
        max_discount_rate,
        decimal_count
      } = req.body;
      const taxRate =
        default_tax_rate === "" || default_tax_rate === null || default_tax_rate === undefined
          ? 18
          : Number(default_tax_rate);

      const result = await pool.query(
        `INSERT INTO pos_settings
         (company_id, pos_enabled, default_tax_rate, currency, receipt_format,
          printer_name, allowed_payment_methods, max_discount_rate, decimal_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (company_id)
         DO UPDATE SET
           pos_enabled=EXCLUDED.pos_enabled,
           default_tax_rate=EXCLUDED.default_tax_rate,
           currency=EXCLUDED.currency,
           receipt_format=EXCLUDED.receipt_format,
           printer_name=EXCLUDED.printer_name,
           allowed_payment_methods=EXCLUDED.allowed_payment_methods,
           max_discount_rate=EXCLUDED.max_discount_rate,
           decimal_count=EXCLUDED.decimal_count,
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
          Number(max_discount_rate || 0),
          Number(decimal_count || 0)
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
      const companyId = getEffectiveCompanyId(req);
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
    const companyId = getEffectiveCompanyId(req);
    const isSuperAdmin = req.user.is_super_admin === true;
    const shouldFilterByCompany = !isSuperAdmin || Boolean(companyId);
    const values = shouldFilterByCompany ? [companyId] : [];
    const companyClause = shouldFilterByCompany ? "AND company_id=$1" : "";

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

    const companyId = getEffectiveCompanyId(req);
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

    const companyId = getEffectiveCompanyId(req);
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
    const companyId = getEffectiveCompanyId(req);

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
    const companyId = getEffectiveCompanyId(req);
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

    const companyId = getEffectiveCompanyId(req);
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

  if (existingFinalReceipt.rows[0]) {
    const updatedExistingSale = await client.query(
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

    return {
      sale: updatedExistingSale.rows[0] || sale,
      items: [],
      receipt: existingFinalReceipt.rows[0],
      already_finalized: true
    };
  }

  const itemsResult = await client.query(
    "SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY id ASC",
    [sale.id]
  );
  const saleItems = [];
  const existingMovementResult = await client.query(
    "SELECT COUNT(*)::int AS count FROM stock_movements WHERE reason=$1 AND company_id=$2",
    [`Vente POS ${sale.sale_number}`, sale.company_id]
  );
  const inventoryAlreadyFinalized = Number(existingMovementResult.rows[0]?.count || 0) > 0;

  for (const item of itemsResult.rows) {
    const publicationResult = await client.query(
      `SELECT *
       FROM marketplace_products
       WHERE id=$1 AND company_id=$2
       FOR UPDATE`,
      [item.marketplace_product_id, order.vendor_company_id]
    );
    const publication = publicationResult.rows[0];
    if (!publication) throw new Error("Publication marketplace introuvable.");

    const productResult = await client.query(
      `SELECT *
       FROM products
       WHERE id=$1 AND company_id=$2
       FOR UPDATE`,
      [item.product_id, sale.company_id]
    );
    const product = productResult.rows[0];

    if (!product) {
      console.log("Produit introuvable pendant finalisation POS:", {
        sale_id: sale.id,
        sale_number: sale.sale_number,
        product_id: item.product_id
      });
      saleItems.push(item);
      continue;
    }

    const quantity = Number(item.quantity || 0);

    if (!inventoryAlreadyFinalized && Number(product.stock || 0) < quantity) {
      console.log("Stock insuffisant pendant finalisation POS, reçu conservé:", {
        sale_id: sale.id,
        sale_number: sale.sale_number,
        product_reference: product.reference,
        stock: product.stock,
        quantity
      });
      saleItems.push(item);
      continue;
    }

    let batch = null;
    if (!inventoryAlreadyFinalized && (product.batch_tracking_enabled || product.expiration_tracking_enabled)) {
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
        console.log("Aucun lot disponible pendant finalisation POS, reçu conservé:", {
          sale_id: sale.id,
          product_reference: product.reference
        });
        saleItems.push(item);
        continue;
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

    if (!inventoryAlreadyFinalized) {
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
    }

    saleItems.push({ ...item, batch_id: batch?.id || item.batch_id, lot_number: batch?.lot_number || item.lot_number });
  }

  const receiptNumber = `REC-${new Date().getFullYear()}-${String(sale.id).padStart(6, "0")}`;
  const companySettings = await getCompanySettingsForCompany(client, sale.company_id);

  const updatedSaleResult = await client.query(
    `UPDATE sales
     SET payment_status='paid',
         status='validée',
         amount_paid=total_amount,
         amount_due=0,
         remaining_amount=0,
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
          company_settings: companySettings
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

  const paymentResult = await client.query(
    `INSERT INTO payments
     (company_id, amount, currency, payment_method, payment_reference,
      status, notes, paid_at, sale_id, receipt_id, payment_status, caisse_id)
     VALUES ($1,$2,'FCFA',$3,$4,'paid',$5,CURRENT_TIMESTAMP,$6,$7,'paid',$8)
     RETURNING *`,
    [
      sale.company_id,
      Number(sale.total_amount || 0),
      sale.payment_method,
      sale.payment_reference || sale.sale_number,
      `Paiement POS ${sale.sale_number}`,
      sale.id,
      receipt?.id || null,
      sale.caisse_id || sale.cash_register_id || null
    ]
  );
  const payment = paymentResult.rows[0];
  await recordPosPaymentAccounting(client, {
    sale: updatedSale,
    payment,
    user,
    amount: Number(sale.total_amount || 0)
  });

  return {
    sale: updatedSale,
    items: saleItems,
    receipt,
    company_settings: companySettings
  };
}

async function getUserCaisse(clientOrPool, userId) {
  const result = await clientOrPool.query(
    `SELECT u.caisse_id, c.*
     FROM users u
     LEFT JOIN caisses c ON c.id=u.caisse_id
     WHERE u.id=$1
     LIMIT 1`,
    [userId]
  );

  return result.rows[0] || null;
}

async function resolveSaleCaisse(clientOrPool, user, requestedCaisseId) {
  const companyId = user.company_id || null;
  const assigned = await getUserCaisse(clientOrPool, user.id);
  const isManager = canManageCaisses(user);
  const preferredId = requestedCaisseId || assigned?.caisse_id || null;

  if (preferredId) {
    const values = [preferredId];
    let query = "SELECT * FROM caisses WHERE id=$1 AND actif=true";

    if (!user.is_super_admin) {
      values.push(companyId);
      query += " AND (company_id=$2 OR company_id IS NULL)";
    }

    const result = await clientOrPool.query(query, values);
    const caisse = result.rows[0];

    if (!caisse) throw new Error("Caisse introuvable ou inactive.");
    if (!isManager && Number(assigned?.caisse_id || 0) !== Number(caisse.id)) {
      throw new Error("Vous n'êtes pas affecté à cette caisse.");
    }

    return caisse;
  }

  if (!isManager) {
    throw new Error("Aucune caisse n'est affectée à cet utilisateur.");
  }

  const result = await clientOrPool.query(
    `SELECT * FROM caisses
     WHERE actif=true AND ($1::int IS NULL OR company_id=$1)
     ORDER BY id ASC
     LIMIT 1`,
    [companyId]
  );

  return result.rows[0] || null;
}

app.get("/pos/caisses", authenticateToken, async (req, res) => {
  try {
    if (!canUsePos(req.user) && !canAccessDirectionModule(req.user)) {
      return res.status(403).json({ error: "Accès POS refusé." });
    }

    const companyId = getEffectiveCompanyId(req);
    const isManager = canManageCaisses(req.user);
    const values = [];
    let query = `
      SELECT c.*, COUNT(u.id)::int AS assigned_users
      FROM caisses c
      LEFT JOIN users u ON u.caisse_id=c.id
      WHERE c.actif=true
    `;

    if (!req.user.is_super_admin || companyId) {
      values.push(companyId);
      query += ` AND (c.company_id=$${values.length} OR c.company_id IS NULL)`;
    }

    if (!isManager && !canAccessDirectionModule(req.user)) {
      values.push(req.user.id);
      query += ` AND EXISTS (SELECT 1 FROM users cu WHERE cu.id=$${values.length} AND cu.caisse_id=c.id)`;
    }

    query += " GROUP BY c.id ORDER BY c.id ASC";

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR POS CAISSES :", error);
    res.status(500).json({ error: "Erreur lecture caisses" });
  }
});

app.post("/pos/caisses", authenticateToken, async (req, res) => {
  try {
    if (!canManageCaisses(req.user)) {
      return res.status(403).json({ error: "Accès refusé : réservé à l’administrateur" });
    }

    const { nom_caisse, code_caisse, solde_initial = 0 } = req.body;
    const result = await pool.query(
      `INSERT INTO caisses
       (company_id, nom_caisse, code_caisse, statut, solde_initial, solde_actuel)
       VALUES ($1,$2,$3,'fermée',$4,$4)
       RETURNING *`,
      [
        getEffectiveCompanyId(req),
        nom_caisse || "Caisse principale",
        code_caisse || `CAISSE-${Date.now()}`,
        Number(solde_initial || 0)
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR CREATE CAISSE :", error);
    res.status(500).json({ error: "Erreur création caisse" });
  }
});

app.put("/pos/caisses/:id", authenticateToken, async (req, res) => {
  try {
    if (!canManageCaisses(req.user)) {
      return res.status(403).json({ error: "Accès refusé : réservé à l’administrateur" });
    }

    const { nom_caisse, code_caisse, solde_initial = 0 } = req.body;
    const values = [nom_caisse || "Caisse principale", code_caisse || "", Number(solde_initial || 0), req.params.id];
    let query = `
      UPDATE caisses
      SET nom_caisse=$1, code_caisse=$2, solde_initial=$3, updated_at=CURRENT_TIMESTAMP
      WHERE id=$4
    `;

    if (!req.user.is_super_admin) {
      values.push(getEffectiveCompanyId(req));
      query += " AND company_id=$5";
    }

    query += " RETURNING *";

    const result = await pool.query(query, values);
    res.json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR UPDATE CAISSE :", error);
    res.status(500).json({ error: "Erreur modification caisse" });
  }
});

app.delete("/pos/caisses/:id", authenticateToken, async (req, res) => {
  try {
    if (!canManageCaisses(req.user)) {
      return res.status(403).json({ error: "Accès refusé : réservé à l’administrateur" });
    }

    const values = [req.params.id];
    let query = "UPDATE caisses SET actif=false, updated_at=CURRENT_TIMESTAMP WHERE id=$1";

    if (!req.user.is_super_admin) {
      values.push(getEffectiveCompanyId(req));
      query += " AND company_id=$2";
    }

    await pool.query(query, values);
    res.json({ message: "Caisse désactivée" });
  } catch (error) {
    console.error("ERREUR DELETE CAISSE :", error);
    res.status(500).json({ error: "Erreur suppression caisse" });
  }
});

app.post("/pos/caisses/:id/open", authenticateToken, async (req, res) => {
  try {
    if (!canUsePos(req.user)) return res.status(403).json({ error: "Accès POS refusé." });

    const caisse = await resolveSaleCaisse(pool, req.user, req.params.id);
    const soldeInitial = Number(req.body.solde_initial || req.body.montant_depart || 0);

    const result = await pool.query(
      `UPDATE caisses
       SET statut='ouverte', solde_initial=$1, solde_actuel=$1,
           opened_by=$2, opened_at=CURRENT_TIMESTAMP,
           closed_by=NULL, closed_at=NULL, updated_at=CURRENT_TIMESTAMP
       WHERE id=$3
       RETURNING *`,
      [soldeInitial, req.user.id || null, caisse.id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR OPEN CAISSE :", error);
    res.status(500).json({ error: error.message || "Erreur ouverture caisse" });
  }
});

app.post("/pos/caisses/:id/close", authenticateToken, async (req, res) => {
  try {
    if (!canUsePos(req.user)) return res.status(403).json({ error: "Accès POS refusé." });

    const caisse = await resolveSaleCaisse(pool, req.user, req.params.id);
    const totals = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN lower(status) <> 'annulée' THEN amount_paid ELSE 0 END),0)::numeric AS total_encaisse
       FROM sales
       WHERE caisse_id=$1 AND ($2::timestamp IS NULL OR created_at >= $2)`,
      [caisse.id, caisse.opened_at || null]
    );
    const soldeFinal = Number(caisse.solde_initial || 0) + Number(totals.rows[0]?.total_encaisse || 0);

    const result = await pool.query(
      `UPDATE caisses
       SET statut='fermée', solde_actuel=$1, closed_by=$2,
           closed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
       WHERE id=$3
       RETURNING *`,
      [soldeFinal, req.user.id || null, caisse.id]
    );

    res.json({ caisse: result.rows[0], solde_final: soldeFinal });
  } catch (error) {
    console.error("ERREUR CLOSE CAISSE :", error);
    res.status(500).json({ error: error.message || "Erreur fermeture caisse" });
  }
});

app.get("/pos/caisses/report", authenticateToken, async (req, res) => {
  try {
    if (!canUsePos(req.user) && !canAccessDirectionModule(req.user)) {
      return res.status(403).json({ error: "Accès POS refusé." });
    }

    const { date_from, date_to } = req.query;
    const companyId = getEffectiveCompanyId(req);
    const values = [];
    let filter = "WHERE c.actif=true";

    if (!req.user.is_super_admin || companyId) {
      values.push(companyId);
      filter += ` AND (c.company_id=$${values.length} OR c.company_id IS NULL)`;
    }

    if (!canManageCaisses(req.user) && !canAccessDirectionModule(req.user)) {
      values.push(req.user.id);
      filter += ` AND EXISTS (SELECT 1 FROM users cu WHERE cu.id=$${values.length} AND cu.caisse_id=c.id)`;
    }

    let salesDateFilter = "";
    if (date_from) {
      values.push(date_from);
      salesDateFilter += ` AND DATE(s.created_at) >= $${values.length}`;
    }
    if (date_to) {
      values.push(date_to);
      salesDateFilter += ` AND DATE(s.created_at) <= $${values.length}`;
    }

    const result = await pool.query(
      `SELECT c.id, c.nom_caisse, c.code_caisse, c.statut, c.solde_initial,
              COALESCE(SUM(CASE WHEN lower(COALESCE(s.status,'')) <> 'annulée' THEN s.total_amount ELSE 0 END),0)::numeric AS total_vendu,
              COALESCE(SUM(CASE WHEN lower(COALESCE(s.status,'')) <> 'annulée' THEN s.amount_paid ELSE 0 END),0)::numeric AS total_encaisse,
              COALESCE(SUM(CASE WHEN lower(COALESCE(s.status,'')) <> 'annulée' AND s.payment_method='Espèces' THEN s.amount_paid ELSE 0 END),0)::numeric AS ventes_especes,
              COALESCE(SUM(CASE WHEN lower(COALESCE(s.status,'')) <> 'annulée' AND s.payment_method IN ('Orange Money','Moov Money','Wave') THEN s.amount_paid ELSE 0 END),0)::numeric AS ventes_mobile_money,
              COALESCE(SUM(CASE WHEN lower(COALESCE(s.status,'')) <> 'annulée' AND s.payment_method='Carte bancaire' THEN s.amount_paid ELSE 0 END),0)::numeric AS ventes_carte,
              COALESCE(SUM(CASE WHEN lower(COALESCE(s.status,'')) <> 'annulée' THEN COALESCE(NULLIF(s.remaining_amount,0), s.amount_due, 0) ELSE 0 END),0)::numeric AS credits,
              COALESCE(SUM(CASE WHEN lower(COALESCE(s.status,''))='annulée' THEN s.total_amount ELSE 0 END),0)::numeric AS annulations,
              (c.solde_initial + COALESCE(SUM(CASE WHEN lower(COALESCE(s.status,'')) <> 'annulée' THEN s.amount_paid ELSE 0 END),0))::numeric AS solde_final
       FROM caisses c
       LEFT JOIN sales s ON s.caisse_id=c.id ${salesDateFilter}
       ${filter}
       GROUP BY c.id
       ORDER BY c.id ASC`,
      values
    );

    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR RAPPORT CAISSES :", error);
    res.status(500).json({ error: "Erreur rapport caisses" });
  }
});

app.post("/pos/sales", authenticateToken, async (req, res) => {
  const client = await pool.connect();

  try {
    if (!canUsePos(req.user)) {
      return res.status(403).json({ error: "Accès POS refusé." });
    }

    const companyId = getEffectiveCompanyId(req);
    if (!companyId) {
      return res.status(400).json({
        error: "Entreprise active introuvable. Sélectionnez une entreprise avant de vendre."
      });
    }
    const {
      customer_name,
      customer_phone,
      client_name,
      client_id = null,
      items = [],
      discount_amount = 0,
      tax_enabled = false,
      payment_method = "Espèces",
      payment_status = "payé",
      warehouse_id = null,
      caisse_id = null,
      cash_register_id = null,
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
    const caisse = await resolveSaleCaisse(client, req.user, caisse_id || cash_register_id);
    let saleCustomerName = customer_name || client_name || "Client comptoir";
    let saleCustomerPhone = customer_phone || "";

    if (client_id) {
      const partnerResult = await client.query(
        `SELECT id, name, phone, address
         FROM partners
         WHERE id=$1 AND ($2::boolean OR company_id=$3)
         LIMIT 1`,
        [client_id, req.user.is_super_admin === true, companyId]
      );
      const partner = partnerResult.rows[0];

      if (partner) {
        saleCustomerName = partner.name || saleCustomerName;
        saleCustomerPhone = partner.phone || saleCustomerPhone;
      }
    }

    let subtotal = 0;
    let taxAmount = 0;
    let totalProfit = 0;
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
       (company_id, warehouse_id, cash_register_id, caisse_id, nom_caisse,
        sale_number, customer_name, customer_phone, client_id, client_name,
        subtotal, discount_amount, tax_amount, total_amount, payment_method,
        payment_status, status, created_by, created_by_name, created_by_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,0,0,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        companyId,
        warehouse_id,
        caisse?.id || null,
        caisse?.id || null,
        caisse?.nom_caisse || "",
        saleNumber,
        saleCustomerName,
        saleCustomerPhone,
        client_id || null,
        saleCustomerName,
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
         WHERE id=$1
           AND (company_id=$2 OR company_id IS NULL)
         FOR UPDATE`,
        [item.product_id, companyId]
      );

      let product = productResult.rows[0];

      if (!product) {
        const existingProduct = await client.query(
          `SELECT id, reference, name, company_id
           FROM products
           WHERE id=$1
           LIMIT 1`,
          [item.product_id]
        );
        const found = existingProduct.rows[0];

        if (found) {
          throw new Error(
            `Produit ${
              found.reference || found.name || found.id
            } appartient à une autre entreprise. Entreprise active : ${companyId}.`
          );
        }

        throw new Error("Produit introuvable dans cette entreprise.");
      }

      if (!product.company_id) {
        const assignedProduct = await client.query(
          `UPDATE products
           SET company_id=$1,
               updated_at=CURRENT_TIMESTAMP
           WHERE id=$2
           RETURNING *`,
          [companyId, product.id]
        );
        product = assignedProduct.rows[0];
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
      const purchasePrice = Number(product.purchase_price || 0);
      const lineProfit = (unitPrice - purchasePrice) * quantity - itemDiscount;
      subtotal += unitPrice * quantity - itemDiscount;
      taxAmount += lineTax;
      totalProfit += lineProfit;

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
          tax_rate, total_price, warehouse_id, location_id, purchase_price,
          sale_price, profit)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
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
          product.location_id || null,
          purchasePrice,
          unitPrice,
          lineProfit
        ]
      );

      saleItems.push(itemResult.rows[0]);

      if (shouldFinalizeImmediately) {
        await client.query(
          `INSERT INTO stock_movements
           (type, product_reference, product_name, quantity, source_warehouse,
            destination_warehouse, reason, status, company_id, created_by,
            created_by_name, created_by_role, location_code, warehouse_id,
            approval_status, original_quantity, final_quantity, product_id,
            location_id, partner_id, partner_name, partner_type, apply_price,
            unit_price, total_amount)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'Validé',$8,$9,$10,$11,$12,$13,'Validé',$4,$4,$14,$15,$16,$17,$18,true,$19,$20)`,
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
            product.location_id || null,
            client_id || null,
            saleCustomerName,
            "client",
            unitPrice,
            unitPrice * quantity
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
           remaining_amount=$5,
           change_due=$6,
           total_profit=$7,
           provider=$8,
           payment_status=$9,
           status=$10,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$11
       RETURNING *`,
      [
        subtotal,
        taxAmount,
        totalAmount,
        confirmedPaidAmount,
        dueAmount,
        Number(change_due || 0),
        totalProfit,
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
          request_payload, response_payload, provider_response, created_by,
          caisse_id)
         VALUES ($1,$2,$3,$4,$5,'FCFA',$6,$7,$8,$9,$10,$11,$11,$12,$13)
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
          saleCustomerPhone,
          JSON.stringify({ sale_id: sale.id, payment_method: row.method, amount: row.amount }),
          JSON.stringify({
            sandbox: isPendingPosPaymentMethod(row.method),
            message: isPendingPosPaymentMethod(row.method)
              ? "Transaction sandbox créée. Simulez le résultat dans Paiements POS."
              : "Paiement manuel enregistré."
          }),
          req.user.id,
          caisse?.id || null
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
          status, created_by, caisse_id)
         VALUES ($1,$2,$3,$4,$5,'FCFA',$6,$7,$8)`,
        [
          companyId,
          sale.id,
          createdTransaction.id,
          row.method,
          Number(row.amount || 0),
          rowStatus,
          req.user.id,
          caisse?.id || null
        ]
      );
    }

    await client.query(
      `UPDATE sales
       SET transaction_id=$1, payment_reference=$2
       WHERE id=$3`,
      [paymentTransaction?.id || null, paymentReference || saleNumber, sale.id]
    );

    const companySettings = await getCompanySettingsForCompany(client, companyId);
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
            company_settings: companySettings
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
          saleCustomerName,
          totalAmount,
          `Reçu généré depuis vente POS ${saleNumber}`,
          req.user.email || "Caissier",
          companyId,
          "sale",
          sale.id,
          "Validé"
        ]
      );

      const paymentResult = await client.query(
        `INSERT INTO payments
         (company_id, amount, currency, payment_method, payment_reference,
          status, notes, paid_at, sale_id, receipt_id, payment_status, caisse_id)
         VALUES ($1,$2,'FCFA',$3,$4,$5,$6,CURRENT_TIMESTAMP,$7,$8,$5,$9)
         RETURNING *`,
        [
          companyId,
          totalAmount,
          payment_method,
          saleNumber,
          requestedPaymentStatus,
          `Paiement POS ${saleNumber}`,
          sale.id,
          receipt.id,
          caisse?.id || null
        ]
      );

      await recordPosPaymentAccounting(client, {
        sale: updatedSale.rows[0],
        payment: paymentResult.rows[0],
        user: req.user,
        amount: confirmedPaidAmount || totalAmount
      });
    }

    await client.query("COMMIT");

    res.status(201).json({
      sale: updatedSale.rows[0],
      items: saleItems,
      receipt,
      company_settings: companySettings,
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
    const companyId = getEffectiveCompanyId(req);
    const isSuperAdmin = req.user.is_super_admin === true;
    const shouldFilterByCompany = !isSuperAdmin || Boolean(companyId);
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

    let query = `SELECT DISTINCT sales.*,
                        COALESCE(c.nom_caisse, sales.nom_caisse, '') AS nom_caisse
                 FROM sales
                 LEFT JOIN sale_items ON sale_items.sale_id = sales.id
                 LEFT JOIN caisses c ON c.id = sales.caisse_id
                 WHERE 1=1`;

    if (shouldFilterByCompany) {
      values.push(companyId);
      query += ` AND sales.company_id=$${values.length}`;
    }

    if (!canManageCaisses(req.user) && !canAccessDirectionModule(req.user)) {
      const assigned = await getUserCaisse(pool, req.user.id);
      if (assigned?.caisse_id) {
        values.push(assigned.caisse_id);
        query += ` AND (sales.caisse_id=$${values.length} OR sales.cash_register_id=$${values.length})`;
      } else {
        values.push(req.user.id);
        query += ` AND sales.created_by=$${values.length}`;
      }
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
      query += ` AND (sales.cash_register_id=$${values.length} OR sales.caisse_id=$${values.length})`;
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

app.get("/pos/sales-summary", authenticateToken, async (req, res) => {
  try {
    const companyId = getEffectiveCompanyId(req);
    const isSuperAdmin = req.user.is_super_admin === true;
    const shouldFilterByCompany = !isSuperAdmin || Boolean(companyId);
    const { date_from, date_to, payment_method, status, cash_register_id } = req.query;
    const values = [];
    let where = "WHERE 1=1";

    if (shouldFilterByCompany) {
      values.push(companyId);
      where += ` AND sales.company_id=$${values.length}`;
    }

    if (!canManageCaisses(req.user) && !canAccessDirectionModule(req.user)) {
      const assigned = await getUserCaisse(pool, req.user.id);
      if (assigned?.caisse_id) {
        values.push(assigned.caisse_id);
        where += ` AND (sales.caisse_id=$${values.length} OR sales.cash_register_id=$${values.length})`;
      } else {
        values.push(req.user.id);
        where += ` AND sales.created_by=$${values.length}`;
      }
    }

    if (cash_register_id) {
      values.push(cash_register_id);
      where += ` AND (sales.caisse_id=$${values.length} OR sales.cash_register_id=$${values.length})`;
    }
    if (date_from) {
      values.push(date_from);
      where += ` AND DATE(sales.created_at) >= $${values.length}`;
    }
    if (date_to) {
      values.push(date_to);
      where += ` AND DATE(sales.created_at) <= $${values.length}`;
    }
    if (payment_method) {
      values.push(payment_method);
      where += ` AND sales.payment_method=$${values.length}`;
    }
    if (status) {
      values.push(status);
      where += ` AND LOWER(sales.status)=LOWER($${values.length})`;
    }

    const summary = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE lower(COALESCE(status,'')) <> 'annulée')::int AS nombre_ventes,
         COALESCE(SUM(CASE WHEN lower(COALESCE(status,'')) <> 'annulée' THEN total_amount ELSE 0 END),0)::numeric AS total_vendu,
         COALESCE(SUM(CASE WHEN lower(COALESCE(status,'')) <> 'annulée' THEN amount_paid ELSE 0 END),0)::numeric AS total_encaisse,
         COALESCE(SUM(CASE WHEN lower(COALESCE(status,'')) <> 'annulée' THEN COALESCE(NULLIF(remaining_amount,0), amount_due, 0) ELSE 0 END),0)::numeric AS total_credit,
         COALESCE(SUM(CASE WHEN lower(COALESCE(status,'')) = 'annulée' THEN total_amount ELSE 0 END),0)::numeric AS total_annule,
         COALESCE(SUM(CASE WHEN lower(COALESCE(status,'')) <> 'annulée' THEN total_profit ELSE 0 END),0)::numeric AS total_profit,
         CASE
           WHEN COUNT(*) FILTER (WHERE lower(COALESCE(status,'')) <> 'annulée') > 0
           THEN COALESCE(SUM(CASE WHEN lower(COALESCE(status,'')) <> 'annulée' THEN total_amount ELSE 0 END),0)
                / COUNT(*) FILTER (WHERE lower(COALESCE(status,'')) <> 'annulée')
           ELSE 0
         END::numeric AS montant_moyen
       FROM sales
       ${where}`,
      values
    );

    const byCaisse = await pool.query(
      `SELECT
         COALESCE(c.id, sales.caisse_id, sales.cash_register_id) AS caisse_id,
         COALESCE(c.nom_caisse, sales.nom_caisse, 'Sans caisse') AS nom_caisse,
         COALESCE(SUM(CASE WHEN lower(COALESCE(sales.status,'')) <> 'annulée' THEN sales.total_amount ELSE 0 END),0)::numeric AS total_vendu,
         COALESCE(SUM(CASE WHEN lower(COALESCE(sales.status,'')) <> 'annulée' THEN sales.amount_paid ELSE 0 END),0)::numeric AS total_encaisse,
         COUNT(*) FILTER (WHERE lower(COALESCE(sales.status,'')) <> 'annulée')::int AS nombre_ventes
       FROM sales
       LEFT JOIN caisses c ON c.id=sales.caisse_id
       ${where}
       GROUP BY COALESCE(c.id, sales.caisse_id, sales.cash_register_id), COALESCE(c.nom_caisse, sales.nom_caisse, 'Sans caisse')
       ORDER BY nom_caisse ASC`,
      values
    );

    res.json({
      totals: summary.rows[0],
      by_caisse: byCaisse.rows
    });
  } catch (error) {
    console.error("ERREUR POS SALES SUMMARY :", error);
    res.status(500).json({ error: "Erreur résumé ventes POS" });
  }
});

app.get("/pos/sales/:id", authenticateToken, async (req, res) => {
  try {
    const companyId = getEffectiveCompanyId(req);
    const isSuperAdmin = req.user.is_super_admin === true;
    const shouldFilterByCompany = !isSuperAdmin || Boolean(companyId);

    const saleResult = await pool.query(
      `SELECT *
       FROM sales
       WHERE id=$1 ${shouldFilterByCompany ? "AND company_id=$2" : ""}`,
      shouldFilterByCompany ? [req.params.id, companyId] : [req.params.id]
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
    const companySettings = await getCompanySettingsForCompany(pool, saleResult.rows[0].company_id || companyId);

    res.json({
      sale: saleResult.rows[0],
      items: itemsResult.rows,
      receipt: receiptResult.rows[0] || null,
      company_settings: companySettings
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

    const companyId = getEffectiveCompanyId(req);
    const shouldFilterByCompany = req.user.is_super_admin !== true || Boolean(companyId);
    const { reason } = req.body;

    await client.query("BEGIN");

    const saleResult = await client.query(
      `SELECT * FROM sales
       WHERE id=$1 ${shouldFilterByCompany ? "AND company_id=$2" : ""}
       FOR UPDATE`,
      shouldFilterByCompany ? [req.params.id, companyId] : [req.params.id]
    );
    const sale = saleResult.rows[0];

    if (!sale) throw new Error("Vente introuvable");
    if (sale.status === "annulée") throw new Error("Vente déjà annulée");

    const itemsResult = await client.query("SELECT * FROM sale_items WHERE sale_id=$1", [sale.id]);

    for (const item of itemsResult.rows) {
      /* Passe par le garde-fou partagé : filtre company_id (absent ici
         auparavant) et refuse de remonter un stock global sans emplacement
         dès que le produit est géré par bin. */
      await stockLocations.adjustGlobalStock(client, {
        companyId, productId: item.product_id, delta: Number(item.quantity || 0),
        user: { id: req.user.id, name: req.user.email, role: req.user.role },
        reason: `Annulation vente ${sale.id}`, type: "Entrée",
        locationId: item.location_id || null, origin: "annulation de vente",
      });

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

    if (sale.caisse_id || sale.cash_register_id) {
      await client.query(
        `UPDATE caisses
         SET solde_actuel = GREATEST(COALESCE(solde_actuel,0) - $1, 0),
             updated_at=CURRENT_TIMESTAMP
         WHERE id=$2`,
        [Number(sale.amount_paid || 0), sale.caisse_id || sale.cash_register_id]
      );
    }

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
    const isSuperAdmin = req.user.is_super_admin === true;
    const companyId = getEffectiveCompanyId(req);
    const shouldFilterByCompany = !isSuperAdmin || Boolean(companyId);
    const result = await pool.query(
      `SELECT *
       FROM receipts
       WHERE id=$1 ${shouldFilterByCompany ? "AND company_id=$2" : ""}`,
      shouldFilterByCompany ? [req.params.id, companyId] : [req.params.id]
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

app.post("/pos/send-receipt-email", authenticateToken, async (req, res) => {
  try {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return res.status(503).json({
        error: "Configuration SMTP manquante. Configurez SMTP_HOST, SMTP_USER et SMTP_PASS."
      });
    }

    const { receipt_id, sale_id, recipient_email, subject = "", message = "" } = req.body || {};
    const recipientEmail = String(recipient_email || "").trim();

    if (!recipientEmail || !recipientEmail.includes("@")) {
      return res.status(400).json({ error: "Email destinataire invalide." });
    }

    const companyId = getEffectiveCompanyId(req);
    const isSuperAdmin = req.user.is_super_admin === true;
    const shouldFilterByCompany = !isSuperAdmin || Boolean(companyId);
    const values = [receipt_id || null, sale_id || null];
    let companyFilter = "";
    if (shouldFilterByCompany) {
      values.push(companyId);
      companyFilter = `AND r.company_id=$${values.length}`;
    }

    const receiptResult = await pool.query(
      `SELECT r.*, s.sale_number, s.customer_name, s.customer_phone,
              s.payment_method, s.payment_status, s.created_at AS sale_created_at
       FROM receipts r
       LEFT JOIN sales s ON s.id=r.sale_id
       WHERE (($1::int IS NOT NULL AND r.id=$1) OR ($2::int IS NOT NULL AND r.sale_id=$2))
       ${companyFilter}
       ORDER BY r.id DESC
       LIMIT 1`,
      values
    );

    const receipt = receiptResult.rows[0];
    if (!receipt) {
      return res.status(404).json({ error: "Reçu introuvable." });
    }

    const companySettings = await getCompanySettingsForCompany(pool, receipt.company_id || companyId);
    const rawReceiptData = receipt.receipt_data || {};
    const receiptData =
      typeof rawReceiptData === "string"
        ? JSON.parse(rawReceiptData || "{}")
        : rawReceiptData;
    const items = Array.isArray(receiptData.items) ? receiptData.items : [];
    const appName = companySettings?.company_name || receiptData.company_name || "Triangle WMS Pro";
    const totalAmount = Number(receipt.total_amount || receiptData.total_amount || 0);
    const emailSubject =
      subject ||
      `Reçu ${receipt.receipt_number || receipt.sale_number || ""} - ${appName}`;
    const htmlItems = items
      .map(
        (item) => `<tr>
          <td>${escapeHtml(item.product_name || item.name || "")}</td>
          <td style="text-align:right">${Number(item.quantity || 0)}</td>
          <td style="text-align:right">${Number(item.unit_price || item.price || 0).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} FCFA</td>
          <td style="text-align:right">${Number(item.total_price || item.total || 0).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} FCFA</td>
        </tr>`
      )
      .join("");
    const html = `
      <div style="font-family:Arial,sans-serif;color:#111827">
        <h2>${escapeHtml(appName)}</h2>
        <p>${escapeHtml(message || "Veuillez trouver ci-dessous votre reçu POS.")}</p>
        <p><strong>Reçu :</strong> ${escapeHtml(receipt.receipt_number || "")}</p>
        <p><strong>Vente :</strong> ${escapeHtml(receipt.sale_number || "")}</p>
        <p><strong>Client :</strong> ${escapeHtml(receipt.customer_name || receiptData.customer_name || "Client comptoir")}</p>
        <table width="100%" cellpadding="6" cellspacing="0" style="border-collapse:collapse;border:1px solid #e5e7eb">
          <thead>
            <tr style="background:#f9fafb">
              <th align="left">Produit</th>
              <th align="right">Qté</th>
              <th align="right">Prix</th>
              <th align="right">Total</th>
            </tr>
          </thead>
          <tbody>${htmlItems || "<tr><td colspan=\"4\">Aucun article détaillé.</td></tr>"}</tbody>
        </table>
        <h3 style="text-align:right">Total : ${totalAmount.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} FCFA</h3>
      </div>`;

    const logResult = await pool.query(
      `INSERT INTO pos_receipt_email_logs
       (tenant_id, company_id, sale_id, receipt_id, recipient_email, subject, status, sent_by)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)
       RETURNING id`,
      [req.tenant_id || getTenantFromRequest(req), receipt.company_id || companyId, receipt.sale_id || null, receipt.id, recipientEmail, emailSubject, req.user.id || null]
    );

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipientEmail,
      subject: emailSubject,
      html
    });

    await pool.query(
      `UPDATE pos_receipt_email_logs
       SET status='sent',
           provider_message_id=$1,
           sent_at=CURRENT_TIMESTAMP
       WHERE id=$2`,
      [info.messageId || "", logResult.rows[0].id]
    );

    await logAudit(req, "email_pos_receipt", "receipt", receipt.id, {
      recipient_email: recipientEmail,
      message_id: info.messageId || ""
    });

    res.json({ message: "Reçu envoyé par email.", message_id: info.messageId || "" });
  } catch (error) {
    console.error("ERREUR EMAIL RECU POS :", error);
    res.status(500).json({ error: error.message || "Erreur envoi reçu POS" });
  }
});

app.post("/push/subscribe", authenticateToken, async (req, res) => {
  try {
    if (!process.env.WEB_PUSH_VAPID_PUBLIC_KEY || !process.env.WEB_PUSH_VAPID_PRIVATE_KEY) {
      return res.status(503).json({
        error: "Configuration Web Push manquante. Configurez WEB_PUSH_VAPID_PUBLIC_KEY et WEB_PUSH_VAPID_PRIVATE_KEY."
      });
    }

    const { endpoint, keys = {} } = req.body || {};
    if (!endpoint || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: "Abonnement push invalide." });
    }

    const result = await pool.query(
      `INSERT INTO push_subscriptions
       (tenant_id, company_id, user_id, endpoint, p256dh, auth, user_agent, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true)
       ON CONFLICT (tenant_id, endpoint)
       DO UPDATE SET
         company_id=EXCLUDED.company_id,
         user_id=EXCLUDED.user_id,
         p256dh=EXCLUDED.p256dh,
         auth=EXCLUDED.auth,
         user_agent=EXCLUDED.user_agent,
         is_active=true,
         updated_at=CURRENT_TIMESTAMP
       RETURNING id`,
      [
        req.tenant_id || getTenantFromRequest(req),
        getEffectiveCompanyId(req),
        req.user.id || null,
        endpoint,
        keys.p256dh,
        keys.auth,
        req?.headers?.["user-agent"] || ""
      ]
    );

    res.status(201).json({ message: "Abonnement notification enregistré.", id: result.rows[0].id });
  } catch (error) {
    console.error("ERREUR PUSH SUBSCRIBE :", error);
    res.status(500).json({ error: "Erreur abonnement notification" });
  }
});

app.post("/push/test", authenticateToken, async (req, res) => {
  try {
    if (!process.env.WEB_PUSH_VAPID_PUBLIC_KEY || !process.env.WEB_PUSH_VAPID_PRIVATE_KEY) {
      return res.status(503).json({
        error: "Configuration Web Push manquante. Configurez WEB_PUSH_VAPID_PUBLIC_KEY et WEB_PUSH_VAPID_PRIVATE_KEY."
      });
    }

    if (!webPush) {
      return res.status(503).json({
        error: "Module web-push non installé côté backend. Installez web-push avant d’envoyer des notifications réelles."
      });
    }

    webPush.setVapidDetails(
      process.env.WEB_PUSH_CONTACT || `mailto:${process.env.SMTP_FROM || process.env.SMTP_USER || "support@trianglewmspro.com"}`,
      process.env.WEB_PUSH_VAPID_PUBLIC_KEY,
      process.env.WEB_PUSH_VAPID_PRIVATE_KEY
    );

    const result = await pool.query(
      `SELECT *
       FROM push_subscriptions
       WHERE tenant_id=$1
         AND user_id=$2
         AND is_active=true
       ORDER BY id DESC
       LIMIT 5`,
      [req.tenant_id || getTenantFromRequest(req), req.user.id || null]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Aucun abonnement push actif pour cet utilisateur." });
    }

    const payload = JSON.stringify({
      title: "Triangle WMS Pro",
      message: "Notification test envoyée depuis le backend.",
      url: "/notifications"
    });

    const deliveries = [];
    for (const subscription of result.rows) {
      try {
        await webPush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: {
              p256dh: subscription.p256dh,
              auth: subscription.auth
            }
          },
          payload
        );
        deliveries.push({ id: subscription.id, sent: true });
      } catch (pushError) {
        deliveries.push({ id: subscription.id, sent: false, error: pushError.message || String(pushError) });
      }
    }

    res.json({ message: "Test Web Push terminé.", deliveries });
  } catch (error) {
    console.error("ERREUR PUSH TEST :", error);
    res.status(500).json({ error: "Erreur test notification push" });
  }
});

app.get("/pos/reports/daily", authenticateToken, requirePermission("rapport", "view"), async (req, res) => {
  try {

    const companyId = getEffectiveCompanyId(req);
    const isSuperAdmin = req.user.is_super_admin === true;
    const shouldFilterByCompany = !isSuperAdmin || Boolean(companyId);
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    const sales = await pool.query(
      `SELECT COUNT(*)::int AS sales_count,
              COALESCE(SUM(total_amount),0)::numeric AS revenue
       FROM sales
       WHERE DATE(created_at)=$1
       ${shouldFilterByCompany ? "AND company_id=$2" : ""}`,
      shouldFilterByCompany ? [date, companyId] : [date]
    );

    const payments = await pool.query(
      `SELECT payment_method, COUNT(*)::int AS count,
              COALESCE(SUM(total_amount),0)::numeric AS total
       FROM sales
       WHERE DATE(created_at)=$1
       ${shouldFilterByCompany ? "AND company_id=$2" : ""}
       GROUP BY payment_method
       ORDER BY total DESC`,
      shouldFilterByCompany ? [date, companyId] : [date]
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
        getEffectiveCompanyId(req),
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
    const companyId = getEffectiveCompanyId(req);
    const isSuperAdmin = req.user.is_super_admin === true;
    const shouldFilterByCompany = !isSuperAdmin || Boolean(companyId);
    const result = await pool.query(
      `SELECT pt.*, s.sale_number, s.customer_name
       FROM payment_transactions pt
       LEFT JOIN sales s ON s.id = pt.sale_id
       WHERE 1=1 ${shouldFilterByCompany ? "AND pt.company_id=$1" : ""}
       ORDER BY pt.id DESC
       LIMIT 200`,
      shouldFilterByCompany ? [companyId] : []
    );

    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR LECTURE PAIEMENTS :", error);
    res.status(500).json({ error: "Erreur lecture paiements" });
  }
});

app.get("/payments/:id", authenticateToken, async (req, res) => {
  try {
    const companyId = getEffectiveCompanyId(req);
    const isSuperAdmin = req.user.is_super_admin === true;
    const shouldFilterByCompany = !isSuperAdmin || Boolean(companyId);
    const result = await pool.query(
      `SELECT pt.*, s.sale_number, s.customer_name
       FROM payment_transactions pt
       LEFT JOIN sales s ON s.id = pt.sale_id
       WHERE pt.id=$1 ${shouldFilterByCompany ? "AND pt.company_id=$2" : ""}`,
      shouldFilterByCompany ? [req.params.id, companyId] : [req.params.id]
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
        getEffectiveCompanyId(req),
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
    const numericTransactionId =
      transaction_id !== undefined &&
      transaction_id !== null &&
      String(transaction_id).trim() !== "" &&
      Number.isInteger(Number(transaction_id))
        ? Number(transaction_id)
        : null;
    const safeReference = String(
      provider_reference || (!numericTransactionId ? transaction_id || "" : "")
    ).trim();
    console.log("Sandbox simulation request:", req.body);
    console.log("Reference received:", safeReference || transaction_id || "");
    await client.query("BEGIN");

    const transactionResult = await client.query(
      `SELECT *
       FROM payment_transactions
       WHERE ($1::integer IS NOT NULL AND id=$1::integer)
          OR ($2::text <> '' AND LOWER(TRIM(provider_reference::text))=LOWER(TRIM($2::text)))
          OR ($2::text <> '' AND LOWER(TRIM(external_reference::text))=LOWER(TRIM($2::text)))
       ORDER BY id DESC
       LIMIT 1
       FOR UPDATE`,
      [numericTransactionId, safeReference]
    );

    if (transactionResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({
        error: "Transaction sandbox introuvable.",
        reference: safeReference || transaction_id || ""
      });
    }

    const transaction = transactionResult.rows[0];
    console.log("Payment found:", {
      id: transaction.id,
      sale_id: transaction.sale_id,
      provider_reference: transaction.provider_reference,
      external_reference: transaction.external_reference,
      status: transaction.status
    });
    const currentStatus = String(transaction.status || "").toLowerCase();

    if (!["pending", "en attente"].includes(currentStatus)) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "Ce paiement a déjà été traité",
        status: transaction.status,
        transaction_id: transaction.id,
        provider_reference: transaction.provider_reference
      });
    }

    await client.query(
      `UPDATE payment_transactions
       SET status=$1::varchar,
           paid_at=CASE WHEN $1::text='paid' THEN CURRENT_TIMESTAMP ELSE paid_at END,
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
      `UPDATE sale_payments SET status=$1::varchar WHERE transaction_id=$2`,
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
          console.log("sale liée", sale);
          console.log("receipt créé", receipt);
        } else {
          const saleResult = await client.query(
            `UPDATE sales
             SET payment_status='en attente',
                 status='en attente',
                 amount_paid=$1,
                 amount_due=GREATEST(total_amount - $1, 0),
                 remaining_amount=GREATEST(total_amount - $1, 0),
                 updated_at=CURRENT_TIMESTAMP
             WHERE id=$2
             RETURNING *`,
            [paidAmount, transaction.sale_id]
          );
          sale = saleResult.rows[0] || null;
          console.log("sale liée", sale);
        }
      } else {
        const saleResult = await client.query(
          `UPDATE sales
           SET payment_status=$1,
               status='annulée',
               amount_due=total_amount - COALESCE(amount_paid, 0),
               remaining_amount=total_amount - COALESCE(amount_paid, 0),
               updated_at=CURRENT_TIMESTAMP
           WHERE id=$2
           RETURNING *`,
          [nextStatus, transaction.sale_id]
        );
        sale = saleResult.rows[0] || null;
        console.log("sale liée", sale);
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
    res.status(500).json({
      error: "Erreur sandbox paiement",
      details: error.message || String(error)
    });
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

app.get("/pos/reports/products", authenticateToken, requirePermission("rapport", "view"), async (req, res) => {
  try {

    const companyId = getEffectiveCompanyId(req);
    const isSuperAdmin = req.user.is_super_admin === true;
    const shouldFilterByCompany = !isSuperAdmin || Boolean(companyId);

    const result = await pool.query(
      `SELECT product_reference, product_name,
              SUM(quantity)::int AS quantity_sold,
              COALESCE(SUM(total_price),0)::numeric AS total
       FROM sale_items
       ${shouldFilterByCompany ? "WHERE company_id=$1" : ""}
       GROUP BY product_reference, product_name
       ORDER BY quantity_sold DESC
       LIMIT 50`,
      shouldFilterByCompany ? [companyId] : []
    );

    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR RAPPORT POS PRODUITS :", error);
    res.status(500).json({ error: "Erreur rapport produits POS" });
  }
});

app.get("/pos/reports/payments", authenticateToken, requirePermission("rapport", "view"), async (req, res) => {
  try {

    const companyId = getEffectiveCompanyId(req);
    const isSuperAdmin = req.user.is_super_admin === true;
    const shouldFilterByCompany = !isSuperAdmin || Boolean(companyId);

    const result = await pool.query(
      `SELECT payment_method, payment_status,
              COUNT(*)::int AS count,
              COALESCE(SUM(total_amount),0)::numeric AS total
       FROM sales
       ${shouldFilterByCompany ? "WHERE company_id=$1" : ""}
       GROUP BY payment_method, payment_status
       ORDER BY total DESC`,
      shouldFilterByCompany ? [companyId] : []
    );

    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR RAPPORT POS PAIEMENTS :", error);
    res.status(500).json({ error: "Erreur rapport paiements POS" });
  }
});

async function nextAccountingNumber(client, tableName, columnName, prefix, companyId) {
  const year = new Date().getFullYear();
  const safeCompanyId = Number(companyId || 0);
  const counterKey = `${tableName}.${columnName}.${prefix}.${year}`;
  const counterResult = await client.query(
    `INSERT INTO number_counters (company_id, counter_key, last_value)
     VALUES ($1,$2,1)
     ON CONFLICT (company_id, counter_key)
     DO UPDATE SET
       last_value=number_counters.last_value + 1,
       updated_at=CURRENT_TIMESTAMP
     RETURNING last_value`,
    [safeCompanyId, counterKey]
  );
  const counterSequence = Number(counterResult.rows[0]?.last_value || 1);
  const hasCompanyId = await columnExists(tableName, "company_id");

  const result = await client.query(
    `SELECT ${columnName} AS number
     FROM ${tableName}
     WHERE ${hasCompanyId ? "company_id=$1 AND" : ""}
       ${columnName} LIKE $${hasCompanyId ? "2" : "1"}
     ORDER BY id DESC
     LIMIT 1`,
    hasCompanyId ? [companyId, `${prefix}-${year}-%`] : [`${prefix}-${year}-%`]
  );
  const lastNumber = String(result.rows[0]?.number || "");
  const lastSequence = Number(lastNumber.split("-").pop() || 0);
  const nextSequence = Math.max(counterSequence, lastSequence + 1);

  if (nextSequence !== counterSequence) {
    await client.query(
      `UPDATE number_counters
       SET last_value=$1,
           updated_at=CURRENT_TIMESTAMP
       WHERE company_id=$2
         AND counter_key=$3`,
      [nextSequence, safeCompanyId, counterKey]
    );
  }

  return `${prefix}-${year}-${String(nextSequence).padStart(6, "0")}`;
}

async function ensureTreasuryAccount(client, companyId, currency = "FCFA") {
  const result = await client.query(
    `INSERT INTO treasury_accounts (company_id, currency, initial_balance, current_balance)
     VALUES ($1,$2,0,0)
     ON CONFLICT (company_id)
     DO UPDATE SET company_id=EXCLUDED.company_id
     RETURNING *`,
    [companyId, currency || "FCFA"]
  );
  return result.rows[0];
}

function normalizePaymentMethodLabel(method = "") {
  return String(method || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function paymentMethodBankKeywords(method = "") {
  const normalized = normalizePaymentMethodLabel(method);
  if (normalized.includes("orange")) return ["orange", "orange money"];
  if (normalized.includes("moov")) return ["moov", "moov money"];
  if (normalized.includes("wave")) return ["wave"];
  if (normalized.includes("carte")) return ["carte", "card", "banque"];
  if (normalized.includes("virement") || normalized.includes("banque")) {
    return ["virement", "banque", "bank"];
  }
  return [];
}

async function findAccountingBankForPayment(client, companyId, method = "") {
  const keywords = paymentMethodBankKeywords(method);
  if (keywords.length === 0) return null;

  const values = [companyId];
  const filters = keywords.map((keyword) => {
    values.push(`%${keyword}%`);
    return `LOWER(bank_name) LIKE LOWER($${values.length})`;
  });

  const result = await client.query(
    `SELECT *
     FROM accounting_banks
     WHERE company_id=$1
       AND is_active=true
       AND (${filters.join(" OR ")})
     ORDER BY id ASC
     LIMIT 1
     FOR UPDATE`,
    values
  );

  return result.rows[0] || null;
}

async function recordPosPaymentAccounting(client, { sale, payment, user = {}, amount = null }) {
  const paymentId = payment?.id || null;
  const saleId = sale?.id || payment?.sale_id || null;
  const companyId = sale?.company_id || payment?.company_id || user?.company_id || null;
  const amountValue = Number(amount ?? payment?.amount ?? sale?.total_amount ?? 0);
  const method = payment?.payment_method || payment?.method || sale?.payment_method || "";
  const normalizedMethod = normalizePaymentMethodLabel(method);

  if (!paymentId || !saleId || !companyId || amountValue <= 0) return null;
  if (normalizedMethod.includes("credit")) return null;

  const existing = await client.query(
    `SELECT id
     FROM accounting_transactions
     WHERE source_type='pos_payment'
       AND source_id=$1
       AND company_id=$2
     LIMIT 1`,
    [paymentId, companyId]
  );
  if (existing.rows[0]) return existing.rows[0];

  await ensureTreasuryAccount(client, companyId, payment?.currency || "FCFA");

  let bank = null;
  const isCash = normalizedMethod.includes("espece") || normalizedMethod.includes("cash");
  const caisseId = sale?.caisse_id || sale?.cash_register_id || payment?.caisse_id || null;
  let destinationLabel = "Trésorerie interne";
  let bankId = null;
  let finalCaisseId = null;

  if (isCash && caisseId) {
    finalCaisseId = caisseId;
    await client.query(
      `UPDATE caisses
       SET solde_actuel=COALESCE(solde_actuel,0)+$1,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$2
         AND company_id=$3`,
      [amountValue, finalCaisseId, companyId]
    );
    destinationLabel = sale?.nom_caisse || "Caisse POS";
  } else if (!isCash) {
    bank = await findAccountingBankForPayment(client, companyId, method);
    if (bank) {
      bankId = bank.id;
      destinationLabel = bank.bank_name || method || "Banque";
      await client.query(
        `UPDATE accounting_banks
         SET current_balance=COALESCE(current_balance,0)+$1,
             updated_at=CURRENT_TIMESTAMP
         WHERE id=$2`,
        [amountValue, bank.id]
      );
    } else {
      await client.query(
        `UPDATE treasury_accounts
         SET current_balance=COALESCE(current_balance,0)+$1,
             updated_by=$2,
             updated_at=CURRENT_TIMESTAMP
         WHERE company_id=$3`,
        [amountValue, user?.id || sale?.created_by || null, companyId]
      );
      destinationLabel = `Trésorerie interne (${method || "paiement POS"})`;
    }
  } else {
    await client.query(
      `UPDATE treasury_accounts
       SET current_balance=COALESCE(current_balance,0)+$1,
           updated_by=$2,
           updated_at=CURRENT_TIMESTAMP
       WHERE company_id=$3`,
      [amountValue, user?.id || sale?.created_by || null, companyId]
    );
  }

  const transactionNumber = await nextAccountingNumber(
    client,
    "accounting_transactions",
    "transaction_number",
    "POS",
    companyId
  );

  const transaction = await client.query(
    `INSERT INTO accounting_transactions
     (company_id, transaction_number, transaction_type, source_type, source_id,
      bank_id, caisse_id, amount, currency, direction, category, partner_name,
      description, status, source_label, destination_label, created_by,
      validated_by, validated_at)
     VALUES ($1,$2,'encaissement_pos','pos_payment',$3,$4,$5,$6,$7,'entrée',
             'Vente POS',$8,$9,'validé',$10,$11,$12,$12,CURRENT_TIMESTAMP)
     RETURNING *`,
    [
      companyId,
      transactionNumber,
      paymentId,
      bankId,
      finalCaisseId,
      amountValue,
      payment?.currency || "FCFA",
      sale?.customer_name || "",
      `Encaissement POS ${sale?.sale_number || saleId} - ${method || "paiement"}`,
      method || "POS",
      destinationLabel,
      user?.id || sale?.created_by || null
    ]
  );

  await client.query(
    `UPDATE payments
     SET accounting_transaction_id=$1,
         updated_at=CURRENT_TIMESTAMP
     WHERE id=$2`,
    [transaction.rows[0].id, paymentId]
  );

  await createAccountingEntry(client, {
    companyId,
    sourceType: "pos_payment",
    sourceId: paymentId,
    accountLabel: destinationLabel,
    debit: amountValue,
    credit: 0,
    description: `Encaissement POS ${sale?.sale_number || saleId}`,
    createdBy: user?.id || sale?.created_by || null
  });

  await createAccountingEntry(client, {
    companyId,
    sourceType: "pos_payment",
    sourceId: paymentId,
    accountLabel: "Ventes POS",
    debit: 0,
    credit: amountValue,
    description: `Vente POS ${sale?.sale_number || saleId}`,
    createdBy: user?.id || sale?.created_by || null
  });

  return transaction.rows[0];
}

async function createAccountingEntry(client, {
  companyId,
  sourceType,
  sourceId,
  accountLabel,
  debit = 0,
  credit = 0,
  description = "",
  createdBy = null
}) {
  const entryNumber = await nextAccountingNumber(
    client,
    "accounting_entries",
    "entry_number",
    "ECR",
    companyId
  );

  await client.query(
    `INSERT INTO accounting_entries
     (company_id, entry_number, source_type, source_id, account_label,
      debit, credit, description, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      companyId,
      entryNumber,
      sourceType,
      sourceId,
      accountLabel,
      Number(debit || 0),
      Number(credit || 0),
      description,
      createdBy
    ]
  );
}

async function createJournalEntry(client, {
  companyId,
  label,
  moduleSource,
  sourceId,
  lines,
  createdBy = null
}) {
  const normalizedLines = (lines || []).map((line) => ({
    ...line,
    debit: Number(line.debit || 0),
    credit: Number(line.credit || 0)
  }));
  const totalDebit = normalizedLines.reduce((sum, line) => sum + line.debit, 0);
  const totalCredit = normalizedLines.reduce((sum, line) => sum + line.credit, 0);

  if (Math.round(totalDebit) !== Math.round(totalCredit)) {
    const error = new Error("Écriture comptable déséquilibrée.");
    error.statusCode = 400;
    throw error;
  }

  const entryNumber = await nextAccountingNumber(
    client,
    "journal_entries",
    "entry_number",
    "JRN",
    companyId
  );
  const entryResult = await client.query(
    `INSERT INTO journal_entries
     (company_id, entry_number, label, module_source, source_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [companyId, entryNumber, label, moduleSource, sourceId, createdBy]
  );

  for (const line of normalizedLines) {
    await client.query(
      `INSERT INTO journal_entry_lines
       (entry_id, company_id, account_code, account_name, debit, credit,
        partner_id, bank_id, caisse_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        entryResult.rows[0].id,
        companyId,
        line.account_code,
        line.account_name,
        line.debit,
        line.credit,
        line.partner_id || null,
        line.bank_id || null,
        line.caisse_id || null
      ]
    );
  }

  return entryResult.rows[0];
}

function normalizeOptionalId(value) {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

async function loadAccountingBankForUpdate(client, user, bankId) {
  if (!bankId) return null;
  const isSuperAdmin = user?.is_super_admin === true || normalizeRole(user?.role) === "super_admin";
  const result = await client.query(
    `SELECT * FROM accounting_banks
     WHERE id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}
     FOR UPDATE`,
    isSuperAdmin ? [bankId] : [bankId, user.company_id]
  );
  return result.rows[0] || null;
}

async function loadAccountingCaisseForUpdate(client, user, caisseId) {
  if (!caisseId) return null;
  const isSuperAdmin = user?.is_super_admin === true || normalizeRole(user?.role) === "super_admin";
  const result = await client.query(
    `SELECT * FROM caisses
     WHERE id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}
     FOR UPDATE`,
    isSuperAdmin ? [caisseId] : [caisseId, user.company_id]
  );
  return result.rows[0] || null;
}

function ensureSufficientBalance(balance, amount, message) {
  if (Number(balance || 0) < Number(amount || 0)) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  }
}

function getAccountingScope(req, requireCompany = false) {
  const isSuperAdmin = isSuperAdminUser(req.user);
  const companyId = getEffectiveCompanyId(req);
  if (requireCompany && !companyId) {
    const error = new Error("Veuillez choisir une entreprise active avant cette opération.");
    error.statusCode = 400;
    throw error;
  }
  const values = companyId ? [companyId] : [];
  const filter = companyId ? "WHERE company_id=$1" : "";
  const andFilter = companyId ? "AND company_id=$1" : "";
  return { isSuperAdmin, companyId, values, filter, andFilter };
}

function logAccountingError(route, error, req, extra = {}) {
  const payload = req?.body && typeof req.body === "object" ? { ...req.body } : req?.body;
  console.error(`[ACCOUNTING ERROR] ${route}`, {
    message: error?.message,
    stack: error?.stack,
    postgres: {
      code: error?.code,
      detail: error?.detail,
      hint: error?.hint,
      table: error?.table,
      column: error?.column,
      constraint: error?.constraint,
      routine: error?.routine
    },
    context: {
      company_id: getEffectiveCompanyId(req),
      user_id: req?.user?.id || null,
      role: req?.user?.role || "",
      bank_id: payload?.bank_id || req?.params?.bank_id || null,
      caisse_id: payload?.caisse_id || req?.params?.caisse_id || null,
      transaction_number: payload?.transaction_number || extra.transaction_number || null,
      ...extra
    },
    payload
  });
}

function accountingErrorMessage(error, fallback) {
  return error?.detail || error?.message || fallback;
}

app.get("/accounting/dashboard", authenticateToken, async (req, res) => {
  try {
    if (!canViewAccounting(req.user)) {
      return res.status(403).json({ error: "Accès comptabilité refusé." });
    }

    const { companyId, values, filter, andFilter } = getAccountingScope(req, false);

    const treasury = await pool.query(
      `SELECT COALESCE(SUM(current_balance),0)::numeric AS total
       FROM treasury_accounts ${filter}`,
      values
    );
    const banks = await pool.query(
      `SELECT COALESCE(SUM(current_balance),0)::numeric AS total
       FROM accounting_banks ${filter}`,
      values
    );
    const caisses = await pool.query(
      `SELECT COALESCE(SUM(solde_actuel),0)::numeric AS total
       FROM caisses ${filter}`,
      values
    );
    const dailyIn = await pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS total
       FROM accounting_transactions
       WHERE direction='entrée' AND DATE(created_at)=CURRENT_DATE ${andFilter}`,
      values
    );
    const dailyOut = await pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS total
       FROM accounting_transactions
       WHERE direction='sortie' AND DATE(created_at)=CURRENT_DATE ${andFilter}`,
      values
    );
    const monthExpenses = await pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS total
       FROM accounting_transactions
       WHERE direction='sortie'
         AND date_trunc('month', created_at)=date_trunc('month', CURRENT_DATE)
         ${andFilter}`,
      values
    );
    const requests = await pool.query(
      `SELECT status, COUNT(*)::int AS count
       FROM expense_requests
       ${filter}
       GROUP BY status`,
      values
    );
    const payroll = await pool.query(
      `SELECT COALESCE(SUM(net_amount),0)::numeric AS total
       FROM payroll_runs
       WHERE status IN ('brouillon','à payer','validé') ${andFilter}`,
      values
    );

    res.json({
      treasury_balance: Number(treasury.rows[0]?.total || 0),
      bank_balance: Number(banks.rows[0]?.total || 0),
      cash_register_balance: Number(caisses.rows[0]?.total || 0),
      total_treasury: Number(treasury.rows[0]?.total || 0) + Number(banks.rows[0]?.total || 0) + Number(caisses.rows[0]?.total || 0),
      encaissements_jour: Number(dailyIn.rows[0]?.total || 0),
      cash_in_today: Number(dailyIn.rows[0]?.total || 0),
      decaissements_jour: Number(dailyOut.rows[0]?.total || 0),
      cash_out_today: Number(dailyOut.rows[0]?.total || 0),
      depenses_mois: Number(monthExpenses.rows[0]?.total || 0),
      expenses_month: Number(monthExpenses.rows[0]?.total || 0),
      salaires_a_payer: Number(payroll.rows[0]?.total || 0),
      payroll_pending: Number(payroll.rows[0]?.total || 0),
      expense_requests_pending: Number(requests.rows.find((row) => row.status === "soumis")?.count || 0),
      expense_requests_approved: Number(requests.rows.find((row) => row.status === "validé")?.count || 0),
      expense_requests_rejected: Number(requests.rows.find((row) => row.status === "refusé")?.count || 0),
      demandes: requests.rows.reduce((acc, row) => {
        acc[row.status] = Number(row.count || 0);
        return acc;
      }, {})
    });
  } catch (error) {
    logAccountingError("/accounting/dashboard", error, req);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Erreur dashboard comptable" });
  }
});

app.get("/accounting/chart-accounts", authenticateToken, async (req, res) => {
  try {
    if (!canViewAccounting(req.user)) {
      return res.status(403).json({ error: "Accès comptabilité refusé." });
    }
    const { values, filter } = getAccountingScope(req, false);
    const result = await pool.query(
      `SELECT *
       FROM accounting_chart_accounts
       ${filter}
       ORDER BY account_code ASC`,
      values
    );
    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR CHART ACCOUNTS :", error);
    res.status(500).json({ error: "Erreur plan comptable" });
  }
});

app.post("/accounting/chart-accounts", authenticateToken, async (req, res) => {
  try {
    if (!canManageAccounting(req.user)) {
      return res.status(403).json({ error: "Accès gestion comptable refusé." });
    }
    const { account_code, account_name, account_class = "", account_type = "" } = req.body;
    const { companyId } = getAccountingScope(req, true);
    if (!account_code || !account_name) {
      return res.status(400).json({ error: "Code et nom de compte obligatoires." });
    }
    const result = await pool.query(
      `INSERT INTO accounting_chart_accounts
       (company_id, account_code, account_name, account_class, account_type, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (company_id, account_code)
       DO UPDATE SET
         account_name=EXCLUDED.account_name,
         account_class=EXCLUDED.account_class,
         account_type=EXCLUDED.account_type,
         updated_at=CURRENT_TIMESTAMP
       RETURNING *`,
      [companyId, account_code, account_name, account_class, account_type, req.user.id]
    );
    await logAudit(req, "upsert_chart_account", "accounting_chart_account", result.rows[0].id, { account_code });
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR UPSERT CHART ACCOUNT :", error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Erreur enregistrement compte" });
  }
});

app.get("/accounting/caisses", authenticateToken, async (req, res) => {
  try {
    if (!canViewAccounting(req.user)) {
      return res.status(403).json({ error: "Accès comptabilité refusé." });
    }
    const { values, filter } = getAccountingScope(req, false);
    const result = await pool.query(
      `SELECT c.*, u.fullname AS responsable_name, u.email AS responsable_email
       FROM caisses c
       LEFT JOIN users u ON u.caisse_id=c.id
       ${filter ? "WHERE c.company_id=$1" : ""}
       ORDER BY c.id DESC`,
      values
    );
    res.json(result.rows);
  } catch (error) {
    logAccountingError("GET /accounting/caisses", error, req);
    res.status(500).json({ error: "Erreur lecture caisses comptables" });
  }
});

app.get("/accounting/journal-entries", authenticateToken, async (req, res) => {
  try {
    if (!canViewAccounting(req.user)) {
      return res.status(403).json({ error: "Accès comptabilité refusé." });
    }
    const { values, filter } = getAccountingScope(req, false);
    const result = await pool.query(
      `SELECT e.*,
        COALESCE(json_agg(l ORDER BY l.id) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines
       FROM journal_entries e
       LEFT JOIN journal_entry_lines l ON l.entry_id=e.id
       ${filter ? "WHERE e.company_id=$1" : ""}
       GROUP BY e.id
       ORDER BY e.id DESC
       LIMIT 300`,
      values
    );
    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR JOURNAL ENTRIES :", error);
    res.status(500).json({ error: "Erreur lecture journal" });
  }
});

app.get("/accounting/banks", authenticateToken, async (req, res) => {
  try {
    if (!canViewAccounting(req.user)) {
      return res.status(403).json({ error: "Accès comptabilité refusé." });
    }
    const { values, filter } = getAccountingScope(req, false);
    const result = await pool.query(
      `SELECT * FROM accounting_banks
       ${filter}
       ORDER BY is_active DESC, bank_name ASC`,
      values
    );
    res.json(result.rows);
  } catch (error) {
    logAccountingError("GET /accounting/banks", error, req);
    res.status(500).json({ error: "Erreur lecture banques" });
  }
});

app.post("/accounting/banks", authenticateToken, async (req, res) => {
  try {
    if (!canManageAccounting(req.user)) {
      return res.status(403).json({ error: "Accès gestion comptable refusé." });
    }
    const {
      bank_name,
      account_number = "",
      iban = "",
      swift = req.body.swift_code || "",
      currency = "FCFA",
      initial_balance = 0,
      is_active = true
    } = req.body;

    if (!bank_name) {
      return res.status(400).json({ error: "Nom banque obligatoire." });
    }
    const { companyId } = getAccountingScope(req, true);

    const result = await pool.query(
      `INSERT INTO accounting_banks
       (company_id, bank_name, account_number, iban, swift, currency,
        initial_balance, current_balance, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9)
       RETURNING *`,
      [
        companyId,
        bank_name,
        account_number,
        iban,
        swift,
        currency,
        Number(initial_balance || 0),
        is_active !== false,
        req.user.id
      ]
    );
    await logAudit(req, "create_bank", "accounting_bank", result.rows[0].id, { bank_name });
    res.status(201).json(result.rows[0]);
  } catch (error) {
    logAccountingError("POST /accounting/banks", error, req);
    res.status(error.statusCode || 500).json({ error: accountingErrorMessage(error, "Erreur création banque") });
  }
});

app.put("/accounting/banks/:id", authenticateToken, async (req, res) => {
  try {
    if (!canManageAccounting(req.user)) {
      return res.status(403).json({ error: "Accès gestion comptable refusé." });
    }
    const isSuperAdmin = req.user.is_super_admin === true;
    const companyId = getEffectiveCompanyId(req);
    const {
      bank_name,
      account_number = "",
      iban = "",
      swift = "",
      currency = "FCFA",
      is_active = true
    } = req.body;
    const result = await pool.query(
      `UPDATE accounting_banks
       SET bank_name=$1, account_number=$2, iban=$3, swift=$4,
           currency=$5, is_active=$6, updated_at=CURRENT_TIMESTAMP
       WHERE id=$7 ${isSuperAdmin && !companyId ? "" : "AND company_id=$8"}
       RETURNING *`,
      isSuperAdmin && !companyId
        ? [bank_name, account_number, iban, swift, currency, is_active !== false, req.params.id]
        : [bank_name, account_number, iban, swift, currency, is_active !== false, req.params.id, companyId || req.user.company_id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Banque introuvable." });
    await logAudit(req, "update_bank", "accounting_bank", req.params.id, { bank_name });
    res.json(result.rows[0]);
  } catch (error) {
    logAccountingError("PUT /accounting/banks/:id", error, req, { bank_id: req.params.id });
    res.status(error.statusCode || 500).json({ error: accountingErrorMessage(error, "Erreur modification banque") });
  }
});

app.delete("/accounting/banks/:id", authenticateToken, async (req, res) => {
  try {
    if (!canManageAccounting(req.user)) {
      return res.status(403).json({ error: "Accès gestion comptable refusé." });
    }
    const isSuperAdmin = req.user.is_super_admin === true;
    const companyId = getEffectiveCompanyId(req);
    const result = await pool.query(
      `UPDATE accounting_banks
       SET is_active=false,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$1 ${isSuperAdmin && !companyId ? "" : "AND company_id=$2"}
       RETURNING *`,
      isSuperAdmin && !companyId ? [req.params.id] : [req.params.id, companyId || req.user.company_id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Banque introuvable." });
    await logAudit(req, "deactivate_bank", "accounting_bank", req.params.id, {
      bank_name: result.rows[0].bank_name
    });
    res.json({ message: "Banque désactivée.", bank: result.rows[0] });
  } catch (error) {
    logAccountingError("DELETE /accounting/banks/:id", error, req, { bank_id: req.params.id });
    res.status(error.statusCode || 500).json({ error: accountingErrorMessage(error, "Erreur suppression banque") });
  }
});

app.get("/accounting/transactions", authenticateToken, async (req, res) => {
  try {
    if (!canViewAccounting(req.user)) {
      return res.status(403).json({ error: "Accès comptabilité refusé." });
    }
    const { values, filter } = getAccountingScope(req, false);
    const result = await pool.query(
      `SELECT t.*, b.bank_name, c.nom_caisse
       FROM accounting_transactions t
       LEFT JOIN accounting_banks b ON b.id=t.bank_id
       LEFT JOIN caisses c ON c.id=t.caisse_id
       ${filter ? "WHERE t.company_id=$1" : ""}
       ORDER BY t.id DESC
       LIMIT 300`,
      values
    );
    res.json(result.rows);
  } catch (error) {
    logAccountingError("GET /accounting/transactions", error, req);
    res.status(500).json({ error: "Erreur lecture mouvements comptables" });
  }
});

app.post("/accounting/transactions", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!canManageAccounting(req.user)) {
      return res.status(403).json({ error: "Accès gestion comptable refusé." });
    }
    const {
      transaction_type,
      bank_id = null,
      caisse_id = null,
      amount,
      direction,
      category = "",
      partner_id = null,
      partner_name = "",
      description = "",
      attachment_url = "",
      source_label = "",
      destination_label = ""
    } = req.body;

    const amountValue = Number(amount || 0);
    if (!transaction_type || amountValue <= 0 || !["entrée", "sortie"].includes(direction)) {
      return res.status(400).json({ error: "Type, sens et montant valides obligatoires." });
    }
    const bankId = normalizeOptionalId(bank_id);
    const caisseId = normalizeOptionalId(caisse_id);

    await client.query("BEGIN");
    const bank = await loadAccountingBankForUpdate(client, req.user, bankId);
    if (bankId && !bank) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Banque introuvable ou non autorisée pour cette entreprise." });
    }
    const caisse = await loadAccountingCaisseForUpdate(client, req.user, caisseId);
    if (caisseId && !caisse) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Caisse introuvable ou non autorisée pour cette entreprise." });
    }

    const companyId = bank?.company_id || caisse?.company_id || getAccountingScope(req, true).companyId;
    await ensureTreasuryAccount(client, companyId);
    const transactionNumber = await nextAccountingNumber(
      client,
      "accounting_transactions",
      "transaction_number",
      direction === "entrée" ? "ENC" : "DEC",
      companyId
    );

    if (bank) {
      const bankDelta =
        transaction_type === "depot_caisse_banque" || direction === "entrée"
          ? amountValue
          : -amountValue;
      if (bankDelta < 0) {
        ensureSufficientBalance(bank.current_balance, amountValue, "Solde insuffisant dans cette banque.");
      }
      await client.query(
        `UPDATE accounting_banks
         SET current_balance=COALESCE(current_balance,0)+$1,
             updated_at=CURRENT_TIMESTAMP
         WHERE id=$2`,
        [bankDelta, bankId]
      );
    }

    if (caisse) {
      const caisseDelta =
        transaction_type === "retrait_banque" || direction === "entrée"
          ? amountValue
          : -amountValue;
      if (caisseDelta < 0) {
        ensureSufficientBalance(caisse.solde_actuel, amountValue, "Solde insuffisant dans cette caisse.");
      }
      await client.query(
        `UPDATE caisses
         SET solde_actuel=COALESCE(solde_actuel,0)+$1,
             updated_at=CURRENT_TIMESTAMP
         WHERE id=$2`,
        [caisseDelta, caisseId]
      );
    }

    const treasuryDelta =
      transaction_type === "retrait_banque" && bank && !caisse
        ? amountValue
        : !bank && !caisse && (transaction_type === "encaissement_especes" || direction === "entrée")
          ? amountValue
          : !bank && !caisse && direction === "sortie"
            ? -amountValue
            : 0;

    if (treasuryDelta !== 0) {
      if (treasuryDelta < 0) {
        const treasuryResult = await client.query(
          `SELECT * FROM treasury_accounts WHERE company_id=$1 FOR UPDATE`,
          [companyId]
        );
        ensureSufficientBalance(treasuryResult.rows[0]?.current_balance, amountValue, "Solde insuffisant dans la trésorerie.");
      }
      await client.query(
        `UPDATE treasury_accounts
         SET current_balance=COALESCE(current_balance,0)+$1,
             updated_by=$2,
             updated_at=CURRENT_TIMESTAMP
         WHERE company_id=$3`,
        [treasuryDelta, req.user.id, companyId]
      );
    }

    const result = await client.query(
      `INSERT INTO accounting_transactions
       (company_id, transaction_number, transaction_type, bank_id, caisse_id, amount,
        direction, category, partner_id, partner_name, description,
        attachment_url, source_label, destination_label, created_by, validated_by, validated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        companyId,
        transactionNumber,
        transaction_type,
        bankId,
        caisseId,
        amountValue,
        direction,
        category,
        partner_id || null,
        partner_name || "",
        description,
        attachment_url,
        source_label,
        destination_label,
        req.user.id
      ]
    );

    await createAccountingEntry(client, {
      companyId,
      sourceType: "accounting_transaction",
      sourceId: result.rows[0].id,
      accountLabel: direction === "entrée" ? "Banque / Trésorerie" : "Charge / Décaissement",
      debit: direction === "entrée" ? amountValue : 0,
      credit: direction === "sortie" ? amountValue : 0,
      description,
      createdBy: req.user.id
    });

    const isBankCashTransfer = transaction_type === "retrait_banque" && bankId && caisseId;
    const isCashBankDeposit = transaction_type === "depot_caisse_banque" && bankId && caisseId;
    const debitLine =
      isBankCashTransfer
        ? {
            account_code: "57",
            account_name: "Caisse",
            debit: amountValue,
            credit: 0,
            caisse_id: caisseId
          }
        : isCashBankDeposit
          ? {
              account_code: "52",
              account_name: "Banque",
              debit: amountValue,
              credit: 0,
              bank_id: bankId
            }
          : direction === "entrée"
        ? {
            account_code: bankId ? "52" : caisseId ? "57" : "57",
            account_name: bankId ? "Banque" : "Caisse",
            debit: amountValue,
            credit: 0,
            bank_id: bankId,
            caisse_id: caisseId
          }
        : {
            account_code:
              transaction_type === "salaire"
                ? "64"
                : transaction_type === "paiement_fournisseur"
                  ? "40"
                  : "65",
            account_name:
              transaction_type === "salaire"
                ? "Charges de personnel"
                : transaction_type === "paiement_fournisseur"
                  ? "Fournisseurs"
                  : "Autres charges",
            debit: amountValue,
            credit: 0,
            partner_id: partner_id || null
          };
    const creditLine =
      isBankCashTransfer
        ? {
            account_code: "52",
            account_name: "Banque",
            debit: 0,
            credit: amountValue,
            bank_id: bankId
          }
        : isCashBankDeposit
          ? {
              account_code: "57",
              account_name: "Caisse",
              debit: 0,
              credit: amountValue,
              caisse_id: caisseId
            }
          : direction === "entrée"
        ? {
            account_code: transaction_type === "encaissement_bancaire" ? "70" : "75",
            account_name: transaction_type === "encaissement_bancaire" ? "Ventes" : "Autres produits",
            debit: 0,
            credit: amountValue,
            partner_id: partner_id || null
          }
        : {
            account_code: bankId ? "52" : "57",
            account_name: bankId ? "Banque" : "Caisse",
            debit: 0,
            credit: amountValue,
            bank_id: bankId,
            caisse_id: caisseId
          };

    await createJournalEntry(client, {
      companyId,
      label: description || transaction_type,
      moduleSource: "accounting_transaction",
      sourceId: result.rows[0].id,
      lines: [debitLine, creditLine],
      createdBy: req.user.id
    });

    await client.query("COMMIT");
    await logAudit(req, "create_accounting_transaction", "accounting_transaction", result.rows[0].id, { amount: amountValue, direction });
    res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    logAccountingError("POST /accounting/transactions", error, req);
    res.status(error.statusCode || 500).json({ error: accountingErrorMessage(error, "Erreur mouvement comptable") });
  } finally {
    client.release();
  }
});

app.get("/accounting/vouchers", authenticateToken, async (req, res) => {
  try {
    if (!canViewAccounting(req.user)) {
      return res.status(403).json({ error: "Accès comptabilité refusé." });
    }
    const { values, filter } = getAccountingScope(req, false);
    const result = await pool.query(
      `SELECT v.*, b.bank_name, c.nom_caisse
       FROM cash_vouchers v
       LEFT JOIN accounting_banks b ON b.id=v.bank_id
       LEFT JOIN caisses c ON c.id=v.caisse_id
       ${filter ? "WHERE v.company_id=$1" : ""}
       ORDER BY v.id DESC
       LIMIT 300`,
      values
    );
    res.json(result.rows);
  } catch (error) {
    logAccountingError("GET /accounting/vouchers", error, req);
    res.status(500).json({ error: "Erreur lecture bons" });
  }
});

app.post("/accounting/vouchers", authenticateToken, async (req, res) => {
  try {
    if (!canManageAccounting(req.user)) {
      return res.status(403).json({ error: "Accès gestion comptable refusé." });
    }
    const {
      voucher_type,
      amount,
      origin = "",
      beneficiary = "",
      bank_id = null,
      caisse_id = null,
      partner_id = null,
      partner_name = "",
      reason = "",
      expense_category = "",
      attachment_url = ""
    } = req.body;
    const amountValue = Number(amount || 0);
    const bankId = normalizeOptionalId(bank_id);
    const caisseId = normalizeOptionalId(caisse_id);
    if (!["encaissement", "decaissement"].includes(voucher_type) || amountValue <= 0) {
      return res.status(400).json({ error: "Type de bon et montant valides obligatoires." });
    }
    const { companyId } = getAccountingScope(req, true);
    const voucherNumber = await nextAccountingNumber(
      pool,
      "cash_vouchers",
      "voucher_number",
      voucher_type === "encaissement" ? "BE" : "BD",
      companyId
    );
    const result = await pool.query(
      `INSERT INTO cash_vouchers
       (company_id, voucher_number, voucher_type, amount, origin, beneficiary,
        bank_id, caisse_id, partner_id, partner_name, reason, expense_category,
        attachment_url, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'soumis',$14)
       RETURNING *`,
      [
        companyId,
        voucherNumber,
        voucher_type,
        amountValue,
        origin,
        beneficiary,
        bankId,
        caisseId,
        partner_id || null,
        partner_name || "",
        reason,
        expense_category,
        attachment_url,
        req.user.id
      ]
    );
    await logAudit(req, "create_cash_voucher", "cash_voucher", result.rows[0].id, { voucher_type, amount: amountValue });
    res.status(201).json(result.rows[0]);
  } catch (error) {
    logAccountingError("POST /accounting/vouchers", error, req);
    res.status(error.statusCode || 500).json({ error: accountingErrorMessage(error, "Erreur création bon") });
  }
});

app.put("/accounting/vouchers/:id/validate", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!canApproveAccounting(req.user) && !canManageAccounting(req.user)) {
      return res.status(403).json({ error: "Accès validation comptable refusé." });
    }
    await client.query("BEGIN");
    const voucherResult = await client.query(
      `SELECT *
       FROM cash_vouchers
       WHERE id=$1 ${isSuperAdminUser(req.user) && !getEffectiveCompanyId(req) ? "" : "AND company_id=$2"}
       FOR UPDATE`,
      isSuperAdminUser(req.user) && !getEffectiveCompanyId(req)
        ? [req.params.id]
        : [req.params.id, getEffectiveCompanyId(req) || req.user.company_id]
    );
    const voucher = voucherResult.rows[0];
    if (!voucher) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Bon introuvable." });
    }
    if (voucher.status === "validé") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Bon déjà validé." });
    }

    await ensureTreasuryAccount(client, voucher.company_id);
    const amountValue = Number(voucher.amount || 0);
    const direction = voucher.voucher_type === "encaissement" ? "entrée" : "sortie";
    const bank = await loadAccountingBankForUpdate(client, req.user, normalizeOptionalId(voucher.bank_id));
    const caisse = await loadAccountingCaisseForUpdate(client, req.user, normalizeOptionalId(voucher.caisse_id));

    if (voucher.bank_id && !bank) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Banque introuvable ou non autorisée pour ce bon." });
    }
    if (voucher.caisse_id && !caisse) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Caisse introuvable ou non autorisée pour ce bon." });
    }

    if (bank) {
      const delta = direction === "entrée" ? amountValue : -amountValue;
      if (delta < 0) ensureSufficientBalance(bank.current_balance, amountValue, "Solde insuffisant dans cette banque.");
      await client.query(
        `UPDATE accounting_banks
         SET current_balance=COALESCE(current_balance,0)+$1,
             updated_at=CURRENT_TIMESTAMP
         WHERE id=$2`,
        [delta, bank.id]
      );
    } else if (caisse) {
      const delta = direction === "entrée" ? amountValue : -amountValue;
      if (delta < 0) ensureSufficientBalance(caisse.solde_actuel, amountValue, "Solde insuffisant dans cette caisse.");
      await client.query(
        `UPDATE caisses
         SET solde_actuel=COALESCE(solde_actuel,0)+$1,
             updated_at=CURRENT_TIMESTAMP
         WHERE id=$2`,
        [delta, caisse.id]
      );
    } else {
      const treasuryDelta = direction === "entrée" ? amountValue : -amountValue;
      if (treasuryDelta < 0) {
        const treasuryResult = await client.query(
          `SELECT * FROM treasury_accounts WHERE company_id=$1 FOR UPDATE`,
          [voucher.company_id]
        );
        ensureSufficientBalance(treasuryResult.rows[0]?.current_balance, amountValue, "Solde insuffisant dans la trésorerie.");
      }
      await client.query(
        `UPDATE treasury_accounts
         SET current_balance=COALESCE(current_balance,0)+$1,
             updated_by=$2,
             updated_at=CURRENT_TIMESTAMP
         WHERE company_id=$3`,
        [treasuryDelta, req.user.id, voucher.company_id]
      );
    }

    const transactionNumber = await nextAccountingNumber(
      client,
      "accounting_transactions",
      "transaction_number",
      voucher.voucher_type === "encaissement" ? "ENC" : "DEC",
      voucher.company_id
    );
    await client.query(
      `INSERT INTO accounting_transactions
       (company_id, transaction_number, transaction_type, source_type, source_id,
        bank_id, caisse_id, amount, direction, category, partner_id, partner_name,
        description, attachment_url, created_by, validated_by, validated_at)
       VALUES ($1,$2,$3,'cash_voucher',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,CURRENT_TIMESTAMP)`,
      [
        voucher.company_id,
        transactionNumber,
        voucher.voucher_type,
        voucher.id,
        voucher.bank_id,
        voucher.caisse_id,
        amountValue,
        direction,
        voucher.expense_category || "",
        voucher.partner_id,
        voucher.partner_name || "",
        voucher.reason || "",
        voucher.attachment_url || "",
        req.user.id
      ]
    );

    await createJournalEntry(client, {
      companyId: voucher.company_id,
      label: voucher.reason || voucher.voucher_number,
      moduleSource: "cash_voucher",
      sourceId: voucher.id,
      lines: direction === "entrée"
        ? [
            {
              account_code: bank ? "52" : "57",
              account_name: bank ? "Banque" : "Caisse",
              debit: amountValue,
              credit: 0,
              bank_id: bank?.id || null,
              caisse_id: caisse?.id || null
            },
            {
              account_code: "75",
              account_name: "Autres produits",
              debit: 0,
              credit: amountValue,
              partner_id: voucher.partner_id || null
            }
          ]
        : [
            {
              account_code: voucher.expense_category === "achat" ? "60" : "65",
              account_name: voucher.expense_category === "achat" ? "Achats" : "Autres charges",
              debit: amountValue,
              credit: 0,
              partner_id: voucher.partner_id || null
            },
            {
              account_code: bank ? "52" : "57",
              account_name: bank ? "Banque" : "Caisse",
              debit: 0,
              credit: amountValue,
              bank_id: bank?.id || null,
              caisse_id: caisse?.id || null
            }
          ],
      createdBy: req.user.id
    });

    const updated = await client.query(
      `UPDATE cash_vouchers
       SET status='validé',
           validated_by=$1,
           validated_at=CURRENT_TIMESTAMP,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$2
       RETURNING *`,
      [req.user.id, voucher.id]
    );
    await client.query("COMMIT");
    await logAudit(req, "validate_cash_voucher", "cash_voucher", voucher.id, { voucher_type: voucher.voucher_type });
    res.json(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    logAccountingError("PUT /accounting/vouchers/:id/validate", error, req);
    res.status(error.statusCode || 500).json({ error: accountingErrorMessage(error, "Erreur validation bon") });
  } finally {
    client.release();
  }
});

app.put("/accounting/vouchers/:id/reject", authenticateToken, async (req, res) => {
  try {
    if (!canApproveAccounting(req.user) && !canManageAccounting(req.user)) {
      return res.status(403).json({ error: "Accès refus bon comptable refusé." });
    }
    const isGlobalSuperAdmin = isSuperAdminUser(req.user) && !getEffectiveCompanyId(req);
    const values = [
      "refusé",
      req.body?.rejection_reason || req.body?.reason || "",
      req.user.id,
      req.params.id
    ];
    let query = `
      UPDATE cash_vouchers
      SET status=$1,
          rejection_reason=$2,
          validated_by=$3,
          validated_at=CURRENT_TIMESTAMP,
          updated_at=CURRENT_TIMESTAMP
      WHERE id=$4
    `;
    if (!isGlobalSuperAdmin) {
      values.push(getEffectiveCompanyId(req) || req.user.company_id);
      query += " AND company_id=$5";
    }
    query += " RETURNING *";

    const result = await pool.query(query, values);
    if (!result.rows[0]) return res.status(404).json({ error: "Bon introuvable." });
    await logAudit(req, "reject_cash_voucher", "cash_voucher", req.params.id, {
      reason: req.body?.rejection_reason || req.body?.reason || ""
    });
    res.json(result.rows[0]);
  } catch (error) {
    logAccountingError("PUT /accounting/vouchers/:id/reject", error, req);
    res.status(error.statusCode || 500).json({ error: accountingErrorMessage(error, "Erreur refus bon") });
  }
});

app.get("/accounting/expense-requests", authenticateToken, async (req, res) => {
  try {
    if (!canViewAccounting(req.user)) {
      return res.status(403).json({ error: "Accès comptabilité refusé." });
    }
    const isSuperAdmin = isSuperAdminUser(req.user);
    const activeCompanyId = getEffectiveCompanyId(req);
    const whereClause = isSuperAdmin
      ? activeCompanyId ? "company_id=$1" : "true"
      : "company_id=$1";
    const values = isSuperAdmin
      ? activeCompanyId ? [activeCompanyId] : []
      : [req.user.company_id];
    const result = await pool.query(
      `SELECT *
       FROM expense_requests
       WHERE ${whereClause}
       ORDER BY id DESC`,
      values
    );
    res.json(result.rows);
  } catch (error) {
    logAccountingError("GET /accounting/expense-requests", error, req);
    res.status(500).json({ error: "Erreur lecture demandes" });
  }
});

app.post("/accounting/expense-requests", authenticateToken, async (req, res) => {
  try {
    if (!canViewAccounting(req.user)) {
      return res.status(403).json({ error: "Accès comptabilité refusé." });
    }
    const {
      requested_amount,
      reason,
      description = "",
      urgency = "normale",
      attachment_url = ""
    } = req.body;
    const amountValue = Number(requested_amount || 0);
    if (amountValue <= 0 || !reason) {
      return res.status(400).json({ error: "Montant et motif obligatoires." });
    }
    const { companyId } = getAccountingScope(req, true);
    const requestNumber = await nextAccountingNumber(
      pool,
      "expense_requests",
      "request_number",
      "DD",
      companyId
    );
    const result = await pool.query(
      `INSERT INTO expense_requests
       (company_id, request_number, requested_amount, reason, description,
        urgency, attachment_url, status, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'soumis',$8,$9)
       RETURNING *`,
      [
        companyId,
        requestNumber,
        amountValue,
        reason,
        description,
        urgency,
        attachment_url,
        req.user.id,
        req.user.email || ""
      ]
    );
    await logAudit(req, "create_expense_request", "expense_request", result.rows[0].id, { amount: amountValue });
    res.status(201).json(result.rows[0]);
  } catch (error) {
    logAccountingError("POST /accounting/expense-requests", error, req);
    res.status(error.statusCode || 500).json({ error: accountingErrorMessage(error, "Erreur création demande") });
  }
});

app.put("/accounting/expense-requests/:id/status", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    let { status, rejection_reason = "", proof_url = "" } = req.body;
    if (status === "payé") status = "paiement_effectué";
    const allowed = ["validé", "refusé", "paiement_effectué", "justificatif_reçu", "clôturé"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: "Statut invalide." });
    }
    if ((status === "validé" || status === "refusé") && !canApproveAccounting(req.user)) {
      return res.status(403).json({ error: "Validation réservée à la direction/admin." });
    }
    if ((status === "paiement_effectué" || status === "justificatif_reçu" || status === "clôturé") && !canManageAccounting(req.user)) {
      return res.status(403).json({ error: "Paiement/clôture réservé au comptable/admin." });
    }

    await client.query("BEGIN");
    const isGlobalSuperAdmin = isSuperAdminUser(req.user) && !getEffectiveCompanyId(req);
    const requestResult = await client.query(
      `SELECT *
       FROM expense_requests
       WHERE id=$1 ${isGlobalSuperAdmin ? "" : "AND company_id=$2"}
       FOR UPDATE`,
      isGlobalSuperAdmin ? [req.params.id] : [req.params.id, getEffectiveCompanyId(req) || req.user.company_id]
    );
    const request = requestResult.rows[0];
    if (!request) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Demande introuvable." });
    }
    if (status === "clôturé" && !proof_url && !request.proof_url) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Justificatif obligatoire pour clôturer." });
    }

    if (status === "paiement_effectué" && request.status !== "paiement_effectué") {
      await ensureTreasuryAccount(client, request.company_id);
      const treasuryResult = await client.query(
        `SELECT * FROM treasury_accounts WHERE company_id=$1 FOR UPDATE`,
        [request.company_id]
      );
      ensureSufficientBalance(treasuryResult.rows[0]?.current_balance, Number(request.requested_amount || 0), "Solde insuffisant dans la trésorerie.");
      await client.query(
        `UPDATE treasury_accounts
         SET current_balance=COALESCE(current_balance,0)-$1,
             updated_by=$2,
             updated_at=CURRENT_TIMESTAMP
         WHERE company_id=$3`,
        [Number(request.requested_amount || 0), req.user.id, request.company_id]
      );
    }

    const update = await client.query(
      `UPDATE expense_requests
       SET status=$1,
           rejection_reason=CASE WHEN $1='refusé' THEN $2 ELSE rejection_reason END,
           proof_url=COALESCE(NULLIF($3,''), proof_url),
           approved_by=CASE WHEN $1 IN ('validé','refusé') THEN $4 ELSE approved_by END,
           approved_at=CASE WHEN $1 IN ('validé','refusé') THEN CURRENT_TIMESTAMP ELSE approved_at END,
           paid_by=CASE WHEN $1='paiement_effectué' THEN $4 ELSE paid_by END,
           paid_at=CASE WHEN $1='paiement_effectué' THEN CURRENT_TIMESTAMP ELSE paid_at END,
           closed_by=CASE WHEN $1='clôturé' THEN $4 ELSE closed_by END,
           closed_at=CASE WHEN $1='clôturé' THEN CURRENT_TIMESTAMP ELSE closed_at END,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$5
       RETURNING *`,
      [status, rejection_reason, proof_url, req.user.id, request.id]
    );
    await client.query("COMMIT");
    await logAudit(req, "update_expense_request_status", "expense_request", request.id, { status });
    res.json(update.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    logAccountingError("PUT /accounting/expense-requests/:id/status", error, req);
    res.status(error.statusCode || 500).json({ error: accountingErrorMessage(error, "Erreur changement statut demande") });
  } finally {
    client.release();
  }
});

app.get("/accounting/statements", authenticateToken, async (req, res) => {
  try {
    if (!canViewAccounting(req.user)) {
      return res.status(403).json({ error: "Accès comptabilité refusé." });
    }
    const { values, filter, andFilter } = getAccountingScope(req, false);

    const entries = await pool.query(
      `SELECT e.*, COALESCE(json_agg(l ORDER BY l.id) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines
       FROM journal_entries e
       LEFT JOIN journal_entry_lines l ON l.entry_id=e.id
       ${filter ? "WHERE e.company_id=$1" : ""}
       GROUP BY e.id
       ORDER BY e.id DESC
       LIMIT 500`,
      values
    );
    const debitsCredits = await pool.query(
      `SELECT
         COALESCE(SUM(debit),0)::numeric AS debit,
         COALESCE(SUM(credit),0)::numeric AS credit
       FROM journal_entry_lines
       ${filter}`,
      values
    );
    const cashflow = await pool.query(
      `SELECT direction, COALESCE(SUM(amount),0)::numeric AS total
       FROM accounting_transactions
       WHERE status='validé' ${andFilter}
       GROUP BY direction`,
      values
    );
    const assets = await pool.query(
      `SELECT
         (SELECT COALESCE(SUM(current_balance),0) FROM accounting_banks ${filter}) AS banks,
         (SELECT COALESCE(SUM(current_balance),0) FROM treasury_accounts ${filter}) AS treasury,
         (SELECT COALESCE(SUM(solde_actuel),0) FROM caisses ${filter}) AS caisses`,
      values
    );

    res.json({
      bilan: {
        actif:
          Number(assets.rows[0]?.banks || 0) +
          Number(assets.rows[0]?.treasury || 0) +
          Number(assets.rows[0]?.caisses || 0),
        passif: 0,
        banques: Number(assets.rows[0]?.banks || 0),
        caisses: Number(assets.rows[0]?.caisses || 0),
        tresorerie: Number(assets.rows[0]?.treasury || 0)
      },
      compte_resultat: {
        produits: Number(cashflow.rows.find((row) => row.direction === "entrée")?.total || 0),
        charges: Number(cashflow.rows.find((row) => row.direction === "sortie")?.total || 0)
      },
      tableau_tresorerie: cashflow.rows,
      balance_generale: debitsCredits.rows[0],
      grand_livre: entries.rows
    });
  } catch (error) {
    logAccountingError("GET /accounting/statements", error, req);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Erreur états financiers" });
  }
});

app.use("/super-admin", authenticateToken, (req, res, next) => {
  if (req.user?.is_super_admin !== true && normalizeRole(req.user?.role) !== "super_admin") {
    return res.status(403).json({ error: "Accès super admin requis." });
  }
  next();
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
      "comptabilite",
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
/* Documents : generation groupee transactionnelle, correction du contenu
   imprime, annulation avec remplacement.

   Monte AVANT les routes `/documents/...` declarees plus bas : Express
   essaie les routes dans l'ordre, et `/documents/:id` prendrait
   « pending-movements » pour un identifiant. */
const createDocumentsContentRouter = require("./routes/documents-content");
app.use(
  "/",
  createDocumentsContentRouter({
    pool, authenticateToken, getEffectiveCompanyId, requirePermission,
    nextShortDocumentNumber,
    permissionsService: require("./services/permissions"),
  })
);

app.get("/documents", authenticateToken, requirePermission("document", "view"), async (req, res) => {
  try {

    const companyId = getEffectiveCompanyId(req);
    const isSuperAdmin = req.user.is_super_admin === true;

    let query = `
      SELECT * FROM documents
    `;

    let values = [];

    if (!isSuperAdmin || companyId) {
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

app.get("/documents/:id", authenticateToken, requirePermission("document", "view"), async (req, res) => {
  try {

    const companyId = getEffectiveCompanyId(req);
    const isSuperAdmin = req.user.is_super_admin === true;

    const documentResult = await pool.query(
      `SELECT * FROM documents
       WHERE id=$1 ${isSuperAdmin && !companyId ? "" : "AND company_id=$2"}`,
      isSuperAdmin && !companyId ? [req.params.id] : [req.params.id, companyId]
    );

    if (!documentResult.rows[0]) {
      return res.status(404).json({ error: "Document introuvable" });
    }

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

function escapeHtml(value = "") {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderDocumentHtml(document, items = [], companySettings = {}) {
  const isReceipt = String(document.document_type || "").toLowerCase().includes("reçu");
  const rows = items.map((item) => `
    <tr>
      <td>${escapeHtml(item.product_reference || "")}</td>
      <td>${escapeHtml(item.product_name || "")}</td>
      <td class="right">${Number(item.quantity || 0).toLocaleString("fr-FR")}</td>
      <td class="right">${Number(item.unit_price || 0).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} FCFA</td>
      <td class="right">${Number(item.total_price || 0).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} FCFA</td>
    </tr>
  `).join("");

  return `<!doctype html>
  <html lang="fr">
  <head>
    <meta charset="utf-8" />
    <style>
      body { font-family: Arial, sans-serif; color: #111; margin: 0; padding: ${isReceipt ? "10px" : "28px"}; }
      .page { max-width: ${isReceipt ? "80mm" : "210mm"}; margin: 0 auto; }
      .header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #111; padding-bottom: 16px; }
      .logo { max-height: 70px; max-width: 140px; object-fit: contain; }
      h1 { margin: 18px 0 6px; font-size: ${isReceipt ? "18px" : "28px"}; }
      .muted { color: #555; font-size: 13px; }
      table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: ${isReceipt ? "11px" : "13px"}; }
      th, td { border-bottom: 1px solid #ddd; padding: 8px 6px; text-align: left; }
      th { background: #f3f4f6; }
      .right { text-align: right; }
      .total { margin-top: 18px; text-align: right; font-size: ${isReceipt ? "15px" : "20px"}; font-weight: 700; }
      .signature { display: flex; justify-content: space-between; margin-top: 60px; gap: 40px; }
      .signature div { width: 45%; border-top: 1px solid #111; padding-top: 8px; text-align: center; }
      @media print { button { display: none; } body { padding: 0; } }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="header">
        <div>
          ${companySettings.logo_url ? `<img class="logo" src="${escapeHtml(companySettings.logo_url)}" alt="Logo" />` : ""}
          <h2>${escapeHtml(companySettings.name || companySettings.company_name || "Triangle WMS Pro")}</h2>
          <p class="muted">${escapeHtml(companySettings.address || "")}</p>
          <p class="muted">${escapeHtml(companySettings.phone || "")} ${companySettings.email ? `| ${escapeHtml(companySettings.email)}` : ""}</p>
        </div>
        <div class="right">
          <h1>${escapeHtml(document.document_type || "Document")}</h1>
          <p><strong>${escapeHtml(document.document_number || "")}</strong></p>
          <!-- La date IMPRIMÉE est la date métier, pas l'instant où la ligne
               est entrée en base, et elle s'écrit à l'heure de Bamako : sans
               fuseau explicite, le même bon affichait deux heures différentes
               selon le téléphone qui l'ouvrait. -->
          <p class="muted">${(() => {
            const d = documentDates.dateAAfficher(document);
            const local = documentDates.versLocal(d.instant);
            return local ? escapeHtml(local.affichage) : "";
          })()}</p>
          ${Number(document.document_revision || 1) > 1
            ? `<p class="muted">Révision ${Number(document.document_revision)}</p>` : ""}
        </div>
      </section>
      <section>
        <p><strong>Client / Fournisseur :</strong> ${escapeHtml(document.client_name || "-")}</p>
        ${document.client_phone ? `<p><strong>Téléphone :</strong> ${escapeHtml(document.client_phone)}</p>` : ""}
        ${document.client_address ? `<p><strong>Adresse :</strong> ${escapeHtml(document.client_address)}</p>` : ""}
      </section>
      <table>
        <thead>
          <tr><th>Réf.</th><th>Produit</th><th class="right">Qté</th><th class="right">Prix</th><th class="right">Total</th></tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="5">Aucune ligne détaillée.</td></tr>`}</tbody>
      </table>
      <div class="total">Total : ${Number(document.total_amount || 0).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} FCFA</div>
      ${document.observation ? `<p><strong>Observation :</strong> ${escapeHtml(document.observation)}</p>` : ""}
      ${!isReceipt ? `<section class="signature"><div>Signature</div><div>Cachet</div></section>` : ""}
    </main>
  </body>
  </html>`;
}

app.post("/documents/:id/email", authenticateToken, requirePermission("document", "view"), async (req, res) => {
  try {

    const { recipient_email, subject, message } = req.body || {};
    if (!recipient_email || !String(recipient_email).includes("@")) {
      return res.status(400).json({ error: "Email destinataire invalide." });
    }

    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return res.status(503).json({
        error: "SMTP non configuré. Configurez SMTP dans Paramètres > Email."
      });
    }

    const companyId = getEffectiveCompanyId(req);
    const isSuperAdmin = req.user.is_super_admin === true;
    const documentResult = await pool.query(
      `SELECT * FROM documents
       WHERE id=$1 ${isSuperAdmin && !companyId ? "" : "AND company_id=$2"}`,
      isSuperAdmin && !companyId ? [req.params.id] : [req.params.id, companyId]
    );
    const document = documentResult.rows[0];
    if (!document) return res.status(404).json({ error: "Document introuvable" });

    const itemsResult = await pool.query(
      "SELECT * FROM document_items WHERE document_id=$1 ORDER BY id ASC",
      [req.params.id]
    );
    const companySettings = await getCompanySettingsForCompany(pool, document.company_id);
    const html = renderDocumentHtml(document, itemsResult.rows, companySettings || {});

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipient_email,
      subject: subject || `${document.document_type} ${document.document_number}`,
      text: message || `Veuillez trouver le document ${document.document_number}.`,
      html: `<p>${escapeHtml(message || `Veuillez trouver le document ${document.document_number}.`)}</p>${html}`,
      attachments: [
        {
          filename: `${document.document_number || "document"}.html`,
          content: html,
          contentType: "text/html"
        }
      ]
    });

    await pool.query(
      `UPDATE documents
       SET email_sent_to=$1,
           email_sent_at=CURRENT_TIMESTAMP
       WHERE id=$2`,
      [recipient_email, document.id]
    );

    await logAudit(req, "email_document", "document", document.id, {
      recipient_email,
      message_id: info.messageId || ""
    });

    res.json({ message: "Document envoyé par email.", message_id: info.messageId || "" });
  } catch (error) {
    console.error("ERREUR EMAIL DOCUMENT :", error);
    res.status(500).json({
      error: error.message || "Erreur envoi email document"
    });
  }
});

app.post("/reports/email", authenticateToken, requirePermission("rapport", "create"), async (req, res) => {
  try {
    const { recipient_email = "", subject = "Rapport Triangle WMS Pro", html = "", message = "" } = req.body || {};
    if (!recipient_email || !String(recipient_email).includes("@")) {
      return res.status(400).json({ error: "Email destinataire invalide." });
    }
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return res.status(503).json({ error: "SMTP non configuré. Configurez SMTP dans .env." });
    }
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    const finalHtml = html || `<p>${escapeHtml(message || "Rapport Triangle WMS Pro")}</p>`;
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipient_email,
      subject,
      text: message || "Rapport Triangle WMS Pro",
      html: finalHtml,
      attachments: [{ filename: "rapport-triangle-wms.html", content: finalHtml, contentType: "text/html" }]
    });
    await logAudit(req, "email_report", "report", null, { recipient_email, message_id: info.messageId || "" });
    res.json({ message: "Rapport envoyé par email.", message_id: info.messageId || "" });
  } catch (error) {
    console.error("ERREUR EMAIL REPORT :", error);
    res.status(500).json({ error: error.message || "Erreur envoi email rapport" });
  }
});

app.post("/documents", authenticateToken, requirePermission("document", "create"), async (req, res) => {
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

    const document_number = await nextShortDocumentNumber(prefix, getEffectiveCompanyId(req, req.user && req.user.company_id));

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

app.delete("/documents/:id", authenticateToken, requirePermission("document", "delete"), async (req, res) => {
  try {
    if (!canAccessAdminSettings(req.user)) {
      return res.status(403).json({ error: "Accès refusé : réservé à l’administrateur" });
    }

    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;

    await pool.query(
      `DELETE FROM documents
       WHERE id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}`,
      isSuperAdmin ? [req.params.id] : [req.params.id, companyId]
    );

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
app.post("/documents/from-movement/:id", authenticateToken, requirePermission("document", "create"), async (req, res) => {
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
          /* Un bon de livraison accompagne une marchandise vendue et livrée à
             quelqu'un. Une sortie de stock peut être une casse, un départ vers
             un chantier, une consommation interne : lui coller un BL fait
             sortir des livraisons que personne n'a commandées. */
          finalType = "Bon de sortie";
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

    const document_number = await nextShortDocumentNumber(prefix, getEffectiveCompanyId(req, req.user && req.user.company_id));

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
        stock_movement_id,
        warehouse_id,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *`,
      [
        finalType,
        document_number,
        client_name || "",
        client_phone || "",
        client_address || "",
        0,
        `Document généré depuis mouvement stock ID ${movement.id} - ${movement.type}`,
        movement.created_by_name || created_by || req.user.fullname || req.user.email || "Utilisateur",
        movement.company_id || companyId,
        "stock_movement",
        movement.id,
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

/* TRIANGLE MARKETPLACE B2B/B2C */
function canManageMarketplaceVendor(user) {
  const role = normalizeRole(user?.role);
  return (
    user?.is_super_admin === true ||
    role === "super_admin" ||
    role === "admin" ||
    role === "marketplace_vendor" ||
    role === "marketplace_admin"
  );
}

function canAdminMarketplace(user) {
  const role = normalizeRole(user?.role);
  return user?.is_super_admin === true || role === "super_admin" || role === "marketplace_admin";
}

const MARKETPLACE_ORDER_STATUSES = {
  pending: "En attente",
  pending_payment: "En attente",
  confirmed: "Acceptée",
  accepted: "Acceptée",
  paid: "Paiement confirmé",
  preparing: "En préparation",
  ready: "Prête",
  shipped: "Expédiée",
  delivered: "Livrée",
  closed: "Clôturée",
  completed: "Clôturée",
  cancelled: "Annulée",
  canceled: "Annulée",
  rejected: "Refusée",
  refused: "Refusée",
  received: "Clôturée"
};

const MARKETPLACE_PAYMENT_STATUSES = {
  pending: "En attente",
  "en attente": "En attente",
  paid: "Payé",
  paye: "Payé",
  payé: "Payé",
  failed: "Échoué",
  cancelled: "Annulé",
  canceled: "Annulé",
  annule: "Annulé",
  annulé: "Annulé",
  partial: "Partiel",
  partiel: "Partiel"
};

function normalizeMarketplaceOrderStatus(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const key = raw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return MARKETPLACE_ORDER_STATUSES[key] || MARKETPLACE_ORDER_STATUSES[raw.toLowerCase()] || raw;
}

function normalizeMarketplacePaymentStatus(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const key = raw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return MARKETPLACE_PAYMENT_STATUSES[key] || MARKETPLACE_PAYMENT_STATUSES[raw.toLowerCase()] || raw;
}

function isMarketplaceClosedStatus(value) {
  const status = normalizeMarketplaceOrderStatus(value).toLowerCase();
  return ["clôturée", "cloturee", "annulée", "annulee", "refusée", "refusee"].includes(
    status.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  );
}

async function refreshMarketplaceOrderPaymentState(client, orderId) {
  const paidResult = await client.query(
    `SELECT COALESCE(SUM(amount),0)::numeric AS amount_paid
     FROM marketplace_payments
     WHERE order_id=$1
       AND LOWER(status) IN ('payé','paye','paid')`,
    [orderId]
  );
  const orderResult = await client.query("SELECT * FROM marketplace_orders WHERE id=$1 FOR UPDATE", [orderId]);
  const order = orderResult.rows[0];
  if (!order) throw new Error("Commande marketplace introuvable.");
  const amountPaid = Number(paidResult.rows[0]?.amount_paid || 0);
  const totalAmount = Number(order.total_amount || 0);
  const amountDue = Math.max(totalAmount - amountPaid, 0);
  const paymentStatus = amountDue <= 0 && totalAmount > 0 ? "Payé" : amountPaid > 0 ? "Partiel" : "En attente";
  const nextStatus = normalizeMarketplaceOrderStatus(order.status || "En attente");
  const updated = await client.query(
    `UPDATE marketplace_orders
     SET amount_paid=$1,
         amount_due=$2,
         payment_status=$3::text,
         status=$4::text,
         closed_at=CASE WHEN $4::text='Clôturée' THEN COALESCE(closed_at, CURRENT_TIMESTAMP) ELSE closed_at END,
         updated_at=CURRENT_TIMESTAMP
     WHERE id=$5
     RETURNING *`,
    [amountPaid, amountDue, paymentStatus, nextStatus, orderId]
  );
  return updated.rows[0];
}

async function getOrCreateMarketplaceCart(clientOrPool, user) {
  const role = normalizeRole(user?.role);
  const isCustomer = role === "customer";
  const buyerCompanyId = isCustomer ? null : user.company_id || null;
  const existing = await clientOrPool.query(
    `SELECT *
     FROM marketplace_carts
     WHERE user_id=$1
       AND status='active'
     ORDER BY id DESC
     LIMIT 1`,
    [user.id]
  );
  if (existing.rows[0]) return existing.rows[0];

  const created = await clientOrPool.query(
    `INSERT INTO marketplace_carts
     (user_id, company_id, buyer_company_id, customer_email, cart_type, status)
     VALUES ($1,$2,$2,$3,$4,'active')
     RETURNING *`,
    [user.id, buyerCompanyId, user.email || "", buyerCompanyId ? "B2B" : "B2C"]
  );
  return created.rows[0];
}

async function getMarketplaceCartPayload(user) {
  const cart = await getOrCreateMarketplaceCart(pool, user);
  const items = await pool.query(
    `SELECT ci.*, COALESCE(NULLIF(mp.public_title,''), mp.title) AS title,
            COALESCE(NULLIF(mp.public_price,0), mp.price, 0) AS price,
            mp.image_url, mp.status AS marketplace_status,
            p.reference, p.name AS product_name, p.stock,
            c.name AS vendor_name
     FROM marketplace_cart_items ci
     JOIN marketplace_products mp ON mp.id=ci.marketplace_product_id
     LEFT JOIN products p ON p.id=ci.product_id
     LEFT JOIN companies c ON c.id=ci.vendor_company_id
     WHERE ci.cart_id=$1
     ORDER BY ci.id ASC`,
    [cart.id]
  );
  const total = items.rows.reduce((sum, item) => sum + Number(item.total_price || 0), 0);
  return { cart, items: items.rows, total };
}

async function createMarketplaceDocument(client, { order, items, companyId, documentType, prefix, status = "Validé", createdBy = "Marketplace", observation = "" }) {
  const documentNumber = `${prefix}-${new Date().getFullYear()}-${String(order.id).padStart(6, "0")}`;
  const documentResult = await client.query(
    `INSERT INTO documents
     (document_type, document_number, client_name, client_phone, client_address,
      total_amount, observation, created_by, company_id, related_entity_type,
      related_entity_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'marketplace_order',$10,$11)
     RETURNING *`,
    [
      documentType,
      documentNumber,
      order.customer_name || order.customer_email || "",
      order.customer_phone || "",
      order.delivery_address || "",
      Number(order.total_amount || 0),
      observation || `${documentType} généré depuis la commande marketplace ${order.order_number}`,
      createdBy,
      companyId,
      order.id,
      status
    ]
  );

  for (const item of items) {
    await client.query(
      `INSERT INTO document_items
       (document_id, product_reference, product_name, quantity, unit_price, total_price)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        documentResult.rows[0].id,
        item.product_reference || "",
        item.product_name || "",
        Number(item.quantity || 0),
        Number(item.unit_price || 0),
        Number(item.total_price || 0)
      ]
    );
  }

  return documentResult.rows[0];
}

async function finalizeMarketplaceOrder(client, orderId, user = {}) {
  const orderResult = await client.query(
    "SELECT * FROM marketplace_orders WHERE id=$1 FOR UPDATE",
    [orderId]
  );
  const order = orderResult.rows[0];
  if (!order) throw new Error("Commande marketplace introuvable.");

  if (["paid", "payé", "paye"].includes(String(order.payment_status || "").toLowerCase())) {
    return order;
  }

  const itemsResult = await client.query(
    "SELECT * FROM marketplace_order_items WHERE order_id=$1 ORDER BY id ASC",
    [order.id]
  );

  for (const item of itemsResult.rows) {
    const publicationResult = await client.query(
      `SELECT *
       FROM marketplace_products
       WHERE id=$1
         AND company_id=$2
       FOR UPDATE`,
      [item.marketplace_product_id, order.vendor_company_id]
    );
    const publication = publicationResult.rows[0];
    if (!publication) throw new Error(`Publication marketplace introuvable : ${item.marketplace_product_id}`);

    const productResult = await client.query(
      `SELECT *
       FROM products
       WHERE id=$1
         AND company_id=$2
       FOR UPDATE`,
      [item.product_id, order.vendor_company_id]
    );
    const product = productResult.rows[0];
    if (!product) throw new Error(`Produit marketplace introuvable : ${item.product_name || item.product_id}`);

    const quantity = Number(item.quantity || 0);
    const publicationAvailable = Number(publication.available_quantity ?? publication.available_stock ?? product.stock ?? 0);
    if (Number(product.stock || 0) < quantity || publicationAvailable < quantity) {
      throw new Error(`Stock insuffisant pour ${product.reference || product.name}.`);
    }

    await client.query(
      `UPDATE products
       SET stock=COALESCE(stock,0)-$1,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$2`,
      [quantity, product.id]
    );

    await client.query(
      `UPDATE marketplace_products
       SET sold_quantity=COALESCE(sold_quantity,0)+$1,
           available_quantity=GREATEST(COALESCE(available_quantity, available_stock, 0)-$1,0),
           available_stock=GREATEST(COALESCE(available_stock, available_quantity, 0)-$1,0),
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$2`,
      [quantity, item.marketplace_product_id]
    );

    await client.query(
      `INSERT INTO stock_movements
       (type, product_reference, product_name, quantity, source_warehouse,
        destination_warehouse, reason, status, company_id, created_by,
        created_by_name, created_by_role, product_id, location_id,
        warehouse_id, approval_status, original_quantity, final_quantity)
       VALUES ('Sortie',$1,$2,$3,$4,$5,$6,'Validé',$7,$8,$9,$10,$11,$12,$13,'Validé',$3,$3)`,
      [
        product.reference || item.product_reference || "",
        product.name || item.product_name || "",
        quantity,
        product.warehouse || "",
        order.delivery_address || "Marketplace",
        `Commande marketplace ${order.order_number}`,
        order.vendor_company_id,
        user.id || order.customer_user_id || null,
        user.email || order.customer_email || "Marketplace",
        user.role || "marketplace",
        product.id,
        product.location_id || null,
        product.warehouse_id || null
      ]
    );
  }

  const paidSumResult = await client.query(
    `SELECT COALESCE(SUM(amount),0)::numeric AS amount_paid
     FROM marketplace_payments
     WHERE order_id=$1
       AND LOWER(status) IN ('payé','paye','paid')`,
    [order.id]
  );
  const amountAlreadyPaid = Number(paidSumResult.rows[0]?.amount_paid || 0);
  const totalToPay = Number(order.total_amount || 0);
  const amountToComplete = Math.max(totalToPay - amountAlreadyPaid, 0);

  const paidOrder = await client.query(
    `UPDATE marketplace_orders
     SET payment_status='Payé',
         status='Paiement confirmé',
         amount_paid=$2,
         amount_due=0,
         buyer_user_id=COALESCE(buyer_user_id, customer_user_id),
         seller_company_id=COALESCE(seller_company_id, vendor_company_id),
         updated_at=CURRENT_TIMESTAMP
     WHERE id=$1
     RETURNING *`,
    [order.id, totalToPay]
  );

  let marketplacePayment = null;
  if (amountToComplete > 0) {
    const createdPayment = await client.query(
      `INSERT INTO marketplace_payments
       (order_id, company_id, amount, currency, method, status, provider_reference,
        paid_at, created_by)
       VALUES ($1,$2,$3,'FCFA',$4,'Payé',$5,CURRENT_TIMESTAMP,$6)
       RETURNING *`,
      [
        order.id,
        order.vendor_company_id,
        amountToComplete,
        order.payment_method || "Espèces",
        order.order_number,
        user.id || order.customer_user_id || null
      ]
    );
    marketplacePayment = createdPayment.rows[0];
  } else {
    const existingPayment = await client.query(
      `SELECT *
       FROM marketplace_payments
       WHERE order_id=$1
         AND LOWER(status) IN ('payé','paye','paid')
       ORDER BY id DESC
       LIMIT 1`,
      [order.id]
    );
    marketplacePayment = existingPayment.rows[0] || null;
  }

  const accountingPayment = await client.query(
    `INSERT INTO payments
     (company_id, amount, currency, payment_method, payment_reference,
      status, notes, paid_at, payment_status)
     VALUES ($1,$2,'FCFA',$3,$4,'paid',$5,CURRENT_TIMESTAMP,'paid')
     RETURNING *`,
    [
      order.vendor_company_id,
      Number(order.total_amount || 0),
      order.payment_method || "Espèces",
      order.order_number,
      `Paiement marketplace ${order.order_number}`
    ]
  );

  await recordPosPaymentAccounting(client, {
    sale: {
      id: order.id,
      company_id: order.vendor_company_id,
      total_amount: Number(order.total_amount || 0),
      payment_method: order.payment_method || "Espèces",
      sale_number: order.order_number,
      customer_name: order.customer_name || order.customer_email || "Client marketplace",
      created_by: user.id || order.customer_user_id || null
    },
    payment: accountingPayment.rows[0],
    user,
    amount: Number(order.total_amount || 0)
  });

  await createMarketplaceDocument(client, {
    order,
    items: itemsResult.rows,
    companyId: order.vendor_company_id,
    documentType: "Facture marketplace",
    prefix: "FAC-MKP",
    createdBy: user.email || "Marketplace"
  });
  await createMarketplaceDocument(client, {
    order,
    items: itemsResult.rows,
    companyId: order.vendor_company_id,
    documentType: "Reçu marketplace",
    prefix: "REC-MKP",
    createdBy: user.email || "Marketplace",
    observation: `Reçu de paiement marketplace ${order.order_number}`
  });
  await createMarketplaceDocument(client, {
    order,
    items: itemsResult.rows,
    companyId: order.vendor_company_id,
    documentType: "Bon de livraison marketplace",
    prefix: "BL-MKP",
    createdBy: user.email || "Marketplace",
    observation: `Bon de livraison vendeur pour commande marketplace ${order.order_number}`
  });

  if (order.buyer_company_id && Number(order.buyer_company_id) !== Number(order.vendor_company_id)) {
    await createMarketplaceDocument(client, {
      order,
      items: itemsResult.rows,
      companyId: order.buyer_company_id,
      documentType: "Bon de réception marketplace",
      prefix: "BR-MKP",
      status: "En attente",
      createdBy: user.email || "Marketplace",
      observation: `Bon de réception acheteur pour commande B2B ${order.order_number}`
    });

    if (!order.purchase_created && await tableExists("purchases")) {
      const vendor = await client.query("SELECT name FROM companies WHERE id=$1", [order.vendor_company_id]);
      const purchaseNumber = `ACH-MKP-${new Date().getFullYear()}-${String(order.id).padStart(6, "0")}`;
      await client.query(
        `INSERT INTO purchases
         (company_id, supplier_company_id, supplier_name, marketplace_order_id,
          purchase_number, total_amount, amount_paid, amount_due, status,
          created_by, created_at, updated_at)
         SELECT $1,$2,$3,$4,$5,$6,$6,0,'paid',$7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
         WHERE NOT EXISTS (
           SELECT 1 FROM purchases WHERE purchase_number=$5
         )`,
        [
          order.buyer_company_id,
          order.vendor_company_id,
          vendor.rows[0]?.name || "Vendeur marketplace",
          order.id,
          purchaseNumber,
          Number(order.total_amount || 0),
          user.id || order.customer_user_id || null
        ]
      );
      await client.query(
        "UPDATE marketplace_orders SET purchase_created=true, updated_at=CURRENT_TIMESTAMP WHERE id=$1",
        [order.id]
      );
    }
  }

  await createNotification({
    user_id: order.customer_user_id,
    title: "Commande marketplace payée",
    message: `Votre commande ${order.order_number} est payée.`,
    type: "marketplace_order_paid",
    company_id: order.buyer_company_id || order.vendor_company_id,
    related_entity_type: "marketplace_order",
    related_entity_id: order.id,
    action_url: order.buyer_company_id ? `/marketplace/orders/${order.id}` : `/client/orders/${order.id}`
  });

  return { ...paidOrder.rows[0], payment: marketplacePayment };
}

app.get("/marketplace/products", async (req, res) => {
  try {
    const { q = "", vendor_company_id = "", category = "", min_price = "", max_price = "" } = req.query;
    const values = [];
    let where = "WHERE (mp.status='published' OR mp.is_published=true) AND p.is_sellable IS NOT FALSE AND p.is_active IS NOT FALSE";

    if (q) {
      values.push(`%${q}%`);
      where += ` AND (COALESCE(NULLIF(mp.public_title,''), mp.title) ILIKE $${values.length} OR p.reference ILIKE $${values.length} OR p.name ILIKE $${values.length})`;
    }
    if (vendor_company_id) {
      values.push(Number(vendor_company_id));
      where += ` AND mp.company_id=$${values.length}`;
    }
    if (category) {
      values.push(String(category));
      where += ` AND mp.category=$${values.length}`;
    }
    if (min_price) {
      values.push(Number(min_price));
      where += ` AND COALESCE(NULLIF(mp.public_price,0), mp.price, 0) >= $${values.length}`;
    }
    if (max_price) {
      values.push(Number(max_price));
      where += ` AND COALESCE(NULLIF(mp.public_price,0), mp.price, 0) <= $${values.length}`;
    }

    const result = await pool.query(
      `SELECT mp.*, COALESCE(NULLIF(mp.public_title,''), mp.title) AS title,
              COALESCE(NULLIF(mp.public_description,''), mp.description) AS description,
              COALESCE(NULLIF(mp.public_price,0), mp.price, 0) AS price,
              p.reference, p.name AS product_name, p.stock,
              LEAST(COALESCE(p.stock,0), COALESCE(mp.available_quantity, mp.available_stock, 0)) AS display_stock,
              c.name AS vendor_name
       FROM marketplace_products mp
       LEFT JOIN products p ON p.id=mp.product_id
       LEFT JOIN companies c ON c.id=mp.company_id
       ${where}
       ORDER BY mp.id DESC
       LIMIT 100`,
      values
    );
    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR MARKETPLACE PRODUCTS :", error);
    res.status(500).json({ error: "Erreur lecture produits marketplace" });
  }
});

app.get("/marketplace/products/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT mp.*, COALESCE(NULLIF(mp.public_title,''), mp.title) AS title,
              COALESCE(NULLIF(mp.public_description,''), mp.description) AS description,
              COALESCE(NULLIF(mp.public_price,0), mp.price, 0) AS price,
              LEAST(COALESCE(p.stock,0), COALESCE(mp.available_quantity, mp.available_stock, 0)) AS display_stock,
              p.reference, p.name AS product_name, p.stock, p.minimum_stock,
              p.location_code, p.warehouse, c.name AS vendor_name
       FROM marketplace_products mp
       LEFT JOIN products p ON p.id=mp.product_id
       LEFT JOIN companies c ON c.id=mp.company_id
       WHERE mp.id=$1
         AND (mp.status='published' OR mp.is_published=true)
       LIMIT 1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Produit marketplace introuvable" });
    res.json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR MARKETPLACE PRODUCT DETAIL :", error);
    res.status(500).json({ error: "Erreur détail produit marketplace" });
  }
});

app.get("/marketplace/vendors", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT c.id, c.name,
              COALESCE(mvs.store_name, c.name) AS store_name,
              mvs.store_description, mvs.logo_url,
              COUNT(mp.id)::int AS products_count
       FROM companies c
       JOIN marketplace_products mp ON mp.company_id=c.id AND (mp.status='published' OR mp.is_published=true)
       LEFT JOIN marketplace_vendor_settings mvs ON mvs.company_id=c.id
       GROUP BY c.id, c.name, mvs.store_name, mvs.store_description, mvs.logo_url
       ORDER BY store_name ASC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR MARKETPLACE VENDORS :", error);
    res.status(500).json({ error: "Erreur lecture vendeurs marketplace" });
  }
});

app.get("/marketplace/business", authenticateToken, async (req, res) => {
  try {
    const { q = "", category = "" } = req.query;
    const values = [req.user.company_id || 0];
    let where = "WHERE (mp.status='published' OR mp.is_published=true) AND mp.is_b2b=true AND p.is_sellable IS NOT FALSE AND p.is_active IS NOT FALSE";
    if (q) {
      values.push(`%${q}%`);
      where += ` AND (COALESCE(NULLIF(mp.public_title,''), mp.title) ILIKE $${values.length} OR p.reference ILIKE $${values.length} OR p.name ILIKE $${values.length})`;
    }
    if (category) {
      values.push(String(category));
      where += ` AND mp.category=$${values.length}`;
    }
    const result = await pool.query(
      `SELECT mp.*, COALESCE(NULLIF(mp.public_title,''), mp.title) AS title,
              COALESCE(NULLIF(mp.public_description,''), mp.description) AS description,
              COALESCE(NULLIF(mp.public_price,0), mp.price, 0) AS price,
              LEAST(COALESCE(p.stock,0), COALESCE(mp.available_quantity, mp.available_stock, 0)) AS display_stock,
              p.reference, p.name AS product_name, c.name AS vendor_name,
              mp.company_id AS vendor_company_id,
              (mp.company_id=$1) AS is_own_product
       FROM marketplace_products mp
       LEFT JOIN products p ON p.id=mp.product_id
       LEFT JOIN companies c ON c.id=mp.company_id
       ${where}
       ORDER BY mp.id DESC
       LIMIT 100`,
      values
    );
    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR MARKETPLACE BUSINESS :", error);
    res.status(500).json({ error: "Erreur marketplace B2B" });
  }
});

app.post("/marketplace/customers/register", async (req, res) => {
  try {
    const { fullname, email, phone, password, country = "", city = "", address = "" } = req.body || {};
    const cleanEmail = String(email || "").trim().toLowerCase();
    const cleanPhone = String(phone || "").trim();
    if (!fullname || (!cleanEmail && !cleanPhone) || !password) {
      return res.status(400).json({ error: "Nom, contact et mot de passe obligatoires." });
    }
    const storedEmail = cleanEmail || `customer-${Date.now()}-${Math.floor(Math.random() * 100000)}@pending.trianglewmspro.local`;

    const passwordHash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    const userResult = await pool.query(
      `INSERT INTO users
       (fullname, email, phone, password, role, is_active, account_status,
        verification_required, created_at)
       VALUES ($1,$2,$3,$4,'customer',true,'pending_verification',true,NOW())
       RETURNING id, fullname, email, phone, role`,
      [fullname, storedEmail, cleanPhone, passwordHash]
    );
    const user = userResult.rows[0];

    await pool.query(
      `INSERT INTO marketplace_profiles
       (user_id, profile_type, full_name, email, phone, country, city, address, status)
       VALUES ($1,'customer',$2,$3,$4,$5,$6,$7,'active')`,
      [user.id, fullname, cleanEmail, cleanPhone, country, city, address]
    );

    const targetType = cleanEmail ? "email" : "phone";
    const targetValue = cleanEmail || cleanPhone;
    const verification = await createVerificationCode({
      companyId: null,
      userId: user.id,
      targetType,
      targetValue
    });
    const delivery = await sendVerificationMessage({
      targetType,
      targetValue,
      code: verification.code,
      verifyUrl: verification.verify_url
    });

    res.status(201).json({
      success: true,
      user,
      verification: {
        required: true,
        target_type: targetType,
        target_value: targetValue,
        delivery
      }
    });
  } catch (error) {
    console.error("ERREUR MARKETPLACE CUSTOMER REGISTER :", error);
    res.status(500).json({ error: error.detail || error.message || "Erreur inscription client marketplace" });
  }
});

app.get("/marketplace/customers/profile", authenticateToken, async (req, res) => {
  try {
    if (normalizeRole(req.user?.role) !== "customer") {
      return res.status(403).json({ error: "Accès réservé aux clients Marketplace." });
    }
    const profile = await pool.query(
      `SELECT mp.*, u.fullname, u.email AS user_email, u.phone AS user_phone
       FROM marketplace_profiles mp
       LEFT JOIN users u ON u.id=mp.user_id
       WHERE mp.user_id=$1 AND mp.profile_type='customer'
       LIMIT 1`,
      [req.user.id]
    );
    res.json(profile.rows[0] || {
      user_id: req.user.id,
      full_name: req.user.fullname || "",
      email: req.user.email || "",
      phone: req.user.phone || "",
      country: "",
      city: "",
      address: ""
    });
  } catch (error) {
    console.error("ERREUR CUSTOMER PROFILE :", error);
    res.status(500).json({ error: "Erreur profil client marketplace" });
  }
});

app.put("/marketplace/customers/profile", authenticateToken, async (req, res) => {
  try {
    if (normalizeRole(req.user?.role) !== "customer") {
      return res.status(403).json({ error: "Accès réservé aux clients Marketplace." });
    }
    const { full_name = "", phone = "", email = "", country = "", city = "", address = "" } = req.body || {};
    let result = await pool.query(
      `UPDATE marketplace_profiles
       SET full_name=$2,
           email=$3,
           phone=$4,
           country=$5,
           city=$6,
           address=$7,
           updated_at=CURRENT_TIMESTAMP
       WHERE user_id=$1 AND profile_type='customer'
       RETURNING *`,
      [req.user.id, full_name, email, phone, country, city, address]
    );
    if (!result.rows[0]) {
      result = await pool.query(
        `INSERT INTO marketplace_profiles
         (user_id, profile_type, full_name, email, phone, country, city, address, status)
         VALUES ($1,'customer',$2,$3,$4,$5,$6,$7,'active')
         RETURNING *`,
        [req.user.id, full_name, email, phone, country, city, address]
      );
    }
    await pool.query(
      `UPDATE users
       SET fullname=COALESCE(NULLIF($1,''), fullname),
           phone=COALESCE(NULLIF($2,''), phone)
       WHERE id=$3`,
      [full_name, phone, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR UPDATE CUSTOMER PROFILE :", error);
    res.status(500).json({ error: error.detail || error.message || "Erreur modification profil client marketplace" });
  }
});

function canManageLaboratory(user) {
  const role = normalizeRole(user?.role);
  return isSuperAdminUser(user) || ["admin", "directeur", "direction", "laboratoire", "employe_laboratoire", "comptable"].includes(role);
}

function generateLaboratoryResultCode() {
  return `LAB-${new Date().getFullYear()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

app.get("/laboratory/settings", authenticateToken, async (req, res) => {
  try {
    if (!canManageLaboratory(req.user)) return res.status(403).json({ error: "Accès laboratoire refusé." });
    const companyId = getEffectiveCompanyId(req);
    const result = await pool.query("SELECT * FROM laboratory_settings WHERE company_id=$1 ORDER BY id DESC LIMIT 1", [companyId]);
    res.json(result.rows[0] || { company_id: companyId, lab_name: "", is_published: false, public_category: "Santé / Laboratoire" });
  } catch (error) {
    console.error("ERREUR LAB SETTINGS :", error);
    res.status(500).json({ error: "Erreur paramètres laboratoire" });
  }
});

app.put("/laboratory/settings", authenticateToken, async (req, res) => {
  try {
    if (!canManageLaboratory(req.user)) return res.status(403).json({ error: "Accès laboratoire refusé." });
    const companyId = getEffectiveCompanyId(req);
    const {
      lab_name = "", logo_url = "", phone = "", whatsapp = "", email = "",
      address = "", city = "", opening_hours = "", description = "",
      home_sampling_enabled = false, appointments_enabled = true,
      online_payment_enabled = false, is_published = false,
      public_image_url = "", public_description = ""
    } = req.body || {};
    let result = await pool.query(
      `UPDATE laboratory_settings
       SET lab_name=$2, logo_url=$3, phone=$4, whatsapp=$5, email=$6,
           address=$7, city=$8, opening_hours=$9, description=$10,
           home_sampling_enabled=$11, appointments_enabled=$12,
           online_payment_enabled=$13, is_published=$14,
           public_category='Santé / Laboratoire',
           public_image_url=$15, public_description=$16,
           updated_at=CURRENT_TIMESTAMP
       WHERE company_id=$1
       RETURNING *`,
      [
        companyId, lab_name, logo_url, phone, whatsapp, email, address, city,
        opening_hours, description, home_sampling_enabled, appointments_enabled,
        online_payment_enabled, is_published, public_image_url, public_description
      ]
    );
    if (!result.rows[0]) {
      result = await pool.query(
        `INSERT INTO laboratory_settings
         (company_id, lab_name, logo_url, phone, whatsapp, email, address, city,
          opening_hours, description, home_sampling_enabled, appointments_enabled,
          online_payment_enabled, is_published, public_category, public_image_url,
          public_description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'Santé / Laboratoire',$15,$16)
         RETURNING *`,
        [
          companyId, lab_name, logo_url, phone, whatsapp, email, address, city,
          opening_hours, description, home_sampling_enabled, appointments_enabled,
          online_payment_enabled, is_published, public_image_url, public_description
        ]
      );
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR UPDATE LAB SETTINGS :", error);
    res.status(500).json({ error: error.detail || error.message || "Erreur sauvegarde laboratoire" });
  }
});

app.get("/laboratory/analyses", authenticateToken, async (req, res) => {
  try {
    if (!canManageLaboratory(req.user)) return res.status(403).json({ error: "Accès laboratoire refusé." });
    const companyId = getEffectiveCompanyId(req);
    const result = await pool.query(
      `SELECT *
       FROM laboratory_analyses
       WHERE company_id=$1 OR company_id IS NULL
       ORDER BY is_standard DESC, name ASC`,
      [companyId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR LAB ANALYSES :", error);
    res.status(500).json({ error: "Erreur analyses laboratoire" });
  }
});

app.post("/laboratory/analyses", authenticateToken, async (req, res) => {
  try {
    if (!canManageLaboratory(req.user)) return res.status(403).json({ error: "Accès laboratoire refusé." });
    const companyId = getEffectiveCompanyId(req);
    const {
      name,
      description = "",
      price = 0,
      result_delay = "",
      estimated_duration = "",
      is_available = true,
      home_sampling_available = false,
      on_site_available = true,
      teleconsultation_available = false,
      patient_instructions = ""
    } = req.body || {};
    if (!name) return res.status(400).json({ error: "Nom analyse obligatoire." });
    const result = await pool.query(
      `INSERT INTO laboratory_analyses
       (company_id, name, description, price, result_delay, is_available,
        home_sampling_available, patient_instructions, estimated_duration,
        on_site_available, teleconsultation_available)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        companyId,
        name,
        description,
        Number(price || 0),
        result_delay,
        is_available,
        home_sampling_available,
        patient_instructions,
        estimated_duration,
        on_site_available,
        teleconsultation_available
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR CREATE LAB ANALYSIS :", error);
    res.status(500).json({ error: "Erreur création analyse" });
  }
});

app.put("/laboratory/analyses/:id", authenticateToken, async (req, res) => {
  try {
    if (!canManageLaboratory(req.user)) return res.status(403).json({ error: "Accès laboratoire refusé." });
    const companyId = getEffectiveCompanyId(req);
    const {
      name = "",
      description = "",
      price = 0,
      result_delay = "",
      estimated_duration = "",
      is_available = true,
      home_sampling_available = false,
      on_site_available = true,
      teleconsultation_available = false,
      patient_instructions = ""
    } = req.body || {};
    const result = await pool.query(
      `UPDATE laboratory_analyses
       SET name=COALESCE(NULLIF($1,''), name), description=$2, price=$3,
           result_delay=$4, is_available=$5, home_sampling_available=$6,
           patient_instructions=$7, company_id=COALESCE(company_id,$8),
           estimated_duration=$10, on_site_available=$11,
           teleconsultation_available=$12,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$9 AND (company_id=$8 OR company_id IS NULL)
       RETURNING *`,
      [
        name,
        description,
        Number(price || 0),
        result_delay,
        is_available,
        home_sampling_available,
        patient_instructions,
        companyId,
        req.params.id,
        estimated_duration,
        on_site_available,
        teleconsultation_available
      ]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Analyse introuvable." });
    res.json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR UPDATE LAB ANALYSIS :", error);
    res.status(500).json({ error: "Erreur modification analyse" });
  }
});

app.delete("/laboratory/analyses/:id", authenticateToken, async (req, res) => {
  try {
    if (!canManageLaboratory(req.user)) return res.status(403).json({ error: "Accès laboratoire refusé." });
    const companyId = getEffectiveCompanyId(req);
    const id = Number(req.params.id);

    const used = await pool.query(
      "SELECT 1 FROM laboratory_case_analyses WHERE analysis_id=$1 LIMIT 1",
      [id]
    );

    if (used.rows[0]) {
      const disabled = await pool.query(
        `UPDATE laboratory_analyses
         SET is_available=false, updated_at=CURRENT_TIMESTAMP
         WHERE id=$1 AND (company_id=$2 OR company_id IS NULL)
         RETURNING *`,
        [id, companyId]
      );
      if (!disabled.rows[0]) return res.status(404).json({ error: "Analyse introuvable." });
      return res.json({ message: "Analyse utilisée dans l’historique : elle a été désactivée.", analysis: disabled.rows[0] });
    }

    const deleted = await pool.query(
      "DELETE FROM laboratory_analyses WHERE id=$1 AND company_id=$2 RETURNING *",
      [id, companyId]
    );

    if (!deleted.rows[0]) {
      const disabled = await pool.query(
        `UPDATE laboratory_analyses
         SET is_available=false, updated_at=CURRENT_TIMESTAMP
         WHERE id=$1 AND company_id IS NULL
         RETURNING *`,
        [id]
      );
      if (!disabled.rows[0]) return res.status(404).json({ error: "Analyse introuvable." });
      return res.json({ message: "Analyse standard désactivée pour éviter de casser les références.", analysis: disabled.rows[0] });
    }

    res.json({ message: "Analyse supprimée.", analysis: deleted.rows[0] });
  } catch (error) {
    console.error("ERREUR DELETE LAB ANALYSIS :", error);
    res.status(500).json({ error: "Erreur suppression analyse" });
  }
});

app.get("/laboratory/patients", authenticateToken, async (req, res) => {
  try {
    if (!canManageLaboratory(req.user)) return res.status(403).json({ error: "Accès laboratoire refusé." });
    const result = await pool.query("SELECT * FROM laboratory_patients WHERE company_id=$1 ORDER BY id DESC LIMIT 300", [getEffectiveCompanyId(req)]);
    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR LAB PATIENTS :", error);
    res.status(500).json({ error: "Erreur patients laboratoire" });
  }
});

app.post("/laboratory/patients", authenticateToken, async (req, res) => {
  try {
    if (!canManageLaboratory(req.user)) return res.status(403).json({ error: "Accès laboratoire refusé." });
    const companyId = getEffectiveCompanyId(req);
    const { full_name, phone = "", email = "", gender = "", birth_date = null, age = null, address = "", notes = "" } = req.body || {};
    if (!full_name) return res.status(400).json({ error: "Nom patient obligatoire." });
    const result = await pool.query(
      `INSERT INTO laboratory_patients
       (company_id, full_name, phone, email, gender, birth_date, age, address, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [companyId, full_name, phone, email, gender, birth_date || null, age || null, address, notes]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR CREATE LAB PATIENT :", error);
    res.status(500).json({ error: "Erreur création patient" });
  }
});

app.get("/laboratory/appointments", authenticateToken, async (req, res) => {
  try {
    if (!canManageLaboratory(req.user)) return res.status(403).json({ error: "Accès laboratoire refusé." });
    const result = await pool.query("SELECT * FROM laboratory_appointments WHERE company_id=$1 ORDER BY id DESC LIMIT 300", [getEffectiveCompanyId(req)]);
    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR LAB APPOINTMENTS :", error);
    res.status(500).json({ error: "Erreur rendez-vous laboratoire" });
  }
});

app.post("/laboratory/appointments", authenticateToken, async (req, res) => {
  try {
    const isCustomer = normalizeRole(req.user?.role) === "customer";
    const companyId = isCustomer
      ? Number(req.body?.company_id || 0)
      : Number(req.body?.company_id || getEffectiveCompanyId(req));
    if (!companyId) {
      return res.status(400).json({ error: "Laboratoire obligatoire." });
    }
    if (isCustomer) {
      const labExists = await pool.query(
        "SELECT 1 FROM laboratory_settings WHERE company_id=$1 AND is_published=true AND is_active=true LIMIT 1",
        [companyId]
      );
      if (!labExists.rows[0]) {
        return res.status(404).json({ error: "Laboratoire public introuvable." });
      }
    }
    const {
      patient_name = req.user?.fullname || "", patient_phone = req.user?.phone || "",
      patient_email = req.user?.email || "", analysis_id = null, analysis_name = "",
      requested_date = null, requested_time = "", home_sampling = false,
      home_address = "", message = "", service_type = "sur_place"
    } = req.body || {};
    const rawAnalysisIds = Array.isArray(req.body?.analysis_ids)
      ? req.body.analysis_ids
      : analysis_id
        ? [analysis_id]
        : [];
    const analysisIds = rawAnalysisIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);

    if (analysisIds.length === 0) {
      return res.status(400).json({ error: "Veuillez choisir au moins une analyse." });
    }

    const selectedAnalyses = await pool.query(
      `SELECT id, name, price
       FROM laboratory_analyses
       WHERE company_id=$1 AND is_available=true AND id=ANY($2::int[])
       ORDER BY name ASC`,
      [companyId, analysisIds]
    );

    if (selectedAnalyses.rows.length !== analysisIds.length) {
      return res.status(400).json({ error: "Une analyse sélectionnée est indisponible pour ce laboratoire." });
    }

    const selectedNames = selectedAnalyses.rows.map((analysis) => analysis.name).join(", ");
    const totalAmount = selectedAnalyses.rows.reduce((sum, analysis) => sum + Number(analysis.price || 0), 0);
    const result = await pool.query(
      `INSERT INTO laboratory_appointments
       (company_id, client_user_id, patient_name, patient_phone, patient_email,
        analysis_id, analysis_name, requested_date, requested_time,
        home_sampling, home_address, message, status, analysis_ids,
        total_amount, service_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'En attente',$13,$14,$15)
       RETURNING *`,
      [
        companyId,
        req.user?.id || null,
        patient_name,
        patient_phone,
        patient_email,
        analysisIds[0],
        analysis_name || selectedNames,
        requested_date || null,
        requested_time,
        home_sampling || service_type === "domicile",
        home_address,
        message,
        analysisIds,
        totalAmount,
        service_type
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR CREATE LAB APPOINTMENT :", error);
    res.status(500).json({ error: "Erreur demande rendez-vous laboratoire" });
  }
});

app.put("/laboratory/appointments/:id/status", authenticateToken, async (req, res) => {
  try {
    if (!canManageLaboratory(req.user)) return res.status(403).json({ error: "Accès laboratoire refusé." });
    const companyId = getEffectiveCompanyId(req);
    const {
      status = "Confirmé",
      proposed_date = null,
      proposed_time = "",
      lab_response = "",
      laboratory_message = "",
      message = ""
    } = req.body || {};
    const normalizedStatusMap = {
      pending: "En attente",
      accepted: "Confirmé",
      confirmed: "Confirmé",
      rejected: "Refusé",
      refused: "Refusé",
      postponed: "Reporté",
      completed: "Terminé",
      "en attente": "En attente",
      confirmé: "Confirmé",
      confirmée: "Confirmé",
      refusé: "Refusé",
      refusée: "Refusé",
      reporté: "Reporté",
      reportée: "Reporté",
      terminé: "Terminé",
      terminée: "Terminé"
    };
    const normalizedStatus =
      normalizedStatusMap[String(status || "").toLowerCase()] || String(status || "Confirmé");
    const responseMessage = laboratory_message || lab_response || message || "";
    const result = await pool.query(
      `UPDATE laboratory_appointments
       SET status=$1, proposed_date=$2, proposed_time=$3, lab_response=$4,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$5 AND company_id=$6
       RETURNING *`,
      [normalizedStatus, proposed_date || null, proposed_time, responseMessage, req.params.id, companyId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Rendez-vous introuvable." });
    res.json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR UPDATE LAB APPOINTMENT :", error);
    res.status(500).json({ error: "Erreur statut rendez-vous" });
  }
});

app.get("/laboratory/cases", authenticateToken, async (req, res) => {
  try {
    if (!canManageLaboratory(req.user)) return res.status(403).json({ error: "Accès laboratoire refusé." });
    const result = await pool.query(
      `SELECT c.*, p.full_name AS patient_name, p.phone AS patient_phone
       FROM laboratory_cases c
       LEFT JOIN laboratory_patients p ON p.id=c.patient_id
       WHERE c.company_id=$1
       ORDER BY c.id DESC LIMIT 300`,
      [getEffectiveCompanyId(req)]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR LAB CASES :", error);
    res.status(500).json({ error: "Erreur dossiers laboratoire" });
  }
});

app.post("/laboratory/cases", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!canManageLaboratory(req.user)) return res.status(403).json({ error: "Accès laboratoire refusé." });
    const companyId = getEffectiveCompanyId(req);
    const { patient_id, appointment_id = null, analysis_ids = [] } = req.body || {};
    if (!patient_id) return res.status(400).json({ error: "Patient obligatoire." });
    await client.query("BEGIN");
    const selectedAnalyses = await client.query(
      `SELECT * FROM laboratory_analyses
       WHERE id = ANY($1::int[]) AND (company_id=$2 OR company_id IS NULL)`,
      [Array.isArray(analysis_ids) ? analysis_ids.map(Number) : [], companyId]
    );
    const total = selectedAnalyses.rows.reduce((sum, item) => sum + Number(item.price || 0), 0);
    const caseNumber = await nextAccountingNumber(client, "laboratory_cases", "case_number", "LABD", companyId);
    const resultCode = generateLaboratoryResultCode();
    const caseResult = await client.query(
      `INSERT INTO laboratory_cases
       (company_id, patient_id, appointment_id, case_number, result_code,
        status, total_amount, payment_status, created_by)
       VALUES ($1,$2,$3,$4,$5,'en_attente',$6,'pending',$7)
       RETURNING *`,
      [companyId, patient_id, appointment_id || null, caseNumber, resultCode, total, req.user.id]
    );
    for (const analysis of selectedAnalyses.rows) {
      await client.query(
        `INSERT INTO laboratory_case_analyses
         (case_id, analysis_id, analysis_name, price)
         VALUES ($1,$2,$3,$4)`,
        [caseResult.rows[0].id, analysis.id, analysis.name, Number(analysis.price || 0)]
      );
    }
    await client.query("COMMIT");
    res.status(201).json(caseResult.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("ERREUR CREATE LAB CASE :", error);
    res.status(500).json({ error: error.detail || error.message || "Erreur création dossier analyse" });
  } finally {
    client.release();
  }
});

app.put("/laboratory/cases/:id/result", authenticateToken, async (req, res) => {
  try {
    if (!canManageLaboratory(req.user)) return res.status(403).json({ error: "Accès laboratoire refusé." });
    const companyId = getEffectiveCompanyId(req);
    const { status = "résultat_prêt", result_summary = "", result_file_url = "", result_published = false } = req.body || {};
    const result = await pool.query(
      `UPDATE laboratory_cases
       SET status=$1, result_summary=$2, result_file_url=$3,
           result_published=$4,
           published_at=CASE WHEN $4=true THEN CURRENT_TIMESTAMP ELSE published_at END,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$5 AND company_id=$6
       RETURNING *`,
      [status, result_summary, result_file_url, result_published, req.params.id, companyId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Dossier introuvable." });
    res.json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR UPDATE LAB RESULT :", error);
    res.status(500).json({ error: "Erreur résultat laboratoire" });
  }
});

app.post("/laboratory/cases/:id/upload-result", authenticateToken, uploadLaboratoryResult.single("result"), async (req, res) => {
  try {
    if (!canManageLaboratory(req.user)) return res.status(403).json({ error: "Accès laboratoire refusé." });
    if (!req.file) return res.status(400).json({ error: "Fichier résultat obligatoire." });
    const companyId = getEffectiveCompanyId(req);
    const fileUrl = publicUploadUrl(req, `laboratory/${req.file.filename}`);
    const result = await pool.query(
      `UPDATE laboratory_cases
       SET result_file_url=$1,
           status=CASE WHEN status='en_attente' THEN 'résultat_prêt' ELSE status END,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$2 AND company_id=$3
       RETURNING *`,
      [fileUrl, req.params.id, companyId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Dossier introuvable." });
    res.json({ file_url: fileUrl, case: result.rows[0] });
  } catch (error) {
    console.error("ERREUR UPLOAD LAB RESULT :", error);
    res.status(500).json({ error: error.message || "Erreur upload résultat laboratoire" });
  }
});

app.post("/laboratory/cases/:id/email-result", authenticateToken, async (req, res) => {
  try {
    if (!canManageLaboratory(req.user)) return res.status(403).json({ error: "Accès laboratoire refusé." });
    const { recipient_email = "", message = "" } = req.body || {};
    if (!recipient_email || !String(recipient_email).includes("@")) {
      return res.status(400).json({ error: "Email destinataire invalide." });
    }
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      return res.status(503).json({ error: "SMTP non configuré. Configurez SMTP dans .env." });
    }
    const companyId = getEffectiveCompanyId(req);
    const result = await pool.query(
      `SELECT c.*, p.full_name AS patient_name, p.phone AS patient_phone,
              ls.lab_name, ls.email AS lab_email
       FROM laboratory_cases c
       LEFT JOIN laboratory_patients p ON p.id=c.patient_id
       LEFT JOIN laboratory_settings ls ON ls.company_id=c.company_id
       WHERE c.id=$1 AND c.company_id=$2`,
      [req.params.id, companyId]
    );
    const labCase = result.rows[0];
    if (!labCase) return res.status(404).json({ error: "Dossier introuvable." });
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT || 587) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
    const html = `
      <p>${escapeHtml(message || "Votre résultat laboratoire est disponible.")}</p>
      <p><strong>Laboratoire :</strong> ${escapeHtml(labCase.lab_name || "")}</p>
      <p><strong>Patient :</strong> ${escapeHtml(labCase.patient_name || "")}</p>
      <p><strong>Code résultat :</strong> ${escapeHtml(labCase.result_code || "")}</p>
      ${labCase.result_file_url ? `<p><a href="${escapeHtml(labCase.result_file_url)}">Télécharger le résultat</a></p>` : ""}
    `;
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipient_email,
      subject: `Résultat laboratoire ${labCase.case_number || ""}`,
      text: message || `Votre résultat laboratoire est disponible. Code : ${labCase.result_code}`,
      html
    });
    await logAudit(req, "email_laboratory_result", "laboratory_case", labCase.id, {
      recipient_email,
      message_id: info.messageId || ""
    });
    res.json({ message: "Résultat envoyé par email.", message_id: info.messageId || "" });
  } catch (error) {
    console.error("ERREUR EMAIL LAB RESULT :", error);
    res.status(500).json({ error: error.message || "Erreur envoi email résultat laboratoire" });
  }
});

app.get("/laboratory/payments", authenticateToken, async (req, res) => {
  try {
    if (!canManageLaboratory(req.user)) return res.status(403).json({ error: "Accès laboratoire refusé." });
    const result = await pool.query(
      `SELECT lp.*, lc.case_number, lc.result_code, p.full_name AS patient_name
       FROM laboratory_payments lp
       LEFT JOIN laboratory_cases lc ON lc.id=lp.case_id
       LEFT JOIN laboratory_patients p ON p.id=lc.patient_id
       WHERE lp.company_id=$1
       ORDER BY lp.id DESC LIMIT 300`,
      [getEffectiveCompanyId(req)]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR LAB PAYMENTS :", error);
    res.status(500).json({ error: "Erreur paiements laboratoire" });
  }
});

app.post("/laboratory/cases/:id/payments/confirm", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!canManageLaboratory(req.user)) return res.status(403).json({ error: "Accès laboratoire refusé." });
    const companyId = getEffectiveCompanyId(req);
    const { method = "Espèces", amount = null, payment_reference = "" } = req.body || {};
    await client.query("BEGIN");
    const labCase = await client.query("SELECT * FROM laboratory_cases WHERE id=$1 AND company_id=$2 FOR UPDATE", [req.params.id, companyId]);
    if (!labCase.rows[0]) throw new Error("Dossier laboratoire introuvable.");
    const paidAmount = Number(amount ?? labCase.rows[0].total_amount ?? 0);
    const payment = await client.query(
      `INSERT INTO laboratory_payments
       (company_id, case_id, amount, method, status, payment_reference,
        paid_at, created_by)
       VALUES ($1,$2,$3,$4,'paid',$5,CURRENT_TIMESTAMP,$6)
       RETURNING *`,
      [companyId, labCase.rows[0].id, paidAmount, method, payment_reference || labCase.rows[0].case_number, req.user.id]
    );
    await client.query("UPDATE laboratory_cases SET payment_status='paid', updated_at=CURRENT_TIMESTAMP WHERE id=$1", [labCase.rows[0].id]);
    const documentNumber = await nextAccountingNumber(client, "documents", "document_number", "REC-LAB", companyId);
    await client.query(
      `INSERT INTO documents
       (document_type, document_number, client_name, total_amount, observation,
        created_by, company_id, related_entity_type, related_entity_id, status)
       SELECT 'Reçu laboratoire',$1,p.full_name,$2,$3,$4,$5,'laboratory_case',$6,'Validé'
       FROM laboratory_patients p WHERE p.id=$7`,
      [
        documentNumber,
        paidAmount,
        `Paiement laboratoire ${labCase.rows[0].case_number}`,
        req.user.email || "Laboratoire",
        companyId,
        labCase.rows[0].id,
        labCase.rows[0].patient_id
      ]
    );
    await client.query("COMMIT");
    res.json({ payment: payment.rows[0], status: "paid" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("ERREUR CONFIRM LAB PAYMENT :", error);
    res.status(500).json({ error: error.detail || error.message || "Erreur paiement laboratoire" });
  } finally {
    client.release();
  }
});

app.get("/laboratory/documents", authenticateToken, async (req, res) => {
  try {
    if (!canManageLaboratory(req.user)) return res.status(403).json({ error: "Accès laboratoire refusé." });
    const result = await pool.query(
      `SELECT *
       FROM documents
       WHERE company_id=$1
         AND (related_entity_type='laboratory_case' OR document_type ILIKE '%laboratoire%')
       ORDER BY id DESC LIMIT 300`,
      [getEffectiveCompanyId(req)]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR LAB DOCUMENTS :", error);
    res.status(500).json({ error: "Erreur documents laboratoire" });
  }
});

app.get("/client/laboratory/appointments", authenticateToken, async (req, res) => {
  try {
    if (normalizeRole(req.user?.role) !== "customer") {
      return res.status(403).json({ error: "Accès réservé aux clients Marketplace." });
    }
    const result = await pool.query(
      `SELECT la.*, ls.lab_name, ls.city
       FROM laboratory_appointments la
       LEFT JOIN laboratory_settings ls ON ls.company_id=la.company_id
       WHERE la.client_user_id=$1
       ORDER BY la.id DESC LIMIT 200`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR CLIENT LAB APPOINTMENTS :", error);
    res.status(500).json({ error: "Erreur rendez-vous client laboratoire" });
  }
});

app.get("/laboratories/public", async (req, res) => {
  try {
    const { city = "", q = "" } = req.query;
    const values = [];
    let where = "WHERE ls.is_published=true AND ls.is_active=true";
    if (city) {
      values.push(`%${city}%`);
      where += ` AND ls.city ILIKE $${values.length}`;
    }
    if (q) {
      values.push(`%${q}%`);
      where += ` AND (ls.lab_name ILIKE $${values.length} OR ls.description ILIKE $${values.length} OR ls.public_description ILIKE $${values.length})`;
    }
    const result = await pool.query(
      `SELECT ls.*, c.name AS company_name
       FROM laboratory_settings ls
       LEFT JOIN companies c ON c.id=ls.company_id
       ${where}
       ORDER BY ls.updated_at DESC
       LIMIT 100`,
      values
    );
    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR PUBLIC LABS :", error);
    res.status(500).json({ error: "Erreur laboratoires publics" });
  }
});

app.get("/laboratories/public/:id", async (req, res) => {
  try {
    const lab = await pool.query("SELECT * FROM laboratory_settings WHERE id=$1 AND is_published=true AND is_active=true", [req.params.id]);
    if (!lab.rows[0]) return res.status(404).json({ error: "Laboratoire introuvable." });
    const analyses = await pool.query(
      `SELECT *
       FROM laboratory_analyses
       WHERE company_id=$1 AND is_available=true
       ORDER BY name ASC`,
      [lab.rows[0].company_id]
    );
    res.json({ laboratory: lab.rows[0], analyses: analyses.rows });
  } catch (error) {
    console.error("ERREUR PUBLIC LAB DETAIL :", error);
    res.status(500).json({ error: "Erreur détail laboratoire" });
  }
});

app.post("/laboratory/public/results/verify", async (req, res) => {
  try {
    const { result_code = "", verifier = "" } = req.body || {};
    const result = await pool.query(
      `SELECT c.*, p.full_name AS patient_name, p.phone AS patient_phone,
              p.birth_date, ls.lab_name, ls.phone AS lab_phone, ls.email AS lab_email,
              ls.address AS lab_address
       FROM laboratory_cases c
       LEFT JOIN laboratory_patients p ON p.id=c.patient_id
       LEFT JOIN laboratory_settings ls ON ls.company_id=c.company_id
       WHERE c.result_code=$1 AND c.result_published=true
       LIMIT 1`,
      [String(result_code).trim()]
    );
    const row = result.rows[0];
    const verifierText = String(verifier || "").trim().toLowerCase();
    const accepted =
      row &&
      (String(row.patient_phone || "").trim().toLowerCase() === verifierText ||
        String(row.birth_date || "").slice(0, 10).toLowerCase() === verifierText);
    await pool.query(
      `INSERT INTO laboratory_result_access_logs
       (company_id, case_id, result_code, verifier, success, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        row?.company_id || null,
        row?.id || null,
        result_code,
        verifier,
        Boolean(accepted),
        req?.headers?.["x-forwarded-for"] || req?.ip || "",
        req?.headers?.["user-agent"] || ""
      ]
    );
    if (!accepted) return res.status(403).json({ error: "Code résultat ou vérification incorrect." });
    const analyses = await pool.query("SELECT * FROM laboratory_case_analyses WHERE case_id=$1 ORDER BY id ASC", [row.id]);
    res.json({ result: row, analyses: analyses.rows });
  } catch (error) {
    console.error("ERREUR VERIFY LAB RESULT :", error);
    res.status(500).json({ error: "Erreur consultation résultat laboratoire" });
  }
});

app.get("/marketplace/cart", authenticateToken, async (req, res) => {
  try {
    res.json(await getMarketplaceCartPayload(req.user));
  } catch (error) {
    console.error("ERREUR MARKETPLACE CART :", error);
    res.status(500).json({ error: "Erreur panier marketplace" });
  }
});

app.post("/marketplace/cart/items", authenticateToken, async (req, res) => {
  try {
    const { marketplace_product_id, quantity = 1 } = req.body || {};
    const qty = Math.max(Number(quantity || 1), 1);
    const productResult = await pool.query(
      `SELECT mp.*, p.stock, p.id AS base_product_id,
              COALESCE(NULLIF(mp.public_price,0), mp.price, 0) AS effective_price,
              LEAST(COALESCE(p.stock,0), COALESCE(mp.available_quantity, mp.available_stock, 0)) AS effective_available
       FROM marketplace_products mp
       LEFT JOIN products p ON p.id=mp.product_id
       WHERE mp.id=$1
         AND (mp.status='published' OR mp.is_published=true)
       LIMIT 1`,
      [marketplace_product_id]
    );
    const product = productResult.rows[0];
    if (!product) return res.status(404).json({ error: "Produit marketplace introuvable" });
    const buyerRole = normalizeRole(req.user?.role);
    if (buyerRole !== "customer" && req.user.company_id && Number(req.user.company_id) === Number(product.company_id)) {
      return res.status(400).json({ error: "Une entreprise ne peut pas acheter ses propres produits marketplace." });
    }
    const availableStock = Number(product.effective_available || 0);
    if (availableStock < qty) {
      return res.status(400).json({ error: "Stock insuffisant pour ce produit." });
    }

    const cart = await getOrCreateMarketplaceCart(pool, req.user);
    const existing = await pool.query(
      `SELECT * FROM marketplace_cart_items
       WHERE cart_id=$1 AND marketplace_product_id=$2
       LIMIT 1`,
      [cart.id, product.id]
    );
    if (existing.rows[0]) {
      const nextQty = Number(existing.rows[0].quantity || 0) + qty;
      if (availableStock < nextQty) {
        return res.status(400).json({ error: "Stock insuffisant pour cette quantité." });
      }
      await pool.query(
        `UPDATE marketplace_cart_items
         SET quantity=$1,
             unit_price=$2,
             total_price=$1::numeric*$2::numeric,
             updated_at=CURRENT_TIMESTAMP
         WHERE id=$3`,
        [nextQty, Number(product.effective_price || 0), existing.rows[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO marketplace_cart_items
         (cart_id, marketplace_product_id, vendor_company_id, product_id,
          quantity, unit_price, total_price)
         VALUES ($1,$2,$3,$4,$5,$6,$5::numeric*$6::numeric)`,
        [cart.id, product.id, product.company_id, product.product_id, qty, Number(product.effective_price || 0)]
      );
    }

    res.status(201).json(await getMarketplaceCartPayload(req.user));
  } catch (error) {
    console.error("ERREUR MARKETPLACE CART ADD :", error);
    res.status(500).json({ error: error.detail || error.message || "Erreur ajout panier marketplace" });
  }
});

app.delete("/marketplace/cart/items/:id", authenticateToken, async (req, res) => {
  try {
    const cart = await getOrCreateMarketplaceCart(pool, req.user);
    await pool.query(
      "DELETE FROM marketplace_cart_items WHERE id=$1 AND cart_id=$2",
      [req.params.id, cart.id]
    );
    res.json(await getMarketplaceCartPayload(req.user));
  } catch (error) {
    console.error("ERREUR MARKETPLACE CART DELETE :", error);
    res.status(500).json({ error: "Erreur suppression panier marketplace" });
  }
});

app.post("/marketplace/orders", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      customer_name = req.user.fullname || req.user.email || "",
      customer_email = req.user.email || "",
      customer_phone = req.user.phone || "",
      delivery_address = "",
      delivery_method = "Retrait sur place",
      delivery_fee = 0,
      delivery_city = "",
      delivery_neighborhood = "",
      delivery_phone = "",
      delivery_note = "",
      payment_method = "Espèces",
      notes = ""
    } = req.body || {};
    const cart = await getOrCreateMarketplaceCart(client, req.user);
    const itemsResult = await client.query(
      "SELECT * FROM marketplace_cart_items WHERE cart_id=$1 ORDER BY id ASC",
      [cart.id]
    );
    if (itemsResult.rows.length === 0) return res.status(400).json({ error: "Panier vide." });

    await client.query("BEGIN");
    const groups = itemsResult.rows.reduce((acc, item) => {
      const key = String(item.vendor_company_id || 0);
      acc[key] = acc[key] || [];
      acc[key].push(item);
      return acc;
    }, {});
    const orders = [];

    for (const [vendorCompanyId, rows] of Object.entries(groups)) {
      const subtotal = rows.reduce((sum, item) => sum + Number(item.total_price || 0), 0);
      const deliveryFee = Math.max(Number(delivery_fee || 0), 0);
      const totalAmount = subtotal + deliveryFee;
      const orderNumber = await nextAccountingNumber(
        client,
        "marketplace_orders",
        "order_number",
        "MKP",
        Number(vendorCompanyId || 0)
      );
      const orderResult = await client.query(
        `INSERT INTO marketplace_orders
         (order_number, customer_user_id, buyer_user_id, buyer_company_id,
          vendor_company_id, seller_company_id,
          customer_name, customer_email, customer_phone, delivery_address,
          delivery_method, delivery_city, delivery_neighborhood, delivery_phone,
          delivery_note,
          order_type, status, payment_status, payment_method, subtotal,
          delivery_fee, total_amount, amount_paid, amount_due, notes)
         VALUES ($1,$2,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'En attente','En attente',$15,$16,$17,$18,0,$18,$19)
         RETURNING *`,
        [
          orderNumber,
          req.user.id,
          req.user.company_id || null,
          Number(vendorCompanyId || 0),
          customer_name,
          customer_email,
          customer_phone,
          delivery_address,
          delivery_method,
          delivery_city,
          delivery_neighborhood,
          delivery_phone || customer_phone,
          delivery_note,
          req.user.company_id ? "B2B" : "B2C",
          payment_method,
          subtotal,
          deliveryFee,
          totalAmount,
          notes
        ]
      );
      const order = orderResult.rows[0];
      await client.query(
        `INSERT INTO marketplace_payments
         (order_id, company_id, amount, currency, method, status,
          provider_reference, created_by)
         VALUES ($1,$2,$3,'FCFA',$4,'En attente',$5,$6)`,
        [
          order.id,
          Number(vendorCompanyId || 0),
          totalAmount,
          payment_method,
          orderNumber,
          req.user.id
        ]
      );
      for (const item of rows) {
        const product = await client.query(
          "SELECT reference, name FROM products WHERE id=$1 LIMIT 1",
          [item.product_id]
        );
        await client.query(
          `INSERT INTO marketplace_order_items
           (order_id, marketplace_product_id, vendor_company_id, product_id,
            product_reference, product_name, quantity, unit_price, total_price)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            order.id,
            item.marketplace_product_id,
            item.vendor_company_id,
            item.product_id,
            product.rows[0]?.reference || "",
            product.rows[0]?.name || "",
            item.quantity,
            item.unit_price,
            item.total_price
          ]
        );
      }
      const vendorUsers = await client.query(
        `SELECT id
         FROM users
         WHERE company_id=$1
           AND LOWER(COALESCE(role,'')) IN ('admin','super_admin','marketplace_vendor','marketplace_admin','responsable_entrepot')
         LIMIT 20`,
        [Number(vendorCompanyId || 0)]
      );
      for (const vendorUser of vendorUsers.rows) {
        await createNotification({
          user_id: vendorUser.id,
          title: "Nouvelle commande marketplace",
          message: `Commande ${order.order_number} à traiter.`,
          type: "marketplace_order_pending",
          company_id: Number(vendorCompanyId || 0),
          priority: "high",
          related_entity_type: "marketplace_order",
          related_entity_id: order.id,
          action_url: "/vendor/orders",
          created_by: req.user.id
        });
      }
      await createNotification({
        user_id: req.user.id,
        title: "Commande marketplace créée",
        message: `Votre commande ${order.order_number} a été envoyée au vendeur.`,
        type: "marketplace_order_created",
        company_id: req.user.company_id || Number(vendorCompanyId || 0),
        related_entity_type: "marketplace_order",
        related_entity_id: order.id,
        action_url: req.user.company_id ? `/marketplace/orders/${order.id}` : `/client/orders/${order.id}`,
        created_by: req.user.id
      });
      orders.push(order);
    }

    await client.query("DELETE FROM marketplace_cart_items WHERE cart_id=$1", [cart.id]);
    await client.query("UPDATE marketplace_carts SET status='ordered', updated_at=CURRENT_TIMESTAMP WHERE id=$1", [cart.id]);
    await client.query("COMMIT");
    res.status(201).json({ orders });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("ERREUR MARKETPLACE ORDER CREATE :", error);
    res.status(500).json({ error: error.detail || error.message || "Erreur création commande marketplace" });
  } finally {
    client.release();
  }
});

app.get("/marketplace/orders/my", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, c.name AS vendor_name
       FROM marketplace_orders o
       LEFT JOIN companies c ON c.id=COALESCE(o.seller_company_id, o.vendor_company_id)
       WHERE o.customer_user_id=$1
          OR ($2::int IS NOT NULL AND o.buyer_company_id=$2)
       ORDER BY o.id DESC`,
      [req.user.id, req.user.company_id || null]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR MARKETPLACE MY ORDERS :", error);
    res.status(500).json({ error: "Erreur commandes marketplace" });
  }
});

app.get("/marketplace/orders", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, c.name AS vendor_name
       FROM marketplace_orders o
       LEFT JOIN companies c ON c.id=COALESCE(o.seller_company_id, o.vendor_company_id)
       WHERE o.customer_user_id=$1
          OR o.buyer_user_id=$1
          OR ($2::int IS NOT NULL AND o.buyer_company_id=$2)
       ORDER BY o.id DESC`,
      [req.user.id, req.user.company_id || null]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR MARKETPLACE ORDERS :", error);
    res.status(500).json({ error: "Erreur commandes marketplace" });
  }
});

app.get("/marketplace/orders/:id", authenticateToken, async (req, res) => {
  try {
    const orderResult = await pool.query(
      `SELECT o.*, c.name AS vendor_name
       FROM marketplace_orders o
       LEFT JOIN companies c ON c.id=o.vendor_company_id
       WHERE o.id=$1
         AND (
           o.customer_user_id=$2
           OR o.buyer_user_id=$2
           OR COALESCE(o.seller_company_id, o.vendor_company_id)=$3
           OR o.buyer_company_id=$3
           OR $4::boolean=true
         )
       LIMIT 1`,
      [req.params.id, req.user.id, req.user.company_id || null, req.user.is_super_admin === true]
    );
    const order = orderResult.rows[0];
    if (!order) return res.status(404).json({ error: "Commande marketplace introuvable" });
    const items = await pool.query("SELECT * FROM marketplace_order_items WHERE order_id=$1 ORDER BY id ASC", [order.id]);
    const payments = await pool.query("SELECT * FROM marketplace_payments WHERE order_id=$1 ORDER BY id DESC", [order.id]);
    res.json({ order, items: items.rows, payments: payments.rows });
  } catch (error) {
    console.error("ERREUR MARKETPLACE ORDER DETAIL :", error);
    res.status(500).json({ error: "Erreur détail commande marketplace" });
  }
});

app.get("/marketplace/vendor/products", authenticateToken, async (req, res) => {
  try {
    if (!canManageMarketplaceVendor(req.user)) return res.status(403).json({ error: "Accès vendeur marketplace refusé." });
    const companyId = getEffectiveCompanyId(req);
    const result = await pool.query(
      `SELECT mp.*, COALESCE(NULLIF(mp.public_title,''), mp.title) AS title,
              COALESCE(NULLIF(mp.public_description,''), mp.description) AS description,
              COALESCE(NULLIF(mp.public_price,0), mp.price, 0) AS price,
              COALESCE(mp.published_quantity, mp.available_stock, 0) AS published_quantity,
              COALESCE(mp.available_quantity, mp.available_stock, 0) AS available_quantity,
              p.reference, p.name AS product_name, p.stock
       FROM marketplace_products mp
       LEFT JOIN products p ON p.id=mp.product_id
       WHERE mp.company_id=$1
       ORDER BY mp.id DESC`,
      [companyId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR VENDOR PRODUCTS :", error);
    res.status(500).json({ error: "Erreur produits vendeur marketplace" });
  }
});

app.post("/marketplace/vendor/products", authenticateToken, async (req, res) => {
  try {
    if (!canManageMarketplaceVendor(req.user)) return res.status(403).json({ error: "Accès vendeur marketplace refusé." });
    const companyId = getEffectiveCompanyId(req);
    const {
      product_id,
      title,
      public_title,
      description = "",
      public_description = "",
      category = "",
      price = 0,
      public_price = 0,
      published_quantity,
      available_stock,
      image_url = "",
      images = [],
      status = "published",
      is_b2b = true,
      is_b2c = true
    } = req.body || {};
    const product = await pool.query("SELECT * FROM products WHERE id=$1 AND company_id=$2", [product_id, companyId]);
    if (!product.rows[0]) return res.status(404).json({ error: "Produit source introuvable dans cette entreprise." });
    if (product.rows[0].is_sellable === false) {
      return res.status(400).json({ error: "Ce produit n’est pas marqué comme vendable." });
    }
    const sourceStock = Number(product.rows[0].stock || 0);
    const quantityToPublish = Number(published_quantity ?? available_stock ?? sourceStock);
    if (quantityToPublish <= 0 || quantityToPublish > sourceStock) {
      return res.status(400).json({ error: "La quantité publiée doit être supérieure à 0 et inférieure ou égale au stock disponible." });
    }
    const finalPrice = Number(public_price || price || product.rows[0].sale_price || product.rows[0].price || 0);
    const finalTitle = public_title || title || product.rows[0].name;
    const finalDescription = public_description || description || "";
    const finalStatus = status === "draft" || status === "brouillon" ? "draft" : "published";
    const result = await pool.query(
      `INSERT INTO marketplace_products
       (company_id, product_id, title, public_title, description, public_description,
        category, price, public_price, image_url, images, available_stock,
        published_quantity, available_quantity, sold_quantity, status,
        is_published, is_b2b, is_b2c, created_by)
       VALUES ($1,$2,$3,$3,$4,$4,$5,$6,$6,$7,$8::jsonb,$9,$9,$9,0,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        companyId,
        product_id,
        finalTitle,
        finalDescription,
        category || product.rows[0].category || "",
        finalPrice,
        image_url || product.rows[0].image_url || "",
        JSON.stringify(Array.isArray(images) ? images : []),
        quantityToPublish,
        finalStatus,
        finalStatus === "published",
        is_b2b !== false,
        is_b2c !== false,
        req.user.id
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR CREATE VENDOR PRODUCT :", error);
    res.status(500).json({ error: error.detail || error.message || "Erreur publication produit marketplace" });
  }
});

app.put("/marketplace/vendor/products/:id", authenticateToken, async (req, res) => {
  try {
    if (!canManageMarketplaceVendor(req.user)) return res.status(403).json({ error: "Accès vendeur marketplace refusé." });
    const companyId = getEffectiveCompanyId(req);
    const {
      title,
      public_title,
      description = "",
      public_description = "",
      category = "",
      price = 0,
      public_price = 0,
      published_quantity,
      available_stock,
      image_url = "",
      status = "published",
      is_b2b = true,
      is_b2c = true
    } = req.body || {};
    const existing = await pool.query(
      `SELECT mp.*, p.stock
       FROM marketplace_products mp
       LEFT JOIN products p ON p.id=mp.product_id
       WHERE mp.id=$1 AND mp.company_id=$2`,
      [req.params.id, companyId]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: "Produit marketplace introuvable" });
    const nextPublishedQuantity = Number(published_quantity ?? available_stock ?? existing.rows[0].published_quantity ?? existing.rows[0].available_stock ?? 0);
    if (nextPublishedQuantity > Number(existing.rows[0].stock || 0)) {
      return res.status(400).json({ error: "La quantité publiée dépasse le stock disponible." });
    }
    const nextAvailable = Math.max(nextPublishedQuantity - Number(existing.rows[0].sold_quantity || 0), 0);
    const finalStatus = status === "draft" || status === "brouillon" ? "draft" : "published";
    const result = await pool.query(
      `UPDATE marketplace_products
       SET title=$1, public_title=$1, description=$2, public_description=$2,
           category=$3, price=$4, public_price=$4, image_url=$5,
           published_quantity=$6, available_quantity=$7, available_stock=$7,
           status=$8, is_published=$9, is_b2b=$10, is_b2c=$11,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$12 AND company_id=$13
       RETURNING *`,
      [
        public_title || title || existing.rows[0].title,
        public_description || description,
        category,
        Number(public_price || price || 0),
        image_url,
        nextPublishedQuantity,
        nextAvailable,
        finalStatus,
        finalStatus === "published",
        is_b2b !== false,
        is_b2c !== false,
        req.params.id,
        companyId
      ]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Produit marketplace introuvable" });
    res.json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR UPDATE VENDOR PRODUCT :", error);
    res.status(500).json({ error: "Erreur modification produit marketplace" });
  }
});

app.delete("/marketplace/vendor/products/:id", authenticateToken, async (req, res) => {
  try {
    if (!canManageMarketplaceVendor(req.user)) return res.status(403).json({ error: "Accès vendeur marketplace refusé." });
    const companyId = getEffectiveCompanyId(req);
    const result = await pool.query(
      `UPDATE marketplace_products
       SET status='inactive', is_published=false, updated_at=CURRENT_TIMESTAMP
       WHERE id=$1 AND company_id=$2
       RETURNING *`,
      [req.params.id, companyId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Produit marketplace introuvable" });
    res.json({ message: "Produit marketplace désactivé.", product: result.rows[0] });
  } catch (error) {
    console.error("ERREUR DELETE VENDOR PRODUCT :", error);
    res.status(500).json({ error: "Erreur désactivation produit marketplace" });
  }
});

app.get("/marketplace/vendor/orders", authenticateToken, async (req, res) => {
  try {
    if (!canManageMarketplaceVendor(req.user)) return res.status(403).json({ error: "Accès vendeur marketplace refusé." });
    const companyId = getEffectiveCompanyId(req);
    const result = await pool.query(
      `SELECT *
       FROM marketplace_orders
       WHERE vendor_company_id=$1
       ORDER BY id DESC`,
      [companyId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error("ERREUR VENDOR ORDERS :", error);
    res.status(500).json({ error: "Erreur commandes vendeur marketplace" });
  }
});

app.put("/marketplace/vendor/orders/:id/status", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!canManageMarketplaceVendor(req.user)) return res.status(403).json({ error: "Accès vendeur marketplace refusé." });
    const companyId = getEffectiveCompanyId(req);
    const requestedStatus = normalizeMarketplaceOrderStatus(req.body?.status);
    const requestedPaymentStatus = normalizeMarketplacePaymentStatus(req.body?.payment_status);
    await client.query("BEGIN");
    const orderCheck = await client.query(
      "SELECT * FROM marketplace_orders WHERE id=$1 AND vendor_company_id=$2 FOR UPDATE",
      [req.params.id, companyId]
    );
    if (!orderCheck.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Commande marketplace introuvable" });
    }
    if (isMarketplaceClosedStatus(orderCheck.rows[0].status) && req.user.is_super_admin !== true) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Commande clôturée. Seul le super admin peut la modifier." });
    }
    let result;
    if (
      requestedPaymentStatus === "Payé" ||
      requestedStatus === "Paiement confirmé"
    ) {
      result = await finalizeMarketplaceOrder(client, req.params.id, req.user);
      if (requestedStatus && requestedStatus !== "Paiement confirmé") {
        const statusUpdate = await client.query(
          `UPDATE marketplace_orders
           SET status=$1::text,
               closed_at=CASE WHEN $1::text='Clôturée' THEN COALESCE(closed_at, CURRENT_TIMESTAMP) ELSE closed_at END,
               updated_at=CURRENT_TIMESTAMP
           WHERE id=$2
           RETURNING *`,
          [requestedStatus === "Livrée" ? "Clôturée" : requestedStatus, req.params.id]
        );
        result = { ...result, ...statusUpdate.rows[0] };
      }
    } else {
      const finalStatus = requestedStatus === "Livrée" ? "Clôturée" : requestedStatus;
      const update = await client.query(
        `UPDATE marketplace_orders
         SET status=COALESCE(NULLIF($1::text,''), status::text),
             payment_status=COALESCE(NULLIF($2::text,''), payment_status::text),
             vendor_message=COALESCE(NULLIF($3::text,''), vendor_message::text),
             closed_at=CASE WHEN $1::text='Clôturée' THEN COALESCE(closed_at, CURRENT_TIMESTAMP) ELSE closed_at END,
             updated_at=CURRENT_TIMESTAMP
         WHERE id=$4
         RETURNING *`,
        [finalStatus || "", requestedPaymentStatus || "", req.body?.vendor_message || "", req.params.id]
      );
      result = update.rows[0];
    }
    await createNotification({
      user_id: result.customer_user_id,
      title: "Statut commande marketplace",
      message: `La commande ${result.order_number} est maintenant ${result.status}.`,
      type: "marketplace_order_status",
      company_id: result.buyer_company_id || result.vendor_company_id,
      related_entity_type: "marketplace_order",
      related_entity_id: result.id,
      action_url: result.buyer_company_id ? `/marketplace/orders/${result.id}` : `/client/orders/${result.id}`,
      created_by: req.user.id
    });
    await client.query("COMMIT");
    res.json(result);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("ERREUR VENDOR ORDER STATUS :", error);
    res.status(500).json({ error: error.detail || error.message || "Erreur statut commande marketplace" });
  } finally {
    client.release();
  }
});

app.post("/marketplace/vendor/orders/:id/payments", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!canManageMarketplaceVendor(req.user)) return res.status(403).json({ error: "Accès paiement marketplace refusé." });
    const companyId = getEffectiveCompanyId(req);
    const amount = Number(req.body?.amount || 0);
    if (amount <= 0) return res.status(400).json({ error: "Montant paiement obligatoire." });

    await client.query("BEGIN");
    const orderResult = await client.query(
      `SELECT *
       FROM marketplace_orders
       WHERE id=$1 AND vendor_company_id=$2
       FOR UPDATE`,
      [req.params.id, companyId]
    );
    const order = orderResult.rows[0];
    if (!order) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Commande marketplace introuvable" });
    }
    if (isMarketplaceClosedStatus(order.status) && req.user.is_super_admin !== true) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Commande clôturée. Paiement impossible sans super admin." });
    }

    const reference =
      req.body?.provider_reference ||
      `${order.order_number}-PAY-${Date.now().toString().slice(-6)}`;
    await client.query(
      `INSERT INTO marketplace_payments
       (order_id, company_id, amount, currency, method, status,
        provider_reference, notes, paid_at, created_by)
       VALUES ($1,$2,$3,'FCFA',$4,'Payé',$5,$6,CURRENT_TIMESTAMP,$7)`,
      [
        order.id,
        companyId,
        amount,
        req.body?.method || order.payment_method || "Espèces",
        reference,
        req.body?.notes || "Paiement partiel marketplace",
        req.user.id
      ]
    );

    const updated = await refreshMarketplaceOrderPaymentState(client, order.id);
    await client.query("COMMIT");
    res.status(201).json({
      success: true,
      message: updated.amount_due <= 0 ? "Commande payée entièrement." : "Paiement partiel enregistré.",
      order: updated
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("ERREUR MARKETPLACE PARTIAL PAYMENT :", error);
    res.status(500).json({ error: error.detail || error.message || "Erreur paiement marketplace" });
  } finally {
    client.release();
  }
});

app.post("/marketplace/orders/:id/receive", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = req.user.company_id;
    if (!companyId) return res.status(403).json({ error: "Réception réservée aux comptes entreprise." });
    await client.query("BEGIN");
    const orderResult = await client.query(
      `SELECT *
       FROM marketplace_orders
       WHERE id=$1 AND buyer_company_id=$2 AND UPPER(order_type)='B2B'
       FOR UPDATE`,
      [req.params.id, companyId]
    );
    const order = orderResult.rows[0];
    if (!order) throw new Error("Commande B2B introuvable pour cette entreprise.");
    if (order.stock_entry_created === true) throw new Error("Entrée stock déjà créée pour cette commande.");
    const items = await client.query("SELECT * FROM marketplace_order_items WHERE order_id=$1", [order.id]);
    for (const item of items.rows) {
      const productRef = item.product_reference || `MKP-${item.product_id}`;
      const productName = item.product_name || "Produit marketplace";
      let product = await client.query(
        "SELECT * FROM products WHERE company_id=$1 AND reference=$2 LIMIT 1",
        [companyId, productRef]
      );
      if (!product.rows[0]) {
        product = await client.query(
          `INSERT INTO products
           (company_id, reference, name, category, stock, status, unit, sale_price, is_active)
           VALUES ($1,$2,$3,'Achat marketplace',0,'Disponible','pièce',$4,true)
           RETURNING *`,
          [companyId, productRef, productName, Number(item.unit_price || 0)]
        );
      }
      /* Même garde-fou : company_id appliqué, et emplacement exigé si le
         produit est réparti par bin. */
      await stockLocations.adjustGlobalStock(client, {
        companyId, productId: product.rows[0].id, delta: Number(item.quantity || 0),
        user: { id: req.user?.id, name: req.user?.email, role: req.user?.role },
        reason: "Réception achat marketplace", type: "Entrée",
        origin: "achat marketplace",
      });
      await client.query(
        `INSERT INTO stock_movements
         (type, product_reference, product_name, quantity, source_warehouse,
          destination_warehouse, reason, status, company_id, created_by,
          created_by_name, created_by_role, product_id, approval_status,
          original_quantity, final_quantity)
         VALUES ('Entrée',$1,$2,$3,$4,$5,$6,'Validé',$7,$8,$9,$10,$11,'Validé',$3,$3)`,
        [
          productRef,
          productName,
          Number(item.quantity || 0),
          "Marketplace",
          req.body?.destination_warehouse || "Stock acheteur",
          `Réception commande marketplace ${order.order_number}`,
          companyId,
          req.user.id,
          req.user.email || req.user.fullname || "Acheteur marketplace",
          req.user.role || "admin",
          product.rows[0].id
        ]
      );
    }
    await client.query(
      "UPDATE marketplace_orders SET stock_entry_created=true, status='received', updated_at=CURRENT_TIMESTAMP WHERE id=$1",
      [order.id]
    );
    await client.query("COMMIT");
    res.json({ success: true, message: "Entrée stock créée côté acheteur." });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("ERREUR MARKETPLACE RECEIVE :", error);
    res.status(500).json({ error: error.message || "Erreur réception marketplace" });
  } finally {
    client.release();
  }
});

app.get("/super-admin/marketplace", authenticateToken, async (req, res) => {
  try {
    if (!canAdminMarketplace(req.user)) return res.status(403).json({ error: "Accès super admin marketplace refusé." });
    const [products, orders, vendors, customers] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS total FROM marketplace_products"),
      pool.query("SELECT COUNT(*)::int AS total, COALESCE(SUM(total_amount),0)::numeric AS amount FROM marketplace_orders"),
      pool.query("SELECT COUNT(DISTINCT company_id)::int AS total FROM marketplace_products"),
      pool.query("SELECT COUNT(*)::int AS total FROM marketplace_profiles WHERE profile_type='customer'")
    ]);
    res.json({
      products: products.rows[0],
      orders: orders.rows[0],
      vendors: vendors.rows[0],
      customers: customers.rows[0]
    });
  } catch (error) {
    console.error("ERREUR SUPER ADMIN MARKETPLACE :", error);
    res.status(500).json({ error: "Erreur overview marketplace" });
  }
});

app.get("/super-admin/marketplace/orders", authenticateToken, async (req, res) => {
  try {
    if (!canAdminMarketplace(req.user)) return res.status(403).json({ error: "Accès super admin marketplace refusé." });
    const result = await pool.query("SELECT * FROM marketplace_orders ORDER BY id DESC LIMIT 200");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Erreur commandes marketplace super admin" });
  }
});

app.get("/super-admin/marketplace/vendors", authenticateToken, async (req, res) => {
  try {
    if (!canAdminMarketplace(req.user)) return res.status(403).json({ error: "Accès super admin marketplace refusé." });
    const result = await pool.query(
      `SELECT c.id, c.name, COUNT(mp.id)::int AS products_count
       FROM companies c
       LEFT JOIN marketplace_products mp ON mp.company_id=c.id
       GROUP BY c.id, c.name
       ORDER BY c.name ASC`
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Erreur vendeurs marketplace super admin" });
  }
});

app.get("/super-admin/marketplace/customers", authenticateToken, async (req, res) => {
  try {
    if (!canAdminMarketplace(req.user)) return res.status(403).json({ error: "Accès super admin marketplace refusé." });
    const result = await pool.query("SELECT * FROM marketplace_profiles WHERE profile_type='customer' ORDER BY id DESC LIMIT 200");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Erreur clients marketplace super admin" });
  }
});

/* MODULES METIERS : AUTOMOBILE / IMMOBILIER / RESTAURANT */
function canViewBusinessModule(user) {
  const role = normalizeRole(user?.role);
  return (
    user?.is_super_admin === true ||
    role === "super_admin" ||
    role === "admin" ||
    role === "directeur" ||
    role === "direction" ||
    role === "comptable" ||
    role === "caissier" ||
    role === "vendeur" ||
    role === "serveur" ||
    role === "cuisine" ||
    role === "magasinier" ||
    role === "employe" ||
    role === "employé"
  );
}

function canManageBusinessModule(user) {
  const role = normalizeRole(user?.role);
  return (
    user?.is_super_admin === true ||
    role === "super_admin" ||
    role === "admin" ||
    role === "directeur" ||
    role === "direction" ||
    role === "comptable" ||
    role === "caissier" ||
    role === "vendeur" ||
    role === "serveur" ||
    role === "cuisine"
  );
}

function getBusinessCompanyScope(req, alias = "") {
  const { companyId, shouldFilterByCompany } = getCompanyFilter(req);
  const prefix = alias ? `${alias}.` : "";
  const values = [];
  let clause = "";

  if (shouldFilterByCompany) {
    values.push(companyId);
    clause = `WHERE ${prefix}company_id=$1`;
  }

  return { companyId, shouldFilterByCompany, clause, values };
}

async function recordBusinessPayment(client, {
  companyId,
  amount,
  category,
  sourceType,
  sourceId,
  description,
  partnerName = "",
  user = {},
  documentType = "Reçu"
}) {
  const amountValue = Number(amount || 0);
  if (!companyId || amountValue <= 0) return null;

  const transactionNumber = await nextAccountingNumber(
    client,
    "accounting_transactions",
    "transaction_number",
    "METIER",
    companyId
  );

  const transaction = await client.query(
    `INSERT INTO accounting_transactions
     (company_id, transaction_number, transaction_type, source_type, source_id,
      amount, currency, direction, category, partner_name, description, status,
      source_label, destination_label, created_by, validated_by, validated_at)
     VALUES ($1,$2,'encaissement_metier',$3,$4,$5,'FCFA','entrée',$6,$7,$8,
             'validé',$9,'Trésorerie',$10,$10,CURRENT_TIMESTAMP)
     RETURNING *`,
    [
      companyId,
      transactionNumber,
      sourceType,
      sourceId,
      amountValue,
      category,
      partnerName,
      description,
      category,
      user?.id || null
    ]
  );

  const documentNumber = await nextAccountingNumber(
    client,
    "documents",
    "document_number",
    "DOC-METIER",
    companyId
  );

  await client.query(
    `INSERT INTO documents
     (document_type, document_number, client_name, total_amount, observation,
      created_by, company_id, related_entity_type, related_entity_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Validé')`,
    [
      documentType,
      documentNumber,
      partnerName,
      amountValue,
      description,
      user?.email || user?.fullname || "Triangle WMS",
      companyId,
      sourceType,
      sourceId
    ]
  );

  return transaction.rows[0];
}

app.get("/automobile/dashboard", authenticateToken, async (req, res) => {
  try {
    if (!canViewBusinessModule(req.user)) return res.status(403).json({ error: "Accès automobile refusé." });
    const { clause, values } = getBusinessCompanyScope(req);
    const vehicleFilter = clause || "";
    const rentalFilter = clause || "";
    const salesFilter = clause || "";
    const [vehicles, rentals, sales] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total,
                         COUNT(*) FILTER (WHERE statut='disponible')::int AS disponibles,
                         COUNT(*) FILTER (WHERE statut='loué' OR statut='loue')::int AS loues,
                         COUNT(*) FILTER (WHERE statut='vendu')::int AS vendus
                  FROM vehicles ${vehicleFilter}`, values),
      pool.query(`SELECT COUNT(*)::int AS total,
                         COALESCE(SUM(total_amount),0)::numeric AS total_amount,
                         COALESCE(SUM(paid_amount),0)::numeric AS paid_amount
                  FROM vehicle_rentals ${rentalFilter}`, values),
      pool.query(`SELECT COUNT(*)::int AS total,
                         COALESCE(SUM(sale_price),0)::numeric AS sale_amount,
                         COALESCE(SUM(amount_paid),0)::numeric AS paid_amount,
                         COALESCE(SUM(remaining_amount),0)::numeric AS remaining_amount
                  FROM vehicle_sales ${salesFilter}`, values)
    ]);
    res.json({ vehicles: vehicles.rows[0], rentals: rentals.rows[0], sales: sales.rows[0] });
  } catch (error) {
    console.error("ERREUR AUTOMOBILE DASHBOARD :", error);
    res.status(500).json({ error: "Erreur dashboard automobile" });
  }
});

app.get("/automobile/vehicles", authenticateToken, async (req, res) => {
  try {
    if (!canViewBusinessModule(req.user)) return res.status(403).json({ error: "Accès automobile refusé." });
    const { clause, values } = getBusinessCompanyScope(req);
    const result = await pool.query(`SELECT * FROM vehicles ${clause} ORDER BY id DESC LIMIT 200`, values);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Erreur lecture véhicules" });
  }
});

app.post("/automobile/vehicles", authenticateToken, async (req, res) => {
  try {
    if (!canManageBusinessModule(req.user)) return res.status(403).json({ error: "Accès modification automobile refusé." });
    const companyId = getEffectiveCompanyId(req);
    const {
      product_id, marque, modele, immatriculation, numero_chassis, annee,
      couleur, kilometrage, carburant, statut = "disponible",
      boite_vitesse, nombre_places, etat_vehicule,
      prix_vente, prix_location_jour, prix_location_semaine,
      prix_location_mois, disponibilite,
      is_sellable, is_rentable, publish_on_marketplace
    } = req.body || {};
    const result = await pool.query(
      `INSERT INTO vehicles
       (company_id, product_id, marque, modele, immatriculation, numero_chassis,
        annee, couleur, kilometrage, carburant, statut, prix_vente,
        prix_location_jour, prix_location_semaine, prix_location_mois,
        boite_vitesse, nombre_places, etat_vehicule, disponibilite,
        is_sellable, is_rentable, publish_on_marketplace, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       RETURNING *`,
      [
        companyId, product_id || null, marque || "", modele || "",
        immatriculation || "", numero_chassis || "", annee || null,
        couleur || "", Number(kilometrage || 0), carburant || "", statut,
        Number(prix_vente || 0), Number(prix_location_jour || 0),
        Number(prix_location_semaine || 0), Number(prix_location_mois || 0),
        boite_vitesse || "", Number(nombre_places || 0), etat_vehicule || "",
        disponibilite || statut || "disponible",
        toBooleanFlag(is_sellable, true),
        toBooleanFlag(is_rentable, false),
        toBooleanFlag(publish_on_marketplace, false),
        req.user.id
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR CREATION VEHICULE :", error);
    res.status(500).json({ error: "Erreur création véhicule" });
  }
});

app.put("/automobile/vehicles/:id", authenticateToken, async (req, res) => {
  try {
    if (!canManageBusinessModule(req.user)) return res.status(403).json({ error: "Accès modification automobile refusé." });
    const companyId = getEffectiveCompanyId(req);
    const isSuper = isSuperAdminUser(req.user);
    const fields = req.body || {};
    const result = await pool.query(
      `UPDATE vehicles SET
         marque=COALESCE($1,marque), modele=COALESCE($2,modele),
         immatriculation=COALESCE($3,immatriculation), numero_chassis=COALESCE($4,numero_chassis),
         annee=COALESCE($5,annee), couleur=COALESCE($6,couleur),
         kilometrage=COALESCE($7,kilometrage), carburant=COALESCE($8,carburant),
         statut=COALESCE($9,statut), prix_vente=COALESCE($10,prix_vente),
         prix_location_jour=COALESCE($11,prix_location_jour),
         prix_location_mois=COALESCE($12,prix_location_mois),
         updated_at=CURRENT_TIMESTAMP
       WHERE id=$13 ${isSuper && !companyId ? "" : "AND company_id=$14"}
       RETURNING *`,
      [
        fields.marque ?? null, fields.modele ?? null, fields.immatriculation ?? null,
        fields.numero_chassis ?? null, fields.annee ?? null, fields.couleur ?? null,
        fields.kilometrage ?? null, fields.carburant ?? null, fields.statut ?? null,
        fields.prix_vente ?? null, fields.prix_location_jour ?? null,
        fields.prix_location_mois ?? null, req.params.id, companyId
      ]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Véhicule introuvable" });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Erreur modification véhicule" });
  }
});

app.get("/automobile/rentals", authenticateToken, async (req, res) => {
  try {
    if (!canViewBusinessModule(req.user)) return res.status(403).json({ error: "Accès automobile refusé." });
    const { clause, values } = getBusinessCompanyScope(req, "r");
    const result = await pool.query(
      `SELECT r.*, v.marque, v.modele, v.immatriculation
       FROM vehicle_rentals r
       LEFT JOIN vehicles v ON v.id=r.vehicle_id
       ${clause}
       ORDER BY r.id DESC LIMIT 200`,
      values
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Erreur locations véhicules" });
  }
});

app.post("/automobile/rentals", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!canManageBusinessModule(req.user)) return res.status(403).json({ error: "Accès location véhicule refusé." });
    const companyId = getEffectiveCompanyId(req);
    const { vehicle_id, client_name, client_phone, start_date, end_date, price_per_day, total_amount, deposit_amount, paid_amount } = req.body || {};
    await client.query("BEGIN");
    const rental = await client.query(
      `INSERT INTO vehicle_rentals
       (company_id, vehicle_id, client_name, client_phone, start_date, end_date,
        price_per_day, total_amount, deposit_amount, paid_amount, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        companyId, vehicle_id || null, client_name || "", client_phone || "",
        start_date || null, end_date || null, Number(price_per_day || 0),
        Number(total_amount || 0), Number(deposit_amount || 0),
        Number(paid_amount || 0), Number(paid_amount || 0) > 0 ? "actif" : "en_attente",
        req.user.id
      ]
    );
    if (vehicle_id) {
      await client.query("UPDATE vehicles SET statut='loué', updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND company_id=$2", [vehicle_id, companyId]);
    }
    if (Number(paid_amount || 0) > 0) {
      await recordBusinessPayment(client, {
        companyId,
        amount: paid_amount,
        category: "Location véhicule",
        sourceType: "vehicle_rental",
        sourceId: rental.rows[0].id,
        description: `Paiement location véhicule ${rental.rows[0].id}`,
        partnerName: client_name || "",
        user: req.user,
        documentType: "Reçu location véhicule"
      });
    }
    await client.query("COMMIT");
    res.status(201).json(rental.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("ERREUR LOCATION VEHICULE :", error);
    res.status(500).json({ error: error.message || "Erreur location véhicule" });
  } finally {
    client.release();
  }
});

app.put("/automobile/rentals/:id/status", authenticateToken, async (req, res) => {
  try {
    if (!canManageBusinessModule(req.user)) return res.status(403).json({ error: "Accès location véhicule refusé." });
    const companyId = getEffectiveCompanyId(req);
    const { status } = req.body || {};
    const result = await pool.query(
      `UPDATE vehicle_rentals SET status=$1, updated_at=CURRENT_TIMESTAMP
       WHERE id=$2 AND ($3::int IS NULL OR company_id=$3)
       RETURNING *`,
      [status || "terminé", req.params.id, companyId]
    );
    if (result.rows[0]?.vehicle_id && ["terminé", "termine", "annulé", "annule"].includes(String(status || "").toLowerCase())) {
      await pool.query("UPDATE vehicles SET statut='disponible', updated_at=CURRENT_TIMESTAMP WHERE id=$1", [result.rows[0].vehicle_id]);
    }
    res.json(result.rows[0] || {});
  } catch (error) {
    res.status(500).json({ error: "Erreur statut location véhicule" });
  }
});

app.get("/automobile/sales", authenticateToken, async (req, res) => {
  try {
    if (!canViewBusinessModule(req.user)) return res.status(403).json({ error: "Accès automobile refusé." });
    const { clause, values } = getBusinessCompanyScope(req, "s");
    const result = await pool.query(
      `SELECT s.*, v.marque, v.modele, v.immatriculation
       FROM vehicle_sales s
       LEFT JOIN vehicles v ON v.id=s.vehicle_id
       ${clause}
       ORDER BY s.id DESC LIMIT 200`,
      values
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Erreur ventes véhicules" });
  }
});

app.post("/automobile/sales", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!canManageBusinessModule(req.user)) return res.status(403).json({ error: "Accès vente véhicule refusé." });
    const companyId = getEffectiveCompanyId(req);
    const { vehicle_id, client_name, client_phone, sale_price, amount_paid, payment_plan } = req.body || {};
    const remaining = Math.max(Number(sale_price || 0) - Number(amount_paid || 0), 0);
    await client.query("BEGIN");
    const sale = await client.query(
      `INSERT INTO vehicle_sales
       (company_id, vehicle_id, client_name, client_phone, sale_price,
        amount_paid, remaining_amount, payment_plan, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        companyId, vehicle_id || null, client_name || "", client_phone || "",
        Number(sale_price || 0), Number(amount_paid || 0), remaining,
        payment_plan || "comptant", remaining > 0 ? "partiel" : "payé", req.user.id
      ]
    );
    if (vehicle_id && remaining <= 0) {
      await client.query("UPDATE vehicles SET statut='vendu', updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND company_id=$2", [vehicle_id, companyId]);
    }
    if (Number(amount_paid || 0) > 0) {
      await recordBusinessPayment(client, {
        companyId,
        amount: amount_paid,
        category: "Vente véhicule",
        sourceType: "vehicle_sale",
        sourceId: sale.rows[0].id,
        description: `Paiement vente véhicule ${sale.rows[0].id}`,
        partnerName: client_name || "",
        user: req.user,
        documentType: "Reçu vente véhicule"
      });
    }
    await client.query("COMMIT");
    res.status(201).json(sale.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("ERREUR VENTE VEHICULE :", error);
    res.status(500).json({ error: error.message || "Erreur vente véhicule" });
  } finally {
    client.release();
  }
});

app.get("/immobilier/dashboard", authenticateToken, async (req, res) => {
  try {
    if (!canViewBusinessModule(req.user)) return res.status(403).json({ error: "Accès immobilier refusé." });
    const { clause, values } = getBusinessCompanyScope(req);
    const [propertiesResult, rentals, sales, reservations] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total,
                         COUNT(*) FILTER (WHERE status='disponible')::int AS disponibles,
                         COUNT(*) FILTER (WHERE status='loué' OR status='loue')::int AS loues,
                         COUNT(*) FILTER (WHERE status='vendu')::int AS vendus
                  FROM properties ${clause}`, values),
      pool.query(`SELECT COUNT(*)::int AS total, COALESCE(SUM(paid_amount),0)::numeric AS paid_amount FROM property_rentals ${clause}`, values),
      pool.query(`SELECT COUNT(*)::int AS total, COALESCE(SUM(amount_paid),0)::numeric AS paid_amount, COALESCE(SUM(remaining_amount),0)::numeric AS remaining_amount FROM property_sales ${clause}`, values),
      pool.query(`SELECT COUNT(*)::int AS total, COALESCE(SUM(paid_amount),0)::numeric AS paid_amount FROM hotel_reservations ${clause}`, values)
    ]);
    res.json({ properties: propertiesResult.rows[0], rentals: rentals.rows[0], sales: sales.rows[0], reservations: reservations.rows[0] });
  } catch (error) {
    res.status(500).json({ error: "Erreur dashboard immobilier" });
  }
});

app.get("/immobilier/properties", authenticateToken, async (req, res) => {
  try {
    if (!canViewBusinessModule(req.user)) return res.status(403).json({ error: "Accès immobilier refusé." });
    const { clause, values } = getBusinessCompanyScope(req);
    const result = await pool.query(`SELECT * FROM properties ${clause} ORDER BY id DESC LIMIT 200`, values);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Erreur lecture biens" });
  }
});

app.post("/immobilier/properties", authenticateToken, async (req, res) => {
  try {
    if (!canManageBusinessModule(req.user)) return res.status(403).json({ error: "Accès modification immobilier refusé." });
    const companyId = getEffectiveCompanyId(req);
    const {
      type, title, description, address, city, neighborhood, surface,
      rooms_count, beds_count, guests_count, price_sale, price_rent_day,
      price_rent_month, price_night, status,
      is_sellable, is_rentable, is_bookable, publish_on_marketplace
    } = req.body || {};
    const result = await pool.query(
      `INSERT INTO properties
       (company_id, type, title, description, address, city, surface,
        rooms_count, price_sale, price_rent_day, price_rent_month, status,
        neighborhood, beds_count, guests_count, price_night,
        is_sellable, is_rentable, is_bookable, publish_on_marketplace, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [
        companyId, type || "maison", title || "", description || "",
        address || "", city || "", Number(surface || 0), Number(rooms_count || 0),
        Number(price_sale || 0), Number(price_rent_day || 0),
        Number(price_rent_month || 0), status || "disponible",
        neighborhood || "", Number(beds_count || 0), Number(guests_count || 0),
        Number(price_night || 0), toBooleanFlag(is_sellable, true),
        toBooleanFlag(is_rentable, false), toBooleanFlag(is_bookable, false),
        toBooleanFlag(publish_on_marketplace, false), req.user.id
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR CREATION BIEN :", error);
    res.status(500).json({ error: "Erreur création bien immobilier" });
  }
});

app.get("/immobilier/rentals", authenticateToken, async (req, res) => {
  try {
    if (!canViewBusinessModule(req.user)) return res.status(403).json({ error: "Accès immobilier refusé." });
    const { clause, values } = getBusinessCompanyScope(req, "r");
    const result = await pool.query(
      `SELECT r.*, p.title, p.type, p.address
       FROM property_rentals r
       LEFT JOIN properties p ON p.id=r.property_id
       ${clause}
       ORDER BY r.id DESC LIMIT 200`,
      values
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Erreur locations immobilières" });
  }
});

app.post("/immobilier/rentals", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!canManageBusinessModule(req.user)) return res.status(403).json({ error: "Accès location immobilier refusé." });
    const companyId = getEffectiveCompanyId(req);
    const { property_id, client_name, client_phone, start_date, end_date, total_amount, deposit_amount, paid_amount } = req.body || {};
    await client.query("BEGIN");
    const rental = await client.query(
      `INSERT INTO property_rentals
       (company_id, property_id, client_name, client_phone, start_date, end_date,
        total_amount, deposit_amount, paid_amount, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        companyId, property_id || null, client_name || "", client_phone || "",
        start_date || null, end_date || null, Number(total_amount || 0),
        Number(deposit_amount || 0), Number(paid_amount || 0),
        Number(paid_amount || 0) > 0 ? "actif" : "en_attente", req.user.id
      ]
    );
    if (property_id) {
      await client.query("UPDATE properties SET status='loué', updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND company_id=$2", [property_id, companyId]);
    }
    if (Number(paid_amount || 0) > 0) {
      await recordBusinessPayment(client, {
        companyId,
        amount: paid_amount,
        category: "Location immobilière",
        sourceType: "property_rental",
        sourceId: rental.rows[0].id,
        description: `Paiement location immobilière ${rental.rows[0].id}`,
        partnerName: client_name || "",
        user: req.user,
        documentType: "Reçu location immobilière"
      });
    }
    await client.query("COMMIT");
    res.status(201).json(rental.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: error.message || "Erreur location immobilière" });
  } finally {
    client.release();
  }
});

app.get("/immobilier/sales", authenticateToken, async (req, res) => {
  try {
    if (!canViewBusinessModule(req.user)) return res.status(403).json({ error: "Accès immobilier refusé." });
    const { clause, values } = getBusinessCompanyScope(req, "s");
    const result = await pool.query(
      `SELECT s.*, p.title, p.type, p.address
       FROM property_sales s
       LEFT JOIN properties p ON p.id=s.property_id
       ${clause}
       ORDER BY s.id DESC LIMIT 200`,
      values
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Erreur ventes immobilières" });
  }
});

app.post("/immobilier/sales", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!canManageBusinessModule(req.user)) return res.status(403).json({ error: "Accès vente immobilier refusé." });
    const companyId = getEffectiveCompanyId(req);
    const { property_id, client_name, client_phone, sale_price, amount_paid, payment_plan } = req.body || {};
    const remaining = Math.max(Number(sale_price || 0) - Number(amount_paid || 0), 0);
    await client.query("BEGIN");
    const sale = await client.query(
      `INSERT INTO property_sales
       (company_id, property_id, client_name, client_phone, sale_price,
        amount_paid, remaining_amount, payment_plan, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        companyId, property_id || null, client_name || "", client_phone || "",
        Number(sale_price || 0), Number(amount_paid || 0), remaining,
        payment_plan || "comptant", remaining > 0 ? "partiel" : "payé", req.user.id
      ]
    );
    if (property_id && remaining <= 0) {
      await client.query("UPDATE properties SET status='vendu', updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND company_id=$2", [property_id, companyId]);
    }
    if (Number(amount_paid || 0) > 0) {
      await recordBusinessPayment(client, {
        companyId,
        amount: amount_paid,
        category: "Vente immobilière",
        sourceType: "property_sale",
        sourceId: sale.rows[0].id,
        description: `Paiement vente immobilière ${sale.rows[0].id}`,
        partnerName: client_name || "",
        user: req.user,
        documentType: "Reçu vente immobilière"
      });
    }
    await client.query("COMMIT");
    res.status(201).json(sale.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: error.message || "Erreur vente immobilière" });
  } finally {
    client.release();
  }
});

app.get("/immobilier/hotel/reservations", authenticateToken, async (req, res) => {
  try {
    if (!canViewBusinessModule(req.user)) return res.status(403).json({ error: "Accès hôtel refusé." });
    const { clause, values } = getBusinessCompanyScope(req, "r");
    const result = await pool.query(
      `SELECT r.*, p.title
       FROM hotel_reservations r
       LEFT JOIN properties p ON p.id=r.property_id
       ${clause}
       ORDER BY r.id DESC LIMIT 200`,
      values
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Erreur réservations hôtel" });
  }
});

app.post("/immobilier/hotel/reservations", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!canManageBusinessModule(req.user)) return res.status(403).json({ error: "Accès réservation hôtel refusé." });
    const companyId = getEffectiveCompanyId(req);
    const { property_id, room_number, client_name, client_phone, checkin_date, checkout_date, nights, price_per_night, total_amount, paid_amount, status } = req.body || {};
    await client.query("BEGIN");
    const reservation = await client.query(
      `INSERT INTO hotel_reservations
       (company_id, property_id, room_number, client_name, client_phone,
        checkin_date, checkout_date, nights, price_per_night, total_amount,
        paid_amount, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        companyId, property_id || null, room_number || "", client_name || "",
        client_phone || "", checkin_date || null, checkout_date || null,
        Number(nights || 1), Number(price_per_night || 0),
        Number(total_amount || 0), Number(paid_amount || 0),
        status || "confirmé", req.user.id
      ]
    );
    if (property_id) {
      await client.query("UPDATE properties SET status='réservé', updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND company_id=$2", [property_id, companyId]);
    }
    if (Number(paid_amount || 0) > 0) {
      await recordBusinessPayment(client, {
        companyId,
        amount: paid_amount,
        category: "Réservation hôtel",
        sourceType: "hotel_reservation",
        sourceId: reservation.rows[0].id,
        description: `Paiement réservation hôtel ${reservation.rows[0].id}`,
        partnerName: client_name || "",
        user: req.user,
        documentType: "Facture hôtel"
      });
    }
    await client.query("COMMIT");
    res.status(201).json(reservation.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: error.message || "Erreur réservation hôtel" });
  } finally {
    client.release();
  }
});

app.get("/restaurant/dashboard", authenticateToken, async (req, res) => {
  try {
    if (!canViewBusinessModule(req.user)) return res.status(403).json({ error: "Accès restaurant refusé." });
    const { clause, values } = getBusinessCompanyScope(req);
    const [tables, menu, orders, calls] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total,
                         COUNT(*) FILTER (WHERE status='libre')::int AS libres,
                         COUNT(*) FILTER (WHERE status='occupée' OR status='occupee')::int AS occupees
                  FROM restaurant_tables ${clause}`, values),
      pool.query(`SELECT COUNT(*)::int AS total FROM restaurant_menu_items ${clause}`, values),
      pool.query(`SELECT COUNT(*)::int AS total,
                         COALESCE(SUM(total_amount),0)::numeric AS total_amount,
                         COUNT(*) FILTER (WHERE order_status='préparation' OR order_status='preparation')::int AS preparation
                  FROM restaurant_orders ${clause}`, values),
      pool.query(`SELECT COUNT(*)::int AS total FROM restaurant_call_requests ${clause}`, values)
    ]);
    res.json({ tables: tables.rows[0], menu: menu.rows[0], orders: orders.rows[0], calls: calls.rows[0] });
  } catch (error) {
    res.status(500).json({ error: "Erreur dashboard restaurant" });
  }
});

app.get("/restaurant/tables", authenticateToken, async (req, res) => {
  try {
    if (!canViewBusinessModule(req.user)) return res.status(403).json({ error: "Accès restaurant refusé." });
    const { clause, values } = getBusinessCompanyScope(req);
    const result = await pool.query(`SELECT * FROM restaurant_tables ${clause} ORDER BY id DESC LIMIT 200`, values);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Erreur tables restaurant" });
  }
});

app.post("/restaurant/tables", authenticateToken, async (req, res) => {
  try {
    if (!canManageBusinessModule(req.user)) return res.status(403).json({ error: "Accès modification restaurant refusé." });
    const companyId = getEffectiveCompanyId(req);
    const { table_number, status = "libre" } = req.body || {};
    const result = await pool.query(
      `INSERT INTO restaurant_tables (company_id, table_number, qr_code, status, created_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [
        companyId,
        table_number || "",
        `/restaurant/public/${companyId}/table/{{id}}`,
        status,
        req.user.id
      ]
    );
    const qrCode = `/restaurant/public/${companyId}/table/${result.rows[0].id}`;
    const updated = await pool.query("UPDATE restaurant_tables SET qr_code=$1 WHERE id=$2 RETURNING *", [qrCode, result.rows[0].id]);
    res.status(201).json(updated.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Erreur création table" });
  }
});

app.get("/restaurant/menu-items", authenticateToken, async (req, res) => {
  try {
    if (!canViewBusinessModule(req.user)) return res.status(403).json({ error: "Accès restaurant refusé." });
    const { clause, values } = getBusinessCompanyScope(req);
    const result = await pool.query(`SELECT * FROM restaurant_menu_items ${clause} ORDER BY id DESC LIMIT 200`, values);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Erreur menu restaurant" });
  }
});

app.post("/restaurant/menu-items", authenticateToken, async (req, res) => {
  try {
    if (!canManageBusinessModule(req.user)) return res.status(403).json({ error: "Accès modification restaurant refusé." });
    const companyId = getEffectiveCompanyId(req);
    const { product_id, name, description, category, price, image, is_available = true, preparation_time, publish_on_marketplace } = req.body || {};
    const result = await pool.query(
      `INSERT INTO restaurant_menu_items
       (company_id, product_id, name, description, category, price, image,
        is_available, preparation_time, publish_on_marketplace, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        companyId, product_id || null, name || "", description || "",
        category || "", Number(price || 0), image || "",
        toBooleanFlag(is_available, true), Number(preparation_time || 0),
        toBooleanFlag(publish_on_marketplace, false), req.user.id
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Erreur création plat" });
  }
});

app.get("/restaurant/orders", authenticateToken, async (req, res) => {
  try {
    if (!canViewBusinessModule(req.user)) return res.status(403).json({ error: "Accès restaurant refusé." });
    const { clause, values } = getBusinessCompanyScope(req, "o");
    const result = await pool.query(
      `SELECT o.*, t.table_number
       FROM restaurant_orders o
       LEFT JOIN restaurant_tables t ON t.id=o.table_id
       ${clause}
       ORDER BY o.id DESC LIMIT 200`,
      values
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: "Erreur commandes restaurant" });
  }
});

app.post("/restaurant/orders", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!canManageBusinessModule(req.user)) return res.status(403).json({ error: "Accès commande restaurant refusé." });
    const companyId = getEffectiveCompanyId(req);
    const { table_id, customer_name, customer_phone, items = [], payment_status = "pending", order_status = "nouvelle" } = req.body || {};
    await client.query("BEGIN");
    let total = 0;
    const cleanItems = Array.isArray(items) ? items : [];
    for (const item of cleanItems) {
      total += Number(item.quantity || 1) * Number(item.unit_price || item.price || 0);
    }
    const order = await client.query(
      `INSERT INTO restaurant_orders
       (company_id, table_id, customer_name, customer_phone, total_amount,
        payment_status, order_status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [companyId, table_id || null, customer_name || "", customer_phone || "", total, payment_status, order_status, req.user.id]
    );
    for (const item of cleanItems) {
      const qty = Number(item.quantity || 1);
      const unitPrice = Number(item.unit_price || item.price || 0);
      await client.query(
        `INSERT INTO restaurant_order_items
         (order_id, menu_item_id, quantity, unit_price, total_price, notes)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [order.rows[0].id, item.menu_item_id || item.id || null, qty, unitPrice, qty * unitPrice, item.notes || ""]
      );
    }
    if (table_id) {
      await client.query("UPDATE restaurant_tables SET status='occupée', updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND company_id=$2", [table_id, companyId]);
    }
    await createNotification({
      title: "Nouvelle commande restaurant",
      message: `Commande table ${table_id || "-"} reçue.`,
      type: "restaurant_order",
      company_id: companyId,
      related_entity_type: "restaurant_order",
      related_entity_id: order.rows[0].id,
      action_url: "/restaurant/commandes",
      created_by: req.user.id
    });
    await client.query("COMMIT");
    res.status(201).json(order.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("ERREUR COMMANDE RESTAURANT :", error);
    res.status(500).json({ error: error.message || "Erreur commande restaurant" });
  } finally {
    client.release();
  }
});

app.put("/restaurant/orders/:id/status", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!canManageBusinessModule(req.user)) return res.status(403).json({ error: "Accès commande restaurant refusé." });
    const companyId = getEffectiveCompanyId(req);
    const { order_status, payment_status } = req.body || {};
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE restaurant_orders
       SET order_status=COALESCE($1,order_status),
           payment_status=COALESCE($2,payment_status),
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$3 AND company_id=$4
       RETURNING *`,
      [order_status || null, payment_status || null, req.params.id, companyId]
    );
    if (!result.rows[0]) throw new Error("Commande restaurant introuvable.");
    if (["paid", "payé", "paye"].includes(String(payment_status || "").toLowerCase())) {
      await recordBusinessPayment(client, {
        companyId,
        amount: result.rows[0].total_amount,
        category: "Restaurant",
        sourceType: "restaurant_order",
        sourceId: result.rows[0].id,
        description: `Paiement commande restaurant ${result.rows[0].id}`,
        partnerName: result.rows[0].customer_name || "",
        user: req.user,
        documentType: "Ticket restaurant"
      });
    }
    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: error.message || "Erreur statut commande restaurant" });
  } finally {
    client.release();
  }
});

app.get("/restaurant/public/:companyId/table/:tableId", async (req, res) => {
  try {
    const companyId = Number(req.params.companyId);
    const tableId = Number(req.params.tableId);
    const [table, menu] = await Promise.all([
      pool.query("SELECT id, table_number, status FROM restaurant_tables WHERE id=$1 AND company_id=$2", [tableId, companyId]),
      pool.query("SELECT id, name, description, category, price, image, preparation_time FROM restaurant_menu_items WHERE company_id=$1 AND is_available=true ORDER BY category ASC, name ASC", [companyId])
    ]);
    if (!table.rows[0]) return res.status(404).json({ error: "Table introuvable" });
    res.json({ table: table.rows[0], menu: menu.rows });
  } catch (error) {
    res.status(500).json({ error: "Erreur menu public restaurant" });
  }
});

app.post("/restaurant/public/:companyId/table/:tableId/orders", async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = Number(req.params.companyId);
    const tableId = Number(req.params.tableId);
    const { customer_name, customer_phone, items = [] } = req.body || {};
    const cleanItems = Array.isArray(items) ? items : [];
    if (cleanItems.length === 0) return res.status(400).json({ error: "Panier vide." });
    await client.query("BEGIN");
    let total = 0;
    const itemRows = [];
    for (const item of cleanItems) {
      const menuItem = await client.query(
        "SELECT * FROM restaurant_menu_items WHERE id=$1 AND company_id=$2 AND is_available=true",
        [item.menu_item_id || item.id, companyId]
      );
      if (!menuItem.rows[0]) throw new Error("Plat introuvable.");
      const qty = Number(item.quantity || 1);
      const unitPrice = Number(menuItem.rows[0].price || 0);
      total += qty * unitPrice;
      itemRows.push({ id: menuItem.rows[0].id, quantity: qty, unit_price: unitPrice, notes: item.notes || "" });
    }
    const order = await client.query(
      `INSERT INTO restaurant_orders
       (company_id, table_id, customer_name, customer_phone, total_amount,
        payment_status, order_status)
       VALUES ($1,$2,$3,$4,$5,'pending','nouvelle')
       RETURNING *`,
      [companyId, tableId, customer_name || "", customer_phone || "", total]
    );
    for (const item of itemRows) {
      await client.query(
        `INSERT INTO restaurant_order_items
         (order_id, menu_item_id, quantity, unit_price, total_price, notes)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [order.rows[0].id, item.id, item.quantity, item.unit_price, item.quantity * item.unit_price, item.notes]
      );
    }
    await client.query("UPDATE restaurant_tables SET status='occupée', updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND company_id=$2", [tableId, companyId]);
    await createNotification({
      title: "Nouvelle commande QR table",
      message: `Commande publique table ${tableId} reçue.`,
      type: "restaurant_order",
      company_id: companyId,
      related_entity_type: "restaurant_order",
      related_entity_id: order.rows[0].id,
      action_url: "/restaurant/commandes"
    });
    await client.query("COMMIT");
    res.status(201).json(order.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: error.message || "Erreur commande publique restaurant" });
  } finally {
    client.release();
  }
});

app.post("/restaurant/public/:companyId/table/:tableId/call", async (req, res) => {
  try {
    const { message = "Appel serveur" } = req.body || {};
    const result = await pool.query(
      `INSERT INTO restaurant_call_requests (company_id, table_id, message)
       VALUES ($1,$2,$3)
       RETURNING *`,
      [Number(req.params.companyId), Number(req.params.tableId), message]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: "Erreur appel serveur" });
  }
});

/* HISTORIQUE INVENTAIRE SAAS */
app.get("/inventory-history", authenticateToken, async (req, res) => {
  try {
    const { companyId, shouldFilterByCompany } = getCompanyFilter(req);

    let query = `
      SELECT * FROM inventory_history
    `;

    let values = [];

    if (shouldFilterByCompany) {
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
app.get("/locations", authenticateToken, requirePermission("stock.emplacement", "view"), async (req, res) => {
  try {
    /* Un super admin sans société active voyait ici les emplacements de TOUTES
       les entreprises : un compte FAT & MAT pouvait lire les bacs Triangle et
       l'inverse. L'entreprise administrée est désormais toujours explicite,
       et une société indéterminable refuse plutôt que de tout montrer. */
    const companyId = Number(getEffectiveCompanyIdStrict(req, req.user.company_id) || 0);
    if (!companyId) {
      return res.status(409).json({
        error: "Aucune entreprise active. Sélectionnez l'entreprise à administrer.",
        code: "NO_ACTIVE_COMPANY",
      });
    }

    const result = await pool.query(
      `SELECT
        locations.*,
        warehouses.name AS warehouse_name,
        COALESCE(locations.product_reference, products.reference, '') AS product_reference,
        COALESCE(locations.product_name, products.name, '') AS product_name
       FROM locations
       LEFT JOIN warehouses ON locations.warehouse_id = warehouses.id
       LEFT JOIN products ON locations.product_id = products.id
       WHERE locations.company_id=$1 AND locations.archived_at IS NULL
       ORDER BY locations.warehouse_code,
                COALESCE(NULLIF(locations.rayon_code,''), locations.zone),
                COALESCE(NULLIF(locations.case_code,''), locations.rayon),
                COALESCE(locations.level_rank, 8999),
                COALESCE(locations.bin_rank, 999999),
                locations.id`
      , [companyId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture emplacements" });
  }
});

app.post("/locations", authenticateToken, requirePermission("stock.emplacement", "create"), async (req, res) => {
  try {
    const {
      warehouse_id, zone, rayon, etagere, status,
      product_id, product_reference, product_name,
      rayon_code, case_code, level_code, bin_code, bin_mode, bin_group,
    } = req.body;

    /* L'entreprise vient de la SESSION, jamais du corps de la requête : elle y
       était acceptée telle quelle, ce qui permettait de poser un emplacement
       dans la société d'autrui. */
    const companyId = Number(getEffectiveCompanyIdStrict(req, req.user.company_id) || 0);
    if (!companyId) {
      return res.status(409).json({
        error: "Aucune entreprise active. Sélectionnez l'entreprise à administrer.",
        code: "NO_ACTIVE_COMPANY",
      });
    }

    /* L'entrepôt doit appartenir à cette entreprise. Sans ce filtre, un
       identifiant deviné suffisait à créer un bac chez le voisin. */
    const warehouseResult = await pool.query(
      "SELECT * FROM warehouses WHERE id=$1 AND company_id=$2",
      [warehouse_id, companyId]
    );
    const warehouse = warehouseResult.rows[0];
    if (!warehouse) return res.status(404).json({ error: "Entrepôt introuvable" });

    const composantes = {
      warehouse: String(warehouse.code || "").trim().toUpperCase(),
      row: String(rayon_code || zone || "").trim().toUpperCase(),
      shelf: String(case_code || rayon || "").trim().toUpperCase(),
      level: String(level_code || etagere || "").trim().toUpperCase(),
    };

    /* LE DÉFAUT HISTORIQUE.
       « Full Bin : Bin 1 + 2 + 3 » envoyait bin_code = "1,2,3" et cette route
       insérait UNE ligne portant ce nom. Les bacs 1, 2 et 3 n'existaient donc
       jamais : voilà pourquoi on les cherchait en vain dans les sélecteurs.
       Un code composite donne désormais AUTANT DE BACS QU'IL EN NOMME. */
    const binBrut = String(bin_code || bin_group || "").trim();
    const codes = locationHierarchy.estBinComposite(binBrut)
      ? locationHierarchy.splitCompositeBin(binBrut)
      : [binBrut.toUpperCase()].filter(Boolean);

    if (!codes.length) {
      return res.status(400).json({ error: "Code de bac obligatoire.", code: "MISSING_BIN" });
    }

    const emplacement_code = locationHierarchy.composeEmplacementCode(composantes);
    const crees = [];
    const existants = [];

    for (const code of codes) {
      const full = locationHierarchy.composeFullCode({ ...composantes, bin: code });
      const deja = await pool.query(
        `SELECT id, full_code FROM locations
          WHERE company_id=$1 AND archived_at IS NULL
            AND UPPER(COALESCE(full_code, emplacement_code, ''))=UPPER($2) LIMIT 1`,
        [companyId, full]
      );
      if (deja.rows[0]) { existants.push(deja.rows[0]); continue; }

      const qr = await QRCode.toDataURL(full);
      const result = await pool.query(
        `INSERT INTO locations
          (warehouse_id, warehouse_code, zone, rayon, etagere, emplacement_code, qr_code,
           status, product_id, product_reference, product_name,
           rayon_code, case_code, level_code, bin_code, bin_mode, bin_group, company_id,
           full_code, is_active, occupancy_status, level_rank, bin_rank)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,TRUE,'EMPTY',$20,$21)
        RETURNING *`,
        [
          warehouse.id, warehouse.code,
          composantes.row, composantes.shelf, composantes.level,
          emplacement_code, qr, status || "Disponible",
          product_id || null, product_reference || "", product_name || "",
          composantes.row, composantes.shelf, composantes.level,
          code, "single", bin_group || "", companyId, full,
          locationHierarchy.levelRank(composantes.level),
          locationHierarchy.binRank(code),
        ]
      );
      crees.push(result.rows[0]);

      await pool.query(
        `INSERT INTO location_audit_log
           (company_id, location_id, action, scope, new_value, reason,
            quantity_before, quantity_after, changed_by, changed_by_name)
         VALUES ($1,$2,'CREATE','BIN',$3,$4,0,0,$5,$6)`,
        [companyId, result.rows[0].id, full,
         codes.length > 1 ? `Bac issu du code composite « ${binBrut} »` : "Création",
         req.user?.id || null, req.user?.fullname || req.user?.email || ""]
      );
    }

    await logActivity(
      req.user?.fullname || "Administrateur",
      req.user?.role || "admin",
      "Création emplacement",
      "Emplacements",
      `${crees.length} bac(s) créé(s) sous ${emplacement_code}`
    );

    /* Le corps garde la forme attendue par l'ancien écran — un emplacement —
       tout en exposant la liste complète pour les appelants qui la lisent. */
    res.status(crees.length ? 201 : 200).json({
      ...(crees[0] || existants[0] || {}),
      crees, existants,
      bins_crees: crees.length,
      bins_existants: existants.length,
      stockImpact: 0,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur ajout emplacement" });
  }
});

/**
 * ARCHIVAGE D'UN EMPLACEMENT — la route s'appelle encore DELETE, elle ne
 * supprime plus.
 *
 * Elle exécutait un `DELETE FROM locations`, sans permission et sans vérifier
 * ce que le bac contenait. Pour un produit dont la répartition n'est pas
 * encore établie, aucune balance ne s'y oppose : la ligne partait, et avec
 * elle la seule trace de l'endroit où la marchandise était rangée.
 *
 * Un emplacement se retire de la vue ; il ne se détruit pas. Son id, son
 * historique et ses mouvements restent — c'est ce qui permet de relire un bon
 * d'il y a deux ans sans tomber sur un emplacement introuvable.
 */
app.delete("/locations/:id", authenticateToken, requirePermission("stock.emplacement", "archive"), async (req, res) => {
  const client = await pool.connect();
  try {
    const companyId = Number(getEffectiveCompanyIdStrict(req, req.user.company_id) || 0);
    if (!companyId) {
      return res.status(409).json({
        error: "Aucune entreprise active. Sélectionnez l'entreprise à administrer.",
        code: "NO_ACTIVE_COMPANY",
      });
    }

    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT l.id, l.full_code, l.emplacement_code,
              COALESCE((SELECT SUM(b.quantity) FROM stock_location_balances b
                         WHERE b.location_id = l.id AND b.company_id = l.company_id), 0)::numeric AS quantite
         FROM locations l
        WHERE l.id=$1 AND l.company_id=$2 FOR UPDATE OF l`,
      [Number(req.params.id) || 0, companyId]
    );
    const bac = rows[0];
    if (!bac) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Emplacement introuvable." });
    }

    /* Un bac occupé ne s'archive pas : on le viderait de l'écran sans vider
       l'étagère, et le stock deviendrait introuvable. */
    const quantite = Number(bac.quantite);
    if (quantite > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: `Cet emplacement contient encore ${quantite} unité(s). ` +
               `Transférez-les vers un autre bac avant de l'archiver.`,
        code: "LOCATION_NOT_EMPTY",
        quantite,
      });
    }

    await client.query(
      `UPDATE locations SET archived_at = now(), archived_by = $2, is_active = FALSE,
              occupancy_status = 'INACTIVE', updated_at = now()
        WHERE id=$1 AND company_id=$3`,
      [bac.id, req.user?.id || null, companyId]
    );
    await client.query(
      `INSERT INTO location_audit_log
         (company_id, location_id, action, scope, old_value, new_value, reason,
          quantity_before, quantity_after, changed_by, changed_by_name)
       VALUES ($1,$2,'ARCHIVE','BIN',$3,$3,$4,0,0,$5,$6)`,
      [companyId, bac.id, bac.full_code || bac.emplacement_code,
       String(req.body?.reason || ""), req.user?.id || null,
       req.user?.fullname || req.user?.email || ""]
    );
    await client.query("COMMIT");

    await logActivity(
      req.user?.fullname || "Administrateur",
      req.user?.role || "admin",
      "Archivage emplacement",
      "Emplacements",
      `Emplacement archivé : ${bac.full_code || bac.emplacement_code || bac.id}`
    );

    res.json({
      message: "Emplacement archivé",
      archived: true,
      id: bac.id,
      code: bac.full_code || bac.emplacement_code,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(error);
    res.status(500).json({ error: "Erreur archivage emplacement" });
  } finally {
    client.release();
  }
});

app.get("/scan/resolve/:code", authenticateToken, async (req, res) => {
  try {
    /* L'entreprise vient de la session. Un super admin lisait ici les
       emplacements de TOUTES les sociétés : un code Triangle résolu depuis un
       compte FAT & MAT, et réciproquement. */
    const companyId = Number(getEffectiveCompanyIdStrict(req, req.user.company_id) || 0);
    if (!companyId) {
      return res.status(409).json({
        error: "Aucune entreprise active. Sélectionnez l'entreprise avant de scanner.",
        code: "NO_ACTIVE_COMPANY",
      });
    }
    let code = decodeURIComponent(req.params.code || "").trim();

    try {
      const parsedUrl = new URL(code);
      const productMatch = parsedUrl.pathname.match(/\/scan\/product\/([^/]+)/);
      code = parsedUrl.searchParams.get("location") || (productMatch ? productMatch[1] : code);
      code = decodeURIComponent(code);
    } catch {}

    code = code.replace(/^Ref\s+/i, "").trim();
    const normalizedCode = normalizeProductLookupCode(code);

    /* Code courant, code historique, PUIS ancien code d'avant renommage.
       Une étiquette déjà collée survit ainsi à la réorganisation du rayon,
       et la réponse dit qu'elle est périmée plutôt que de le taire. */
    let resolution = null;
    try {
      resolution = await locationHierarchy.resoudreEtiquette(pool, companyId, code);
    } catch (e) {
      if (e.code === "AMBIGUOUS_CODE") {
        return res.status(409).json({ error: e.message, code: e.code, details: e.details });
      }
      throw e;
    }

    if (resolution) {
      const location = resolution.location;

      const productsResult = await pool.query(
        `SELECT *
         FROM products
         WHERE (
           location_id=$1
           OR location_code=$2
           OR reference=$3
         )
         AND company_id=$4
         ORDER BY id DESC`,
        [
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
         AND company_id=$4
         ORDER BY id DESC
         LIMIT 20`,
        [
              location.emplacement_code,
              `%${location.emplacement_code}%`,
              productsResult.rows.map((product) => product.reference),
              companyId
            ]
      );

      return res.json({
        type: "location",
        code,
        /* Ce que porte l'étiquette scannée, et ce que porte le bac aujourd'hui.
           Les deux, toujours : c'est leur écart qui dit s'il faut réimprimer. */
        code_scanne: resolution.code_scanne,
        code_actuel: resolution.code_actuel,
        ancien_code_utilise: resolution.ancien_code_utilise,
        ancienne_etiquette: resolution.ancienne_etiquette,
        resolu_par: resolution.via,
        archive: resolution.archive,
        avertissement: resolution.avertissement,
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

    const productValues = [code, normalizedCode, companyId];
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
       AND products.company_id=$3
       LIMIT 1`,
      productValues
    );

    if (productResult.rows.length > 0) {
      const product = productResult.rows[0];
      const batchesResult = await pool.query(
        `SELECT *
         FROM product_batches
         WHERE product_id=$1
         AND company_id=$2
         ORDER BY expiration_date ASC NULLS LAST, received_at ASC NULLS LAST, id ASC
         LIMIT 20`,
        [product.id, companyId]
      );
      const movementsResult = await pool.query(
        `SELECT *
         FROM stock_movements
         WHERE product_reference=$1
         AND company_id=$2
         ORDER BY id DESC
         LIMIT 20`,
        [product.reference, companyId]
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
       AND company_id=$2
       LIMIT 1`,
      /* Cette requête partageait le tableau `values` de la recherche
         d'emplacement, disparu avec elle. Ses paramètres sont désormais les
         siens : le code scanné, et l'entreprise de la session. */
      [code, companyId]
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
app.get("/activities", authenticateToken, async (req, res) => {
  try {
    const companyId = getEffectiveCompanyId(req);
    const isSuperAdmin = req.user.is_super_admin === true;
    const hasCompanyColumn = await columnExists("user_activities", "company_id");
    const shouldFilterByCompany = hasCompanyColumn && (!isSuperAdmin || Boolean(companyId));
    const result = await pool.query(
      `SELECT * FROM user_activities
       ${shouldFilterByCompany ? "WHERE company_id=$1" : ""}
       ORDER BY id DESC`,
      shouldFilterByCompany ? [companyId] : []
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

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "");
}

function searchableColumn(column) {
  return `(
    COALESCE(${column}::text,'') ILIKE $1
    OR regexp_replace(
      translate(lower(COALESCE(${column}::text,'')),
        'àáâãäåèéêëìíîïòóôõöùúûüçñ',
        'aaaaaaeeeeiiiiooooouuuucn'
      ),
      '\\s+', '', 'g'
    ) LIKE $2
  )`;
}

async function handleGlobalSearch(req, res) {
  try {
    const q = req.query.q;

    if (!q || String(q).trim() === "") {
      return res.json({
        products: [],
        stockMovements: [],
        movements: [],
        inventories: [],
        documents: [],
        sales: [],
        receipts: [],
        partners: [],
        users: [],
        locations: [],
        totals: {
          products: 0,
          stockMovements: 0,
          movements: 0,
          inventories: 0,
          documents: 0,
          sales: 0,
          receipts: 0,
          partners: 0,
          users: 0,
          locations: 0
        }
      });
    }

    const search = `%${String(q).trim()}%`;
    const compactSearch = `%${normalizeSearchText(q)}%`;
    const companyId = req.user?.company_id || null;
    const isSuperAdmin = req.user?.is_super_admin === true || normalizeRole(req.user?.role) === "super_admin";
    const values = [search, compactSearch];
    const companyValues = isSuperAdmin ? values : [...values, companyId];
    const productCompanyClause = isSuperAdmin ? "" : "AND products.company_id=$3";
    const movementCompanyClause = isSuperAdmin ? "" : "AND company_id=$3";
    const inventoryCompanyClause = isSuperAdmin ? "" : "AND company_id=$3";
    const documentCompanyClause = isSuperAdmin ? "" : "AND company_id=$3";
    const locationCompanyClause = isSuperAdmin ? "" : "AND locations.company_id=$3";
    const salesCompanyClause = isSuperAdmin ? "" : "AND s.company_id=$3";
    const receiptsCompanyClause = isSuperAdmin ? "" : "AND r.company_id=$3";
    const partnersCompanyClause = isSuperAdmin ? "" : "AND company_id=$3";

    const products = await pool.query(
      `SELECT products.*, locations.emplacement_code
       FROM products
       LEFT JOIN locations ON products.location_id = locations.id
       WHERE (
          ${searchableColumn("products.reference")}
          OR ${searchableColumn("products.name")}
          OR ${searchableColumn("products.category")}
          OR ${searchableColumn("products.warehouse")}
          OR ${searchableColumn("products.location_code")}
          OR ${searchableColumn("products.barcode")}
          OR ${searchableColumn("products.sku")}
          OR ${searchableColumn("products.qr_code")}
          OR ${searchableColumn("locations.emplacement_code")}
       )
       ${productCompanyClause}
       ORDER BY products.id DESC`,
      companyValues
    );

    const stockMovements = await pool.query(
      `SELECT *
       FROM stock_movements
       WHERE (
          ${searchableColumn("product_reference")}
          OR ${searchableColumn("product_name")}
          OR ${searchableColumn("type")}
          OR ${searchableColumn("source_warehouse")}
          OR ${searchableColumn("destination_warehouse")}
          OR ${searchableColumn("reason")}
          OR ${searchableColumn("status")}
          OR ${searchableColumn("created_by_name")}
          OR ${searchableColumn("location_code")}
       )
       ${movementCompanyClause}
       ORDER BY id DESC`,
      companyValues
    );

    const inventories = await pool.query(
      `SELECT *
       FROM inventory_history
       WHERE (
          ${searchableColumn("product_reference")}
          OR ${searchableColumn("product_name")}
          OR ${searchableColumn("warehouse")}
          OR ${searchableColumn("location_code")}
          OR ${searchableColumn("user_name")}
          OR ${searchableColumn("status")}
          OR ${searchableColumn("observation")}
       )
       ${inventoryCompanyClause}
       ORDER BY id DESC`,
      companyValues
    );

    const documents = canAccessDirectionModule(req.user)
      ? await pool.query(
          `SELECT *
           FROM documents
           WHERE (
              ${searchableColumn("document_type")}
              OR ${searchableColumn("document_number")}
              OR ${searchableColumn("client_name")}
              OR ${searchableColumn("client_phone")}
              OR ${searchableColumn("client_address")}
              OR ${searchableColumn("observation")}
              OR ${searchableColumn("created_by")}
           )
           ${documentCompanyClause}
           ORDER BY id DESC`,
          companyValues
        )
      : { rows: [] };

    const locations = await pool.query(
      `SELECT locations.*, warehouses.name AS warehouse_name
       FROM locations
       LEFT JOIN warehouses ON locations.warehouse_id = warehouses.id
       WHERE (
          ${searchableColumn("locations.emplacement_code")}
          OR ${searchableColumn("locations.warehouse_code")}
          OR ${searchableColumn("locations.zone")}
          OR ${searchableColumn("locations.rayon")}
          OR ${searchableColumn("locations.etagere")}
          OR ${searchableColumn("locations.rayon_code")}
          OR ${searchableColumn("locations.case_code")}
          OR ${searchableColumn("locations.level_code")}
          OR ${searchableColumn("locations.bin_code")}
          OR ${searchableColumn("locations.product_reference")}
          OR ${searchableColumn("locations.product_name")}
          OR ${searchableColumn("warehouses.name")}
       )
       ${locationCompanyClause}
       ORDER BY locations.id DESC`,
      companyValues
    );

    const sales = await pool.query(
      `SELECT s.*
       FROM sales s
       LEFT JOIN sale_items si ON si.sale_id=s.id
       WHERE (
          ${searchableColumn("s.sale_number")}
          OR ${searchableColumn("s.customer_name")}
          OR ${searchableColumn("s.customer_phone")}
          OR ${searchableColumn("s.payment_method")}
          OR ${searchableColumn("s.payment_status")}
          OR ${searchableColumn("s.status")}
          OR ${searchableColumn("s.created_by_name")}
          OR ${searchableColumn("si.product_reference")}
          OR ${searchableColumn("si.product_name")}
          OR ${searchableColumn("si.barcode")}
          OR ${searchableColumn("si.lot_number")}
       )
       ${salesCompanyClause}
       GROUP BY s.id
       ORDER BY s.id DESC`,
      companyValues
    );

    const receipts = await pool.query(
      `SELECT r.*
       FROM receipts r
       WHERE (
          ${searchableColumn("r.receipt_number")}
          OR ${searchableColumn("r.payment_method")}
          OR ${searchableColumn("r.payment_status")}
          OR ${searchableColumn("r.status")}
          OR ${searchableColumn("r.receipt_data")}
       )
       ${receiptsCompanyClause}
       ORDER BY r.id DESC`,
      companyValues
    );

    const partners = await pool.query(
      `SELECT *
       FROM partners
       WHERE (
          ${searchableColumn("type")}
          OR ${searchableColumn("name")}
          OR ${searchableColumn("phone")}
          OR ${searchableColumn("email")}
          OR ${searchableColumn("address")}
          OR ${searchableColumn("city")}
          OR ${searchableColumn("contact_person")}
          OR ${searchableColumn("nif")}
          OR ${searchableColumn("rccm")}
       )
       ${partnersCompanyClause}
       ORDER BY id DESC`,
      companyValues
    );

    const users = canAccessAdminSettings(req.user)
      ? await pool.query(
          `SELECT id, fullname, email, role, company_id, warehouse_id, is_active, created_at
           FROM users
           WHERE (
              ${searchableColumn("fullname")}
              OR ${searchableColumn("email")}
              OR ${searchableColumn("role")}
              OR ${searchableColumn("badge_code")}
           )
           ${isSuperAdmin ? "" : "AND company_id=$3"}
           ORDER BY id DESC`,
          companyValues
        )
      : { rows: [] };

    res.json({
      products: products.rows,
      stockMovements: stockMovements.rows,
      movements: stockMovements.rows,
      inventories: inventories.rows,
      documents: documents.rows,
      sales: sales.rows,
      receipts: receipts.rows,
      partners: partners.rows,
      users: users.rows,
      locations: locations.rows,
      totals: {
        products: products.rows.length,
        stockMovements: stockMovements.rows.length,
        movements: stockMovements.rows.length,
        inventories: inventories.rows.length,
        documents: documents.rows.length,
        sales: sales.rows.length,
        receipts: receipts.rows.length,
        partners: partners.rows.length,
        users: users.rows.length,
        locations: locations.rows.length
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur recherche globale"
    });
  }
}

/* RECHERCHE GLOBALE INTELLIGENTE */
app.get("/global-search", authenticateToken, handleGlobalSearch);
app.get("/search", authenticateToken, handleGlobalSearch);

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
app.get("/attendance/schedule-groups", authenticateToken, async (req, res) => {
  try {
    const isSuperAdmin = req.user.is_super_admin === true;
    const result = await pool.query(
      `SELECT *
       FROM schedule_groups
       ${isSuperAdmin ? "" : "WHERE company_id=$1"}
       ORDER BY id ASC`,
      isSuperAdmin ? [] : [req.user.company_id]
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
    const isSuperAdmin = req.user.is_super_admin === true;
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
      ${isSuperAdmin ? "" : "WHERE u.company_id=$1"}
      ORDER BY u.fullname ASC
    `, isSuperAdmin ? [] : [req.user.company_id]);

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
    const { companyId, shouldFilterByCompany } = getCompanyFilter(req);

    let query = `
      SELECT ar.*, u.fullname, u.email, u.role, u.profile_image_url
      FROM attendance_records ar
      LEFT JOIN users u ON ar.user_id = u.id
      WHERE ar.work_date = CURRENT_DATE
    `;

    let values = [];

    if (shouldFilterByCompany) {
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
    const isSuperAdmin = req.user.is_super_admin === true;

    const targetUserResult = await pool.query(
      `SELECT id, company_id
       FROM users
       WHERE id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}
       LIMIT 1`,
      isSuperAdmin ? [requestedUserId] : [requestedUserId, req.user.company_id]
    );

    if (!targetUserResult.rows[0]) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    if (
      requestedUserId !== Number(req.user.id) &&
      !isSuperAdmin &&
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

app.post("/attendance/legacy/check", authenticateToken, async (req, res) => {
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

    const isSuperAdmin = req.user.is_super_admin === true;
    const targetUserResult = await pool.query(
      `SELECT id, company_id
       FROM users
       WHERE id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}
       LIMIT 1`,
      isSuperAdmin ? [user_id] : [user_id, req.user.company_id]
    );

    if (!targetUserResult.rows[0]) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
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
app.get(
  "/attendance/settings/schedule-groups",
  authenticateToken,
  authorizeRoles("admin", "super_admin"),
  async (req, res) => {
  try {
    const isSuperAdmin = req.user.is_super_admin === true;
    const result = await pool.query(
      `SELECT *
       FROM schedule_groups
       ${isSuperAdmin ? "" : "WHERE company_id=$1"}
       ORDER BY id ASC`,
      isSuperAdmin ? [] : [req.user.company_id]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture groupes horaires" });
  }
});

app.post(
  "/attendance/settings/schedule-groups",
  authenticateToken,
  authorizeRoles("admin", "super_admin"),
  async (req, res) => {
  try {
    const { name, start_time, end_time, break_start, break_end } = req.body;
    const companyId = req.user.is_super_admin === true
      ? req.body.company_id || req.user.company_id || null
      : req.user.company_id;

    const result = await pool.query(
      `INSERT INTO schedule_groups
      (name, start_time, end_time, break_start, break_end, company_id)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *`,
      [name, start_time, end_time, break_start || null, break_end || null, companyId]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur création groupe horaire" });
  }
});

app.put(
  "/attendance/settings/schedule-groups/:id",
  authenticateToken,
  authorizeRoles("admin", "super_admin"),
  async (req, res) => {
  try {
    const { id } = req.params;
    const { name, start_time, end_time, break_start, break_end } = req.body;
    const isSuperAdmin = req.user.is_super_admin === true;

    const result = await pool.query(
      `UPDATE schedule_groups
       SET name=$1,
           start_time=$2,
           end_time=$3,
           break_start=$4,
           break_end=$5
       WHERE id=$6 ${isSuperAdmin ? "" : "AND company_id=$7"}
       RETURNING *`,
      isSuperAdmin
        ? [name, start_time, end_time, break_start || null, break_end || null, id]
        : [name, start_time, end_time, break_start || null, break_end || null, id, req.user.company_id]
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

    const isSuperAdmin = req.user.is_super_admin === true;

    const targetUserResult = await pool.query(
      `SELECT id, company_id
       FROM users
       WHERE id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}
       LIMIT 1`,
      isSuperAdmin ? [id] : [id, req.user.company_id]
    );

    if (!targetUserResult.rows[0]) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    const targetCompanyId = targetUserResult.rows[0].company_id;

    const groupResult = await pool.query(
      `SELECT *
       FROM schedule_groups
       WHERE id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}
       LIMIT 1`,
      isSuperAdmin
        ? [schedule_group_id || null]
        : [schedule_group_id || null, targetCompanyId]
    );

    const group = groupResult.rows[0] || null;

    if (schedule_group_id && !group) {
      return res.status(404).json({ error: "Groupe horaire introuvable pour cette entreprise" });
    }

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
    const companyId =
      req.user.is_super_admin === true && req.headers["x-company-id"]
        ? Number(req.headers["x-company-id"])
        : req.user.company_id || null;
    const result = await pool.query(
      `INSERT INTO attendance_gps_settings
       (company_id, gps_required, site_name, allowed_radius_meters,
        allow_remote_attendance, kiosk_mode, employee_scanner_access,
        allow_out_of_zone_global)
       VALUES ($1, false, '', 100, false, true, false, false)
       ON CONFLICT (company_id)
       DO UPDATE SET company_id=EXCLUDED.company_id
       RETURNING *`,
      [companyId]
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
      const companyId =
        req.user.is_super_admin === true && req.headers["x-company-id"]
          ? Number(req.headers["x-company-id"])
          : req.user.company_id || null;
      const {
        gps_required,
        site_name,
        site_latitude,
        site_longitude,
        allowed_radius_meters,
        allow_remote_attendance,
        allow_out_of_zone_global,
        kiosk_mode,
        employee_scanner_access
      } = req.body;

      const result = await pool.query(
        `INSERT INTO attendance_gps_settings
         (company_id, gps_required, site_name, site_latitude, site_longitude,
          allowed_radius_meters, allow_remote_attendance, allow_out_of_zone_global,
          kiosk_mode, employee_scanner_access, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (company_id)
         DO UPDATE SET
           gps_required=EXCLUDED.gps_required,
           site_name=EXCLUDED.site_name,
           site_latitude=EXCLUDED.site_latitude,
           site_longitude=EXCLUDED.site_longitude,
           allowed_radius_meters=EXCLUDED.allowed_radius_meters,
           allow_remote_attendance=EXCLUDED.allow_remote_attendance,
           allow_out_of_zone_global=EXCLUDED.allow_out_of_zone_global,
           kiosk_mode=EXCLUDED.kiosk_mode,
           employee_scanner_access=EXCLUDED.employee_scanner_access,
           updated_by=EXCLUDED.updated_by,
           updated_at=CURRENT_TIMESTAMP
         RETURNING *`,
        [
          companyId,
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
          allow_out_of_zone_global === true,
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

app.get("/attendance-sites", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id || null;
    const isManager = canManageAttendanceSites(req.user);

    if (isManager) {
      const result = await pool.query(
        `SELECT *
         FROM attendance_sites
         WHERE ($1::int IS NULL OR company_id=$1 OR $2::boolean=true)
         ORDER BY actif DESC, nom_du_site ASC`,
        [companyId, req.user.is_super_admin === true]
      );
      return res.json(result.rows);
    }

    const sites = await getAllowedAttendanceSitesForUser(req.user);
    res.json(sites);
  } catch (error) {
    console.error("ERREUR ATTENDANCE SITES :", error);
    res.status(500).json({ error: "Erreur lecture sites de pointage" });
  }
});

app.post("/attendance-sites", authenticateToken, async (req, res) => {
  try {
    if (!canManageAttendanceSites(req.user)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const {
      nom_du_site,
      latitude,
      longitude,
      rayon_autorise_metre = 100,
      actif = true,
      company_id
    } = req.body;

    if (!nom_du_site || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: "Nom, latitude et longitude sont obligatoires." });
    }

    const companyId = req.user.is_super_admin === true
      ? company_id || req.user.company_id || null
      : req.user.company_id;

    const result = await pool.query(
      `INSERT INTO attendance_sites
       (company_id, nom_du_site, latitude, longitude, rayon_autorise_metre, actif)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        companyId,
        nom_du_site,
        Number(latitude),
        Number(longitude),
        Number(rayon_autorise_metre || 100),
        actif !== false
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR CREATION SITE POINTAGE :", error);
    res.status(500).json({ error: "Erreur création site de pointage" });
  }
});

app.put("/attendance-sites/:id", authenticateToken, async (req, res) => {
  try {
    if (!canManageAttendanceSites(req.user)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const companyId = req.user.company_id || null;
    const isSuperAdmin = req.user.is_super_admin === true;
    const {
      nom_du_site,
      latitude,
      longitude,
      rayon_autorise_metre,
      actif
    } = req.body;

    const result = await pool.query(
      `UPDATE attendance_sites
       SET nom_du_site=$1,
           latitude=$2,
           longitude=$3,
           rayon_autorise_metre=$4,
           actif=$5,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$6 ${isSuperAdmin ? "" : "AND company_id=$7"}
       RETURNING *`,
      isSuperAdmin
        ? [
            nom_du_site || "",
            Number(latitude),
            Number(longitude),
            Number(rayon_autorise_metre || 100),
            actif !== false,
            req.params.id
          ]
        : [
            nom_du_site || "",
            Number(latitude),
            Number(longitude),
            Number(rayon_autorise_metre || 100),
            actif !== false,
            req.params.id,
            companyId
          ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Site de pointage introuvable." });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR UPDATE SITE POINTAGE :", error);
    res.status(500).json({ error: "Erreur modification site de pointage" });
  }
});

app.delete("/attendance-sites/:id", authenticateToken, async (req, res) => {
  try {
    if (!canManageAttendanceSites(req.user)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const companyId = req.user.company_id || null;
    const isSuperAdmin = req.user.is_super_admin === true;
    const result = await pool.query(
      `UPDATE attendance_sites
       SET actif=false, updated_at=CURRENT_TIMESTAMP
       WHERE id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}
       RETURNING *`,
      isSuperAdmin ? [req.params.id] : [req.params.id, companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Site de pointage introuvable." });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("ERREUR DELETE SITE POINTAGE :", error);
    res.status(500).json({ error: "Erreur désactivation site de pointage" });
  }
});

app.get("/employees/:id/attendance-sites", authenticateToken, async (req, res) => {
  try {
    if (!canManageAttendanceSites(req.user) && String(req.user.id) !== String(req.params.id)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const userResult = await pool.query(
      `SELECT id, company_id, primary_attendance_site_id, employee_mobile, allow_out_of_zone
       FROM users
       WHERE id=$1 ${req.user.is_super_admin === true ? "" : "AND company_id=$2"}`,
      req.user.is_super_admin === true ? [req.params.id] : [req.params.id, req.user.company_id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "Employé introuvable." });
    }

    const sitesResult = await pool.query(
      `SELECT s.*
       FROM attendance_sites s
       INNER JOIN employee_attendance_sites eas ON eas.attendance_site_id=s.id
       WHERE eas.user_id=$1
       ORDER BY s.nom_du_site ASC`,
      [req.params.id]
    );

    res.json({
      user: userResult.rows[0],
      sites: sitesResult.rows
    });
  } catch (error) {
    console.error("ERREUR EMPLOYEE SITES :", error);
    res.status(500).json({ error: "Erreur lecture affectations sites" });
  }
});

app.put("/employees/:id/attendance-sites", authenticateToken, async (req, res) => {
  const client = await pool.connect();

  try {
    if (!canManageAttendanceSites(req.user)) {
      return res.status(403).json({ error: "Accès refusé." });
    }

    const { site_ids = [], primary_attendance_site_id = null, employee_mobile = false, allow_out_of_zone = false } = req.body;
    const companyId = req.user.company_id || null;
    const isSuperAdmin = req.user.is_super_admin === true;

    await client.query("BEGIN");

    const userResult = await client.query(
      `SELECT * FROM users WHERE id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"} FOR UPDATE`,
      isSuperAdmin ? [req.params.id] : [req.params.id, companyId]
    );

    if (userResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Employé introuvable." });
    }

    const user = userResult.rows[0];
    const cleanSiteIds = Array.isArray(site_ids)
      ? [...new Set(site_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id)))]
      : [];

    await client.query("DELETE FROM employee_attendance_sites WHERE user_id=$1", [user.id]);

    for (const siteId of cleanSiteIds) {
      const siteResult = await client.query(
        `SELECT id, company_id
         FROM attendance_sites
         WHERE id=$1 AND actif=true ${isSuperAdmin ? "" : "AND company_id=$2"}
         LIMIT 1`,
        isSuperAdmin ? [siteId] : [siteId, user.company_id]
      );
      if (siteResult.rows.length === 0) continue;

      await client.query(
        `INSERT INTO employee_attendance_sites
         (user_id, attendance_site_id, company_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (user_id, attendance_site_id) DO NOTHING`,
        [user.id, siteId, user.company_id]
      );
    }

    const primarySiteId = primary_attendance_site_id
      ? Number(primary_attendance_site_id)
      : cleanSiteIds[0] || null;

    await client.query(
      `UPDATE users
       SET primary_attendance_site_id=$1,
           employee_mobile=$2,
           allow_out_of_zone=$3
       WHERE id=$4`,
      [primarySiteId, employee_mobile === true, allow_out_of_zone === true, user.id]
    );

    await client.query(
      `INSERT INTO attendance_settings
       (user_id, primary_attendance_site_id, employee_mobile, allow_out_of_zone)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id)
       DO UPDATE SET
         primary_attendance_site_id=EXCLUDED.primary_attendance_site_id,
         employee_mobile=EXCLUDED.employee_mobile,
         allow_out_of_zone=EXCLUDED.allow_out_of_zone,
         updated_at=CURRENT_TIMESTAMP`,
      [user.id, primarySiteId, employee_mobile === true, allow_out_of_zone === true]
    );

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("ERREUR SAVE EMPLOYEE SITES :", error);
    res.status(500).json({ error: "Erreur sauvegarde affectations sites" });
  } finally {
    client.release();
  }
});

/* LISTE GROUPES HORAIRES */
app.get("/attendance/groups", authenticateToken, authorizeRoles("admin", "super_admin"), async (req, res) => {
  try {
    const isSuperAdmin = req.user.is_super_admin === true;
    const result = await pool.query(
      `SELECT *
       FROM schedule_groups
       ${isSuperAdmin ? "" : "WHERE company_id=$1"}
       ORDER BY id ASC`,
      isSuperAdmin ? [] : [req.user.company_id]
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
app.post("/attendance/groups", authenticateToken, authorizeRoles("admin", "super_admin"), async (req, res) => {
  try {
    const { name, start_time, end_time, break_start, break_end } = req.body;
    const companyId = req.user.is_super_admin === true
      ? req.body.company_id || req.user.company_id || null
      : req.user.company_id;

    const result = await pool.query(
      `INSERT INTO schedule_groups
      (
        name,
        start_time,
        end_time,
        break_start,
        break_end,
        company_id
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *`,
      [name, start_time, end_time, break_start, break_end, companyId]
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
app.put("/attendance/groups/:id", authenticateToken, authorizeRoles("admin", "super_admin"), async (req, res) => {
  try {
    const { id } = req.params;

    const { name, start_time, end_time, break_start, break_end } = req.body;
    const isSuperAdmin = req.user.is_super_admin === true;

    const result = await pool.query(
      `UPDATE schedule_groups
       SET
         name=$1,
         start_time=$2,
         end_time=$3,
         break_start=$4,
         break_end=$5
       WHERE id=$6 ${isSuperAdmin ? "" : "AND company_id=$7"}
       RETURNING *`,
      isSuperAdmin
        ? [name, start_time, end_time, break_start, break_end, id]
        : [name, start_time, end_time, break_start, break_end, id, req.user.company_id]
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
app.delete("/attendance/groups/:id", authenticateToken, authorizeRoles("admin", "super_admin"), async (req, res) => {
  try {
    const isSuperAdmin = req.user.is_super_admin === true;
    await pool.query(
      `DELETE FROM schedule_groups
       WHERE id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}`,
      isSuperAdmin ? [req.params.id] : [req.params.id, req.user.company_id]
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

const DEFAULT_AI_MODULE_KNOWLEDGE = [
  {
    module_key: "dashboard",
    module_name: "Tableau de bord",
    description:
      "Vue centrale de pilotage avec les indicateurs produits, stocks, mouvements, ventes, alertes et activité récente.",
    role_explanation:
      "Le tableau de bord sert à comprendre rapidement l'état global de l'entreprise et à détecter les priorités.",
    available_actions: ["consulter indicateurs", "voir alertes", "voir mouvements récents", "actualiser données"],
    pages: ["/dashboard"],
    permissions: ["super_admin", "admin", "direction", "responsable_entrepot", "magasinier", "client"],
    data_sources: ["products", "warehouses", "locations", "stock_movements", "inventory_history", "sales", "user_activities"],
    examples: ["Combien de produits ai-je ?", "Quel est le stock total ?", "Quelles sont les alertes importantes ?"]
  },
  {
    module_key: "stock",
    module_name: "Stocks & mouvements",
    description:
      "Module de suivi des quantités, entrées, sorties, transferts, inventaires et validations de mouvements.",
    role_explanation:
      "Il permet de contrôler les flux physiques de marchandises et de garder une traçabilité complète.",
    available_actions: ["entrée stock", "sortie stock", "transfert", "inventaire", "validation", "refus"],
    pages: ["/stocks", "/inventaires", "/scanner"],
    permissions: ["super_admin", "admin", "responsable_entrepot", "magasinier"],
    data_sources: ["products", "stock_movements", "inventory_history", "locations", "warehouses"],
    examples: ["Quel est le dernier mouvement ?", "Quels produits sont en rupture ?", "Explique-moi un transfert stock"]
  },
  {
    module_key: "products",
    module_name: "Produits",
    description:
      "Gestion des fiches produits, références, prix, images, QR codes, codes-barres, lots et stock minimum.",
    role_explanation:
      "Ce module centralise l'identité des articles utilisés par le WMS, le POS et les rapports.",
    available_actions: ["créer produit", "modifier produit", "consulter produit", "générer QR", "imprimer étiquette"],
    pages: ["/produits", "/pos/produits", "/scan/product/[code]"],
    permissions: ["super_admin", "admin", "responsable_entrepot", "magasinier", "direction", "client"],
    data_sources: ["products", "product_batches", "product_price_history", "locations"],
    examples: ["Montre-moi les produits", "Quel produit a le stock faible ?", "Explique-moi les lots"]
  },
  {
    module_key: "pos",
    module_name: "POS / Caisse",
    description:
      "Point de vente pour scanner les produits, créer des ventes, encaisser, imprimer les reçus et déduire le stock.",
    role_explanation:
      "Le POS transforme les produits en ventes payées, crée les paiements, reçus et mouvements de stock associés.",
    available_actions: ["vendre", "scanner produit", "encaisser", "imprimer reçu", "annuler vente", "consulter historique"],
    pages: ["/pos", "/pos/historique", "/pos/ventes", "/pos/paiements", "/pos/recus", "/pos/caisses"],
    permissions: ["super_admin", "admin", "caissier", "direction"],
    data_sources: ["sales", "sale_items", "payments", "receipts", "caisses", "products"],
    examples: ["Montre-moi les ventes d'aujourd'hui", "Explique-moi les paiements POS", "Quel est le total vendu ?"]
  },
  {
    module_key: "accounting",
    module_name: "Comptabilité & Trésorerie",
    description:
      "Module permettant de gérer les banques, caisses, mouvements financiers, bons, demandes de décaissement, salaires, états financiers et rapports comptables.",
    role_explanation:
      "Ce module sert à suivre les entrées et sorties d'argent, contrôler la trésorerie, gérer les dépenses, suivre les paiements et produire des états financiers.",
    available_actions: ["afficher banques", "afficher caisses", "afficher mouvements", "créer bon", "valider demande", "consulter états", "générer rapport comptable"],
    pages: ["/comptabilite", "/comptabilite/banques", "/comptabilite/tresorerie", "/comptabilite/demandes", "/comptabilite/etats"],
    permissions: ["super_admin", "admin", "direction", "comptable"],
    data_sources: ["accounting_banks", "caisses", "accounting_transactions", "cash_vouchers", "expense_requests", "treasury_accounts", "journal_entries", "journal_entry_lines"],
    examples: ["C'est quoi la comptabilité ?", "Combien j'ai dans les banques ?", "Quels sont les mouvements comptables ?"]
  },
  {
    module_key: "attendance",
    module_name: "Pointage QR & RH",
    description:
      "Module de pointage par badge QR avec horaires, pauses, historique, règles GPS, sites de pointage et calculs RH.",
    role_explanation:
      "Il sert à contrôler la présence, les retards, les pauses et les affectations horaires des employés.",
    available_actions: ["scanner badge", "début travail", "début pause", "fin pause", "fin travail", "consulter historique"],
    pages: ["/attendance-scan", "/pointage", "/parametres-pointage"],
    permissions: ["super_admin", "admin", "responsable_entrepot", "employe", "magasinier"],
    data_sources: ["attendance_records", "attendance_settings", "attendance_sites", "users"],
    examples: ["Explique-moi le pointage GPS", "Quels employés sont présents ?", "C'est quoi un site de pointage ?"]
  },
  {
    module_key: "documents_reports",
    module_name: "Documents & Rapports",
    description:
      "Centralise les documents, reçus, bons, rapports de stock, ventes, inventaires, pointage et comptabilité.",
    role_explanation:
      "Il sert à imprimer, télécharger, consulter et tracer les pièces importantes de l'entreprise.",
    available_actions: ["voir document", "imprimer", "exporter PDF", "filtrer rapport", "envoyer par email si configuré"],
    pages: ["/documents", "/rapports", "/pos/recus"],
    permissions: ["super_admin", "admin", "direction"],
    data_sources: ["documents", "receipts", "sales", "stock_movements", "inventory_history", "accounting_transactions"],
    examples: ["Quels documents récents ?", "Explique-moi les rapports", "Où voir les reçus ?"]
  },
  {
    module_key: "partners",
    module_name: "Partenaires, clients & fournisseurs",
    description:
      "Gestion des partenaires avec ventes, achats, paiements, documents liés, solde client et dette fournisseur.",
    role_explanation:
      "Ce module relie les clients et fournisseurs aux opérations commerciales, documents et soldes.",
    available_actions: ["consulter fiche", "voir historique ventes", "voir paiements", "désactiver partenaire"],
    pages: ["/partenaires"],
    permissions: ["super_admin", "admin", "direction", "commercial"],
    data_sources: ["partners", "sales", "documents", "receipts", "accounting_transactions"],
    examples: ["Explique-moi les partenaires", "Quel est le solde client ?", "Quels documents sont liés ?"]
  },
  {
    module_key: "users_permissions",
    module_name: "Utilisateurs, rôles & permissions",
    description:
      "Gestion des comptes, rôles, permissions, modules activés et restrictions par entreprise.",
    role_explanation:
      "Ce module protège l'accès au logiciel et adapte les menus/actions au rôle de chaque utilisateur.",
    available_actions: ["créer utilisateur", "modifier rôle", "désactiver utilisateur", "contrôler permissions"],
    pages: ["/utilisateurs", "/super-admin", "/parametres"],
    permissions: ["super_admin", "admin"],
    data_sources: ["users", "companies", "module_settings", "audit_logs"],
    examples: ["Explique-moi les rôles", "Qui peut voir les rapports ?", "Quels modules sont activés ?"]
  }
];

function normalizeAssistantText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function matchDefaultModuleKnowledge(message) {
  const text = normalizeAssistantText(message);
  const matches = [];

  for (const module of DEFAULT_AI_MODULE_KNOWLEDGE) {
    const haystack = normalizeAssistantText(
      [
        module.module_key,
        module.module_name,
        module.description,
        module.role_explanation,
        ...(module.available_actions || []),
        ...(module.pages || []),
        ...(module.data_sources || []),
        ...(module.examples || [])
      ].join(" ")
    );

    if (
      text.includes(normalizeAssistantText(module.module_name)) ||
      text.includes(normalizeAssistantText(module.module_key)) ||
      haystack
        .split(/\s+/)
        .filter((word) => word.length >= 5)
        .some((word) => text.includes(word))
    ) {
      matches.push(module);
    }
  }

  if (matches.length > 0) return matches.slice(0, 5);

  if (/module|expli|c.est quoi|sert a quoi|comment/.test(text)) {
    return DEFAULT_AI_MODULE_KNOWLEDGE.slice(0, 5);
  }

  return [];
}

async function getAssistantModuleKnowledge(message) {
  const fallback = matchDefaultModuleKnowledge(message);
  const search = `%${String(message || "").trim()}%`;

  try {
    const hasActiveColumn = await columnExists("ai_module_knowledge", "active");
    const hasIsActiveColumn = await columnExists("ai_module_knowledge", "is_active");
    const activeFilter = hasActiveColumn
      ? "active=true AND"
      : hasIsActiveColumn
        ? "is_active=true AND"
        : "";
    const result = await pool.query(
      `SELECT module_key, module_name, description, role_explanation,
              available_actions, pages, permissions, data_sources, examples
       FROM ai_module_knowledge
       WHERE ${activeFilter}
         (
           module_key ILIKE $1 OR module_name ILIKE $1
           OR description ILIKE $1 OR role_explanation ILIKE $1
         )
       ORDER BY module_name ASC
       LIMIT 8`,
      [search]
    );

    if (result.rows.length > 0) return result.rows;
  } catch (error) {
    return fallback;
  }

  return fallback;
}

function chooseAssistantTools(message) {
  const text = String(message || "").toLowerCase();
  const tools = new Set();

  tools.add("get_module_knowledge");

  if (/produit|products?/.test(text)) tools.add("get_products");
  if (/stock|reste|rupture|faible/.test(text)) tools.add("get_stock");
  if (/mouvement|entrée|sortie|transfert|dernier/.test(text)) tools.add("get_last_movement");
  if (/vente|caisse|pos|vendu|aujourd/.test(text)) tools.add("get_sales_today");
  if (/compta|comptabilit|banque|trésorerie|tresorerie|décaissement|decaissement|encaissement|bilan|grand livre|journal|état financier|etat financier/.test(text)) {
    tools.add("get_accounting_summary");
  }
  if (/alerte|rupture|faible/.test(text)) tools.add("get_alerts");
  if (/utilisateur|employé|user|personnel/.test(text)) tools.add("get_users");
  if (/inventaire/.test(text)) tools.add("get_inventory");
  if (/document|reçu|bon|rapport/.test(text)) tools.add("get_documents");
  if (/entrepôt|entrepot|warehouse/.test(text)) tools.add("get_warehouses");
  if (/emplacement|location|rayon|bin/.test(text)) tools.add("get_locations");
  if (/marketplace|catalogue|commande|vendeur|acheteur|client final|b2b|b2c/.test(text)) {
    tools.add("get_marketplace_summary");
  }
  if (/automobile|voiture|vehicule|véhicule|garage|parking|location voiture/.test(text)) {
    tools.add("get_automobile_summary");
  }
  if (/immobilier|maison|terrain|appartement|villa|hotel|hôtel|chambre|reservation|réservation/.test(text)) {
    tools.add("get_real_estate_summary");
  }
  if (/restaurant|table|menu|plat|cuisine|serveur|commande restaurant/.test(text)) {
    tools.add("get_restaurant_summary");
  }

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

  if (toolName === "get_module_knowledge") {
    return [];
  }

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

  if (toolName === "get_accounting_summary") {
    const banks = await pool.query(
      `SELECT id, bank_name, account_number, currency, current_balance, is_active
       FROM accounting_banks ${where}
       ORDER BY id DESC
       LIMIT 30`,
      values
    );
    const treasury = await pool.query(
      `SELECT COALESCE(SUM(current_balance),0)::numeric AS total_treasury
       FROM treasury_accounts ${where}`,
      values
    );
    const caisses = await pool.query(
      `SELECT id, nom_caisse, code_caisse, statut, solde_actuel
       FROM caisses ${where}
       ORDER BY id DESC
       LIMIT 30`,
      values
    );
    const movements = await pool.query(
      `SELECT id, transaction_number, transaction_type, amount, source_label,
              destination_label, status, created_at
       FROM accounting_transactions ${where}
       ORDER BY created_at DESC NULLS LAST, id DESC
       LIMIT 10`,
      values
    );

    const totalBanks = banks.rows.reduce(
      (sum, bank) => sum + Number(bank.current_balance || 0),
      0
    );
    const totalCaisses = caisses.rows.reduce(
      (sum, caisse) => sum + Number(caisse.solde_actuel || 0),
      0
    );

    return {
      summary: {
        banks_count: banks.rows.length,
        total_banks: totalBanks,
        total_treasury: Number(treasury.rows[0]?.total_treasury || 0),
        cash_registers_count: caisses.rows.length,
        total_cash_registers: totalCaisses
      },
      banks: banks.rows,
      cash_registers: caisses.rows,
      recent_movements: movements.rows
    };
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

  if (toolName === "get_marketplace_summary") {
    const scopeValues = [];
    const companyScope = assistantScope(user, scopeValues);
    const productWhere = companyScope ? `WHERE ${companyScope.replaceAll("company_id", "mp.company_id")}` : "";
    const orderWhere = companyScope ? `WHERE ${companyScope.replaceAll("company_id", "o.vendor_company_id")}` : "";

    const products = await pool.query(
      `SELECT COUNT(*)::int AS total_products,
              COUNT(*) FILTER (WHERE status='published')::int AS published_products
       FROM marketplace_products mp ${productWhere}`,
      scopeValues
    );
    const orders = await pool.query(
      `SELECT COUNT(*)::int AS total_orders,
              COALESCE(SUM(total_amount),0)::numeric AS total_amount,
              COUNT(*) FILTER (WHERE payment_status='paid')::int AS paid_orders,
              COUNT(*) FILTER (WHERE UPPER(order_type)='B2B')::int AS b2b_orders,
              COUNT(*) FILTER (WHERE UPPER(order_type)='B2C')::int AS b2c_orders,
              COUNT(*) FILTER (WHERE status IN ('pending','pending_payment') OR payment_status='pending')::int AS pending_orders
       FROM marketplace_orders o ${orderWhere}`,
      scopeValues
    );
    const recentOrders = await pool.query(
      `SELECT id, order_number, customer_name, total_amount, payment_status,
              status, created_at
       FROM marketplace_orders o ${orderWhere}
       ORDER BY created_at DESC NULLS LAST, id DESC
       LIMIT 10`,
      scopeValues
    );

    return {
      products: products.rows[0],
      orders: orders.rows[0],
      recent_orders: recentOrders.rows
    };
  }

  if (toolName === "get_automobile_summary") {
    const vehicles = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE statut='disponible')::int AS disponibles,
              COUNT(*) FILTER (WHERE statut='loué' OR statut='loue')::int AS loues,
              COUNT(*) FILTER (WHERE statut='vendu')::int AS vendus
       FROM vehicles ${where}`,
      values
    );
    const rentals = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(paid_amount),0)::numeric AS paid_amount,
              COUNT(*) FILTER (WHERE end_date < CURRENT_DATE AND status NOT IN ('terminé','termine','annulé','annule'))::int AS retards
       FROM vehicle_rentals ${where}`,
      values
    );
    const sales = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(amount_paid),0)::numeric AS paid_amount,
              COALESCE(SUM(remaining_amount),0)::numeric AS remaining_amount
       FROM vehicle_sales ${where}`,
      values
    );
    return { vehicles: vehicles.rows[0], rentals: rentals.rows[0], sales: sales.rows[0] };
  }

  if (toolName === "get_real_estate_summary") {
    const propertiesResult = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='disponible')::int AS disponibles,
              COUNT(*) FILTER (WHERE status='loué' OR status='loue')::int AS loues,
              COUNT(*) FILTER (WHERE status='vendu')::int AS vendus
       FROM properties ${where}`,
      values
    );
    const reservations = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='occupé' OR status='occupe')::int AS occupees,
              COALESCE(SUM(paid_amount),0)::numeric AS paid_amount
       FROM hotel_reservations ${where}`,
      values
    );
    const sales = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(amount_paid),0)::numeric AS paid_amount,
              COALESCE(SUM(remaining_amount),0)::numeric AS remaining_amount
       FROM property_sales ${where}`,
      values
    );
    return { properties: propertiesResult.rows[0], reservations: reservations.rows[0], sales: sales.rows[0] };
  }

  if (toolName === "get_restaurant_summary") {
    const tables = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status='libre')::int AS libres,
              COUNT(*) FILTER (WHERE status='occupée' OR status='occupee')::int AS occupees
       FROM restaurant_tables ${where}`,
      values
    );
    const orders = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(total_amount),0)::numeric AS total_amount,
              COUNT(*) FILTER (WHERE order_status='préparation' OR order_status='preparation')::int AS preparation
       FROM restaurant_orders ${where}`,
      values
    );
    const calls = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM restaurant_call_requests ${where}`,
      values
    );
    return { tables: tables.rows[0], orders: orders.rows[0], calls: calls.rows[0] };
  }

  return null;
}

function buildLocalAssistantAnswer(message, toolResults) {
  const lines = ["Voici les informations WMS trouvées :"];

  for (const item of toolResults) {
    if (item.tool === "get_module_knowledge") {
      const modules = Array.isArray(item.data) ? item.data : [];
      if (modules.length > 0) {
        lines.push("- Connaissance des modules :");
        modules.slice(0, 3).forEach((module) => {
          lines.push(
            `  • ${module.module_name} : ${module.role_explanation || module.description || "Module Triangle WMS Pro."}`
          );
        });
      }
    } else if (item.tool === "get_products") {
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
    } else if (item.tool === "get_accounting_summary") {
      lines.push(
        `- Comptabilité : banques ${Number(item.data?.summary?.total_banks || 0).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} FCFA, trésorerie ${Number(item.data?.summary?.total_treasury || 0).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} FCFA, caisses ${Number(item.data?.summary?.total_cash_registers || 0).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} FCFA.`
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
    } else if (item.tool === "get_marketplace_summary") {
      lines.push(
        `- Marketplace : ${item.data?.products?.published_products || 0} produit(s) publié(s), ${item.data?.orders?.total_orders || 0} commande(s) dont ${item.data?.orders?.b2b_orders || 0} B2B et ${item.data?.orders?.b2c_orders || 0} B2C, ${item.data?.orders?.pending_orders || 0} en attente, total ${Number(item.data?.orders?.total_amount || 0).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} FCFA.`
      );
    } else if (item.tool === "get_automobile_summary") {
      lines.push(
        `- Automobile : ${item.data?.vehicles?.disponibles || 0} véhicule(s) disponible(s), ${item.data?.rentals?.retards || 0} location(s) en retard, encaissements ${Number(item.data?.rentals?.paid_amount || 0).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} FCFA.`
      );
    } else if (item.tool === "get_real_estate_summary") {
      lines.push(
        `- Immobilier/Hôtel : ${item.data?.properties?.disponibles || 0} bien(s) disponible(s), ${item.data?.reservations?.occupees || 0} chambre(s) occupée(s), encaissements ${Number(item.data?.reservations?.paid_amount || 0).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} FCFA.`
      );
    } else if (item.tool === "get_restaurant_summary") {
      lines.push(
        `- Restaurant : ${item.data?.orders?.preparation || 0} commande(s) en préparation, ventes ${Number(item.data?.orders?.total_amount || 0).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} FCFA, tables occupées ${item.data?.tables?.occupees || 0}.`
      );
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
      const data =
        tool === "get_module_knowledge"
          ? await getAssistantModuleKnowledge(message)
          : await runAssistantTool(tool, req.user);
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
                "Tu es l'assistant IA connecté au WMS Triangle WMS Pro. Réponds en français simple et professionnel. Tu connais les modules grâce à l'outil get_module_knowledge et tu utilises les données fournies par les outils internes. Même si aucune donnée métier n'existe, explique clairement le rôle du module avec la connaissance fournie. Si une liste est longue, résume les éléments importants. Ne dis jamais que tu n'as pas accès aux données quand des résultats d'outils sont fournis."
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
app.post("/ai/chat", authenticateToken, async (req, res) => {
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
app.post("/payments/manual", authenticateToken, async (req, res) => {
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
app.post("/subscriptions/renew", authenticateToken, async (req, res) => {
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
         + ($1::text || ' month')::INTERVAL
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

app.use("/super-admin", authenticateToken, authorizeRoles("super_admin"));

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

app.get("/super-admin/plans", authenticateToken, authorizeRoles("super_admin"), async (req, res) => {
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

app.get("/partners/:id/details", authenticateToken, async (req, res) => {
  try {
    const companyId = req.user.company_id;
    const isSuperAdmin = req.user.is_super_admin === true;
    const partnerId = req.params.id;

    const partnerResult = await pool.query(
      `SELECT *
       FROM partners
       WHERE id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}
       LIMIT 1`,
      isSuperAdmin ? [partnerId] : [partnerId, companyId]
    );

    const partner = partnerResult.rows[0];

    if (!partner) {
      return res.status(404).json({ error: "Partenaire introuvable" });
    }

    const paymentsHasPartner = await columnExists("payments", "partner_id");
    const receiptsHasPartner = await columnExists("receipts", "partner_id");
    const documentsHasPartner = await columnExists("documents", "partner_id");
    const salesHasClient = await columnExists("sales", "client_id");

    const salesResult = salesHasClient
      ? await pool.query(
          `SELECT id, sale_number, customer_name, customer_phone, total_amount,
                  amount_paid, amount_due, remaining_amount, payment_method,
                  payment_status, status, created_at
           FROM sales
           WHERE client_id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}
           ORDER BY id DESC
           LIMIT 100`,
          isSuperAdmin ? [partnerId] : [partnerId, companyId]
        )
      : { rows: [] };

    const paymentsResult = paymentsHasPartner
      ? await pool.query(
          `SELECT id, amount, currency, payment_method, status, notes,
                  paid_at, created_at, sale_id
           FROM payments
           WHERE partner_id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}
           ORDER BY id DESC
           LIMIT 100`,
          isSuperAdmin ? [partnerId] : [partnerId, companyId]
        )
      : { rows: [] };

    const receiptPartnerCondition = receiptsHasPartner ? "r.partner_id=$1" : "false";
    const receiptSaleCondition = salesHasClient ? "s.client_id=$1" : "false";
    const receiptsResult =
      receiptsHasPartner || salesHasClient
        ? await pool.query(
            `SELECT r.id, r.receipt_number, r.total_amount, r.payment_method,
                    r.payment_status, r.status, r.created_at, r.sale_id
             FROM receipts r
             LEFT JOIN sales s ON s.id=r.sale_id
             WHERE (${receiptPartnerCondition} OR ${receiptSaleCondition})
             ${isSuperAdmin ? "" : "AND (r.company_id=$2 OR s.company_id=$2)"}
             ORDER BY r.id DESC
             LIMIT 100`,
            isSuperAdmin ? [partnerId] : [partnerId, companyId]
          )
        : { rows: [] };

    const documentsResult = documentsHasPartner
      ? await pool.query(
          `SELECT id, document_type, document_number, client_name, total_amount,
                  status, created_by, created_at
           FROM documents
           WHERE partner_id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}
           ORDER BY id DESC
           LIMIT 100`,
          isSuperAdmin ? [partnerId] : [partnerId, companyId]
        )
      : { rows: [] };

    const purchasesExists = await tableExists("purchases");
    let purchases = [];

    if (purchasesExists) {
      const purchasesResult = await pool.query(
        `SELECT *
         FROM purchases
         WHERE supplier_id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}
         ORDER BY id DESC
         LIMIT 100`,
        isSuperAdmin ? [partnerId] : [partnerId, companyId]
      );
      purchases = purchasesResult.rows;
    }

    const salesTotal = salesResult.rows.reduce((sum, sale) => sum + Number(sale.total_amount || 0), 0);
    const salesPaid = salesResult.rows.reduce((sum, sale) => sum + Number(sale.amount_paid || 0), 0);
    const supplierDebt = purchases.reduce((sum, purchase) => {
      const total = Number(purchase.total_amount || purchase.amount || 0);
      const paid = Number(purchase.amount_paid || 0);
      return sum + Math.max(total - paid, 0);
    }, 0);

    res.json({
      partner,
      sales: salesResult.rows,
      purchases,
      payments: paymentsResult.rows,
      receipts: receiptsResult.rows,
      documents: documentsResult.rows,
      balance: {
        client_credit: Math.max(salesTotal - salesPaid, 0),
        supplier_debt: supplierDebt
      }
    });
  } catch (error) {
    console.error("ERREUR PARTNER DETAILS :", error);
    res.status(500).json({ error: "Erreur fiche partenaire" });
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
    const partnerId = req.params.id;

    const partnerResult = await pool.query(
      `SELECT *
       FROM partners
       WHERE id=$1 ${isSuperAdmin ? "" : "AND company_id=$2"}
       LIMIT 1`,
      isSuperAdmin ? [partnerId] : [partnerId, companyId]
    );

    const partner = partnerResult.rows[0];

    if (!partner) {
      return res.status(404).json({ error: "Partenaire introuvable" });
    }

    const usageChecks = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS count FROM sales WHERE client_id=$1", [partnerId]),
      pool.query("SELECT COUNT(*)::int AS count FROM products WHERE supplier_id=$1", [partnerId]),
      pool.query("SELECT COUNT(*)::int AS count FROM product_batches WHERE supplier_id=$1", [partnerId])
    ]);

    const usageCount = usageChecks.reduce(
      (sum, result) => sum + Number(result.rows[0]?.count || 0),
      0
    );

    if (usageCount > 0) {
      const disabled = await pool.query(
        `UPDATE partners
         SET status='inactive'
         WHERE id=$1
         RETURNING *`,
        [partnerId]
      );
      await logAudit(req, "partner_disabled_instead_of_delete", "partner", partnerId, {
        usage_count: usageCount
      });

      return res.json({
        message: "Partenaire utilisé dans l’historique : il a été désactivé au lieu d’être supprimé.",
        partner: disabled.rows[0]
      });
    }

    let query = `DELETE FROM partners WHERE id=$1`;
    const values = [partnerId];

    if (!isSuperAdmin) {
      query += ` AND company_id=$2`;
      values.push(companyId);
    }

    query += ` RETURNING *`;

    const result = await pool.query(query, values);
    await logAudit(req, "partner_deleted", "partner", partnerId, {
      name: partner.name,
      type: partner.type
    });

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
        CASE
          WHEN LOWER(name)='premium' AND COALESCE(max_users,0) <= 0 THEN 30
          WHEN LOWER(name)='standard' AND COALESCE(max_users,0) <= 0 THEN 10
          WHEN LOWER(name) IN ('essentiel','starter') AND COALESCE(max_users,0) <= 0 THEN 3
          ELSE max_users
        END AS max_users,
        CASE
          WHEN LOWER(name)='premium' AND COALESCE(max_warehouses,0) <= 0 THEN 10
          WHEN LOWER(name)='standard' AND COALESCE(max_warehouses,0) <= 0 THEN 3
          WHEN LOWER(name) IN ('essentiel','starter') AND COALESCE(max_warehouses,0) <= 0 THEN 1
          ELSE max_warehouses
        END AS max_warehouses,
        CASE
          WHEN LOWER(name)='premium' AND COALESCE(max_products,0) <= 0 THEN 10000
          WHEN LOWER(name)='standard' AND COALESCE(max_products,0) < 2000 THEN 2000
          WHEN LOWER(name) IN ('essentiel','starter') AND COALESCE(max_products,0) < 300 THEN 300
          ELSE max_products
        END AS max_products,
        CASE
          WHEN LOWER(name)='premium' AND COALESCE(max_movements_monthly,0) <= 0 THEN 20000
          WHEN LOWER(name)='standard' AND COALESCE(max_movements_monthly,0) <= 0 THEN 3000
          WHEN LOWER(name) IN ('essentiel','starter') AND COALESCE(max_movements_monthly,0) <= 0 THEN 500
          ELSE max_movements_monthly
        END AS max_movements_monthly,
        trial_days,
        modules,
        COALESCE(currency, 'FCFA') AS currency,
        COALESCE(duration_days, 30) AS duration_days,
        COALESCE(max_cash_registers, 0) AS max_cash_registers,
        COALESCE(max_sales_per_month, 0) AS max_sales_per_month,
        COALESCE(max_stock_movements_per_month, max_movements_monthly, 0) AS max_stock_movements_per_month,
        COALESCE(max_modules_allowed, 0) AS max_modules_allowed,
        COALESCE(billing_cycle, 'monthly') AS billing_cycle,
        COALESCE(is_active, true) AS is_active,
        can_use_reports,
        can_use_qr,
        can_use_advanced_inventory,
        can_use_documents,
        can_use_chat,
        can_use_ai
      FROM subscription_plans
      WHERE name IN ('Essentiel', 'Starter', 'Standard', 'Premium')
        AND COALESCE(is_active, true)=true
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

function normalizePlanPayload(body = {}) {
  const modulesValue = Array.isArray(body.modules)
    ? body.modules.join(", ")
    : typeof body.modules === "object" && body.modules !== null
      ? Object.entries(body.modules)
          .filter(([, enabled]) => enabled === true)
          .map(([key]) => key)
          .join(", ")
      : body.modules || "";

  return {
    name: body.name || "",
    price_monthly: Number(body.price_monthly ?? body.monthly_price ?? 0),
    monthly_price: Number(body.monthly_price ?? body.price_monthly ?? 0),
    yearly_price: Number(body.yearly_price || 0),
    currency: body.currency || "FCFA",
    duration_days: Number(body.duration_days || 30),
    billing_cycle: body.billing_cycle || "monthly",
    max_users: Number(body.max_users || 0),
    max_warehouses: Number(body.max_warehouses || 0),
    max_products: Number(body.max_products || 0),
    max_cash_registers: Number(body.max_cash_registers || 0),
    max_sales_per_month: Number(body.max_sales_per_month || 0),
    max_movements_monthly: Number(body.max_movements_monthly ?? body.max_stock_movements_per_month ?? 0),
    max_stock_movements_per_month: Number(body.max_stock_movements_per_month ?? body.max_movements_monthly ?? 0),
    max_modules_allowed: Number(body.max_modules_allowed ?? body.nombre_modules_autorises ?? 0),
    trial_days: Number(body.trial_days || 15),
    modules: modulesValue,
    features_json: body.features_json && typeof body.features_json === "object" ? body.features_json : {},
    is_active: body.is_active !== false,
    can_use_reports: body.can_use_reports !== false,
    can_use_qr: body.can_use_qr !== false,
    can_use_advanced_inventory: body.can_use_advanced_inventory !== false,
    can_use_documents: body.can_use_documents !== false,
    can_use_chat: body.can_use_chat !== false,
    can_use_ai: body.can_use_ai !== false
  };
}

async function updateSubscriptionPlan(planId, payload) {
  return pool.query(
    `UPDATE subscription_plans
     SET
      name=$1,
      price_monthly=$2,
      monthly_price=$3,
      yearly_price=$4,
      currency=$5,
      duration_days=$6,
      billing_cycle=$7,
      max_users=$8,
      max_warehouses=$9,
      max_products=$10,
      max_cash_registers=$11,
      max_sales_per_month=$12,
      max_movements_monthly=$13,
      max_stock_movements_per_month=$14,
      max_modules_allowed=$15,
      trial_days=$16,
      modules=$17,
      features_json=$18::jsonb,
      is_active=$19,
      can_use_reports=$20,
      can_use_qr=$21,
      can_use_advanced_inventory=$22,
      can_use_documents=$23,
      can_use_chat=$24,
      can_use_ai=$25
     WHERE id=$26
     RETURNING *`,
    [
      payload.name,
      payload.price_monthly,
      payload.monthly_price,
      payload.yearly_price,
      payload.currency,
      payload.duration_days,
      payload.billing_cycle,
      payload.max_users,
      payload.max_warehouses,
      payload.max_products,
      payload.max_cash_registers,
      payload.max_sales_per_month,
      payload.max_movements_monthly,
      payload.max_stock_movements_per_month,
      payload.max_modules_allowed,
      payload.trial_days,
      payload.modules,
      JSON.stringify(payload.features_json || {}),
      payload.is_active,
      payload.can_use_reports,
      payload.can_use_qr,
      payload.can_use_advanced_inventory,
      payload.can_use_documents,
      payload.can_use_chat,
      payload.can_use_ai,
      planId
    ]
  );
}

/* GESTION PLANS SAAS */
app.put("/super-admin/plans/:id", authenticateToken, authorizeRoles("super_admin"), async (req, res) => {
  try {
    const result = await updateSubscriptionPlan(req.params.id, normalizePlanPayload(req.body));

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur modification plan SaaS"
    });
  }
});

/* SUPER ADMIN - GESTION UTILISATEURS */
app.get("/super-admin/users", authenticateToken, authorizeRoles("super_admin"), async (req, res) => {
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

app.put("/super-admin/users/:id", authenticateToken, authorizeRoles("super_admin"), async (req, res) => {
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

app.put("/super-admin/users/:id/password", authenticateToken, authorizeRoles("super_admin"), async (req, res) => {
  try {
    const { password } = req.body;
    const passwordError = validatePasswordStrength(password);

    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }

    const result = await pool.query(
      `UPDATE users
       SET password=$1
       WHERE id=$2
       RETURNING id, fullname, email`,
      [await hashPassword(password), req.params.id]
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
app.get("/dashboard-stats", authenticateToken, async (req, res) => {
  try {
    const isSuperAdmin = req.user?.is_super_admin === true;
    const companyId = getEffectiveCompanyId(req);
    const shouldFilterByCompany = !isSuperAdmin || Boolean(companyId);
    const companyFilter = shouldFilterByCompany ? " WHERE company_id=$1" : "";
    const values = shouldFilterByCompany ? [companyId] : [];

    const totalProduits = await pool.query(`SELECT COUNT(*) FROM products${companyFilter}`, values);
    const totalStock = await pool.query(
      `SELECT COALESCE(SUM(stock), 0) AS total FROM products${companyFilter}`,
      values
    );
    const totalEntrepots = await pool.query(`SELECT COUNT(*) FROM warehouses${companyFilter}`, values);
    const totalEmplacements = await pool.query(
      `SELECT COUNT(*) FROM locations${companyFilter}`,
      values
    );
    const totalUsers = await pool.query(`SELECT COUNT(*) FROM users${companyFilter}`, values);
    const totalInventaires = await pool.query(
      `SELECT COUNT(*) FROM inventory_history${companyFilter}`,
      values
    );

    const mouvementsAttente = await pool.query(
      `SELECT COUNT(*) FROM stock_movements WHERE status='En attente'${shouldFilterByCompany ? " AND company_id=$1" : ""}`,
      values
    );

    const stockFaible = await pool.query(
      `SELECT COUNT(*) FROM products WHERE stock > 0 AND stock <= minimum_stock${shouldFilterByCompany ? " AND company_id=$1" : ""}`,
      values
    );

    const ruptureStock = await pool.query(
      `SELECT COUNT(*) FROM products WHERE stock <= 0${shouldFilterByCompany ? " AND company_id=$1" : ""}`,
      values
    );

    const activitiesHaveCompany = await columnExists("user_activities", "company_id");
    const activitesRecentes = await pool.query(
      `SELECT * FROM user_activities
       ${activitiesHaveCompany && shouldFilterByCompany ? "WHERE company_id=$1" : ""}
       ORDER BY id DESC LIMIT 5`,
      activitiesHaveCompany && shouldFilterByCompany ? values : []
    );

    const derniersMouvements = await pool.query(
      `SELECT * FROM stock_movements${companyFilter} ORDER BY id DESC LIMIT 5`,
      values
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
app.get("/attendance/today", authenticateToken, async (req, res) => {
  try {
    /* Cette route listait TOUS les utilisateurs de TOUTES les entreprises,
       avec leur badge, leur rôle et leurs paramètres de salaire. N'importe
       quel compte authentifié — Triangle comme FAT & MAT — voyait le
       personnel de l'autre société et ce qu'il gagne. On la borne à
       l'entreprise du contexte, comme le reste. */
    const companyId = Number(getEffectiveCompanyId(req, req.user?.company_id) || 0);
    if (!companyId) {
      return res.status(409).json({
        error: "Aucune entreprise active.", code: "NO_ACTIVE_COMPANY",
      });
    }
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

      WHERE u.company_id = $1

      ORDER BY u.fullname ASC
    `, [companyId]);

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
app.delete("/super-admin/users/:id", authenticateToken, authorizeRoles("super_admin"), async (req, res) => {
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
app.delete("/super-admin/plans/:id", authenticateToken, authorizeRoles("super_admin"), async (req, res) => {
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
app.get("/super-admin/companies", authenticateToken, authorizeRoles("super_admin"), async (req, res) => {
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
app.get("/super-admin/users", authenticateToken, authorizeRoles("super_admin"), async (req, res) => {
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
app.get("/super-admin/plans", authenticateToken, authorizeRoles("super_admin"), async (req, res) => {
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
app.post("/super-admin/plans", authenticateToken, authorizeRoles("super_admin"), async (req, res) => {
  try {
    const payload = normalizePlanPayload(req.body);

    const result = await pool.query(
      `
      INSERT INTO subscription_plans
      (
        name,
        price_monthly,
        monthly_price,
        yearly_price,
        currency,
        duration_days,
        billing_cycle,
        max_users,
        max_warehouses,
        max_products,
        max_cash_registers,
        max_sales_per_month,
        max_movements_monthly,
        max_stock_movements_per_month,
        max_modules_allowed,
        trial_days,
        modules,
        features_json,
        is_active,
        can_use_reports,
        can_use_qr,
        can_use_advanced_inventory,
        can_use_documents,
        can_use_chat,
        can_use_ai
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22,$23,$24,$25)
      RETURNING *
      `,
      [
        payload.name,
        payload.price_monthly,
        payload.monthly_price,
        payload.yearly_price,
        payload.currency,
        payload.duration_days,
        payload.billing_cycle,
        payload.max_users,
        payload.max_warehouses,
        payload.max_products,
        payload.max_cash_registers,
        payload.max_sales_per_month,
        payload.max_movements_monthly,
        payload.max_stock_movements_per_month,
        payload.max_modules_allowed,
        payload.trial_days,
        payload.modules,
        JSON.stringify(payload.features_json || {}),
        payload.is_active,
        payload.can_use_reports,
        payload.can_use_qr,
        payload.can_use_advanced_inventory,
        payload.can_use_documents,
        payload.can_use_chat,
        payload.can_use_ai
      ]
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
app.put("/super-admin/plans/:id", authenticateToken, authorizeRoles("super_admin"), async (req, res) => {
  try {
    const result = await updateSubscriptionPlan(req.params.id, normalizePlanPayload(req.body));

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
            ) + ($1::text || ' month')::interval
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

app.post("/payments/create", authenticateToken, async (req, res) => {
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
app.post("/attendance/legacy/scan", authenticateToken, async (req, res) => {
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
        allow_remote_attendance, kiosk_mode, employee_scanner_access,
        allow_out_of_zone_global)
       VALUES (1, false, '', 100, false, true, false, false)
       ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id
       RETURNING *`
    );
    const gpsSettings = gpsSettingsResult.rows[0] || {};
    const gpsRequired = gpsSettings.gps_required === true;
    const allowRemoteAttendance = gpsSettings.allow_remote_attendance === true || gpsSettings.allow_out_of_zone_global === true;
    const lat = latitude === "" || latitude === null || latitude === undefined ? null : Number(latitude);
    const lon = longitude === "" || longitude === null || longitude === undefined ? null : Number(longitude);
    const gpsAccuracy = accuracy === "" || accuracy === null || accuracy === undefined ? null : Number(accuracy);
    const userAttendanceSettings = await pool.query(
      `SELECT primary_attendance_site_id, employee_mobile, allow_out_of_zone
       FROM attendance_settings
       WHERE user_id=$1
       LIMIT 1`,
      [user.id]
    );
    const employeeMobile = user.employee_mobile === true || userAttendanceSettings.rows[0]?.employee_mobile === true;
    const allowOutOfZoneForUser = user.allow_out_of_zone === true || userAttendanceSettings.rows[0]?.allow_out_of_zone === true;
    const allowedSites = await getAllowedAttendanceSitesForUser({
      ...user,
      primary_attendance_site_id: user.primary_attendance_site_id || userAttendanceSettings.rows[0]?.primary_attendance_site_id
    });

    if (gpsRequired && (lat === null || lon === null || !Number.isFinite(lat) || !Number.isFinite(lon))) {
      return res.status(403).json({
        error: "Pointage refusé : localisation obligatoire."
      });
    }

    if (gpsRequired && !employeeMobile && allowedSites.length === 0) {
      return res.status(403).json({
        error: "Pointage refusé : aucun site de pointage autorisé."
      });
    }

    let distanceMeters = null;
    let isInsideZone = null;
    let detectedSite = null;
    let allowedRadius = Number(gpsSettings.allowed_radius_meters || 100);
    let gpsStatus = "accepté";

    if (
      lat !== null &&
      lon !== null &&
      Number.isFinite(lat) &&
      Number.isFinite(lon)
    ) {
      for (const site of allowedSites) {
        const siteLat = Number(site.latitude);
        const siteLon = Number(site.longitude);
        if (!Number.isFinite(siteLat) || !Number.isFinite(siteLon)) continue;

        const distance = calculateDistanceMeters(siteLat, siteLon, lat, lon);
        if (distanceMeters === null || distance < distanceMeters) {
          distanceMeters = distance;
          detectedSite = site;
          allowedRadius = Number(site.rayon_autorise_metre || gpsSettings.allowed_radius_meters || 100);
          isInsideZone = distance <= allowedRadius;
        }
      }
    }

    if (employeeMobile) {
      gpsStatus = "mobile";
      isInsideZone = isInsideZone === null ? true : isInsideZone;
    } else if (isInsideZone) {
      gpsStatus = "accepté";
    } else if (gpsRequired && (allowRemoteAttendance || allowOutOfZoneForUser)) {
      gpsStatus = "hors_zone_autorisé";
    } else if (gpsRequired) {
      gpsStatus = "refusé";
    }

    if (gpsRequired && !employeeMobile && !allowRemoteAttendance && !allowOutOfZoneForUser && !isInsideZone) {
      return res.status(403).json({
        error: "Pointage refusé : vous êtes hors de la zone autorisée.",
        distance_meters: distanceMeters,
        allowed_radius_meters: allowedRadius,
        site_name: detectedSite?.nom_du_site || ""
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
           attendance_site_id=$6,
           attendance_site_name=$7,
           gps_status=$8,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$9
       RETURNING *`,
      [
        lat,
        lon,
        gpsAccuracy,
        distanceMeters,
        isInsideZone,
        detectedSite?.id || null,
        detectedSite?.nom_du_site || (employeeMobile ? "Pointage mobile" : ""),
        gpsStatus,
        result.rows[0].id
      ]
    );

    await pool.query(
      `INSERT INTO attendance_history
       (user_id, action_type, device_info, location_info,
        latitude, longitude, accuracy, distance_meters, is_inside_zone,
        attendance_site_id, attendance_site_name, gps_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        user.id,
        action_type,
        "QR",
        lat !== null && lon !== null ? `${lat},${lon}` : "",
        lat,
        lon,
        gpsAccuracy,
        distanceMeters,
        isInsideZone,
        detectedSite?.id || null,
        detectedSite?.nom_du_site || (employeeMobile ? "Pointage mobile" : ""),
        gpsStatus
      ]
    );

    res.json({
      success: true,
      user,
      attendance: updatedAttendance.rows[0] || result.rows[0],
      action,
      gps: {
        gps_required: gpsRequired,
        site_name: detectedSite?.nom_du_site || (employeeMobile ? "Pointage mobile" : gpsSettings.site_name || ""),
        site_id: detectedSite?.id || null,
        distance_meters: distanceMeters,
        allowed_radius_meters: allowedRadius,
        is_inside_zone: isInsideZone,
        allow_remote_attendance: allowRemoteAttendance || allowOutOfZoneForUser,
        employee_mobile: employeeMobile,
        gps_status: gpsStatus
      }
    });
  } catch (error) {
    console.error("ERREUR ATTENDANCE SCAN :", error);

    res.status(500).json({
      error: "Erreur scan QR"
    });
  }
});
// ===================================================================
// RBAC : permissions effectives de l'utilisateur courant.
// PHASE 31 — propagation immédiate : le frontend interroge cet endpoint à
// chaque chargement, il ne dépend donc PAS des permissions figées dans le JWT.
// Une modification par le Super Admin est effective au rechargement suivant.
// ===================================================================
app.get("/me/permissions", authenticateToken, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(await rbacTriangle.effectivePermissions(pool, req.user));
  } catch (error) {
    console.error("ERREUR /me/permissions :", error);
    res.status(500).json({ error: "Erreur lecture permissions" });
  }
});

// ===================================================================
// PHASE 1 — RECHERCHE PRODUIT ULTRA-RAPIDE (serveur, paginée)
// Ne charge JAMAIS tout le catalogue. Recherche multi-mots, insensible à la
// casse ET aux accents (translate() : aucune extension PostgreSQL requise).
// Chaque mot doit apparaître dans le texte recherchable (nom, référence, SKU,
// code-barres, catégorie, description) — « plaf met d » trouve
// « FAUX PLAFOND MÉTALLIQUE D ».
// ===================================================================
const ACCENTS_FROM = "áàâäãåéèêëíìîïóòôöõúùûüýÿçñÁÀÂÄÃÅÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÝÇÑ";
const ACCENTS_TO   = "aaaaaaeeeeiiiiooooouuuuyycnAAAAAAEEEEIIIIOOOOOUUUUYCN";

app.get("/products/search", authenticateToken, async (req, res) => {
  try {
    const companyId = getEffectiveCompanyId(req, req.user.company_id);
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    // Texte recherchable normalisé (sans accents, minuscules).
    const norm = (expr) => `lower(translate(coalesce(${expr},''), '${ACCENTS_FROM}', '${ACCENTS_TO}'))`;
    const haystack = `(${norm("p.name")} || ' ' || ${norm("p.reference")} || ' ' || ${norm("p.sku")} || ' ' || ` +
                     `${norm("p.barcode")} || ' ' || ${norm("p.category")} || ' ' || ${norm("p.description")})`;

    const params = [companyId];
    const conds = ["p.company_id = $1"];

    // Multi-mots : chaque token doit être présent (ET logique).
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    for (const token of tokens) {
      const normalized = token.normalize("NFD").replace(/[̀-ͯ]/g, "");
      params.push(`%${normalized}%`);
      conds.push(`${haystack} LIKE $${params.length}`);
    }
    // Index du dernier token (pertinence : correspondance sur le nom d'abord).
    const lastTokenIdx = tokens.length ? params.length : null;

    params.push(limit, offset);
    const relevance = lastTokenIdx ? `(${norm("p.name")} LIKE $${lastTokenIdx}) DESC, ` : "";
    const sql =
      `SELECT p.id, p.reference, p.name, p.category, p.unit, p.stock,
              p.warehouse, p.location_code, p.barcode, p.sku, p.sale_price, p.minimum_stock
         FROM products p
        WHERE ${conds.join(" AND ")}
        ORDER BY ${relevance}p.name ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const { rows } = await pool.query(sql, params);
    const totalRow = await pool.query(
      `SELECT COUNT(*)::int AS n FROM products p WHERE ${conds.join(" AND ")}`,
      params.slice(0, params.length - 2)
    );
    /* `total` suit la recherche ; `total_active` est le nombre de produits
       ACTIFS de l'entreprise, indépendant de la recherche, de la pagination et
       du tri. C'est lui qui alimente le compteur « Produits » — sans quoi
       l'écran afficherait la taille de la page (50) au lieu du total réel. */
    const totalActifs = await pool.query(
      `SELECT COUNT(*)::int AS n FROM products p
        WHERE p.company_id = $1 AND COALESCE(p.is_active, TRUE) = TRUE`,
      [companyId]
    );
    res.json({
      items: rows, total: totalRow.rows[0].n,
      total_active: totalActifs.rows[0].n,
      limit, offset, query: q,
    });
  } catch (error) {
    console.error("ERREUR RECHERCHE PRODUITS :", error);
    res.status(500).json({ error: "Erreur recherche produits" });
  }
});

// ===================================================================
// WORKFLOWS STOCK MULTI-PRODUITS (PHASES 3-10)
// Demandes entrée/sortie/transfert/inventaire, réception, documents, audit.
// Le stock ne bouge qu'à la confirmation réelle (transactionnel, verrouillé).
// ===================================================================
const createStockWorkflowRouter = require("./routes/stock-workflow");
app.use(
  "/",
  createStockWorkflowRouter({ pool, authenticateToken, getEffectiveCompanyId, requirePermission, createNotification, rbac: rbacTriangle })
);

// ===================================================================
// DÉCAISSEMENTS + DIRECTION (PHASES 13-22) — réutilise disbursement_requests.
// La trésorerie ne bouge qu'au décaissement réel (écritures équilibrées).
// ===================================================================
const multerDisb = require("multer");
const fsDisb = require("fs");
const pathDisb = require("path");
const disbDir = pathDisb.join(__dirname, "uploads", "disbursements");
fsDisb.mkdirSync(disbDir, { recursive: true });
const disbUpload = multerDisb({
  storage: multerDisb.diskStorage({
    destination: (req, file, cb) => cb(null, disbDir),
    filename: (req, file, cb) => cb(null, `just_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${pathDisb.extname(file.originalname || "").toLowerCase()}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(pdf|jpg|jpeg|png)$/i.test(file.originalname || "");
    cb(ok ? null : new Error("Formats acceptés : PDF, JPG, JPEG, PNG."), ok);
  },
});
const createDisbursementsRouter = require("./routes/disbursements");
app.use(
  "/",
  createDisbursementsRouter({
    pool, authenticateToken, getEffectiveCompanyId, requirePermission, createNotification,
    accounting: { nextAccountingNumber, createAccountingEntry }, upload: disbUpload, rbacHelper: rbacTriangle,
  })
);

// ===================================================================
// CENTRE D'IMPORTATION (moteur commun porté, adapté à Triangle WMS)
// RBAC simplifié : gating par RÔLE (Triangle n'a pas le moteur RBAC
// complet). Un utilisateur sans rôle autorisé reçoit 403.
// ===================================================================
function importRolePermission(moduleKey, action) {
  return (req, res, next) => {
    const role = normalizeRole(req.user && req.user.role);
    const allowed =
      isSuperAdminUser(req.user) ||
      ["admin", "administrateur", "direction", "directeur", "comptable", "manager", "gerant"].includes(role);
    if (!allowed) {
      return res.status(403).json({ error: "Droit d'importation requis.", code: "PERMISSION_DENIED", module: moduleKey, action });
    }
    return next();
  };
}

const createImportRouter = require("./routes/import");
app.use(
  "/import",
  createImportRouter({
    pool,
    authenticateToken,
    getEffectiveCompanyId,
    isSuperAdminUser,
    requirePermission: importRolePermission,
    accounting: { nextAccountingNumber, createAccountingEntry },
  })
);

/* Import d'inventaire Excel : fichier gardé en mémoire, jamais écrit sur disque
   — il ne sert qu'à l'analyse et son empreinte SHA-256 assure l'idempotence. */
const inventoryImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname || "");
    cb(ok ? null : new Error("Format non supporté (.xlsx, .xls ou .csv attendu)."), ok);
  },
});
const createStockReceptionsRouter = require("./routes/stock-receptions");
app.use(
  "/",
  createStockReceptionsRouter({
    pool, authenticateToken, getEffectiveCompanyId, requirePermission,
    upload: inventoryImportUpload,
  })
);

/* Stock par emplacement : répartition manuelle, entrée / sortie / transfert
   au bac près. La règle « qu'est-ce qu'un vrai bac » est partagée avec le
   moteur via services/location-rules.js. */
const createStockLocationsRouter = require("./routes/stock-locations");
app.use(
  "/",
  createStockLocationsRouter({ pool, authenticateToken, getEffectiveCompanyId, requirePermission })
);

/* Administration des emplacements : arborescence complète, création en série,
   renommage atomique, découpage des bacs composites « 1,2,3 » hérités de
   l'ancien écran. Aucune de ces routes n'écrit une quantité de stock. */
const createLocationsAdminRouter = require("./routes/locations-admin");
app.use(
  "/",
  createLocationsAdminRouter({ pool, authenticateToken, getEffectiveCompanyId: getEffectiveCompanyIdStrict, requirePermission })
);

/* Dates métier des documents : ce qui est IMPRIMÉ se corrige, ce qui est
   ENREGISTRÉ ne se réécrit pas. created_at reste hors d'atteinte. */
const createDocumentDatesRouter = require("./routes/documents-dates");
app.use(
  "/",
  createDocumentDatesRouter({ pool, authenticateToken, getEffectiveCompanyId: getEffectiveCompanyIdStrict, requirePermission })
);

/* Impression groupée : lecture seule, aucun document ni stock touché. */
/* Centre Droits & permissions. Monté avant les autres routeurs pour que
   /permissions/me réponde même si un module plus bas est masqué. */
const createPermissionsRouter = require("./routes/permissions");
app.use("/", createPermissionsRouter({ pool, authenticateToken, getEffectiveCompanyId }));

/* Accès multi-sociétés : le comptable et le directeur travaillent pour les
   deux sociétés sans second compte ni élévation en super admin. Monté ici,
   juste après le centre des droits, parce que le sélecteur d'entreprise
   interroge /acces-societes/mes-societes au tout premier chargement. */
const createAccesSocietesRouter = require("./routes/acces-societes");
app.use("/", createAccesSocietesRouter({ pool, authenticateToken, requirePermission }));

const createDocumentsPrintRouter = require("./routes/documents-print");
app.use(
  "/",
  createDocumentsPrintRouter({ pool, authenticateToken, getEffectiveCompanyId, requirePermission })
);

/* Import d'un classeur de stock : réceptions conteneur, mouvements colorés,
   anomalies en attente de décision. */
const createImportEm2sRouter = require("./routes/import-em2s");
app.use(
  "/",
  createImportEm2sRouter({
    pool, authenticateToken, getEffectiveCompanyId, requirePermission,
    upload: inventoryImportUpload,
  })
);

/* Pointage opérationnel : effectif RH distinct des comptes, périmètres des
   opérateurs et confidentialité salariale. Les anciennes routes restent
   disponibles pendant la transition, mais les nouveaux écrans utilisent v2. */
const createAttendanceWorkforceRouter = require("./routes/attendance-workforce");
app.use(
  "/",
  createAttendanceWorkforceRouter({
    pool, authenticateToken, getEffectiveCompanyId,
    nextAccountingNumber, createAccountingEntry,
  })
);

/* Corriger un pointage déjà enregistré, avec motif obligatoire et trace
   avant/après. Même règle d'accès que pointer : qui peut pointer un employé
   peut corriger son pointage. */
const createAttendanceCorrectionsRouter = require("./routes/attendance-corrections");
app.use(
  "/",
  createAttendanceCorrectionsRouter({ pool, authenticateToken, getEffectiveCompanyId })
);

/* Pointage QR et badges. Écran, route et droit distincts du pointage manuel —
   on ne transforme pas l'un en l'autre — mais un seul moteur d'écriture,
   partagé avec lui : le mode change qui déclenche, pas la règle métier. */
const createAttendanceQrRouter = require("./routes/attendance-qr");
app.use(
  "/",
  createAttendanceQrRouter({ pool, authenticateToken, getEffectiveCompanyId, requirePermission })
);

/* Périodes du 25 au 24, validation du pointage et chemin d'une paie jusqu'au
   bon signé. Le passage par la Direction n'est pas une consigne : la route de
   paiement exige une demande VALIDEE, décidée par un autre compte que celui
   qui l'a soumise. */
const createPaieWorkflowRouter = require("./routes/paie-workflow");
app.use(
  "/",
  createPaieWorkflowRouter({
    pool, authenticateToken, getEffectiveCompanyId, requirePermission, nextAccountingNumber,
  })
);

/* Avances sur salaire. Tout mouvement d'argent passe par services/tresorerie.js
   — verrou sur le compte, contrôle du solde, transaction et écritures
   équilibrées écrites ensemble. Aucune route ne touche un solde directement. */
const createAvancesRouter = require("./routes/avances-salaire");
app.use(
  "/",
  createAvancesRouter({
    pool, authenticateToken, getEffectiveCompanyId, requirePermission,
    nextAccountingNumber, createAccountingEntry,
  })
);

/* Acomptes clients (sable et ciment). L'argent n'entre qu'une fois, au
   versement : imputer un dépôt sur une facture ne fait entrer aucun argent,
   cela solde une dette envers le client contre une créance. */
const createAcomptesRouter = require("./routes/acomptes-clients");
app.use(
  "/",
  createAcomptesRouter({
    pool, authenticateToken, getEffectiveCompanyId, requirePermission,
    nextAccountingNumber, createAccountingEntry,
  })
);

/* Fiscalité. Aucun taux n'est actif au départ : une règle ne calcule rien tant
   qu'une personne ne l'a pas validée avec sa référence de texte officiel. Et
   aucune pénalité n'est inventée — sans règle validée, l'application le dit. */
const createFiscaliteRouter = require("./routes/fiscalite");
app.use(
  "/",
  createFiscaliteRouter({
    pool, authenticateToken, getEffectiveCompanyId, requirePermission,
    nextAccountingNumber, createAccountingEntry,
  })
);

/* Rapports de pointage. Ils lisent la valeur EFFECTIVE — une journée
   régularisée, une absence marquée par-dessus — et disent d'où vient chaque
   chiffre, pour qu'un total contesté puisse être remonté jusqu'à son origine. */
const createPointageRapportsRouter = require("./routes/pointage-rapports");
app.use(
  "/",
  createPointageRapportsRouter({ pool, authenticateToken, getEffectiveCompanyId, requirePermission })
);

/* Tableau de bord et notifications métier. Les alertes portent une clé
   d'événement : rafraîchir dix fois ne crée pas dix alertes. */
const createTableauDeBordRouter = require("./routes/tableau-de-bord");
app.use(
  "/",
  createTableauDeBordRouter({ pool, authenticateToken, getEffectiveCompanyId, requirePermission })
);

const createInventoryImportRouter = require("./routes/inventory-import");
app.use(
  "/",
  createInventoryImportRouter({
    pool,
    authenticateToken,
    getEffectiveCompanyId,
    requirePermission,
    upload: inventoryImportUpload,
  })
);

const createAccountingRouter = require("./routes/accounting");
app.use(
  "/accounting",
  createAccountingRouter({ pool, authenticateToken, getEffectiveCompanyId, isSuperAdminUser, requirePermission: importRolePermission })
);

const createFacturesCamionsRouter = require("./routes/factures-camions");
app.use(
  "/",
  createFacturesCamionsRouter({
    pool,
    authenticateToken,
    getEffectiveCompanyId,
    requirePermission: importRolePermission,
    accounting: { nextAccountingNumber, createAccountingEntry },
  })
);


// ===================================================================
// VENTE DE CIMENT — indépendant du module Stocks
// ===================================================================
const createCementSalesRouter = require("./routes/cement-sales");

app.use(
  "/",
  createCementSalesRouter({
    pool,
    authenticateToken,
    getEffectiveCompanyId,
    requirePermission,
    requireCompanyModule,
    createNotification,
    // Encaissements : on réutilise le moteur comptable existant, pas de second.
    accounting: { nextAccountingNumber, createAccountingEntry }
  })
);


// ===================================================================
// FAT & MAT — VENTE DE SABLE
// Indépendant du stock et du module ciment
// ===================================================================
const createSandSalesRouter = require("./routes/sand-sales");

app.use(
  "/",
  createSandSalesRouter({
    pool,
    authenticateToken,
    getEffectiveCompanyId,
    requirePermission,
    requireCompanyModule,
    createNotification,
    // Encaissements : on réutilise le moteur comptable existant, pas de second.
    accounting: { nextAccountingNumber, createAccountingEntry }
  })
);

// Modifier un brouillon, le supprimer, annuler ou corriger une vente
// validée, contrepasser un paiement. Monté avant /sand/sales/:id (déjà
// défini ci-dessus) car Express dispatche à la première route qui matche :
// une méthode différente (PATCH/DELETE/POST) sur le même chemin ne se
// confond jamais avec le GET existant, donc l'ordre de montage n'a pas
// d'incidence ici — mais il est gardé immédiatement après par lisibilité.
const createSandSalesCancellationRouter = require("./routes/sand-sales-cancellation");

app.use(
  "/",
  createSandSalesCancellationRouter({
    pool,
    authenticateToken,
    getEffectiveCompanyId,
    requirePermission,
    requireCompanyModule,
    accounting: { nextAccountingNumber, createAccountingEntry }
  })
);


// ============================================================
// MULTI_COMPANY_SWITCH_V1
// Triangle Logistics <-> FAT & MAT
// ============================================================

/**
 * LES ENTREPRISES QUE CE COMPTE PEUT ATTEINDRE.
 *
 * Cette route alimente le sélecteur d'entreprise. Elle interrogeait
 * `user_company_access.is_active` — une table qui n'existait dans aucune
 * migration, et une colonne qui n'existe pas dans celle posée depuis (079,
 * où elle se nomme `active`). Le sélecteur était donc VIDE pour un super
 * admin : la requête échouait, tombait dans le catch, et renvoyait une liste
 * vide sans que rien ne le signale à l'écran.
 *
 * Elle délègue désormais à `services/acces-societes.js`, seule réponse de
 * l'application à la question « quelles sociétés ? ». Conséquence voulue : un
 * comptable ou un directeur HABILITÉ (migration 079) voit lui aussi son
 * sélecteur, sans qu'on ait eu à l'élever en super admin.
 */
app.get("/companies/available", authenticateToken, async (req, res) => {
  try {
    const ids = await accesSocietes.societesAccessibles(
      pool, req.user, req.tenant_id || null
    );
    if (!ids.length) return res.json([]);

    const { rows } = await pool.query(
      `SELECT c.id, c.name, c.business_type, c.status, cs.logo_url
         FROM companies c
         LEFT JOIN company_settings cs ON cs.company_id = c.id
        WHERE c.id = ANY($1::int[])
          AND COALESCE(c.status, 'active') <> 'deleted'
        ORDER BY c.name`,
      [ids]
    );
    res.json(rows);
  } catch (e) {
    console.error("Entreprises accessibles :", e);
    /* On ne renvoie pas une liste vide en silence : un sélecteur vide se
       confond avec « une seule entreprise », et c'est ce qui a masqué le
       défaut pendant si longtemps. */
    res.status(500).json({ error: "Impossible de lire les entreprises accessibles." });
  }
});

app.post("/companies/switch", authenticateToken, async (req,res) => {
  try {
    const companyId = Number(req.body?.company_id);

    if (!companyId) {
      return res.status(400).json({error:"Entreprise invalide."});
    }

    const isSuper =
      req.user?.is_super_admin === true ||
      String(req.user?.role || "").toLowerCase() === "super_admin";

    if (!isSuper && companyId !== Number(req.user.company_id)) {
      return res.status(403).json({error:"Accès entreprise refusé."});
    }

    if (isSuper) {
      const access = await pool.query(
        `SELECT 1
         FROM user_company_access
         WHERE user_id=$1
           AND company_id=$2
           AND is_active=TRUE`,
        [req.user.id, companyId]
      );

      if (!access.rowCount) {
        return res.status(403).json({error:"Entreprise non autorisée."});
      }
    }

    const company = (
      await pool.query(
        `SELECT id,name,business_type,status,tenant_id
         FROM companies
         WHERE id=$1`,
        [companyId]
      )
    ).rows[0];

    if (!company || company.status !== "active") {
      return res.status(404).json({error:"Entreprise indisponible."});
    }

    if (company.tenant_id !== (req.tenant_id || "triangle")) {
      return res.status(403).json({error:"Tenant entreprise invalide."});
    }

    const token = jwt.sign(
      {
        id: req.user.id,
        email: req.user.email,
        role: req.user.role,
        company_id: company.id,
        tenant_id: company.tenant_id,
        is_super_admin: isSuper,
        subscription_status: req.user.subscription_status || ""
      },
      JWT_SECRET,
      { expiresIn:"1d" }
    );

    res.json({
      success:true,
      token,
      company
    });

  } catch(e) {
    console.error(e);
    res.status(500).json({error:"Erreur changement entreprise."});
  }
});

app.listen(5050, () => {
  console.log("Backend sécurisé démarré sur le port 5050");
});

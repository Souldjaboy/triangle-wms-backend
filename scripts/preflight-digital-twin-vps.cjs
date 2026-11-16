#!/usr/bin/env node
"use strict";
/* Diagnostic autonome : aucun changement du code, des services ou de la base.
 * Exécution depuis un fichier temporaire ; dépendances lues dans le backend.
 * Les valeurs d'environnement, URLs PostgreSQL et mots de passe ne sont jamais affichés.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const root = process.argv[2] || "/var/www/triangle-wms";
const back = path.join(root, "backend");
const front = path.join(root, "frontend");
const required = {
  companies: "id tenant_id",
  users: "id email fullname role company_id is_active is_super_admin",
  warehouses: "id company_id code name location status",
  locations:
    "id company_id warehouse_id warehouse_code zone rayon etagere rayon_code case_code level_code bin_code full_code emplacement_code is_active status occupancy_status merged_into_location_id",
  products:
    "id company_id name reference unit barcode category stock location_id location_managed",
  stock_location_balances:
    "company_id location_id product_id quantity reserved_quantity",
  stock_movements:
    "id company_id type quantity status created_at product_name product_reference location_id source_location_id destination_location_id source_warehouse_id destination_warehouse_id location_stock_before location_stock_after destination_stock_before destination_stock_after",
  permission_modules:
    "module_key parent_key label description sort_order is_active is_system actions",
  role_permissions: "company_id role module_key action allowed",
  user_permission_overrides: "company_id user_id module_key action effect",
  user_permissions:
    "user_id module_key can_view can_create can_edit can_delete can_validate",
  audit_logs:
    "user_id user_email user_role company_id action entity_type entity_id ip_address user_agent details",
  user_company_access: "user_id company_id is_active",
};
const read = (p) => fs.readFileSync(p, "utf8");
const sha = (p) =>
  fs.existsSync(p)
    ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex")
    : null;
function command(program, args, cwd) {
  try {
    return execFileSync(program, args, {
      cwd,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
function packageInfo(dir) {
  if (!fs.existsSync(path.join(dir, "package.json"))) return { exists: false };
  const p = JSON.parse(read(path.join(dir, "package.json")));
  const names = [
    "express",
    "pg",
    "next",
    "react",
    "react-dom",
    "typescript",
    "three",
    "@react-three/fiber",
    "@react-three/drei",
  ];
  const versions = {};
  for (const k of names)
    if (p.dependencies?.[k] || p.devDependencies?.[k])
      versions[k] = p.dependencies?.[k] || p.devDependencies[k];
  const changed = command(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    dir,
  );
  return {
    exists: true,
    directory: dir,
    git_head: command("git", ["rev-parse", "HEAD"], dir),
    tracked_changes:
      changed === null ? null : changed ? changed.split("\n").length : 0,
    versions,
  };
}
// Analyse de valeurs simples uniquement ; aucun eval, aucun require du serveur.
function literal(s, env) {
  s = s.trim();
  const varMatch = s.match(
    /^process\.env\.([A-Z0-9_]+)(?:\s*(\|\||\?\?)\s*(.+))?$/,
  );
  if (varMatch) {
    const v = env[varMatch[1]];
    if (varMatch[2] === "||") return v || literal(varMatch[3], env);
    if (varMatch[2] === "??") return v ?? literal(varMatch[3], env);
    return v;
  }
  if (/^\d+$/.test(s)) return Number(s);
  if (/^"[^"\\]*"$/.test(s) || /^'[^'\\]*'$/.test(s)) return s.slice(1, -1);
  throw new Error("UNSUPPORTED_POOL_EXPRESSION");
}
function poolConfig(source, env) {
  const definition = source.match(/(?:const|let|var)\s+pool\s*=([^;]+);/);
  if (!definition) throw new Error("POOL_DECLARATION_NOT_FOUND");
  const d = definition[1];
  if (
    /connectionString\s*:\s*process\.env\.DATABASE_URL\b/.test(d) &&
    env.DATABASE_URL
  )
    return { connectionString: env.DATABASE_URL };
  const objects = [...d.matchAll(/new\s+Pool\s*\(\s*\{([^}]+)\}\s*\)/g)].map(
    (m) => m[1],
  );
  const simple = objects.filter((o) => !o.includes("connectionString"));
  if (simple.length !== 1)
    throw new Error("POOL_CONFIGURATION_REQUIRES_REVIEW");
  const config = {};
  // Les virgules à l'intérieur des chaînes ne sont pas séparées.
  const entries = simple[0].match(/(?:[^,'"]|"[^"\\]*"|'[^'\\]*')+/g) || [];
  for (const entry of entries) {
    if (!entry.trim()) continue;
    const m = entry
      .trim()
      .match(/^(user|host|database|password|port)\s*:\s*([\s\S]+)$/);
    if (!m) throw new Error("POOL_CONFIGURATION_REQUIRES_REVIEW");
    config[m[1]] = literal(m[2], env);
  }
  if (!config.database) throw new Error("DATABASE_NOT_IDENTIFIED");
  return config;
}
async function main() {
  const report = {
    diagnostic: "TRIANGLE_DIGITAL_TWIN_PREFLIGHT_V1",
    node: process.version,
    backend: packageInfo(back),
    frontend: packageInfo(front),
  };
  let runtimeEnv = {},
    backendApp;
  const pm = command("pm2", ["jlist"], root);
  if (pm) {
    try {
      const apps = JSON.parse(pm);
      report.services = apps
        .filter((a) =>
          ["triangle-backend", "triangle-frontend"].includes(a.name),
        )
        .map((a) => ({
          name: a.name,
          cwd: a.pm2_env?.pm_cwd,
          entry: a.pm2_env?.pm_exec_path,
          status: a.pm2_env?.status,
        }));
      backendApp = apps.find((a) => a.name === "triangle-backend");
      runtimeEnv = {
        ...(backendApp?.pm2_env?.env || {}),
        ...(backendApp?.pm2_env || {}),
      };
    } catch {
      report.services_status = "PM2_JSON_UNAVAILABLE";
    }
  }
  report.fingerprints = {};
  for (const f of [
    "server.js",
    "services/permissions.js",
    "rbac-triangle.js",
    "services/location-rules.js",
    "services/stock-locations.js",
    "routes/stock-locations.js",
    "routes/digital-twin.js",
    "scripts/audit-digital-twin.js",
  ])
    report.fingerprints["backend/" + f] = sha(path.join(back, f));
  for (const f of [
    "app/lib/api.ts",
    "app/stocks/page.tsx",
    "app/stocks/digital-twin/page.tsx",
    "middleware.ts",
    "next.config.ts",
  ])
    report.fingerprints["frontend/" + f] = sha(path.join(front, f));
  try {
    const s = fs.statfsSync(root);
    report.disk_available_gib =
      Math.round(((s.bavail * s.bsize) / 1024 ** 3) * 10) / 10;
  } catch {}
  if (!report.backend.exists || !report.frontend.exists) {
    report.database = { status: "APPLICATION_PATH_MISSING" };
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const source = read(path.join(back, "server.js"));
  report.integration = {
    listen_anchors: (source.match(/app\.listen\s*\(/g) || []).length,
    existing_router: source.includes("routes/digital-twin"),
    authenticateToken: /\b(?:async\s+)?function\s+authenticateToken\s*\(/.test(
      source,
    ),
    getEffectiveCompanyId: /\bfunction\s+getEffectiveCompanyId\s*\(/.test(
      source,
    ),
    pool_declared: /(?:const|let|var)\s+pool\s*=/.test(source),
  };
  if (
    !backendApp ||
    path.resolve(backendApp.pm2_env?.pm_cwd || "") !== path.resolve(back)
  ) {
    report.database = { status: "PM2_BACKEND_PATH_REQUIRES_REVIEW" };
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  let db, client;
  try {
    const requireBackend = createRequire(path.join(back, "package.json"));
    const envPath = path.join(back, ".env");
    const envFile = fs.existsSync(envPath)
      ? requireBackend("dotenv").parse(fs.readFileSync(envPath))
      : {};
    const config = poolConfig(source, {
      ...envFile,
      ...process.env,
      ...runtimeEnv,
    });
    report.database = {
      status: "CONNECTING",
      configuration: config.connectionString
        ? "DATABASE_URL"
        : "EXPLICIT_POOL_VALUES",
    };
    const { Pool } = requireBackend("pg");
    db = new Pool({
      ...config,
      max: 1,
      connectionTimeoutMillis: 5000,
      options:
        "-c default_transaction_read_only=on -c statement_timeout=8000 -c lock_timeout=2000",
    });
    client = await db.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const tables = Object.keys(required);
    const columns = (
      await client.query(
        "SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=ANY($1::text[])",
        [tables],
      )
    ).rows;
    const missing = [];
    for (const [table, fields] of Object.entries(required))
      for (const column of fields.split(" "))
        if (
          !columns.some(
            (c) => c.table_name === table && c.column_name === column,
          )
        )
          missing.push(table + "." + column);
    report.database.status = missing.length
      ? "SCHEMA_ADAPTATION_REQUIRED"
      : "REQUIRED_COLUMNS_PRESENT";
    report.database.missing_columns = missing;
    report.database.column_types = columns
      .filter((c) =>
        [
          "id",
          "company_id",
          "warehouse_id",
          "location_id",
          "product_id",
          "stock",
          "quantity",
          "reserved_quantity",
        ].includes(c.column_name),
      )
      .map((c) => `${c.table_name}.${c.column_name}:${c.data_type}`);
    report.database.existing_dt_tables = (
      await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname=current_schema() AND tablename LIKE 'dt\\_%' ESCAPE '\\'",
      )
    ).rows.map((r) => r.tablename);
    if (!missing.length) {
      report.database.integrity = (
        await client.query(
          `SELECT count(*)::int AS managed_products_with_mismatch FROM (SELECT p.id FROM products p LEFT JOIN stock_location_balances b ON b.company_id=p.company_id AND b.product_id=p.id WHERE p.location_managed=TRUE GROUP BY p.id HAVING p.stock::numeric<>COALESCE(sum(b.quantity),0)) x`,
        )
      ).rows[0];
      report.database.invalid_balances = (
        await client.query(
          `SELECT count(*)::int AS count FROM stock_location_balances b LEFT JOIN locations l ON l.id=b.location_id AND l.company_id=b.company_id LEFT JOIN products p ON p.id=b.product_id AND p.company_id=b.company_id WHERE l.id IS NULL OR p.id IS NULL OR b.quantity<0 OR b.reserved_quantity<0 OR b.reserved_quantity>b.quantity`,
        )
      ).rows[0].count;
      report.database.coverage = (
        await client.query(
          `SELECT count(*)::int AS products_with_stock, count(*) FILTER(WHERE NOT COALESCE(location_managed,FALSE))::int AS products_not_location_managed, count(*) FILTER(WHERE location_id IS NULL)::int AS products_without_primary_location FROM products WHERE stock<>0`,
        )
      ).rows[0];
    }
    await client.query("COMMIT");
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    report.database = {
      status: "DATABASE_REVIEW_REQUIRED",
      code: /^[A-Z0-9_]+$/.test(e.code || "")
        ? e.code
        : /^[A-Z0-9_]+$/.test(e.message || "")
          ? e.message
          : "CONFIGURATION_OR_CONNECTION_ERROR",
    };
  } finally {
    client?.release();
    if (db) await db.end();
  }
  console.log(JSON.stringify(report, null, 2));
}
if (require.main === module)
  main().catch(() => {
    console.error("DIAGNOSTIC_INCOMPLET — aucune modification du logiciel.");
    process.exitCode = 1;
  });
module.exports = { literal, poolConfig };

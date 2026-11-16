#!/usr/bin/env node
"use strict";
// Lecture seule, sans chargement implicite de .env. Utilise PG* / DATABASE_URL.
// Lancer dans l'environnement de test ou avec un compte PostgreSQL lecture seule.
const { Pool } = require("pg");
const required = {
  companies: ["id", "tenant_id"],
  users: ["id", "company_id", "is_active", "is_super_admin", "role"],
  warehouses: ["id", "company_id", "code", "name", "location"],
  locations: [
    "id",
    "company_id",
    "warehouse_id",
    "zone",
    "rayon",
    "etagere",
    "rayon_code",
    "case_code",
    "level_code",
    "bin_code",
    "full_code",
    "is_active",
    "status",
    "occupancy_status",
    "merged_into_location_id",
  ],
  products: [
    "id",
    "company_id",
    "stock",
    "unit",
    "barcode",
    "location_id",
    "location_managed",
  ],
  stock_location_balances: [
    "company_id",
    "location_id",
    "product_id",
    "quantity",
    "reserved_quantity",
  ],
  stock_movements: [
    "id",
    "company_id",
    "location_id",
    "source_location_id",
    "destination_location_id",
    "source_warehouse_id",
    "destination_warehouse_id",
    "location_stock_before",
    "location_stock_after",
    "destination_stock_before",
    "destination_stock_after",
  ],
  permission_modules: ["module_key", "actions", "is_active"],
  role_permissions: ["company_id", "role", "module_key", "action", "allowed"],
  user_permission_overrides: [
    "company_id",
    "user_id",
    "module_key",
    "action",
    "effect",
  ],
  user_permissions: [
    "user_id",
    "module_key",
    "can_view",
    "can_edit",
    "can_validate",
  ],
  audit_logs: [
    "user_id",
    "company_id",
    "action",
    "entity_type",
    "entity_id",
    "details",
  ],
  user_company_access: ["user_id", "company_id", "is_active"],
};
(async () => {
  const pool = new Pool(
    process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {},
  );
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout='10s'");
    const { rows } = await client.query(
      "SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=ANY($1::text[])",
      [Object.keys(required)],
    );
    const missing = [];
    for (const [table, columns] of Object.entries(required))
      for (const column of columns)
        if (
          !rows.some((r) => r.table_name === table && r.column_name === column)
        )
          missing.push(`${table}.${column}`);
    const report = {
      generated_at: new Date().toISOString(),
      status: missing.length ? "BLOCKED" : "SCHEMA_COLUMNS_PRESENT",
      missing,
      columns: rows,
      notes: [
        "Présence des colonnes uniquement : ne certifie ni données, ni unités, ni déploiement.",
        "Les plans physiques doivent être relevés et validés sur site.",
      ],
    };
    if (!missing.length) {
      report.integrity = (
        await client.query(
          `SELECT count(*)::int AS mismatches FROM (SELECT p.id FROM products p LEFT JOIN stock_location_balances b ON b.company_id=p.company_id AND b.product_id=p.id WHERE p.location_managed=TRUE GROUP BY p.id HAVING p.stock::numeric<>COALESCE(sum(b.quantity),0)) x`,
        )
      ).rows[0];
      report.orphans = (
        await client.query(
          `SELECT count(*)::int AS invalid_balances FROM stock_location_balances b LEFT JOIN locations l ON l.id=b.location_id AND l.company_id=b.company_id LEFT JOIN products p ON p.id=b.product_id AND p.company_id=b.company_id WHERE l.id IS NULL OR p.id IS NULL OR b.quantity<0 OR b.reserved_quantity<0 OR b.reserved_quantity>b.quantity`,
        )
      ).rows[0];
      if (report.integrity.mismatches || report.orphans.invalid_balances)
        report.status = "BLOCKED";
    }
    await client.query("COMMIT");
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "BLOCKED") process.exitCode = 2;
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error(
      "Audit indisponible. Code PostgreSQL :",
      e.code || "CONNECTION_ERROR",
    );
    process.exitCode = 1;
  } finally {
    client?.release();
    await pool.end();
  }
})();

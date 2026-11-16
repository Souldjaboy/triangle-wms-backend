const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");
const express = require("express");
const S = require("../../digital-twin/service");
let pg, pool, server, base;
const req = {
  user: { id: 1, company_id: 1 },
  tenant_id: "triangle",
  ip: "127.0.0.1",
  get: () => "",
  headers: {},
};
let ctx;
function fixture() {
  let parent = null;
  return ["warehouse", "zone", "aisle", "rack", "level", "bin"].map(
    (kind, i) => {
      const id = randomUUID(),
        n = {
          id,
          parent_id: parent,
          kind,
          code: "K" + i,
          name: "",
          geometry: {
            x: 0,
            y: 0,
            z: 0,
            width: 10,
            height: 10,
            depth: 10,
            yaw: 0,
          },
          location_id: kind === "bin" ? 1 : null,
          capacity: kind === "bin" ? 100 : null,
          capacity_unit: kind === "bin" ? "carton" : null,
          operational_state: "active",
        };
      parent = id;
      return n;
    },
  );
}
before(async () => {
  pg = new PGlite();
  pool = {
    query: (sql, p) => pg.query(sql, p),
    connect: async () => ({
      query: (sql, p) => pg.query(sql, p),
      release: () => {},
    }),
  };
  await pg.exec(`CREATE TABLE companies(id int primary key,tenant_id text); INSERT INTO companies VALUES(1,'triangle'),(2,'triangle'),(3,'other');
 CREATE TABLE users(id int primary key,email text,fullname text,role text,company_id int,is_active boolean,is_super_admin boolean,warehouse_id int);
 INSERT INTO users VALUES(1,'admin@test','Admin','admin',1,true,false,null),(2,'worker@test','Magasinier','magasinier',1,true,false,1),(3,'outsider@test','Autre','admin',2,true,false,null),(4,'super@test','Super','super_admin',1,true,true,null);
 CREATE TABLE warehouses(id int primary key,company_id int,code text,name text,location text,status text);INSERT INTO warehouses VALUES(1,1,'A','Entrepôt A','Bamako','Actif'),(2,1,'B','Entrepôt B','','Actif'),(3,2,'C','Autre entreprise','','Actif');
 CREATE TABLE locations(id int primary key,company_id int,warehouse_id int,warehouse_code text,zone text,rayon text,etagere text,rayon_code text,case_code text,level_code text,bin_code text,full_code text,emplacement_code text,is_active boolean,occupancy_status text,merged_into_location_id int,status text);
 INSERT INTO locations VALUES(1,1,1,'A','Z','R','N','Z','R','N','B01','A-Z-R-N-B01','A-Z-R-N',true,'OCCUPIED',null,'Disponible'),(2,2,3,'C','Z','R','N','Z','R','N','B01','C-Z-R-N-B01','C-Z-R-N',true,'OCCUPIED',null,'Disponible');
 CREATE TABLE products(id int primary key,company_id int,name text,reference text,unit text,barcode text,category text,stock numeric,location_id int,location_managed boolean);
 INSERT INTO products VALUES(1,1,'Produit réel','P001','carton','123','test',20,1,true),(2,2,'Produit privé','SECRET','carton','456','test',50,2,true);
 CREATE TABLE stock_location_balances(id int primary key,company_id int,location_id int,product_id int,quantity numeric,reserved_quantity numeric);
 INSERT INTO stock_location_balances VALUES(1,1,1,1,20,5),(2,2,2,2,50,0);
 CREATE TABLE stock_movements(id int primary key,company_id int,type text,quantity numeric,status text,created_at timestamptz,product_name text,product_reference text,location_id int,source_location_id int,destination_location_id int,source_warehouse_id int,destination_warehouse_id int,location_stock_before numeric,location_stock_after numeric,destination_stock_before numeric,destination_stock_after numeric);
 CREATE TABLE audit_logs(id serial primary key,user_id int,user_email text,user_role text,company_id int,action text,entity_type text,entity_id int,ip_address text,user_agent text,details jsonb);
 CREATE TABLE user_company_access(user_id int,company_id int,is_active boolean);
 CREATE TABLE permission_modules(module_key text,parent_key text,label text,description text,sort_order int,is_active boolean,is_system boolean,actions text[]);
 INSERT INTO permission_modules VALUES('stock',null,'Stock','',1,true,true,ARRAY['view','visible','update','validate']);
 CREATE TABLE role_permissions(company_id int,role text,module_key text,action text,allowed boolean);
 INSERT INTO role_permissions VALUES(1,'magasinier','stock','view',true),(1,'magasinier','stock','visible',true);
 CREATE TABLE user_permission_overrides(company_id int,user_id int,module_key text,action text,effect text);
 CREATE TABLE user_permissions(user_id int,module_key text,can_view boolean,can_create boolean,can_edit boolean,can_delete boolean,can_validate boolean);`);
  await pg.exec(
    fs
      .readFileSync(
        require("node:path").join(__dirname, "../../sql/064_digital_twin.sql"),
        "utf8",
      )
      .replace(/^\\.*$/gm, ""),
  );
  ctx = await S.context(pool, req, (_r, f) => f);
  const app = express();
  app.use(express.json());
  app.use(
    "/digital-twin",
    require("../../routes/digital-twin")({
      pool,
      getEffectiveCompanyId: (r, f) =>
        Number(r.headers["x-active-company-id"] || f),
      authenticateToken: (r, s, n) => {
        if (!r.headers.authorization)
          return s.status(401).json({ error: "Token manquant" });
        r.user = { id: Number(r.headers.authorization), company_id: 1 };
        r.tenant_id = "triangle";
        n();
      },
    }),
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/digital-twin`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  await pg.close();
});
test("company + warehouse scopes use current user and explicit grants", async () => {
  assert.deepEqual(
    (await S.warehouses(pool, ctx)).map((w) => w.id),
    [1, 2],
  );
  const worker = await S.context(
    pool,
    { ...req, user: { id: 2 } },
    (_r, f) => f,
  );
  assert.deepEqual(
    (await S.warehouses(pool, worker)).map((w) => w.id),
    [1],
  );
  await assert.rejects(() => S.requireWarehouse(pool, worker, 2), {
    status: 404,
  });
  await assert.rejects(() => S.context(pool, req, () => 2), { status: 403 });
  await assert.rejects(
    () => S.context(pool, { ...req, user: { id: 4 } }, () => 2),
    { status: 403 },
  );
  await assert.rejects(
    () => S.context(pool, { ...req, user: { id: 4 } }, () => 3),
    { status: 403 },
  );
});
test("API requires auth and prevents direct-object warehouse disclosure", async () => {
  const bodySelection = await S.context(
    pool,
    { ...req, body: { company_id: 2 } },
    (r, fallback) => r.body.company_id || fallback,
  );
  assert.equal(bodySelection.companyId, 1);
  assert.equal((await fetch(base + "/warehouses")).status, 401);
  assert.equal(
    (await fetch(base + "/warehouses/2", { headers: { Authorization: "2" } }))
      .status,
    404,
  );
  assert.equal(
    (await fetch(base + "/warehouses/3", { headers: { Authorization: "1" } }))
      .status,
    404,
  );
  const r = await fetch(base + "/search?q=SECRET", {
    headers: { Authorization: "1" },
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).results.length, 0);
});
test("draft/publication audit are transactional and never alter stocks", async () => {
  const nodes = fixture();
  await pg.exec("BEGIN");
  const draft = await S.saveDraft(pool, ctx, req, 1, {
    nodes,
    high_threshold: 80,
    base_id: null,
  });
  await pg.exec("COMMIT");
  assert.equal((await S.snapshot(pool, ctx, 1)).layout, null);
  await pg.exec("BEGIN");
  await S.publish(pool, ctx, req, 1, draft.id);
  await pg.exec("COMMIT");
  const data = await S.snapshot(pool, ctx, 1);
  assert.equal(
    data.nodes.find((n) => n.kind === "warehouse").metrics.percent,
    20,
  );
  assert.equal(data.balances[0].available, "15");
  assert.equal(
    (await pool.query("SELECT stock FROM products WHERE id=1")).rows[0].stock,
    "20",
  );
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM audit_logs")).rows[0].n,
    2,
  );
  const next = { nodes, base_id: draft.id, high_threshold: 85 };
  await pg.exec("BEGIN");
  const d1 = await S.saveDraft(pool, ctx, req, 1, next);
  const d2 = await S.saveDraft(pool, ctx, req, 1, next);
  await pg.exec("COMMIT");
  await pg.exec("BEGIN");
  await S.publish(pool, ctx, req, 1, d1.id);
  await pg.exec("COMMIT");
  await pg.exec("BEGIN");
  await assert.rejects(() => S.publish(pool, ctx, req, 1, d2.id), {
    status: 409,
  });
  await pg.exec("ROLLBACK");
});
test("committed movement refresh and rollback are consistent", async () => {
  await pg.exec(
    "BEGIN; UPDATE stock_location_balances SET quantity=40 WHERE id=1; UPDATE products SET stock=40 WHERE id=1; COMMIT;",
  );
  assert.equal(
    (await S.snapshot(pool, ctx, 1)).nodes.find((n) => n.kind === "warehouse")
      .metrics.percent,
    40,
  );
  await pg.exec(
    "BEGIN; UPDATE stock_location_balances SET quantity=99 WHERE id=1; ROLLBACK;",
  );
  assert.equal(
    (await S.snapshot(pool, ctx, 1)).nodes.find((n) => n.kind === "warehouse")
      .metrics.percent,
    40,
  );
});
test("search by rack returns real descendants; non-admin cannot configure", async () => {
  const r = await fetch(base + "/search?q=K3", {
    headers: { Authorization: "1" },
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.results.length, 1);
  assert.equal(j.results[0].location_id, 1);
  assert.equal(
    (
      await fetch(base + "/warehouses/1/layouts", {
        method: "POST",
        headers: { Authorization: "2", "Content-Type": "application/json" },
        body: JSON.stringify({ nodes: fixture(), high_threshold: 80 }),
      })
    ).status,
    403,
  );
});
test("audit failure rolls back the entire draft", async () => {
  const data = await S.snapshot(pool, ctx, 1),
    before = (await pool.query("SELECT count(*)::int AS n FROM dt_layouts"))
      .rows[0].n;
  await pg.exec("ALTER TABLE audit_logs RENAME TO audit_logs_unavailable");
  try {
    const r = await fetch(base + "/warehouses/1/layouts", {
      method: "POST",
      headers: { Authorization: "1", "Content-Type": "application/json" },
      body: JSON.stringify({
        nodes: data.nodes,
        base_id: data.layout.id,
        high_threshold: 80,
      }),
    });
    assert.equal(r.status, 503);
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM dt_layouts")).rows[0].n,
      before,
    );
  } finally {
    await pg.exec("ALTER TABLE audit_logs_unavailable RENAME TO audit_logs");
  }
});
test("mismatches hide capacity without changing stock, including an empty primary bin", async () => {
  await pg.exec("BEGIN");
  try {
    await pg.exec("UPDATE products SET stock=90 WHERE id=1");
    let data = await S.snapshot(pool, ctx, 1);
    assert.deepEqual(
      data.discrepancies.map((p) => p.id),
      [1],
    );
    assert.equal(data.balances[0].quantity, "40");
    assert.equal(data.balances[0].unverified, true);
    assert.equal(data.locations[0].unverified, true);
    let metric = data.nodes.find((n) => n.kind === "warehouse").metrics;
    assert.equal(metric.percent, null);
    assert.equal(metric.capacities[0].available, null);
    assert.equal(metric.empty, 0);
    assert.equal(metric.overloaded, 0);
    assert.equal((await S.snapshot(pool, ctx, 2)).discrepancies.length, 0);
    assert.equal("stock" in data.discrepancies[0], false);
    await pg.exec("DELETE FROM stock_location_balances WHERE id=1");
    data = await S.snapshot(pool, ctx, 1);
    metric = data.nodes.find((n) => n.kind === "warehouse").metrics;
    assert.equal(data.discrepancies.length, 1);
    assert.equal(metric.empty, 0);
    assert.equal(metric.percent, null);
    assert.equal(
      (await pool.query("SELECT stock FROM products WHERE id=1")).rows[0].stock,
      "90",
    );
  } finally {
    await pg.exec("ROLLBACK");
  }
});
test("integrity uses all company balances but does not disclose an inaccessible location", async () => {
  await pg.exec("BEGIN");
  try {
    await pg.exec(`INSERT INTO locations(id,company_id,warehouse_id) VALUES(3,1,2);
      INSERT INTO stock_location_balances VALUES(3,1,3,1,10,0);
      UPDATE products SET stock=50,location_id=3 WHERE id=1;`);
    let data = await S.snapshot(pool, ctx, 1);
    assert.equal(data.discrepancies.length, 0);
    assert.equal(data.balances.length, 1);
    assert.equal(data.balances[0].quantity, "40");
    await pg.exec("UPDATE products SET stock=60 WHERE id=1");
    data = await S.snapshot(pool, ctx, 1);
    assert.equal(data.discrepancies[0].location_id, null);
    assert.equal(data.balances[0].unverified, true);
    await pg.exec("UPDATE products SET stock=50 WHERE id=1");
    assert.equal(
      (await S.snapshot(pool, ctx, 1)).nodes.find((n) => n.kind === "warehouse")
        .metrics.percent,
      40,
    );
  } finally {
    await pg.exec("ROLLBACK");
  }
});
test("a company grant does not carry legacy stock permissions to another company", async () => {
  await pg.exec("BEGIN");
  try {
    await pg.exec(`INSERT INTO user_company_access VALUES(2,2,true);
      INSERT INTO user_permissions VALUES(2,'stock',true,false,false,false,false);`);
    await assert.rejects(
      () => S.context(pool, { ...req, user: { id: 2 } }, () => 2),
      { status: 403 },
    );
  } finally {
    await pg.exec("ROLLBACK");
  }
});
test("explicit DENY and inactive user revoke access immediately", async () => {
  await pg.exec(
    "INSERT INTO user_permission_overrides VALUES(1,2,'stock','view','DENY')",
  );
  assert.equal(
    (await fetch(base + "/warehouses", { headers: { Authorization: "2" } }))
      .status,
    403,
  );
  await pg.exec("UPDATE users SET is_active=false WHERE id=1");
  assert.equal(
    (await fetch(base + "/warehouses", { headers: { Authorization: "1" } }))
      .status,
    403,
  );
});

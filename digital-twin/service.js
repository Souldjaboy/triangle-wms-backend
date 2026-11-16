"use strict";
const { error, validateLayout, summarize } = require("./model");
const rules = require("../services/location-rules");
const permissions = require("../services/permissions");
const ADMIN = ["super_admin", "admin", "administrateur"];
async function context(pool, req, getCompany) {
  const user = (
    await pool.query(
      "SELECT id, email, fullname, role, company_id, is_active, is_super_admin, to_jsonb(users)->>'warehouse_id' AS warehouse_id FROM users WHERE id=$1",
      [req.user.id],
    )
  ).rows[0];
  if (!user || user.is_active !== true)
    throw error("Compte indisponible.", 403);
  const companyId = Number(getCompany(req, user.company_id));
  if (!Number.isSafeInteger(companyId) || companyId <= 0)
    throw error("Entreprise requise.", 403);
  const company = (
    await pool.query("SELECT id, tenant_id FROM companies WHERE id=$1", [
      companyId,
    ])
  ).rows[0];
  if (!company || company.tenant_id !== req.tenant_id)
    throw error("Entreprise non autorisée.", 403);
  const superUser = permissions.estSuperAdmin(user);
  if (Number(user.company_id) !== companyId) {
    if (!superUser) throw error("Entreprise non autorisée.", 403);
    const access = await pool.query(
      "SELECT 1 FROM user_company_access WHERE user_id=$1 AND company_id=$2 AND is_active=TRUE",
      [user.id, companyId],
    );
    if (!access.rows.length) throw error("Entreprise non autorisée.", 403);
  }
  // Contexte rechargé en base : les révocations ne dépendent pas du JWT ancien.
  const current = { ...user, company_id: companyId };
  const rights = await permissions.chargerContexte(pool, current);
  if (!permissions.decider(rights, "stock", "view").autorise)
    throw error("Consultation du stock non autorisée.", 403);
  return {
    companyId,
    user: current,
    admin: ADMIN.includes(String(user.role).toLowerCase()) || superUser,
    allWarehouses:
      permissions.ROLES_ADMIN.includes(String(user.role).toLowerCase()) ||
      superUser,
    canConfigure:
      (ADMIN.includes(String(user.role).toLowerCase()) || superUser) &&
      permissions.decider(rights, "stock.emplacement", "update").autorise,
    canPublish:
      (ADMIN.includes(String(user.role).toLowerCase()) || superUser) &&
      permissions.decider(rights, "stock.emplacement", "validate").autorise,
  };
}
async function warehouses(db, ctx) {
  return (
    await db.query(
      `SELECT w.id,w.code,w.name,w.location,w.status FROM warehouses w
    WHERE w.company_id=$1 AND ($2::boolean OR w.id=$3::integer OR EXISTS(
      SELECT 1 FROM dt_warehouse_access a WHERE a.company_id=w.company_id AND a.warehouse_id=w.id AND a.user_id=$4)) ORDER BY w.code,w.id`,
      [
        ctx.companyId,
        ctx.allWarehouses,
        ctx.user.warehouse_id || null,
        ctx.user.id,
      ],
    )
  ).rows;
}
async function requireWarehouse(db, ctx, id) {
  const w = (await warehouses(db, ctx)).find(
    (w) => Number(w.id) === Number(id),
  );
  if (!w) throw error("Entrepôt introuvable.", 404);
  return w;
}
async function locations(db, ctx, id) {
  return (
    await db.query(
      `SELECT l.id,l.warehouse_id,l.warehouse_code,l.zone,l.rayon,l.etagere,l.rayon_code,l.case_code,l.level_code,l.bin_code,l.full_code,l.emplacement_code,l.is_active,l.status,l.occupancy_status,l.merged_into_location_id
    FROM locations l WHERE l.company_id=$1 AND l.warehouse_id=$2 ORDER BY l.id`,
      [ctx.companyId, id],
    )
  ).rows;
}
async function balances(db, ctx, id) {
  return (
    await db.query(
      `SELECT b.location_id,b.product_id,b.quantity,b.reserved_quantity,(b.quantity-b.reserved_quantity) AS available,
    p.name,p.reference,p.unit,p.barcode,p.category,p.location_managed
    FROM stock_location_balances b JOIN locations l ON l.id=b.location_id AND l.company_id=b.company_id
    JOIN products p ON p.id=b.product_id AND p.company_id=b.company_id
    WHERE b.company_id=$1 AND l.warehouse_id=$2 ORDER BY l.id,p.id`,
      [ctx.companyId, id],
    )
  ).rows;
}
async function published(db, ctx, id) {
  return (
    (
      await db.query(
        "SELECT id,base_id,high_threshold,created_at,published_at,state FROM dt_layouts WHERE company_id=$1 AND warehouse_id=$2 AND state='published'",
        [ctx.companyId, id],
      )
    ).rows[0] || null
  );
}
async function nodes(db, layoutId) {
  return (
    await db.query(
      "SELECT id,parent_id,kind,code,name,zone_type,location_id,geometry,capacity,capacity_unit,operational_state FROM dt_nodes WHERE layout_id=$1 ORDER BY kind,code",
      [layoutId],
    )
  ).rows;
}
async function snapshot(db, ctx, id) {
  const warehouse = await requireWarehouse(db, ctx, id),
    layout = await published(db, ctx, id);
  const bins = await locations(db, ctx, id),
    stock = await balances(db, ctx, id);
  if (
    stock.some(
      (b) =>
        !Number.isFinite(Number(b.quantity)) ||
        !Number.isFinite(Number(b.reserved_quantity)) ||
        Number(b.quantity) < 0 ||
        Number(b.reserved_quantity) < 0 ||
        Number(b.reserved_quantity) > Number(b.quantity),
    )
  )
    throw error(
      "Balances incohérentes : vérification du stock nécessaire.",
      409,
    );
  const model = layout ? await nodes(db, layout.id) : [];
  const unallocated = (
    await db.query(
      `SELECT p.id,p.reference,p.name,p.unit,p.stock,p.location_id FROM products p
    JOIN locations l ON l.id=p.location_id AND l.company_id=p.company_id
    WHERE p.company_id=$1 AND l.warehouse_id=$2 AND COALESCE(p.location_managed,FALSE)=FALSE AND p.stock<>0`,
      [ctx.companyId, id],
    )
  ).rows;
  const uncertain = new Set(unallocated.map((p) => Number(p.location_id)));
  // Les stocks historiques non répartis ne permettent pas d'attester qu'un bin est vide.
  model.forEach((n) => {
    n.unverified = uncertain.has(Number(n.location_id));
    const l = bins.find((l) => Number(l.id) === Number(n.location_id));
    if (l && (l.is_active === false || l.occupancy_status === "INACTIVE"))
      n.operational_state = "inactive";
    else if (l && /bloqu|quarant|maintenance/i.test(l.status || ""))
      n.operational_state = "blocked";
  });
  summarize(model, stock, Number(layout?.high_threshold || 80));
  const linked = new Set(model.map((n) => Number(n.location_id)));
  return {
    warehouse,
    layout,
    nodes: model,
    locations: bins.map((l) => ({
      ...l,
      physical: rules.isPhysicalBin(l),
      unverified: uncertain.has(Number(l.id)),
      configuration_issue: rules.rejectionReason(l),
    })),
    balances: stock,
    unmapped: bins.filter((l) => !linked.has(Number(l.id))).map((l) => l.id),
    unallocated,
    capabilities: { configure: ctx.canConfigure, publish: ctx.canPublish },
    as_of: new Date().toISOString(),
    refresh_seconds: 15,
  };
}
async function audit(db, ctx, req, action, id, details) {
  await db.query(
    `INSERT INTO audit_logs(user_id,user_email,user_role,company_id,action,entity_type,entity_id,ip_address,user_agent,details)
    VALUES($1,$2,$3,$4,$5,'digital_twin_layout',$6,$7,$8,$9)`,
    [
      ctx.user.id,
      ctx.user.email,
      ctx.user.role,
      ctx.companyId,
      action,
      id,
      req.ip || "",
      req.get("user-agent") || "",
      JSON.stringify(details),
    ],
  );
}
async function saveDraft(db, ctx, req, id, body) {
  if (!ctx.canConfigure) throw error("Configuration non autorisée.", 403);
  await requireWarehouse(db, ctx, id);
  const current = await published(db, ctx, id);
  if (String(body.base_id ?? "") !== String(current?.id ?? ""))
    throw error("Le plan publié a changé. Rechargez avant de continuer.", 409);
  const data = validateLayout(
    body,
    await locations(db, ctx, id),
    current ? await nodes(db, current.id) : [],
  );
  const layout = (
    await db.query(
      `INSERT INTO dt_layouts(company_id,warehouse_id,base_id,high_threshold,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,state`,
      [
        ctx.companyId,
        id,
        current?.id || null,
        data.high_threshold,
        ctx.user.id,
      ],
    )
  ).rows[0];
  for (const n of data.nodes)
    await db.query(
      `INSERT INTO dt_nodes(layout_id,id,parent_id,kind,code,name,zone_type,location_id,geometry,capacity,capacity_unit,operational_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        layout.id,
        n.id,
        n.parent_id,
        n.kind,
        n.code,
        n.name,
        n.zone_type,
        n.location_id,
        n.geometry,
        n.capacity,
        n.capacity_unit,
        n.operational_state,
      ],
    );
  await audit(db, ctx, req, "digital_twin.draft", layout.id, {
    warehouse_id: id,
    nodes: data.nodes.length,
  });
  return layout;
}
async function publish(db, ctx, req, id, layoutId) {
  if (!ctx.canPublish) throw error("Publication du plan non autorisée.", 403);
  await requireWarehouse(db, ctx, id);
  await db.query(
    "SELECT id FROM warehouses WHERE id=$1 AND company_id=$2 FOR UPDATE",
    [id, ctx.companyId],
  );
  const draft = (
    await db.query(
      "SELECT * FROM dt_layouts WHERE id=$1 AND company_id=$2 AND warehouse_id=$3 AND state='draft' FOR UPDATE",
      [layoutId, ctx.companyId, id],
    )
  ).rows[0];
  if (!draft) throw error("Brouillon introuvable.", 404);
  const current = await published(db, ctx, id);
  if (String(draft.base_id ?? "") !== String(current?.id ?? ""))
    throw error("Conflit : une autre version a été publiée.", 409);
  const data = validateLayout(
    { ...draft, nodes: await nodes(db, draft.id) },
    await locations(db, ctx, id),
    current ? await nodes(db, current.id) : [],
  );
  if (data.nodes.some((n) => !n.geometry))
    throw error(
      "Renseignez toutes les dimensions et positions avant publication.",
      409,
    );
  if (current)
    await db.query("UPDATE dt_layouts SET state='archived' WHERE id=$1", [
      current.id,
    ]);
  await db.query(
    "UPDATE dt_layouts SET state='published',published_at=NOW() WHERE id=$1",
    [draft.id],
  );
  await audit(db, ctx, req, "digital_twin.publish", draft.id, {
    warehouse_id: id,
    previous_id: current?.id || null,
  });
  return { id: draft.id, state: "published" };
}
module.exports = {
  context,
  warehouses,
  requireWarehouse,
  locations,
  balances,
  published,
  nodes,
  snapshot,
  audit,
  saveDraft,
  publish,
};

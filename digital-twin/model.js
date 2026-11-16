"use strict";
const rules = require("../services/location-rules");
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const parents = {
  warehouse: null,
  zone: "warehouse",
  aisle: "zone",
  rack: "aisle",
  level: "rack",
  bin: "level",
};
const states = ["active", "blocked", "quarantine", "maintenance", "inactive"];
function error(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const normalizedUnit = (v) =>
  String(v || "")
    .trim()
    .toLowerCase();
function bounds(g) {
  const swap = g.yaw === 90 || g.yaw === 270;
  return {
    x: g.x,
    z: g.z,
    y: g.y,
    w: swap ? g.depth : g.width,
    d: swap ? g.width : g.depth,
    h: g.height,
  };
}
function validateLayout(input, locations, previous = []) {
  if (
    !input ||
    !Array.isArray(input.nodes) ||
    input.nodes.length < 1 ||
    input.nodes.length > 2000
  )
    throw error("Le plan doit contenir entre 1 et 2 000 éléments.");
  const threshold = Number(input.high_threshold);
  if (!finite(threshold) || threshold <= 0 || threshold >= 100)
    throw error("Seuil élevé invalide.");
  const byId = new Map(),
    codes = new Set(),
    locs = new Set(),
    available = new Map(locations.map((l) => [Number(l.id), l]));
  const nodes = input.nodes.map((n) => {
    if (
      !n ||
      !UUID.test(n.id) ||
      byId.has(n.id) ||
      !Object.hasOwn(parents, n.kind)
    )
      throw error("Identifiant ou type invalide / dupliqué.");
    if (n.parent_id !== null && !UUID.test(n.parent_id))
      throw error("Parent invalide.");
    const code = String(n.code || "").trim(),
      key = `${n.parent_id}|${code.toLowerCase()}`;
    if (!code || code.length > 100 || codes.has(key))
      throw error("Code vide, trop long ou dupliqué dans le même parent.");
    codes.add(key);
    if (!states.includes(n.operational_state))
      throw error("État opérationnel invalide.");
    const g = n.geometry;
    if (g !== null) {
      if (
        !g ||
        !["x", "y", "z", "width", "height", "depth", "yaw"].every((k) =>
          finite(g[k]),
        ) ||
        ["x", "y", "z"].some((k) => g[k] < 0 || g[k] > 10000) ||
        ["width", "height", "depth"].some((k) => g[k] <= 0 || g[k] > 10000) ||
        ![0, 90, 180, 270].includes(g.yaw)
      )
        throw error(
          "Géométrie invalide : mètres, dimensions positives, rotation 0/90/180/270°.",
        );
    }
    const locationId = n.kind === "bin" ? Number(n.location_id) : null;
    if (n.kind === "bin") {
      const l = available.get(locationId);
      if (
        !l ||
        !rules.isPhysicalBin(l) ||
        l.merged_into_location_id ||
        locs.has(locationId)
      )
        throw error("Bin inexistant, ambigu, fusionné ou déjà associé.");
      locs.add(locationId);
    }
    const capacity = n.capacity == null ? null : Number(n.capacity),
      unit = n.capacity_unit == null ? null : normalizedUnit(n.capacity_unit);
    if (
      (capacity === null) !== (unit === null) ||
      (capacity !== null &&
        (!finite(capacity) ||
          capacity <= 0 ||
          !unit ||
          unit.length > 80 ||
          n.kind !== "bin"))
    )
      throw error(
        "Capacité invalide : valeur et unité métier obligatoires pour un bin.",
      );
    const out = {
      id: n.id,
      parent_id: n.parent_id,
      kind: n.kind,
      code,
      name: String(n.name || "").slice(0, 200),
      zone_type:
        n.kind === "zone"
          ? String(n.zone_type || "stockage").slice(0, 80)
          : null,
      location_id: locationId,
      geometry: g
        ? Object.fromEntries(
            ["x", "y", "z", "width", "height", "depth", "yaw"].map((k) => [
              k,
              g[k],
            ]),
          )
        : null,
      capacity,
      capacity_unit: unit,
      operational_state: n.operational_state,
    };
    byId.set(out.id, out);
    return out;
  });
  if (nodes.filter((n) => n.kind === "warehouse").length !== 1)
    throw error("Un seul bâtiment racine est requis.");
  for (const n of nodes) {
    const p = byId.get(n.parent_id);
    if (
      n.kind === "warehouse"
        ? n.parent_id !== null
        : !p || p.kind !== parents[n.kind]
    )
      throw error(
        "Hiérarchie invalide : entrepôt → zone → allée → rack → niveau → bin.",
      );
    if (n.geometry && p?.geometry) {
      const a = bounds(n.geometry),
        b = bounds(p.geometry),
        e = 0.00001;
      if (
        a.x < b.x - e ||
        a.y < b.y - e ||
        a.z < b.z - e ||
        a.x + a.w > b.x + b.w + e ||
        a.y + a.h > b.y + b.h + e ||
        a.z + a.d > b.z + b.d + e
      )
        throw error(`Élément ${n.code} hors des limites de son parent.`);
    }
  }
  // Deux racks ou deux bins frères ne peuvent pas occuper le même volume.
  const siblings = new Map();
  for (const n of nodes.filter(
    (n) =>
      ["rack", "bin"].includes(n.kind) &&
      n.geometry &&
      n.operational_state !== "inactive",
  )) {
    const key = n.parent_id + "|" + n.kind,
      list = siblings.get(key) || [],
      a = bounds(n.geometry),
      e = 0.00001;
    for (const other of list) {
      const b = bounds(other.geometry);
      if (
        a.x < b.x + b.w - e &&
        a.x + a.w > b.x + e &&
        a.y < b.y + b.h - e &&
        a.y + a.h > b.y + e &&
        a.z < b.z + b.d - e &&
        a.z + a.d > b.z + e
      )
        throw error(`Chevauchement physique entre ${n.code} et ${other.code}.`);
    }
    list.push(n);
    siblings.set(key, list);
  }
  for (const old of previous) {
    const n = byId.get(old.id);
    if (
      !n ||
      n.kind !== old.kind ||
      n.location_id !==
        (old.location_id == null ? null : Number(old.location_id))
    )
      throw error(
        "Identité publiée à préserver : désactiver un élément au lieu de le supprimer ou réaffecter.",
      );
  }
  return { nodes, high_threshold: threshold };
}
// Aucune conversion implicite entre pièces, cartons, kg et m³.
function measure(node, balances) {
  const unit = normalizedUnit(node.capacity_unit),
    capacity = node.capacity == null ? null : Number(node.capacity);
  const occupied = balances.some((b) => Number(b.quantity) > 0);
  const unverified = node.unverified === true;
  const known =
    !unverified &&
    balances.filter((b) => Number(b.quantity) > 0).length <= 1 &&
    capacity !== null &&
    capacity > 0 &&
    balances.every(
      (b) => Number(b.quantity) === 0 || normalizedUnit(b.unit) === unit,
    );
  const used = known
    ? balances.reduce((s, b) => s + Number(b.quantity), 0)
    : null;
  return {
    capacity,
    unit: unit || null,
    used,
    available: used === null ? null : Math.max(0, capacity - used),
    percent: used === null ? null : (100 * used) / capacity,
    occupied,
    unverified,
    reserved: balances.some((b) => Number(b.reserved_quantity) > 0),
  };
}
function summarize(nodes, balances, threshold = 80) {
  const byId = new Map(nodes.map((n) => [n.id, n])),
    byLoc = new Map();
  for (const b of balances) {
    const k = Number(b.location_id);
    if (!byLoc.has(k)) byLoc.set(k, []);
    byLoc.get(k).push(b);
  }
  const children = new Map();
  for (const n of nodes) {
    if (!children.has(n.parent_id)) children.set(n.parent_id, []);
    children.get(n.parent_id).push(n);
  }
  function visit(n, inherited = "active") {
    const state = inherited === "active" ? n.operational_state : inherited;
    const leaves =
      n.kind === "bin"
        ? [{ ...measure(n, byLoc.get(Number(n.location_id)) || []), state }]
        : (children.get(n.id) || []).flatMap((c) => visit(c, state));
    const units = {};
    for (const l of leaves) {
      if (l.capacity !== null && l.unit) {
        units[l.unit] ??= { capacity: 0, used: 0, known: true, bins: 0 };
        const u = units[l.unit];
        u.capacity += l.capacity;
        u.bins++;
        if (l.used === null) u.known = false;
        else u.used += l.used;
      }
    }
    const capacities = Object.entries(units).map(([unit, u]) => ({
      unit,
      capacity: u.capacity,
      used: u.known ? u.used : null,
      percent: u.known ? (100 * u.used) / u.capacity : null,
      available: u.known ? Math.max(0, u.capacity - u.used) : null,
      bins: u.bins,
    }));
    n.metrics = {
      bins: leaves.length,
      occupied: leaves.filter((l) => l.occupied).length,
      empty: leaves.filter((l) => !l.occupied && !l.unverified).length,
      unverified: leaves.filter((l) => l.unverified).length,
      blocked: leaves.filter((l) => l.state !== "active").length,
      reserved: leaves.filter((l) => l.reserved).length,
      full: leaves.filter((l) => l.percent === 100).length,
      overloaded: leaves.filter((l) => l.percent !== null && l.percent > 100)
        .length,
      unknown: leaves.filter((l) => l.percent === null).length,
      capacities,
      percent:
        capacities.length === 1 && capacities[0].bins === leaves.length
          ? capacities[0].percent
          : null,
      high_threshold: threshold,
    };
    n.effective_state = state;
    return leaves;
  }
  nodes
    .filter((n) => !n.parent_id || !byId.has(n.parent_id))
    .forEach((n) => visit(n));
  return nodes;
}
module.exports = {
  error,
  bounds,
  validateLayout,
  measure,
  summarize,
  normalizedUnit,
};

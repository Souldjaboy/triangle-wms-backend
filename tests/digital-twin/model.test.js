const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const {
  validateLayout,
  measure,
  summarize,
} = require("../../digital-twin/model");
const kinds = ["warehouse", "zone", "aisle", "rack", "level", "bin"];
function fixture() {
  let parent = null;
  return kinds.map((kind, i) => {
    const n = {
      id: randomUUID(),
      parent_id: parent,
      kind,
      code: "K" + i,
      name: "",
      geometry: { x: 0, y: 0, z: 0, width: 10, height: 10, depth: 10, yaw: 0 },
      location_id: kind === "bin" ? 1 : null,
      capacity: kind === "bin" ? 100 : null,
      capacity_unit: kind === "bin" ? "carton" : null,
      operational_state: "active",
    };
    parent = n.id;
    return n;
  });
}
const locs = [
  {
    id: 1,
    warehouse_code: "MAG-A",
    rayon_code: "Z01",
    case_code: "R01",
    bin_code: "B01",
  },
];
test("valid hierarchy keeps official location identity", () => {
  const nodes = fixture();
  assert.equal(
    validateLayout({ nodes, high_threshold: 80 }, locs).nodes[5].location_id,
    1,
  );
});
test("unknown or mixed units never fabricate occupancy", () => {
  assert.equal(
    measure({ capacity: 10, capacity_unit: "carton" }, [
      { quantity: 5, unit: "pièce" },
    ]).percent,
    null,
  );
  assert.equal(
    measure({ capacity: null, capacity_unit: null }, []).percent,
    null,
  );
  assert.equal(
    measure({ capacity: 10, capacity_unit: "carton", unverified: true }, [])
      .percent,
    null,
  );
});
test("full is distinct from overload; reservations do not free physical space", () => {
  const nodes = fixture();
  summarize(nodes, [
    { location_id: 1, quantity: 100, reserved_quantity: 30, unit: "carton" },
  ]);
  assert.equal(nodes[0].metrics.full, 1);
  assert.equal(nodes[0].metrics.overloaded, 0);
  assert.equal(nodes[0].metrics.percent, 100);
  assert.equal(nodes[0].metrics.reserved, 1);
  summarize(nodes, [
    { location_id: 1, quantity: 110, reserved_quantity: 0, unit: "carton" },
  ]);
  assert.equal(nodes[0].metrics.overloaded, 1);
  assert.equal(nodes[0].metrics.percent, 110);
});
test("empty blocked bin stays empty and blocked in separate indicators", () => {
  const nodes = fixture();
  nodes[1].operational_state = "blocked";
  summarize(nodes, []);
  assert.equal(nodes[0].metrics.empty, 1);
  assert.equal(nodes[0].metrics.blocked, 1);
});
test("unverified legacy stock does not make an empty bin", () => {
  const nodes = fixture();
  nodes[5].unverified = true;
  summarize(nodes, []);
  assert.equal(nodes[0].metrics.empty, 0);
  assert.equal(nodes[0].metrics.unverified, 1);
});
test("reject duplicates, invalid hierarchy, missing parents and impossible geometry", () => {
  for (const mutate of [
    (n) => (n[5].location_id = 2),
    (n) => (n[5].parent_id = n[1].id),
    (n) => (n[1].geometry.width = 11),
    (n) => (n[3].geometry.width = NaN),
    (n) => (n[2].id = n[1].id),
    (n) => (n[4].geometry.yaw = 45),
  ]) {
    const nodes = fixture();
    mutate(nodes);
    assert.throws(() => validateLayout({ nodes, high_threshold: 80 }, locs));
  }
});
test("reject ambiguous bins and preserve all published IDs", () => {
  const nodes = fixture();
  assert.throws(() =>
    validateLayout({ nodes, high_threshold: 80 }, [
      { ...locs[0], bin_code: "BIN1-2" },
    ]),
  );
  const previous = structuredClone(nodes);
  nodes.splice(5, 1);
  assert.throws(() =>
    validateLayout({ nodes, high_threshold: 80 }, locs, previous),
  );
});
test("aggregate capacities by unit, never average percentages or mix dimensions", () => {
  const nodes = fixture(),
    b = {
      ...nodes[5],
      id: randomUUID(),
      code: "B2",
      location_id: 2,
      capacity: 10,
      capacity_unit: "pièce",
    };
  nodes.push(b);
  summarize(nodes, [
    { location_id: 1, quantity: 50, unit: "carton" },
    { location_id: 2, quantity: 2, unit: "pièce" },
  ]);
  assert.equal(nodes[0].metrics.percent, null);
  assert.equal(nodes[0].metrics.capacities.length, 2);
  b.capacity_unit = "carton";
  summarize(nodes, [
    { location_id: 1, quantity: 50, unit: "carton" },
    { location_id: 2, quantity: 5, unit: "carton" },
  ]);
  assert.equal(nodes[0].metrics.percent, 50);
});
test("physical overlap and multi-reference capacity stay conservative", () => {
  const nodes = fixture();
  nodes.push({ ...nodes[5], id: randomUUID(), code: "B02", location_id: 2 });
  assert.throws(
    () =>
      validateLayout({ nodes, high_threshold: 80 }, [
        ...locs,
        { ...locs[0], id: 2, bin_code: "B02" },
      ]),
    /Chevauchement/,
  );
  assert.equal(
    measure({ capacity: 100, capacity_unit: "carton" }, [
      { quantity: 5, unit: "carton" },
      { quantity: 10, unit: "carton" },
    ]).percent,
    null,
  );
});

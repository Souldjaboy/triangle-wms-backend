"use strict";

/* Tests unitaires du coffre biométrique et du registre des fournisseurs. */

const assert = require("assert");
const crypto = require("crypto");
const coffre = require("../biometrie/crypto/coffre");
const registre = require("../biometrie/providers/registre");
const face = require("../biometrie/providers/face");

const cle = () => crypto.randomBytes(32).toString("hex");
let n = 0;
const attentes = [];
const ok = (titre, fn) => {
  attentes.push(Promise.resolve().then(fn).then(() => { n += 1; console.log(`  ✓ ${titre}`); }));
};
const leve = (fn, code) => {
  try { fn(); } catch (e) { assert.strictEqual(e.code, code, `code attendu ${code}, reçu ${e.code}`); return; }
  assert.fail(`aucune erreur, ${code} attendu`);
};

const K1 = cle();
const env = { BIOMETRIC_ENC_KEY: K1, JWT_SECRET: "secret-jwt-de-test" };
const ctx = { companyId: 7, contexte: "profil:user:12:face:-" };

ok("sans clé : chiffrement refusé (aucun repli en clair)", () => {
  leve(() => coffre.chiffrer(Buffer.from("x"), ctx, { JWT_SECRET: "a" }), "CLE_BIOMETRIQUE_ABSENTE");
  assert.strictEqual(coffre.disponible({}), false);
});
ok("clé trop courte refusée", () => leve(() => coffre.chiffrer("x", ctx, { BIOMETRIC_ENC_KEY: "abcd" }), "CLE_BIOMETRIQUE_INVALIDE"));
ok("la clé biométrique ne peut pas être JWT_SECRET", () => {
  const k = cle();
  leve(() => coffre.chiffrer("x", ctx, { BIOMETRIC_ENC_KEY: k, JWT_SECRET: k }), "CLE_BIOMETRIQUE_INVALIDE");
});
ok("aller-retour chiffré, valeur préfixée bv1, jamais lisible", () => {
  const donnees = crypto.randomBytes(512);
  const v = coffre.chiffrer(donnees, ctx, env);
  assert.ok(v.startsWith("bv1.k1."));
  assert.ok(!v.includes(donnees.toString("base64")));
  assert.ok(coffre.dechiffrer(v, ctx, env).equals(donnees));
});
ok("deux chiffrements du même gabarit diffèrent (IV aléatoire)", () => {
  const d = Buffer.from("gabarit");
  assert.notStrictEqual(coffre.chiffrer(d, ctx, env), coffre.chiffrer(d, ctx, env));
});
ok("gabarit déplacé vers une autre société : refusé", () => {
  const v = coffre.chiffrer("g", ctx, env);
  leve(() => coffre.dechiffrer(v, { ...ctx, companyId: 8 }, env), "INTEGRITE");
});
ok("gabarit recopié sur une autre personne : refusé (AAD)", () => {
  const v = coffre.chiffrer("g", ctx, env);
  leve(() => coffre.dechiffrer(v, { ...ctx, contexte: "profil:user:13:face:-" }, env), "INTEGRITE");
});
ok("valeur altérée : refusée", () => {
  const v = coffre.chiffrer("gabarit", ctx, env).split(".");
  v[4] = Buffer.from("autre chose").toString("base64url");
  leve(() => coffre.dechiffrer(v.join("."), ctx, env), "INTEGRITE");
});
ok("rotation : k2 active, k1 encore lisible, rechiffrement vers k2", () => {
  const ancien = coffre.chiffrer("g", ctx, env);
  const K2 = cle();
  const env2 = { BIOMETRIC_ENC_KEYS: JSON.stringify({ k1: K1, k2: K2 }), BIOMETRIC_ENC_KEY_ID: "k2", JWT_SECRET: "x" };
  assert.strictEqual(coffre.dechiffrer(ancien, ctx, env2).toString(), "g");
  const nouveau = coffre.rechiffrer(ancien, ctx, env2);
  assert.strictEqual(coffre.kidDe(nouveau), "k2");
  assert.strictEqual(coffre.dechiffrer(nouveau, ctx, { BIOMETRIC_ENC_KEYS: JSON.stringify({ k2: K2 }), BIOMETRIC_ENC_KEY_ID: "k2" }).toString(), "g");
});
ok("simulateur refusé hors tests", () => {
  leve(() => registre.fournisseur("face", "mock", { NODE_ENV: "production", BIOMETRIC_ALLOW_MOCK: "1" }), "FOURNISSEUR_INTERDIT");
  leve(() => registre.fournisseur("fingerprint", "mock", { NODE_ENV: "test" }), "FOURNISSEUR_INTERDIT");
  assert.strictEqual(registre.fournisseur("face", "mock", { NODE_ENV: "test", BIOMETRIC_ALLOW_MOCK: "1" }).nom, "mock");
});
ok("aucun fournisseur choisi : refus explicite", () => leve(() => registre.fournisseur("face", "", {}), "FOURNISSEUR_NON_CONFIGURE"));
ok("moteur local non configuré : inactif, annoncé comme tel", () => {
  const cat = registre.catalogue({});
  assert.strictEqual(cat.face.find((f) => f.cle === "local").disponible, false);
  assert.ok(!cat.face.some((f) => f.cle === "mock"));
});
ok("empreinte en navigateur : impossible, dit clairement", async () => {
  const p = registre.fournisseur("fingerprint", "terminal", {});
  assert.strictEqual(p.correspondanceServeur, false);
});
ok("simulateur visage : même personne proche, autre personne éloignée", async () => {
  const m = new face.MockFaceProvider();
  return Promise.all([m.extraire({ mock_identite: "a" }), m.extraire({ mock_identite: "a", variation: 1 }),
    m.extraire({ mock_identite: "b" })]).then(([a1, a2, b]) => {
    assert.ok(m.comparer(a1.gabarit, a2.gabarit) > 0.95);
    assert.ok(m.comparer(a1.gabarit, b.gabarit) < 0.5);
  });
});

Promise.all(attentes).then(() => console.log(`\n✅ ${n} tests unitaires biométrie passés.`))
  .catch((e) => { console.error("✗", e.message); process.exit(1); });

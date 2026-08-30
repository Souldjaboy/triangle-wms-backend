"use strict";

/**
 * SE CONNECTER PAR EMAIL OU PAR TÉLÉPHONE — contre le VRAI serveur.
 *
 * Les routes `/users` et `/login` sont déclarées sur `app` dans server.js :
 * les monter sur un Express de test éprouverait une copie. Ce script parle
 * donc au serveur réel, démarré sur la base de test.
 *
 *   bash scripts/test-identifiants.sh
 *
 * Il vérifie ce qu'on ne peut pas déduire du code : qu'un compte sans adresse
 * email existe vraiment, qu'il entre avec son numéro écrit autrement qu'à la
 * création, et que les comptes déjà en service n'ont rien perdu.
 */

const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const ident = require("../services/identifiants");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const BASE = process.env.BASE_URL || "http://127.0.0.1:5050";
const SECRET = process.env.JWT_SECRET || "test-secret-durcissement";

let reussis = 0, echoues = 0;
const verifier = (nom, ok, detail = "") => {
  if (ok) { reussis += 1; console.log(`  ✓ ${nom}`); }
  else { echoues += 1; console.log(`  ✗ ${nom}${detail ? ` — ${detail}` : ""}`); }
};

/* Un mot de passe de test, engendré à chaque exécution : rien de fixe ne doit
   se retrouver dans le dépôt ni dans un journal. */
const MDP = `Ep${Math.random().toString(36).slice(2, 10)}!7Zk`;

const jeton = (u) => jwt.sign(
  { id: u.id, email: u.email, role: u.role, company_id: u.company_id,
    is_super_admin: u.is_super_admin },
  SECRET, { expiresIn: "1h" });

async function appel(methode, chemin, token, corps, entetes = {}) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...entetes,
    },
    ...(corps ? { body: JSON.stringify(corps) } : {}),
  });
  return { statut: r.status, corps: await r.json().catch(() => ({})) };
}

let SUPER, ADMIN_SIMPLE, TRIANGLE, FATMAT;

async function semer() {
  await pool.query(`DELETE FROM users WHERE email LIKE '%@essai.test' OR fullname LIKE 'Essai %'`);

  /* Un jeu de données qui pose des identifiants explicites laisse la séquence
     derrière lui : l'insertion suivante réclamerait un identifiant déjà pris.
     On la remet au niveau du plus grand identifiant existant. */
  await pool.query(
    `SELECT setval(pg_get_serial_sequence('users', 'id'),
                   GREATEST((SELECT COALESCE(MAX(id), 1) FROM users), 1))`
  );
  const soc = await pool.query(`SELECT id, name FROM companies ORDER BY id`);
  TRIANGLE = soc.rows.find((c) => /triangle/i.test(c.name));
  FATMAT = soc.rows.find((c) => /fat/i.test(c.name));

  const creer = async (nom, email, role, companyId, superAdmin) => (await pool.query(
    `INSERT INTO users (fullname, email, password, role, company_id, is_super_admin,
                        email_verified, verification_mode)
     VALUES ($1,$2,'$test$',$3,$4,$5,true,'none')
     ON CONFLICT DO NOTHING RETURNING *`,
    [nom, email, role, companyId, superAdmin]
  )).rows[0];

  SUPER = await creer("Essai Super", "super@essai.test", "super_admin", TRIANGLE.id, true);
  ADMIN_SIMPLE = await creer("Essai Admin", "admin@essai.test", "admin", TRIANGLE.id, false);
}

async function main() {
  await semer();
  const jetonSuper = jeton(SUPER);
  const jetonAdmin = jeton(ADMIN_SIMPLE);
  const chezTriangle = { "x-active-company-id": String(TRIANGLE.id) };

  console.log("\n▸ NORMALISATION DU NUMÉRO");
  {
    const cas = [
      ["76327799", "+22376327799"],
      ["76 32 77 99", "+22376327799"],
      ["+22376327799", "+22376327799"],
      ["0022376327799", "+22376327799"],
      ["223-76-32-77-99", "+22376327799"],
      ["+33 6 12 34 56 78", "+33612345678"],
      ["12345", ""],
      ["", ""],
      ["pas un numéro", ""],
    ];
    for (const [brut, attendu] of cas) {
      const obtenu = ident.normaliserTelephone(brut);
      verifier(`« ${brut || "(vide)"} » → « ${attendu || "(refusé)"} »`,
        obtenu === attendu, `obtenu « ${obtenu} »`);
    }
  }

  console.log("\n▸ CRÉATION");
  let avecTelephone;
  {
    const r1 = await appel("POST", "/users", jetonSuper, {
      fullname: "Essai Email Seul", email: "e1@essai.test",
      password: MDP, role: "employe", verification_mode: "none",
    }, chezTriangle);
    verifier("email seul accepté", r1.statut === 201 || r1.statut === 200,
      `statut ${r1.statut} ${JSON.stringify(r1.corps).slice(0, 120)}`);

    const r2 = await appel("POST", "/users", jetonSuper, {
      fullname: "Essai Téléphone Seul", phone: "76 32 77 88",
      password: MDP, role: "employe", verification_mode: "none",
    }, chezTriangle);
    verifier("téléphone seul accepté, sans email", r2.statut === 201 || r2.statut === 200,
      `statut ${r2.statut} ${JSON.stringify(r2.corps).slice(0, 160)}`);
    avecTelephone = r2.corps?.user || r2.corps;

    const enBase = (await pool.query(
      `SELECT email, phone_normalise, verification_mode FROM users WHERE fullname = 'Essai Téléphone Seul'`
    )).rows[0];
    verifier("l'email reste vide en base", enBase && enBase.email === null,
      JSON.stringify(enBase));
    verifier("le numéro est enregistré sous sa forme normalisée",
      enBase && enBase.phone_normalise === "+22376327788", JSON.stringify(enBase));

    const r3 = await appel("POST", "/users", jetonSuper, {
      fullname: "Essai Les Deux", email: "e3@essai.test", phone: "76327700",
      password: MDP, role: "employe", verification_mode: "none",
    }, chezTriangle);
    verifier("email et téléphone ensemble acceptés", r3.statut === 201 || r3.statut === 200,
      `statut ${r3.statut}`);

    const r4 = await appel("POST", "/users", jetonSuper, {
      fullname: "Essai Sans Rien", password: MDP, role: "employe",
    }, chezTriangle);
    verifier("refus sans email NI téléphone",
      r4.statut === 400 && r4.corps.code === "IDENTIFIER_REQUIRED",
      `statut ${r4.statut} ${r4.corps.code}`);

    const r5 = await appel("POST", "/users", jetonSuper, {
      fullname: "Essai Doublon", phone: "+223 76 32 77 88",
      password: MDP, role: "employe",
    }, chezTriangle);
    verifier("refus du même numéro écrit autrement",
      r5.statut === 409 && r5.corps.code === "PHONE_TAKEN",
      `statut ${r5.statut} ${r5.corps.code}`);

    const r6 = await appel("POST", "/users", jetonSuper, {
      fullname: "Essai Numéro Faux", phone: "12345",
      password: MDP, role: "employe",
    }, chezTriangle);
    verifier("refus d'un numéro invalide",
      r6.statut === 400 && r6.corps.code === "PHONE_INVALID",
      `statut ${r6.statut} ${r6.corps.code}`);
  }

  console.log("\n▸ QUI PEUT DISPENSER DE VÉRIFICATION");
  {
    const r = await appel("POST", "/users", jetonAdmin, {
      fullname: "Essai Dispense Interdite", phone: "76327766",
      password: MDP, role: "employe", verification_mode: "none",
    }, chezTriangle);
    verifier("un admin non super ne peut pas dispenser",
      r.statut === 403 && r.corps.code === "VERIFICATION_MODE_FORBIDDEN",
      `statut ${r.statut} ${r.corps.code}`);

    const r2 = await appel("POST", "/users", jetonSuper, {
      fullname: "Essai Vérif Email Sans Adresse", phone: "76327755",
      password: MDP, role: "employe", verification_mode: "email",
    }, chezTriangle);
    verifier("vérification email refusée sans adresse",
      r2.statut === 400 && r2.corps.code === "VERIFICATION_EMAIL_IMPOSSIBLE",
      `statut ${r2.statut} ${r2.corps.code}`);

    const r3 = await appel("POST", "/users", jetonSuper, {
      fullname: "Essai Vérif SMS", phone: "76327744",
      password: MDP, role: "employe", verification_mode: "phone",
    }, chezTriangle);
    verifier("vérification SMS refusée si aucun service n'est configuré",
      r3.statut === 400 && r3.corps.code === "SMS_NOT_CONFIGURED",
      `statut ${r3.statut} ${r3.corps.code}`);
  }

  console.log("\n▸ CONNEXION");
  {
    const parEmail = await appel("POST", "/login", null, { email: "e1@essai.test", password: MDP });
    verifier("connexion par email", parEmail.statut === 200 && Boolean(parEmail.corps.token),
      `statut ${parEmail.statut} ${parEmail.corps.error || ""}`);

    const parTel = await appel("POST", "/login", null, { email: "76327788", password: MDP });
    verifier("connexion par téléphone, sans aucun email",
      parTel.statut === 200 && Boolean(parTel.corps.token),
      `statut ${parTel.statut} ${parTel.corps.error || parTel.corps.code || ""}`);

    const autreEcriture = await appel("POST", "/login", null,
      { email: "+223 76 32 77 88", password: MDP });
    verifier("le même numéro écrit autrement ouvre le même compte",
      autreEcriture.statut === 200 && Boolean(autreEcriture.corps.token),
      `statut ${autreEcriture.statut}`);

    const mauvais = await appel("POST", "/login", null, { email: "76327788", password: "Faux!12345" });
    verifier("mot de passe faux refusé", mauvais.statut === 401, `statut ${mauvais.statut}`);

    const inconnu = await appel("POST", "/login", null, { email: "76000000", password: MDP });
    verifier("numéro inconnu refusé", inconnu.statut === 401, `statut ${inconnu.statut}`);
  }

  console.log("\n▸ LA VÉRIFICATION RESTE EXIGÉE QUAND ELLE N'EST PAS LEVÉE");
  {
    await pool.query(
      `INSERT INTO users (fullname, email, password, role, company_id,
                          email_verified, phone_verified, verification_required)
       VALUES ('Essai Non Vérifié','nv@essai.test',$1,'employe',$2,false,false,true)`,
      [(await pool.query(`SELECT password FROM users WHERE fullname='Essai Email Seul'`)).rows[0].password,
       TRIANGLE.id]
    );
    const r = await appel("POST", "/login", null, { email: "nv@essai.test", password: MDP });
    verifier("un compte non dispensé reste bloqué par la vérification",
      r.statut === 403 && r.corps.code === "verification_required",
      `statut ${r.statut} ${r.corps.code || r.corps.error || ""}`);
  }

  console.log("\n▸ ISOLATION DES ENTREPRISES");
  {
    const chezFatmat = { "x-active-company-id": String(FATMAT.id) };
    const r = await appel("POST", "/users", jetonSuper, {
      fullname: "Essai Chez FATMAT", phone: "76327733",
      password: MDP, role: "employe", verification_mode: "none",
    }, chezFatmat);
    const cree = (await pool.query(
      `SELECT company_id, badge_code FROM users WHERE fullname = 'Essai Chez FATMAT'`
    )).rows[0];
    verifier("créé depuis FAT & MAT, il appartient à FAT & MAT",
      cree && Number(cree.company_id) === Number(FATMAT.id),
      JSON.stringify(cree) + ` statut ${r.statut}`);
    verifier("son badge porte le préfixe de FAT & MAT",
      cree && String(cree.badge_code || "").startsWith("FATMAT"), JSON.stringify(cree));

    const chezTri = (await pool.query(
      `SELECT company_id, badge_code FROM users WHERE fullname = 'Essai Téléphone Seul'`
    )).rows[0];
    verifier("créé depuis Triangle, il appartient à Triangle",
      chezTri && Number(chezTri.company_id) === Number(TRIANGLE.id), JSON.stringify(chezTri));
    verifier("son badge porte le préfixe Triangle",
      chezTri && String(chezTri.badge_code || "").startsWith("TRIANGLE"), JSON.stringify(chezTri));
  }

  console.log("\n▸ RESTRICTION À UN ENTREPÔT");
  {
    /* Deux entrepôts chez Triangle, et un bac dans chacun. */
    const wD = (await pool.query(
      `INSERT INTO warehouses (code, name, company_id) VALUES ('D','Entrepôt D',$1)
       ON CONFLICT DO NOTHING RETURNING id`, [TRIANGLE.id])).rows[0]
      || (await pool.query(`SELECT id FROM warehouses WHERE code='D' AND company_id=$1`, [TRIANGLE.id])).rows[0];
    const wA = (await pool.query(
      `INSERT INTO warehouses (code, name, company_id) VALUES ('A','Entrepôt A',$1)
       ON CONFLICT DO NOTHING RETURNING id`, [TRIANGLE.id])).rows[0]
      || (await pool.query(`SELECT id FROM warehouses WHERE code='A' AND company_id=$1`, [TRIANGLE.id])).rows[0];

    /* Rejouable : un bac déjà créé par un passage précédent est réutilisé
       plutôt que réinséré — sinon la suite ne passerait qu'une fois. */
    const bac = async (wid, code, bin) => {
      const plein = `${code}-${bin}`;
      const deja = await pool.query(
        `SELECT id FROM locations WHERE company_id = $1 AND full_code = $2`,
        [TRIANGLE.id, plein]);
      if (deja.rows[0]) {
        await pool.query(`UPDATE locations SET warehouse_id = $1 WHERE id = $2`,
          [wid, deja.rows[0].id]);
        return deja.rows[0].id;
      }
      return (await pool.query(
        `INSERT INTO locations (company_id, warehouse_id, warehouse_code, emplacement_code,
                                full_code, rayon_code, case_code, level_code, bin_code, is_active)
         VALUES ($1,$2,$3,$4,$4,'R','1','1',$5,true) RETURNING id`,
        [TRIANGLE.id, wid, code, plein, bin])).rows[0].id;
    };
    const bacD = await bac(wD.id, "D", "D01");
    const bacA = await bac(wA.id, "A", "A01");

    const r = await appel("POST", "/users", jetonSuper, {
      fullname: "Essai Entrepôt D", phone: "76327722", password: MDP,
      role: "employe", verification_mode: "none", warehouse_id: wD.id,
    }, chezTriangle);
    verifier("affectation à un entrepôt acceptée", r.statut === 201 || r.statut === 200,
      `statut ${r.statut} ${JSON.stringify(r.corps).slice(0, 120)}`);

    const chezAutre = await appel("POST", "/users", jetonSuper, {
      fullname: "Essai Entrepôt Étranger", phone: "76327711", password: MDP,
      role: "employe", warehouse_id: wD.id,
    }, { "x-active-company-id": String(FATMAT.id) });
    verifier("entrepôt d'une autre entreprise refusé",
      chezAutre.statut === 400 && chezAutre.corps.code === "WAREHOUSE_NOT_IN_COMPANY",
      `statut ${chezAutre.statut} ${chezAutre.corps.code}`);

    const drissaLike = (await pool.query(
      `SELECT id, email, role, company_id, is_super_admin, warehouse_id
         FROM users WHERE fullname = 'Essai Entrepôt D'`)).rows[0];
    verifier("l'entrepôt est bien enregistré sur le compte",
      Number(drissaLike.warehouse_id) === Number(wD.id), JSON.stringify(drissaLike));

    /* Il faut le droit d'agir sur les stocks pour éprouver la restriction. */
    for (const [m, a] of [["stock","visible"],["stock","view"],["stock","create"],
                          ["stock.sortie","visible"],["stock.sortie","create"],
                          ["stock.entree","visible"],["stock.entree","create"]]) {
      await pool.query(
        `INSERT INTO user_permission_overrides (user_id, company_id, module_key, action, effect)
         VALUES ($1,$2,$3,$4,'ALLOW') ON CONFLICT DO NOTHING`,
        [drissaLike.id, TRIANGLE.id, m, a]);
    }
    const sien = jeton(drissaLike);

    const dansSonEntrepot = await appel("POST", "/stock/locations/prepare-entry", sien, {
      productId: 1, locationId: bacD, quantity: 1,
    }, chezTriangle);
    verifier("son propre entrepôt n'est pas bloqué par le garde",
      dansSonEntrepot.corps?.code !== "WAREHOUSE_FORBIDDEN",
      `code ${dansSonEntrepot.corps?.code || "(aucun)"}`);

    const ailleurs = await appel("POST", "/stock/locations/prepare-entry", sien, {
      productId: 1, locationId: bacA, quantity: 1,
    }, chezTriangle);
    verifier("un bac d'un autre entrepôt est refusé, même en appelant l'API",
      ailleurs.statut === 403 && ailleurs.corps.code === "WAREHOUSE_FORBIDDEN",
      `statut ${ailleurs.statut} ${ailleurs.corps.code || ailleurs.corps.error}`);

    const arbre = await appel("GET", "/stock/locations/tree", sien, null, chezTriangle);
    const codes = JSON.stringify(arbre.corps || {});
    verifier("l'arborescence ne montre que son entrepôt",
      codes.includes("D01") && !codes.includes("A01"),
      codes.slice(0, 160));
  }

  console.log("\n▸ LES COMPTES EXISTANTS N'ONT RIEN PERDU");
  {
    const r = await appel("POST", "/login", null, { email: "e3@essai.test", password: MDP });
    verifier("un compte avec email ET téléphone entre toujours par son email",
      r.statut === 200 && Boolean(r.corps.token), `statut ${r.statut}`);

    /* Sur les comptes créés par cette suite — les seuls dont on connaisse le
       mot de passe en clair : il ne doit en rester aucune trace lisible. */
    const empreintes = await pool.query(
      `SELECT count(*)::int AS n FROM users
        WHERE fullname LIKE 'Essai %' AND password NOT LIKE '$2%'
          AND fullname NOT IN ('Essai Super', 'Essai Admin')`
    );
    verifier("aucun mot de passe enregistré en clair", empreintes.rows[0].n === 0,
      `${empreintes.rows[0].n} suspect(s)`);

    const enClair = await pool.query(
      `SELECT count(*)::int AS n FROM users WHERE password = $1`, [MDP]
    );
    verifier("le mot de passe de test n'apparaît nulle part en clair",
      enClair.rows[0].n === 0, `${enClair.rows[0].n} occurrence(s)`);
  }

  console.log(`\n${reussis} réussis, ${echoues} échoués`);
  await pool.end();
  process.exit(echoues === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(`\nÉCHEC : ${e.stack || e.message}`);
  await pool.end().catch(() => {});
  process.exit(1);
});

"use strict";
/**
 * De quoi regarder les versions à l'écran.
 *
 * On passe par l'API, et non par des INSERT : seule l'API produit de vrais
 * PDF archivés, des empreintes justes et les lignes de journal. Un jeu posé
 * à la main montrerait un écran qui ne correspond à rien.
 */
const jwt = require("jsonwebtoken");
const BASE = process.env.API || "http://localhost:5050";
const SECRET = process.env.JWT_SECRET || "test_integration";
const SUPER = { id: 900, fullname: "Super Triangle", role: "super_admin",
                company_id: 1, is_super_admin: true, tenant_id: "triangle" };
const t = jwt.sign(SUPER, SECRET, { expiresIn: "2h" });

async function appel(m, chemin, corps) {
  const r = await fetch(BASE + chemin, {
    method: m,
    headers: {
      "x-tenant-id": "triangle", "x-active-company-id": "1",
      Authorization: `Bearer ${t}`,
      ...(corps !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: corps === undefined ? undefined : JSON.stringify(corps),
  });
  let d = null; try { d = await r.json(); } catch { /* PDF ou vide */ }
  return { status: r.status, data: d };
}

(async () => {
  /* Un contrat par salarié : une attestation de travail « ne s'invente pas ». */
  for (const [emp, poste] of [[801, "Responsable d'entrepôt"], [802, "Magasinier"]]) {
    const c = await appel("POST", "/rh/contrats", {
      employee_id: emp, contract_type: "CDI", job_title: poste,
      site_label: "Entrepôt Sotuba", start_date: "2026-01-05",
      trial_period_days: 90, weekly_hours: 40, gross_salary: 300000,
      signed_place: "Bamako",
    });
    if (c.data?.contrat?.id) await appel("POST", `/rh/contrats/${c.data.contrat.id}/activer`, {});
  }

  /* Une attestation : pièce sans version. */
  await appel("POST", "/rh/attestations", { type: "ATTESTATION_TRAVAIL", employee_id: 801 });

  /* Un bulletin, puis sa correction : c'est la chaîne que l'écran doit montrer. */
  await appel("POST", "/rh/bulletins/802/2026-09", { brut: 300000 });
  await appel("POST", "/rh/bulletins/802/2026-09", {
    brut: 350000, motif_version: "prime de rendement oubliée au premier calcul",
  });

  /* Un second bulletin, d'un autre mois, pour qu'une pièce à version unique
     voisine avec une pièce à deux versions. */
  await appel("POST", "/rh/bulletins/801/2026-10", { brut: 450000 });

  const liste = await appel("GET", "/rh/documents");
  const docs = liste.data?.documents || [];
  console.log(`   ${docs.length} pièce(s) préparée(s) : `
    + docs.map((d) => `${d.reference} v${d.version} ${d.status}`).join(", "));
})().catch((e) => { console.error(e); process.exit(1); });

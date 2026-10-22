"use strict";
/* Quelques pièces, pour que les registres ne soient pas vides à l'écran. */
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  await pool.query(`
    INSERT INTO hr_contracts (company_id, employee_id, reference, contract_type, job_title,
      site_label, start_date, trial_period_days, weekly_hours, gross_salary, status,
      signed_at, signed_place, created_by, created_by_name)
    VALUES (1, 801, 'CT-2026-0001', 'CDI', 'Responsable d''entrepôt', 'Entrepôt Sotuba',
            '2026-11-01', 90, 40, 450000, 'ACTIF', '2026-10-21', 'Bamako', 900, 'Super Triangle')
    ON CONFLICT DO NOTHING`);
  await pool.query(`
    INSERT INTO hr_contracts (company_id, employee_id, reference, contract_type, job_title,
      start_date, end_date, cdd_reason, gross_salary, status, created_by, created_by_name)
    VALUES (1, 802, 'CT-2026-0002', 'CDD', 'Magasinier', '2026-11-01', '2027-04-30',
            'Accroissement temporaire d''activité', 300000, 'BROUILLON', 900, 'Super Triangle')
    ON CONFLICT DO NOTHING`);
  await pool.query(`
    INSERT INTO hr_documents (company_id, employee_id, doc_type, reference, title,
      period_code, payload, pdf_sha256, issued_by, issued_by_name)
    VALUES
     (1, 801, 'ATTESTATION_TRAVAIL', 'AT-2026-0001', 'ATTESTATION DE TRAVAIL', NULL,
      '{}'::jsonb, repeat('a', 64), 900, 'Super Triangle'),
     (1, 801, 'BULLETIN', 'BP-2026-0001', 'Bulletin 2026-10', '2026-10',
      '{}'::jsonb, repeat('b', 64), 900, 'Super Triangle'),
     (1, 801, 'DIPLOME', 'DIP-2026-0001', 'Diplôme — Aminata Coulibaly', NULL,
      '{}'::jsonb, repeat('c', 64), 900, 'Super Triangle')
    ON CONFLICT DO NOTHING`);
  const n = (await pool.query(`SELECT count(*) c FROM hr_documents`)).rows[0].c;
  console.log(`   ${n} pièce(s) au registre`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });

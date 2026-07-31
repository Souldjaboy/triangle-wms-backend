"use strict";
/*
 * NETTOYAGE sécurisé des lignes de trésorerie FICTIVES d'une entreprise.
 * - N'agit QUE sur les lignes explicitement ciblées (--match=<motif> ou --ids=<csv>).
 * - Refuse d'agir sans cible, et refuse si la cible couvre TOUTES les lignes.
 * - Transaction PostgreSQL + journal d'audit + info de rollback.
 * - Écriture VALIDÉE -> CONTREPASSATION (jamais de suppression physique).
 * - Écriture non validée / ligne clairement de test -> suppression.
 * - --apply exige --confirm=OUI.
 *
 *   node scripts/cleanup-fake-treasury.js --company-id=<id> --match=test --dry-run
 *   node scripts/cleanup-fake-treasury.js --company-id=<id> --ids=12,34 --dry-run
 *   node scripts/cleanup-fake-treasury.js --company-id=<id> --match=test --apply --confirm=OUI
 */
require("dotenv").config();
const { Pool } = require("pg");

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v === undefined ? true : v]; }));
const companyId = Number(args["company-id"]);
const APPLY = args.apply === true;
const match = args.match ? String(args.match) : null;
const ids = args.ids ? String(args.ids).split(",").map((n) => Number(n)).filter(Boolean) : null;
const USER_ID = Number(args["user-id"] || 0) || null;

async function nextNum(client, cid) {
  const { rows } = await client.query("SELECT COUNT(*)::int n FROM accounting_transactions WHERE company_id=$1", [cid]);
  return `ANN-${cid}-${rows[0].n + 1}-${Date.now().toString(36)}`;
}
async function entry(client, cid, sid, label, debit, credit) {
  const { rows } = await client.query("SELECT COUNT(*)::int n FROM accounting_entries WHERE company_id=$1", [cid]);
  await client.query(
    `INSERT INTO accounting_entries (company_id, entry_number, source_type, source_id, account_label, debit, credit, description, created_by)
     VALUES ($1,$2,'treasury_cleanup',$3,$4,$5,$6,'Contrepassation nettoyage',$7)`,
    [cid, `ECR-ANN-${cid}-${rows[0].n + 1}-${Date.now().toString(36)}`, sid, label, debit, credit, USER_ID]
  );
}

async function main() {
  if (!companyId || (!match && !ids)) { console.error("Usage: --company-id=<id> (--match=<motif> | --ids=<csv>) [--dry-run|--apply --confirm=OUI]"); process.exit(2); }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const co = (await pool.query("SELECT id, name FROM companies WHERE id=$1", [companyId])).rows[0];
  if (!co) { console.error("Entreprise introuvable."); await pool.end(); process.exit(3); }

  const params = [companyId];
  let where = "company_id=$1";
  if (ids) { params.push(ids); where += ` AND id = ANY($${params.length})`; }
  else { params.push(`%${match}%`); where += ` AND description ILIKE $${params.length}`; }

  const targets = (await pool.query(`SELECT id, description, amount, direction, status FROM accounting_transactions WHERE ${where} ORDER BY id`, params)).rows;
  const totalCo = Number((await pool.query("SELECT COUNT(*) n FROM accounting_transactions WHERE company_id=$1", [companyId])).rows[0].n);

  console.log(`\n=== NETTOYAGE — ${co.name} (#${companyId}) — MODE ${APPLY ? "APPLY" : "DRY-RUN"} ===`);
  console.log(`Cible : ${targets.length} ligne(s) sur ${totalCo} (${ids ? "ids" : "motif='" + match + "'"})`);
  if (targets.length === 0) { console.log("Rien à faire."); await pool.end(); process.exit(0); }
  if (targets.length === totalCo && !args.force) { console.error("❌ La cible couvre TOUTES les transactions de l'entreprise — refus (ajouter --force si réellement voulu)."); await pool.end(); process.exit(1); }

  let toReverse = 0, toDelete = 0, deltaIn = 0, deltaOut = 0;
  for (const t of targets) {
    const validated = t.status === "validé";
    if (validated) toReverse++; else toDelete++;
    if (t.direction === "entrée") deltaIn += Number(t.amount); else deltaOut += Number(t.amount);
    console.log(`  ${t.id} | ${String(t.description || "").slice(0, 45)} | ${t.amount} | ${t.direction} | ${t.status} -> ${validated ? "CONTREPASSATION" : "SUPPRESSION"}`);
  }
  console.log(`\nImpact trésorerie : ${(-deltaIn + deltaOut)} (retire ${deltaIn} d'entrées, ${deltaOut} de sorties)`);
  console.log(`À contrepasser (validées) : ${toReverse} | à supprimer (non validées) : ${toDelete}`);

  if (!APPLY) { console.log("\n=== DRY-RUN — aucune écriture. Relancer avec --apply --confirm=OUI pour exécuter. ==="); await pool.end(); process.exit(0); }
  if (args.confirm !== "OUI") { console.error("\n❌ APPLY refusé : ajouter --confirm=OUI."); await pool.end(); process.exit(1); }

  const client = await pool.connect();
  const rollbackInfo = { reversed: [], deleted: [] };
  try {
    await client.query("BEGIN");
    for (const t of targets) {
      if (t.status === "validé") {
        // Contrepassation : transaction inverse + écritures + trésorerie.
        const dir = t.direction === "entrée" ? "sortie" : "entrée";
        const num = await nextNum(client, companyId);
        const ctx = await client.query(
          `INSERT INTO accounting_transactions (company_id, transaction_number, transaction_type, source_type, source_id, amount, currency, direction, category, description, status, created_by, validated_by, validated_at, created_at, updated_at)
           VALUES ($1,$2,'annulation','treasury_cleanup',$3,$4,'FCFA',$5,'Nettoyage fictif',$6,'validé',$7,$7,NOW(),NOW(),NOW()) RETURNING id`,
          [companyId, num, t.id, t.amount, dir, `Contrepassation nettoyage de #${t.id}`, USER_ID]
        );
        const delta = dir === "entrée" ? Number(t.amount) : -Number(t.amount);
        await client.query("UPDATE treasury_accounts SET current_balance=COALESCE(current_balance,0)+$1, updated_at=NOW() WHERE company_id=$2", [delta, companyId]);
        await entry(client, companyId, ctx.rows[0].id, "Contrepassation", dir === "sortie" ? t.amount : 0, dir === "entrée" ? t.amount : 0);
        await entry(client, companyId, ctx.rows[0].id, "Caisse", dir === "entrée" ? t.amount : 0, dir === "sortie" ? t.amount : 0);
        rollbackInfo.reversed.push({ original: t.id, counter: ctx.rows[0].id });
      } else {
        rollbackInfo.deleted.push({ id: t.id, description: t.description, amount: t.amount, direction: t.direction });
        // Ajuste la trésorerie (retire l'effet de la ligne) puis supprime.
        const delta = t.direction === "entrée" ? -Number(t.amount) : Number(t.amount);
        await client.query("UPDATE treasury_accounts SET current_balance=COALESCE(current_balance,0)+$1, updated_at=NOW() WHERE company_id=$2", [delta, companyId]);
        await client.query("DELETE FROM accounting_transactions WHERE id=$1 AND company_id=$2", [t.id, companyId]);
      }
    }
    // Journal d'audit (réutilise import_audit_logs si présent).
    await client.query(
      `INSERT INTO import_audit_logs (company_id, product_code, action, user_id, detail) VALUES ($1,'triangle','treasury_cleanup',$2,$3)`,
      [companyId, USER_ID, JSON.stringify({ match, ids, reversed: rollbackInfo.reversed.length, deleted: rollbackInfo.deleted.length, rollbackInfo })]
    ).catch(() => {});
    await client.query("COMMIT");
    console.log(`\n✅ Nettoyage appliqué : ${rollbackInfo.reversed.length} contrepassée(s), ${rollbackInfo.deleted.length} supprimée(s).`);
    console.log("Info rollback (conservée dans import_audit_logs) :", JSON.stringify(rollbackInfo).slice(0, 400));
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("❌ Erreur — transaction annulée :", e.message);
    process.exitCode = 1;
  } finally { client.release(); await pool.end(); }
}
main().catch((e) => { console.error("ERREUR:", e.message); process.exit(1); });

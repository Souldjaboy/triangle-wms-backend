"use strict";

/**
 * Rollback d'un import de stock (transactionnel) :
 * - inverse chaque mouvement (products.stock -= delta) ;
 * - supprime le mouvement créé ;
 * - supprime le produit créé par l'import s'il n'a plus aucun mouvement ;
 * - audité. Ne supprime jamais silencieusement une donnée dépendante.
 */
async function rollbackStock(pool, companyId, userId, job, importedRows) {
  const client = await pool.connect();
  let reverted = 0;
  const detail = { movements_deleted: 0, products_deleted: 0, kept_products: [] };
  try {
    await client.query("BEGIN");
    for (const r of importedRows) {
      const ref = r.result_ref || {};
      if (!ref.movement_id) continue;
      // Inverse le stock puis supprime le mouvement.
      await client.query(`UPDATE products SET stock = COALESCE(stock,0) - $1, updated_at=NOW() WHERE id=$2 AND company_id=$3`, [ref.delta || 0, ref.product_id, companyId]);
      await client.query(`DELETE FROM stock_movements WHERE id=$1 AND company_id=$2`, [ref.movement_id, companyId]);
      detail.movements_deleted++;
      reverted++;

      if (ref.created_product && ref.product_id) {
        const other = await client.query(`SELECT COUNT(*)::int AS n FROM stock_movements WHERE product_id=$1 AND company_id=$2`, [ref.product_id, companyId]);
        if (other.rows[0].n === 0) {
          await client.query(`DELETE FROM products WHERE id=$1 AND company_id=$2`, [ref.product_id, companyId]);
          detail.products_deleted++;
        } else {
          detail.kept_products.push(ref.product_id); // dépendances subsistantes -> on garde
        }
      }
      await client.query(`UPDATE import_rows SET status='rolled_back' WHERE job_id=$1 AND row_index=$2`, [job.id, r.row_index]);
    }
    await client.query(`UPDATE import_jobs SET status='rolled_back', rolled_back_at=NOW() WHERE id=$1`, [job.id]);
    await client.query(
      `INSERT INTO import_rollback_logs (job_id, company_id, strategy, reverted_rows, detail, user_id) VALUES ($1,$2,'stock_reverse',$3,$4,$5)`,
      [job.id, companyId, reverted, JSON.stringify(detail), userId]
    );
    await client.query("COMMIT");
    return { reverted, detail };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { rollbackStock };

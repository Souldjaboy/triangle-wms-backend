"use strict";

/**
 * LA SÉRIE DES NUMÉROS DE DOCUMENT — UNE SEULE IMPLÉMENTATION.
 *
 * Numéro court et lisible : PREFIX-AAMMJJ-NNN (ex. BR-260801-001), unique par
 * entreprise, préfixe et jour. La séquence est atomique : deux requêtes
 * simultanées obtiennent deux numéros différents. Jamais `Date.now()`.
 *
 * Ce fichier existe parce qu'un script de correction avait recopié cette
 * logique de mémoire, avec des noms de colonnes qui n'existaient pas — et,
 * plus dangereux, sa propre clé de compteur. Il aurait distribué des numéros
 * que l'application aurait ensuite redonnés à d'autres bons. Une série de
 * numéros ne se réimplémente pas : elle s'appelle.
 */

/**
 * @param {string} prefix    « BR », « BS », « BT »…
 * @param {number} companyId l'entreprise ; la série lui est propre
 * @param {object} client    un client PG déjà dans la transaction, ou un pool
 * @returns {Promise<string>} le prochain numéro de la série
 */
async function nextShortDocumentNumber(prefix, companyId, client) {
  const d = new Date();
  const stamp = String(d.getFullYear()).slice(2)
    + String(d.getMonth() + 1).padStart(2, "0")
    + String(d.getDate()).padStart(2, "0");
  const key = `${prefix}#${stamp}`;
  const { rows } = await client.query(
    `INSERT INTO stock_request_counters (company_id, year, prefix, last_seq)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (company_id, year, prefix)
     DO UPDATE SET last_seq = stock_request_counters.last_seq + 1
     RETURNING last_seq`,
    [companyId || 0, d.getFullYear(), key]
  );
  return `${prefix}-${stamp}-${String(rows[0].last_seq).padStart(3, "0")}`;
}

module.exports = { nextShortDocumentNumber };

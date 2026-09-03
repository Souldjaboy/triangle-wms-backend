"use strict";

/**
 * LE JEU D'ESSAI DES VENTES DE SABLE — annulation, correction, contrepassation.
 *
 *   DATABASE_URL=… node scripts/jeu-essai-vente-sable.js
 *
 * Pose, dans la société FAT & MAT (celle du fixture partagé de
 * rebuild-test-db.sh) :
 *
 *   • le module sable activé (company_modules) ;
 *   • un produit, un tarif, un client ;
 *   • une banque active, pour les paiements « banque » ;
 *   • quatre ventes : un BROUILLON, une VALIDÉE impayée, une VALIDÉE payée en
 *     espèces, une VALIDÉE payée en banque ;
 *   • trois comptes : admin (tous les droits sable), comptable (paiement et
 *     contrepassation seulement), employe (brouillons seulement) — chacun
 *     avec un mot de passe connu, pour obtenir un jeton par /auth/login ;
 *   • une SECONDE société, avec sa propre vente validée et payée, pour les
 *     tests d'isolation.
 *
 * Chiffres de simulation. Aucune de ces valeurs n'est une décision du client.
 */

const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL manquant."); process.exit(1); }
if (/5432|prod|production/i.test(process.env.DATABASE_URL)) {
  console.error("Cette URL ressemble à une base de production. Refus."); process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const MOT_DE_PASSE = "Essai-Sable-2026!";

async function main() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");

    /* Base propre pour ce module précis, sans toucher au reste du fixture
       partagé (users hors sable, sociétés, etc.). */
    await c.query(`DELETE FROM sand_sale_audit_log`);
    await c.query(`DELETE FROM sand_payment_reversals`);
    await c.query(`DELETE FROM sand_payments`);
    await c.query(`DELETE FROM sand_invoices`);
    await c.query(`DELETE FROM sand_deliveries`);
    await c.query(`DELETE FROM sand_sales`);
    await c.query(`DELETE FROM sand_prices`);
    await c.query(`DELETE FROM sand_customers`);
    await c.query(`DELETE FROM sand_products`);
    await c.query(`DELETE FROM sand_counters`);
    await c.query(`DELETE FROM users WHERE email LIKE 'sable-%@essai.test'`);
    await c.query(`DELETE FROM accounting_banks WHERE bank_name = 'Banque Essai Sable'`);

    const societes = (await c.query(`SELECT id, name FROM companies ORDER BY id LIMIT 2`)).rows;
    const S1 = societes[0].id;   // Triangle — pour l'isolation
    const S2 = societes[1] ? societes[1].id : S1;   // FAT & MAT

    await c.query(
      `INSERT INTO company_modules (company_id, module_key, is_enabled)
       VALUES ($1,'sand',true) ON CONFLICT (company_id, module_key)
       DO UPDATE SET is_enabled = true`, [S2]);
    await c.query(
      `INSERT INTO company_modules (company_id, module_key, is_enabled)
       VALUES ($1,'sand',true) ON CONFLICT (company_id, module_key)
       DO UPDATE SET is_enabled = true`, [S1]);

    const motDePasseHache = await bcrypt.hash(MOT_DE_PASSE, 10);
    const utilisateur = async (societe, role, suffixe) => (await c.query(
      `INSERT INTO users (company_id, fullname, email, password, role, is_active, created_at)
       VALUES ($1,$2,$3,$4,$5,true,now()) RETURNING id`,
      [societe, `Essai Sable ${suffixe}`, `sable-${suffixe}-${societe}@essai.test`, motDePasseHache, role]
    )).rows[0].id;

    const adminId = await utilisateur(S2, "admin", "admin");
    const comptableId = await utilisateur(S2, "comptable", "comptable");
    const employeId = await utilisateur(S2, "employe", "employe");
    const directionId = await utilisateur(S2, "direction", "direction");
    const autreAdminId = await utilisateur(S1, "admin", "autre-societe");
    /* `cancelled_by` porte une clé étrangère vers `users` : un jeton minté
       avec un id qui n'existe nulle part ferait échouer l'annulation sur une
       violation de contrainte, pas sur le comportement réellement testé. */
    const superAdminId = await utilisateur(S2, "super_admin", "superadmin");

    /* Le module `sable` est masqué par défaut pour comptable/employe/direction
       tant qu'un administrateur ne l'a pas rendu visible pour eux — c'est le
       même écran de droits que pour n'importe quel autre module. Sans ce
       geste, TOUTE action leur serait refusée en 404 (« module masqué »)
       avant même d'atteindre les permissions nouvelles de ce chantier, et le
       test ne prouverait rien de spécifique à elles. On l'accorde donc ici,
       comme le ferait un administrateur réel avant de confier le module. */
    for (const role of ["comptable", "employe", "direction"]) {
      await c.query(
        `INSERT INTO role_permissions (company_id, role, module_key, action, allowed)
         VALUES ($1,$2,'sable','visible',true), ($1,$2,'sable','view',true)
         ON CONFLICT (company_id, role, module_key, action) DO UPDATE SET allowed = true`,
        [S2, role]);
    }

    const banque = (await c.query(
      `INSERT INTO accounting_banks (company_id, bank_name, account_number, currency,
         initial_balance, current_balance, is_active, created_by)
       VALUES ($1,'Banque Essai Sable','SB-001','FCFA',0,0,true,$2) RETURNING *`,
      [S2, adminId])).rows[0];

    const produit = (await c.query(
      `INSERT INTO sand_products (company_id, name, unit, status, created_by)
       VALUES ($1,'Sable','m3','ACTIF',$2) RETURNING *`, [S2, adminId])).rows[0];

    await c.query(
      `INSERT INTO sand_prices (company_id, sand_product_id, destination, quantity_reference,
         price, transport_price, status, created_by)
       VALUES ($1,$2,'Bamako',10,170000,15000,'ACTIF',$3)`,
      [S2, produit.id, adminId]);

    const client = (await c.query(
      `INSERT INTO sand_customers (company_id, customer_code, name, phone, status, created_by)
       VALUES ($1,'CLI-SAB-ESSAI-001','Client Essai Sable','70000000','ACTIF',$2) RETURNING *`,
      [S2, adminId])).rows[0];

    const compteur = async (prefixe) => {
      const { rows } = await c.query(
        `INSERT INTO sand_counters (company_id,counter_key,counter_date,current_value)
         VALUES ($1,$2,CURRENT_DATE,1)
         ON CONFLICT (company_id,counter_key,counter_date)
         DO UPDATE SET current_value = sand_counters.current_value + 1
         RETURNING current_value`, [S2, prefixe]);
      const d = new Date();
      const yy = String(d.getFullYear()).slice(-2), mm = String(d.getMonth() + 1).padStart(2, "0"),
        dd = String(d.getDate()).padStart(2, "0");
      return `${prefixe}-${yy}${mm}${dd}-${String(rows[0].current_value).padStart(3, "0")}`;
    };

    const vente = async ({ statut, quantite = 10, prixUnitaire = 17000, societe = S2, produitLigne = produit,
      clientLigne = client }) => {
        const numero = await compteur("VS");
        const sousTotal = quantite * prixUnitaire;
        const { rows } = await c.query(
          `INSERT INTO sand_sales
             (company_id, sale_number, customer_id, customer_name, customer_phone, customer_address,
              sand_product_id, product_name, destination, delivery_place, quantity_m3, unit_price,
              sand_subtotal, transport_price, transport_total, discount, tax_amount, total_amount,
              paid_amount, remaining_amount, status, sale_date, created_by, price_reference_qty)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Bamako','Bamako',$9,$10,$11,15000,15000,0,0,$12,0,$12,
                   $13,CURRENT_DATE,$14,10)
           RETURNING *`,
          [societe, numero, clientLigne.id, clientLigne.name, clientLigne.phone, "",
           produitLigne.id, produitLigne.name, quantite, prixUnitaire, sousTotal,
           sousTotal + 15000, statut, adminId]);
        return rows[0];
    };

    const validerEtEncaisser = async (sale, { moyen = null, bankId = null } = {}) => {
      const deliveryNumber = await compteur("BL-SAB");
      const invoiceNumber = await compteur("FAC-SAB");
      const delivery = (await c.query(
        `INSERT INTO sand_deliveries
           (company_id, sale_id, delivery_number, destination, quantity_m3, delivered_by, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [sale.company_id, sale.id, deliveryNumber, sale.destination, sale.quantity_m3, "Essai", adminId])).rows[0];
      const invoice = (await c.query(
        `INSERT INTO sand_invoices
           (company_id, sale_id, customer_id, invoice_number, operation_reference, destination,
            total_amount, paid_amount, remaining_amount, status, created_by, validated_by, validated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,0,$7,'IMPAYEE',$8,$8,NOW()) RETURNING *`,
        [sale.company_id, sale.id, sale.customer_id, invoiceNumber, sale.sale_number, sale.destination,
         sale.total_amount, adminId])).rows[0];
      await c.query(
        `UPDATE sand_sales SET status='VALIDEE', validated_by=$1, validated_at=NOW() WHERE id=$2`,
        [adminId, sale.id]);

      let payment = null;
      if (moyen) {
        const paymentNumber = await compteur("PAY");
        payment = (await c.query(
          `INSERT INTO sand_payments
             (company_id, invoice_id, payment_number, payment_date, amount, payment_method, bank_id, created_by)
           VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,$6,$7) RETURNING *`,
          [sale.company_id, invoice.id, paymentNumber, sale.total_amount, moyen, bankId, adminId])).rows[0];
        await c.query(
          `UPDATE sand_invoices SET paid_amount=$1, remaining_amount=0, status='PAYEE' WHERE id=$2`,
          [sale.total_amount, invoice.id]);
        if (bankId) {
          await c.query(`UPDATE accounting_banks SET current_balance = current_balance + $1 WHERE id=$2`,
            [sale.total_amount, bankId]);
        } else {
          await c.query(
            `INSERT INTO treasury_accounts (company_id, currency, initial_balance, current_balance, updated_by)
             SELECT $1,'FCFA',0,0,$2 WHERE NOT EXISTS (SELECT 1 FROM treasury_accounts WHERE company_id=$1)`,
            [sale.company_id, adminId]);
          await c.query(`UPDATE treasury_accounts SET current_balance = current_balance + $1 WHERE company_id=$2`,
            [sale.total_amount, sale.company_id]);
        }
      }
      return { delivery, invoice: payment ? { ...invoice, paid_amount: sale.total_amount, remaining_amount: 0, status: "PAYEE" } : invoice, payment };
    };

    const brouillon = await vente({ statut: "BROUILLON" });
    const valideeImpayee = await vente({ statut: "BROUILLON", quantite: 8, prixUnitaire: 17000 });
    await validerEtEncaisser(valideeImpayee);

    const valideePayeeEspeces = await vente({ statut: "BROUILLON", quantite: 5, prixUnitaire: 17000 });
    const { invoice: factureEspeces, payment: paiementEspeces } =
      await validerEtEncaisser(valideePayeeEspeces, { moyen: "especes" });

    const valideePayeeBanque = await vente({ statut: "BROUILLON", quantite: 6, prixUnitaire: 17000 });
    const { invoice: factureBanque, payment: paiementBanque } =
      await validerEtEncaisser(valideePayeeBanque, { moyen: "banque", bankId: banque.id });

    // Une vente et sa facture dans l'AUTRE société, pour prouver l'isolation.
    const clientAutreSociete = (await c.query(
      `INSERT INTO sand_customers (company_id, customer_code, name, status, created_by)
       VALUES ($1,'CLI-SAB-AUTRE','Client Autre Société','ACTIF',$2) RETURNING *`,
      [S1, autreAdminId])).rows[0];
    const produitAutreSociete = (await c.query(
      `INSERT INTO sand_products (company_id, name, unit, status, created_by)
       VALUES ($1,'Sable','m3','ACTIF',$2) RETURNING *`, [S1, autreAdminId])).rows[0];
    const venteAutreSociete = await vente({
      statut: "BROUILLON", societe: S1, produitLigne: produitAutreSociete, clientLigne: clientAutreSociete,
    });
    await validerEtEncaisser(venteAutreSociete, { moyen: "especes" });

    await c.query("COMMIT");

    console.log(JSON.stringify({
      societes: { triangle: S1, fatmat: S2 },
      mot_de_passe: MOT_DE_PASSE,
      comptes: { admin: adminId, comptable: comptableId, employe: employeId, direction: directionId,
        autre_societe_admin: autreAdminId, super_admin: superAdminId },
      banque: banque.id,
      ventes: {
        brouillon: brouillon.id,
        validee_impayee: valideeImpayee.id,
        validee_payee_especes: valideePayeeEspeces.id,
        facture_especes: factureEspeces.id,
        paiement_especes: paiementEspeces.id,
        validee_payee_banque: valideePayeeBanque.id,
        facture_banque: factureBanque.id,
        paiement_banque: paiementBanque.id,
        autre_societe: venteAutreSociete.id,
      },
    }, null, 2));
  } catch (e) {
    await c.query("ROLLBACK");
    console.error("ÉCHEC :", e.message);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
}

main();

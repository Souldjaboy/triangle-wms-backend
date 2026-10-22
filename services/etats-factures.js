"use strict";

/**
 * LES ÉTATS DE FACTURES.
 *
 * Un état est une liste de factures arrêtée à un moment, numérotée, imprimée
 * et conservée. Une fois validé, c'est une pièce : on le consulte, on le
 * réimprime, on ne le réécrit pas.
 *
 * TROIS CHOIX QUI COMMANDENT LE RESTE.
 *
 *  1. LES MONTANTS SONT RECOPIÉS, PAS LIÉS. Un état dit ce que la facture
 *     valait le jour où il a été arrêté. Si un paiement arrive ensuite, l'état
 *     ne change pas tout seul : sinon le document remis à un client ne
 *     correspondrait plus à celui qu'on lui a remis.
 *
 *  2. UNE FACTURE FIGURE DANS AU PLUS UN ÉTAT QUI LA RÉCLAME. Cette règle
 *     n'est pas gardée par ce fichier : elle est posée en index unique partiel
 *     dans la migration 155. Deux personnes qui valident au même instant ne
 *     peuvent pas y faire entrer la même facture — la seconde reçoit une
 *     violation d'unicité. Un contrôle applicatif seul aurait laissé passer.
 *
 *  3. CORRIGER N'EFFACE RIEN. L'état fautif passe REMPLACÉ, reste consultable
 *     et imprimable, cesse de réclamer ; un nouvel état porte les bonnes
 *     lignes et pointe vers celui qu'il remplace.
 *
 * CE QUE L'ON NE SAIT PAS, ET QU'IL FAUT DIRE. Tant que les états antérieurs
 * n'ont pas été repris, l'absence d'une facture du registre ne prouve pas
 * qu'elle n'a jamais été portée sur un état papier. `avertissementHistorique`
 * rend cette incertitude lisible, au lieu de laisser l'écran affirmer le
 * contraire.
 */

const { nextShortDocumentNumber } = require("./numerotation-documents");
const T = require("./tresorerie");

/* ─────────────────────────────────────────────────────────────────────────
   LES DEUX PRODUITS
   Un seul endroit où les noms de table sont écrits. Les routes et les tests
   passent par ici, pour qu'une faute de nom se voie une fois, pas dix.
   ───────────────────────────────────────────────────────────────────────── */
const PRODUITS = Object.freeze({
  SABLE: Object.freeze({
    cle: "SABLE", libelle: "Sable", prefixe: "ETS",
    factures: "sand_invoices", clients: "sand_customers",
    /* Les statuts qu'un état ne porte pas. Ils DIFFÈRENT d'un produit à
       l'autre : sand_invoices connaît REMPLACEE et ignore BROUILLON,
       cement_invoices fait l'inverse. Une liste commune aurait soit laissé
       passer une facture remplacée, soit rejeté un statut inexistant. */
    statutsExclus: Object.freeze(["ANNULEE", "REMPLACEE"]),
    /* Le module de permission du produit, sous sa clé anglaise : c'est celle
       que les routes de vente emploient, et services/permissions.js la
       normalise. Voir la table ALIAS. */
    module: "sand",
  }),
  CIMENT: Object.freeze({
    cle: "CIMENT", libelle: "Ciment", prefixe: "ETC",
    factures: "cement_invoices", clients: "cement_customers",
    statutsExclus: Object.freeze(["ANNULEE", "BROUILLON"]),
    module: "cement",
  }),
});

const STATUTS = Object.freeze({
  BROUILLON: "BROUILLON", VALIDE: "VALIDE",
  ANNULE: "ANNULE", REMPLACE: "REMPLACE",
});

/* Une seule implémentation de l'erreur portée par les services : le routeur
   lit e.httpStatus et e.code, comme pour les bons et les transferts. */
const erreur = T.erreur;

const nomDe = (u) => u?.name || u?.fullname || "Utilisateur";

/* Les NUMERIC de PostgreSQL arrivent en CHAÎNE. Les faire passer par un
   Number pour les réécrire aussitôt en base ne gagne rien et peut perdre un
   franc en route : on recopie la valeur telle quelle, PostgreSQL la relit.
   `montantLu` n'existe que pour ce que l'on RENVOIE au client HTTP, où un
   nombre est attendu. */
const montantLu = (v) => Number(v || 0);

function produitDe(cle) {
  const p = PRODUITS[String(cle || "").toUpperCase()];
  if (!p) {
    throw erreur(
      `Produit inconnu : « ${cle} ». Les états existent pour ${Object.values(PRODUITS).map((x) => x.libelle).join(" et ")}.`,
      "PRODUCT_UNKNOWN", 400);
  }
  return p;
}

/* ─────────────────────────────────────────────────────────────────────────
   CE QUE L'ON PEUT ENCORE METTRE DANS UN ÉTAT
   ───────────────────────────────────────────────────────────────────────── */
async function facturesDisponibles(client, {
  companyId, product, du = null, au = null, clientId = null,
  inclurePrises = false, recherche = null, limite = 500,
}) {
  const p = produitDe(product);
  const params = [companyId, p.cle];
  const cond = [`i.company_id = $1`];
  const ajoute = (sql, valeur) => { params.push(valeur); cond.push(sql.replace("$n", `$${params.length}`)); };

  if (du) ajoute("i.invoice_date >= $n::date", du);
  if (au) ajoute("i.invoice_date <= $n::date", au);
  if (clientId) ajoute("i.customer_id = $n::int", clientId);
  if (recherche) ajoute("(i.invoice_number ILIKE '%' || $n || '%' OR c.name ILIKE '%' || $n || '%')", recherche);

  params.push(limite);
  const limiteParam = `$${params.length}`;

  /* La jointure sur la vue répond à « déjà prise ? ». `inclurePrises` ne
     change pas la réponse, seulement si la ligne est renvoyée : l'écran de
     sélection doit pouvoir MONTRER qu'une facture est prise, et par quel
     état, plutôt que de la faire disparaître sans explication. */
  const { rows } = await client.query(
    `SELECT i.id, i.invoice_number, i.invoice_date, i.due_date,
            i.total_amount, i.paid_amount, i.remaining_amount, i.status,
            i.operation_reference, i.destination,
            COALESCE(c.name, '') AS client_name,
            e.statement_id, e.statement_number, e.statement_status, e.statement_origin
       FROM ${p.factures} i
       LEFT JOIN ${p.clients} c ON c.id = i.customer_id AND c.company_id = i.company_id
       LEFT JOIN v_factures_deja_sur_etat e
              ON e.company_id = i.company_id AND e.product = $2
             AND (e.invoice_id = i.id
                  OR (e.invoice_id IS NULL
                      AND e.invoice_key = lower(btrim(i.invoice_number))))
      WHERE ${cond.join(" AND ")}
        AND i.status <> ALL ($${params.length + 1}::text[])
        ${inclurePrises ? "" : "AND e.statement_id IS NULL"}
      ORDER BY i.invoice_date DESC NULLS LAST, i.invoice_number DESC
      LIMIT ${limiteParam}`,
    [...params, p.statutsExclus]);

  return rows.map((r) => ({
    id: Number(r.id),
    numero: r.invoice_number,
    date: r.invoice_date,
    echeance: r.due_date,
    client: r.client_name,
    reference_operation: r.operation_reference || "",
    destination: r.destination || "",
    montant: montantLu(r.total_amount),
    paye: montantLu(r.paid_amount),
    restant: montantLu(r.remaining_amount),
    statut: r.status,
    deja_sur_etat: r.statement_id
      ? {
        etat_id: Number(r.statement_id),
        numero: r.statement_number,
        statut: r.statement_status,
        origine: r.statement_origin,
      }
      : null,
  }));
}

/* ─────────────────────────────────────────────────────────────────────────
   L'AVERTISSEMENT SUR LES ÉTATS ANTÉRIEURS
   Appelé par les routes de sélection. Sans lui, l'écran laisserait croire
   qu'une facture absente du registre n'a jamais été portée sur un état.
   ───────────────────────────────────────────────────────────────────────── */
async function avertissementHistorique(client, { companyId, product }) {
  const p = produitDe(product);
  const { rows } = await client.query(
    `SELECT declared_complete, note, declared_by_name, declared_at
       FROM invoice_statement_history_notice
      WHERE company_id = $1 AND product = $2`, [companyId, p.cle]);
  const n = rows[0] || { declared_complete: false, note: "", declared_by_name: "", declared_at: null };
  const { rows: repris } = await client.query(
    `SELECT count(*)::int AS n FROM invoice_statements
      WHERE company_id = $1 AND product = $2 AND origin = 'HISTORIQUE'`,
    [companyId, p.cle]);
  return {
    historique_complet: n.declared_complete === true,
    etats_repris: repris[0].n,
    note: n.note || "",
    declare_par: n.declared_by_name || "",
    declare_le: n.declared_at,
    message: n.declared_complete
      ? "Les états antérieurs ont été repris : l'absence d'une facture de cette liste signifie qu'elle est libre."
      : "Les états antérieurs n'ont pas tous été repris. Une facture absente de cette liste peut déjà figurer sur un état papier : vérifiez avant de la facturer deux fois.",
  };
}

async function declarerHistoriqueComplet(client, { companyId, product, complet, note, utilisateur }) {
  const p = produitDe(product);
  if (complet && String(note || "").trim().length < 10) {
    throw erreur(
      "Déclarer l'historique complet demande une note de 10 caractères minimum : elle dit sur quoi vous vous appuyez.",
      "NOTE_REQUIRED", 400);
  }
  const { rows } = await client.query(
    `INSERT INTO invoice_statement_history_notice
       (company_id, product, declared_complete, note, declared_by, declared_by_name, declared_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $3 THEN now() ELSE NULL END, now())
     ON CONFLICT (company_id, product) DO UPDATE
       SET declared_complete = EXCLUDED.declared_complete,
           note = EXCLUDED.note,
           declared_by = EXCLUDED.declared_by,
           declared_by_name = EXCLUDED.declared_by_name,
           declared_at = EXCLUDED.declared_at,
           updated_at = now()
     RETURNING *`,
    [companyId, p.cle, !!complet, String(note || "").trim(),
      utilisateur?.id || null, nomDe(utilisateur)]);
  return rows[0];
}

/* ─────────────────────────────────────────────────────────────────────────
   JOURNALISER
   ───────────────────────────────────────────────────────────────────────── */
async function journaliser(client, etat, { action, motif = "", details = {}, utilisateur }) {
  await client.query(
    `INSERT INTO invoice_statement_history
       (statement_id, company_id, action, reason, details, acted_by, acted_by_name)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [etat.id, etat.company_id, action, String(motif || ""),
      JSON.stringify(details || {}), utilisateur?.id || null, nomDe(utilisateur)]);
}

async function charger(client, companyId, etatId, { verrou = false } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM invoice_statements
      WHERE id = $1 AND company_id = $2${verrou ? " FOR UPDATE" : ""}`,
    [etatId, companyId]);
  if (!rows[0]) throw erreur("État introuvable dans cette société.", "STATEMENT_NOT_FOUND", 404);
  return rows[0];
}

async function recalculerTotaux(client, etatId) {
  const { rows } = await client.query(
    `UPDATE invoice_statements s
        SET invoices_count  = t.n,
            total_invoiced   = t.montant,
            total_paid       = t.paye,
            total_remaining  = t.restant,
            updated_at       = now()
       FROM (SELECT count(*)::int AS n,
                    COALESCE(sum(total_amount),0)     AS montant,
                    COALESCE(sum(paid_amount),0)      AS paye,
                    COALESCE(sum(remaining_amount),0) AS restant
               FROM invoice_statement_lines WHERE statement_id = $1) t
      WHERE s.id = $1
      RETURNING *`, [etatId]);
  return rows[0];
}

/* ─────────────────────────────────────────────────────────────────────────
   CRÉER UN ÉTAT (brouillon)
   ───────────────────────────────────────────────────────────────────────── */
async function creer(client, {
  companyId, product, factureIds = [], titre = "", du = null, au = null,
  notes = "", utilisateur, remplaceEtatId = null, motifRemplacement = "",
}) {
  const p = produitDe(product);
  const ids = [...new Set((factureIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) {
    throw erreur("Aucune facture sélectionnée : un état vide ne veut rien dire.",
      "NO_INVOICE_SELECTED", 400);
  }

  const numero = await nextShortDocumentNumber(p.prefixe, companyId, client);
  const { rows: creees } = await client.query(
    `INSERT INTO invoice_statements
       (company_id, statement_number, product, title, period_from, period_to,
        status, notes, replaces_statement_id, replace_reason,
        created_by, created_by_name)
     VALUES ($1,$2,$3,$4,$5::date,$6::date,'BROUILLON',$7,$8::bigint,$9,$10,$11)
     RETURNING *`,
    [companyId, numero, p.cle, String(titre || "").trim(), du, au,
      String(notes || "").trim(), remplaceEtatId || null,
      String(motifRemplacement || "").trim(),
      utilisateur?.id || null, nomDe(utilisateur)]);
  const etat = creees[0];

  await ajouterFactures(client, { etat, ids, utilisateur, premier: true });
  await journaliser(client, etat, {
    action: "CREATION", utilisateur,
    details: { numero, produit: p.cle, factures: ids.length },
  });
  return recalculerTotaux(client, etat.id);
}

/* ─────────────────────────────────────────────────────────────────────────
   AJOUTER DES FACTURES
   ───────────────────────────────────────────────────────────────────────── */
async function ajouterFactures(client, { etat, ids, utilisateur, premier = false }) {
  const p = produitDe(etat.product);
  if (!premier && etat.status !== STATUTS.BROUILLON) {
    throw erreur(
      `L'état ${etat.statement_number} est ${etat.status.toLowerCase()} : on ne lui ajoute plus de ligne. Corrigez-le, ce qui en crée un nouveau.`,
      "STATEMENT_NOT_DRAFT", 409);
  }

  /* Les factures sont relues depuis leur table, dans la société de l'état :
     les montants et le nom du client ne viennent pas du client HTTP. */
  const { rows: factures } = await client.query(
    `SELECT i.id, i.invoice_number, i.invoice_date, i.total_amount, i.paid_amount,
            i.remaining_amount, i.status, i.destination,
            COALESCE(c.name,'') AS client_name
       FROM ${p.factures} i
       LEFT JOIN ${p.clients} c ON c.id = i.customer_id AND c.company_id = i.company_id
      WHERE i.company_id = $1 AND i.id = ANY($2::bigint[])
      ORDER BY i.invoice_date NULLS LAST, i.invoice_number`,
    [etat.company_id, ids]);

  if (factures.length !== ids.length) {
    const trouvees = new Set(factures.map((f) => Number(f.id)));
    const manquantes = ids.filter((i) => !trouvees.has(i));
    throw erreur(
      `${manquantes.length} facture(s) introuvable(s) dans cette société : ${manquantes.join(", ")}. La séparation des sociétés n'est pas contournée pour résoudre une sélection.`,
      "INVOICE_NOT_FOUND", 404);
  }

  const exclues = factures.filter((f) => p.statutsExclus.includes(f.status));
  if (exclues.length) {
    throw erreur(
      `${exclues.map((f) => f.invoice_number).join(", ")} : une facture ${exclues[0].status.toLowerCase()} ne se porte pas sur un état.`,
      "INVOICE_STATUS_EXCLUDED", 409);
  }

  /* Le contrôle applicatif, qui sert à DIRE ce qui bloque et par quel état.
     L'index unique reste le gardien ; celui-ci rend le refus lisible. */
  const { rows: prises } = await client.query(
    `SELECT e.invoice_id, e.invoice_number, e.statement_number, e.statement_status
       FROM v_factures_deja_sur_etat e
      WHERE e.company_id = $1 AND e.product = $2
        AND (e.invoice_id = ANY($3::bigint[])
             OR lower(btrim(e.invoice_number)) = ANY($4::text[]))`,
    [etat.company_id, p.cle, ids,
      factures.map((f) => String(f.invoice_number).trim().toLowerCase())]);
  if (prises.length) {
    throw erreur(
      `Déjà sur un état validé : ${prises.map((x) => `${x.invoice_number} (état ${x.statement_number})`).join(", ")}. Annulez ou corrigez cet état d'abord — une facture ne se réclame pas deux fois.`,
      "INVOICE_ALREADY_IN_STATEMENT", 409);
  }

  let ordre = 0;
  const { rows: dernier } = await client.query(
    `SELECT COALESCE(max(sort_order),0) AS n FROM invoice_statement_lines WHERE statement_id = $1`,
    [etat.id]);
  ordre = Number(dernier[0].n);

  for (const f of factures) {
    ordre += 1;
    await client.query(
      `INSERT INTO invoice_statement_lines
         (statement_id, company_id, product, invoice_id, invoice_number, reconciled,
          invoice_date, client_name, site, total_amount, paid_amount, remaining_amount,
          status_at_time, sort_order)
       VALUES ($1,$2,$3,$4::bigint,$5,TRUE,$6::date,$7,$8,$9,$10,$11,$12,$13)`,
      [etat.id, etat.company_id, p.cle, f.id, f.invoice_number,
        f.invoice_date, f.client_name, f.destination || "",
        f.total_amount, f.paid_amount, f.remaining_amount,
        f.status, ordre]);
  }

  if (!premier) {
    await journaliser(client, etat, {
      action: "AJOUT_LIGNE", utilisateur,
      details: { factures: factures.map((f) => f.invoice_number) },
    });
  }
  return factures.length;
}

async function retirerFacture(client, { companyId, etatId, ligneId, utilisateur }) {
  const etat = await charger(client, companyId, etatId, { verrou: true });
  if (etat.status !== STATUTS.BROUILLON) {
    throw erreur(
      `L'état ${etat.statement_number} est ${etat.status.toLowerCase()} : on n'en retire plus de ligne.`,
      "STATEMENT_NOT_DRAFT", 409);
  }
  const { rows } = await client.query(
    `DELETE FROM invoice_statement_lines
      WHERE id = $1 AND statement_id = $2 RETURNING invoice_number`,
    [ligneId, etatId]);
  if (!rows[0]) throw erreur("Ligne introuvable dans cet état.", "LINE_NOT_FOUND", 404);
  await journaliser(client, etat, {
    action: "RETRAIT_LIGNE", utilisateur, details: { facture: rows[0].invoice_number },
  });
  return recalculerTotaux(client, etatId);
}

/* ─────────────────────────────────────────────────────────────────────────
   VALIDER
   C'est ici que l'état devient une pièce, et que ses factures cessent d'être
   disponibles. L'index unique peut refuser : on traduit le refus.
   ───────────────────────────────────────────────────────────────────────── */
async function valider(client, { companyId, etatId, utilisateur }) {
  const etat = await charger(client, companyId, etatId, { verrou: true });
  if (etat.status === STATUTS.VALIDE) {
    throw erreur(`L'état ${etat.statement_number} est déjà validé.`, "ALREADY_VALIDATED", 409);
  }
  if (etat.status !== STATUTS.BROUILLON) {
    throw erreur(`L'état ${etat.statement_number} est ${etat.status.toLowerCase()} : il ne se valide plus.`,
      "STATEMENT_NOT_DRAFT", 409);
  }
  const { rows: lignes } = await client.query(
    `SELECT count(*)::int AS n FROM invoice_statement_lines WHERE statement_id = $1`, [etatId]);
  if (!lignes[0].n) {
    throw erreur("Cet état n'a aucune ligne : il n'y a rien à valider.", "STATEMENT_EMPTY", 409);
  }

  /* Si cet état remplace un autre, l'ancien cesse de réclamer AVANT que le
     nouveau ne réclame : sans cet ordre, l'index unique refuserait les
     factures reprises, et une correction serait impossible. */
  if (etat.replaces_statement_id) {
    const ancien = await charger(client, companyId, etat.replaces_statement_id, { verrou: true });
    if (ancien.status === STATUTS.VALIDE) {
      await client.query(
        `UPDATE invoice_statements
            SET status = 'REMPLACE', replace_reason = $2, updated_at = now()
          WHERE id = $1`,
        [ancien.id, etat.replace_reason || `Remplacé par ${etat.statement_number}`]);
      await journaliser(client, ancien, {
        action: "REMPLACEMENT", motif: etat.replace_reason, utilisateur,
        details: { remplace_par: etat.statement_number },
      });
    }
  }

  try {
    const { rows } = await client.query(
      `UPDATE invoice_statements
          SET status = 'VALIDE', validated_by = $2, validated_by_name = $3,
              validated_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [etatId, utilisateur?.id || null, nomDe(utilisateur)]);
    await journaliser(client, rows[0], {
      action: "VALIDATION", utilisateur, details: { lignes: lignes[0].n },
    });
    return rows[0];
  } catch (e) {
    /* 23505 : une facture de cet état est entrée entre-temps dans un autre
       état validé. C'est exactement le cas que l'index doit attraper, et il
       l'attrape — y compris entre deux validations simultanées. */
    if (e.code === "23505") {
      throw erreur(
        "Une facture de cet état vient d'être portée sur un autre état validé. Rechargez la sélection : rien n'a été validé ici.",
        "CONCURRENT_STATEMENT", 409);
    }
    throw e;
  }
}

async function annuler(client, { companyId, etatId, motif, utilisateur }) {
  const etat = await charger(client, companyId, etatId, { verrou: true });
  const m = String(motif || "").trim();
  if (m.length < 10) {
    throw erreur("Motif d'annulation obligatoire (10 caractères minimum) : il restera attaché à l'état.",
      "REASON_REQUIRED", 400);
  }
  if (etat.status === STATUTS.ANNULE) {
    throw erreur(`L'état ${etat.statement_number} est déjà annulé.`, "ALREADY_CANCELLED", 409);
  }
  if (etat.status === STATUTS.REMPLACE) {
    throw erreur(
      `L'état ${etat.statement_number} a été remplacé : c'est l'état qui lui a succédé qu'il faut annuler.`,
      "STATEMENT_REPLACED", 409);
  }
  const { rows } = await client.query(
    `UPDATE invoice_statements
        SET status = 'ANNULE', cancelled_by = $2, cancelled_by_name = $3,
            cancelled_at = now(), cancel_reason = $4, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [etatId, utilisateur?.id || null, nomDe(utilisateur), m]);
  await journaliser(client, rows[0], { action: "ANNULATION", motif: m, utilisateur });
  return rows[0];
}

/* ─────────────────────────────────────────────────────────────────────────
   CORRIGER
   Ni réécriture ni suppression : un nouvel état, qui désigne l'ancien.
   ───────────────────────────────────────────────────────────────────────── */
async function corriger(client, { companyId, etatId, motif, factureIds, utilisateur }) {
  const ancien = await charger(client, companyId, etatId, { verrou: true });
  const m = String(motif || "").trim();
  if (m.length < 10) {
    throw erreur("Motif de correction obligatoire (10 caractères minimum) : il dira plus tard pourquoi deux états portent les mêmes factures.",
      "REASON_REQUIRED", 400);
  }
  if (ancien.status !== STATUTS.VALIDE) {
    throw erreur(
      `Seul un état validé se corrige. ${ancien.statement_number} est ${ancien.status.toLowerCase()} : modifiez-le directement, ou annulez-le.`,
      "STATEMENT_NOT_VALIDATED", 409);
  }

  /* Par défaut, le nouvel état reprend les mêmes factures : corriger un
     intitulé ou une période ne doit pas obliger à resélectionner. */
  let ids = factureIds;
  if (!ids || !ids.length) {
    const { rows } = await client.query(
      `SELECT invoice_id FROM invoice_statement_lines
        WHERE statement_id = $1 AND invoice_id IS NOT NULL ORDER BY sort_order, id`,
      [etatId]);
    ids = rows.map((r) => Number(r.invoice_id));
  }

  /* L'ancien cesse de réclamer d'abord : sinon ses propres factures seraient
     refusées au nouvel état. */
  await client.query(
    `UPDATE invoice_statements
        SET status = 'REMPLACE', replace_reason = $2, updated_at = now()
      WHERE id = $1`, [ancien.id, m]);
  await journaliser(client, ancien, { action: "REMPLACEMENT", motif: m, utilisateur });

  return creer(client, {
    companyId, product: ancien.product, factureIds: ids,
    titre: ancien.title, du: ancien.period_from, au: ancien.period_to,
    notes: ancien.notes, utilisateur,
    remplaceEtatId: ancien.id, motifRemplacement: m,
  });
}

/* ─────────────────────────────────────────────────────────────────────────
   REPRENDRE UN ÉTAT ANTÉRIEUR
   Pour qu'une facture déjà portée sur un état papier ne soit pas réclamée
   une seconde fois. Les numéros suffisent : les factures sont rapprochées
   quand elles existent, et la ligne reste « non rapprochée » sinon.
   ───────────────────────────────────────────────────────────────────────── */
async function reprendreHistorique(client, {
  companyId, product, reference, numerosFactures = [], titre = "",
  du = null, au = null, notes = "", utilisateur,
}) {
  const p = produitDe(product);
  const ref = String(reference || "").trim();
  if (ref.length < 2) {
    throw erreur("La référence de l'état antérieur est obligatoire : c'est elle qui permettra de retrouver le document papier.",
      "REFERENCE_REQUIRED", 400);
  }
  const numeros = [...new Set((numerosFactures || [])
    .map((n) => String(n || "").trim()).filter(Boolean))];
  if (!numeros.length) {
    throw erreur("Aucun numéro de facture : un état repris sans ligne ne protège rien.",
      "NO_INVOICE_NUMBER", 400);
  }

  const numero = await nextShortDocumentNumber(p.prefixe, companyId, client);
  const { rows: creees } = await client.query(
    `INSERT INTO invoice_statements
       (company_id, statement_number, product, title, period_from, period_to,
        status, origin, historical_reference, notes,
        validated_by, validated_by_name, validated_at, created_by, created_by_name)
     VALUES ($1,$2,$3,$4,$5::date,$6::date,'VALIDE','HISTORIQUE',$7,$8,
             $9,$10,now(),$9,$10)
     RETURNING *`,
    [companyId, numero, p.cle,
      String(titre || `État antérieur ${ref}`).trim(), du, au, ref,
      String(notes || "").trim(), utilisateur?.id || null, nomDe(utilisateur)]);
  const etat = creees[0];

  /* Rapprochement : on cherche chaque numéro parmi les factures existantes.
     Trouvé → la ligne désigne la facture. Pas trouvé → la ligne garde le
     numéro et se déclare non rapprochée, ce qui bloque quand même la
     réutilisation de ce numéro. */
  const { rows: existantes } = await client.query(
    `SELECT i.id, i.invoice_number, i.invoice_date, i.total_amount, i.paid_amount,
            i.remaining_amount, i.status, i.destination, COALESCE(c.name,'') AS client_name
       FROM ${p.factures} i
       LEFT JOIN ${p.clients} c ON c.id = i.customer_id AND c.company_id = i.company_id
      WHERE i.company_id = $1
        AND lower(btrim(i.invoice_number)) = ANY($2::text[])`,
    [companyId, numeros.map((n) => n.toLowerCase())]);
  const parNumero = new Map(existantes.map((f) => [String(f.invoice_number).trim().toLowerCase(), f]));

  let rapprochees = 0, orphelines = 0, ordre = 0;
  const conflits = [];
  for (const n of numeros) {
    ordre += 1;
    const f = parNumero.get(n.toLowerCase());
    try {
      if (f) {
        await client.query(
          `INSERT INTO invoice_statement_lines
             (statement_id, company_id, product, invoice_id, invoice_number, reconciled,
              invoice_date, client_name, site, total_amount, paid_amount, remaining_amount,
              status_at_time, sort_order)
           VALUES ($1,$2,$3,$4::bigint,$5,TRUE,$6::date,$7,$8,$9,$10,$11,$12,$13)`,
          [etat.id, companyId, p.cle, f.id, f.invoice_number, f.invoice_date,
            f.client_name, f.destination || "",
            f.total_amount, f.paid_amount, f.remaining_amount, f.status, ordre]);
        rapprochees += 1;
      } else {
        await client.query(
          `INSERT INTO invoice_statement_lines
             (statement_id, company_id, product, invoice_id, invoice_number, reconciled, sort_order)
           VALUES ($1,$2,$3,NULL,$4,FALSE,$5)`,
          [etat.id, companyId, p.cle, n, ordre]);
        orphelines += 1;
      }
    } catch (e) {
      /* Ce numéro est déjà porté par un autre état validé. On ne casse pas la
         reprise entière pour autant : on note le conflit et on continue, pour
         que la personne voie la liste complète en une fois. */
      if (e.code !== "23505") throw e;
      conflits.push(n);
    }
  }

  await journaliser(client, etat, {
    action: "REPRISE_HISTORIQUE", motif: ref, utilisateur,
    details: { numeros: numeros.length, rapprochees, orphelines, conflits },
  });
  const final = await recalculerTotaux(client, etat.id);
  return { etat: final, rapprochees, orphelines, conflits };
}

/* ─────────────────────────────────────────────────────────────────────────
   RAPPROCHER LES LIGNES RESTÉES ORPHELINES
   Une facture saisie après la reprise d'un vieil état doit pouvoir être
   reliée à sa ligne. Sans cela, l'état resterait éternellement approximatif.
   ───────────────────────────────────────────────────────────────────────── */
async function rapprocher(client, { companyId, product, utilisateur }) {
  const p = produitDe(product);
  const { rows } = await client.query(
    `UPDATE invoice_statement_lines l
        SET invoice_id = i.id, reconciled = TRUE,
            invoice_date = i.invoice_date,
            client_name = COALESCE(c.name, l.client_name),
            total_amount = i.total_amount, paid_amount = i.paid_amount,
            remaining_amount = i.remaining_amount, status_at_time = i.status
       FROM ${p.factures} i
       LEFT JOIN ${p.clients} c ON c.id = i.customer_id AND c.company_id = i.company_id
      WHERE l.company_id = $1 AND l.product = $2 AND l.reconciled = FALSE
        AND i.company_id = l.company_id
        AND lower(btrim(i.invoice_number)) = lower(btrim(l.invoice_number))
      RETURNING l.statement_id, l.invoice_number`,
    [companyId, p.cle]);

  const parEtat = new Map();
  for (const r of rows) {
    if (!parEtat.has(r.statement_id)) parEtat.set(r.statement_id, []);
    parEtat.get(r.statement_id).push(r.invoice_number);
  }
  for (const [etatId, numeros] of parEtat) {
    await journaliser(client, { id: etatId, company_id: companyId }, {
      action: "RAPPROCHEMENT", utilisateur, details: { factures: numeros },
    });
    await recalculerTotaux(client, etatId);
  }
  return { rapprochees: rows.length, etats: parEtat.size };
}

/* ─────────────────────────────────────────────────────────────────────────
   LIRE
   ───────────────────────────────────────────────────────────────────────── */
async function lister(client, { companyId, product = null, statut = null, limite = 100 }) {
  const params = [companyId];
  const cond = ["s.company_id = $1"];
  if (product) { params.push(produitDe(product).cle); cond.push(`s.product = $${params.length}`); }
  if (statut) { params.push(String(statut).toUpperCase()); cond.push(`s.status = $${params.length}`); }
  params.push(limite);
  const { rows } = await client.query(
    `SELECT s.*, r.statement_number AS remplace_numero,
            (SELECT statement_number FROM invoice_statements x
              WHERE x.replaces_statement_id = s.id ORDER BY x.id DESC LIMIT 1) AS remplace_par_numero,
            (SELECT count(*)::int FROM invoice_statement_lines l
              WHERE l.statement_id = s.id AND l.reconciled = FALSE) AS lignes_non_rapprochees
       FROM invoice_statements s
       LEFT JOIN invoice_statements r ON r.id = s.replaces_statement_id
      WHERE ${cond.join(" AND ")}
      ORDER BY s.created_at DESC
      LIMIT $${params.length}`, params);
  return rows;
}

async function detail(client, { companyId, etatId }) {
  const etat = await charger(client, companyId, etatId);
  const { rows: lignes } = await client.query(
    `SELECT * FROM invoice_statement_lines WHERE statement_id = $1 ORDER BY sort_order, id`,
    [etatId]);
  const { rows: historique } = await client.query(
    `SELECT * FROM invoice_statement_history WHERE statement_id = $1 ORDER BY acted_at DESC, id DESC`,
    [etatId]);
  const { rows: liens } = await client.query(
    `SELECT id, statement_number, status FROM invoice_statements
      WHERE id = $1 OR replaces_statement_id = $2`,
    [etat.replaces_statement_id || 0, etatId]);
  return { etat, lignes, historique, liens };
}

async function noterImpression(client, { companyId, etatId, utilisateur }) {
  const etat = await charger(client, companyId, etatId, { verrou: true });
  const premiere = etat.printed_count === 0;
  const { rows } = await client.query(
    `UPDATE invoice_statements
        SET printed_count = printed_count + 1, last_printed_at = now(), updated_at = now()
      WHERE id = $1 RETURNING *`, [etatId]);
  await journaliser(client, rows[0], {
    action: premiere ? "IMPRESSION" : "REIMPRESSION", utilisateur,
    details: { numero_impression: rows[0].printed_count },
  });
  return rows[0];
}

module.exports = {
  PRODUITS, STATUTS,
  produitDe, erreur,
  facturesDisponibles, avertissementHistorique, declarerHistoriqueComplet,
  creer, ajouterFactures, retirerFacture, valider, annuler, corriger,
  reprendreHistorique, rapprocher,
  lister, detail, noterImpression, recalculerTotaux, charger,
};

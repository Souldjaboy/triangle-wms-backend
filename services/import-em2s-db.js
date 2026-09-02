"use strict";

/**
 * DU CLASSEUR À LA BASE.
 *
 * `import-em2s.js` lit le fichier. Ce module confronte cette lecture à ce qui
 * existe déjà, puis écrit — en une transaction, et jamais deux fois la même
 * chose.
 *
 * Trois règles gouvernent tout ce fichier :
 *
 *   — Une réception n'est PAS une entrée en stock. Enregistrer l'arrivée d'un
 *     conteneur ne bouge aucune quantité ; le stock ne monte qu'à la mise en
 *     stock, validée séparément par quelqu'un qui a le droit de le faire.
 *
 *   — Une ligne bloquée ne produit rien. Pas une balance, pas un mouvement,
 *     pas un demi-mouvement. Tant que la répartition par bac ou par date
 *     manque, la ligne attend.
 *
 *   — L'anti-doublon est tenu par la base, pas par le code appelant : chaque
 *     opération porte une clé calculée à partir de ce qui la définit, et un
 *     index d'unicité refuse la seconde écriture.
 */

const crypto = require("crypto");
const P = require("./import-em2s");

/* ──────────────────────────────────────────────────── idempotence ── */

/**
 * Clé stable d'une opération. Elle ne dépend que de ce qui la définit : le
 * fichier, l'endroit d'où elle vient, et ce qu'elle fait. Rejouer le même
 * classeur retombe sur les mêmes clés — c'est ce qui rend le second passage
 * inoffensif.
 */
function cleIdempotence(parties) {
  const texte = [
    parties.sha, parties.kind, parties.feuille ?? "", parties.ligne ?? "",
    parties.conteneur ?? "", parties.entrepot ?? "", parties.libelle ?? "",
    parties.emplacement ?? "", parties.sens ?? "", parties.quantite ?? "",
    parties.date ?? "",
  ].join("|");
  return crypto.createHash("sha256").update(texte).digest("hex");
}

/* ──────────────────────────────────────────────────────── produits ── */

/** Forme comparable d'un libellé : casse, accents et espaces neutralisés. */
function normaliserLibelle(libelle) {
  return String(libelle ?? "")
    .normalize("NFD")
    /* Les signes diacritiques occupent le bloc U+0300 à U+036F : on les
       retire pour que « MEMBRANE » et « MÉMBRANE » se comparent. */
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

/**
 * Index des produits de l'entreprise, construit UNE fois par
 * prévisualisation : interroger la table à chaque ligne la relirait quatre
 * cents fois pour un seul classeur.
 */
async function chargerIndexProduits(client, companyId) {
  const [{ rows: produits }, { rows: alias }] = await Promise.all([
    client.query(`SELECT id, name FROM products WHERE company_id = $1`, [companyId]),
    client.query(
      `SELECT a.alias_norm, a.product_id, p.name
         FROM product_import_aliases a
         JOIN products p ON p.id = a.product_id AND p.company_id = a.company_id
        WHERE a.company_id = $1`, [companyId]),
  ]);

  const parNom = new Map();
  for (const p of produits) {
    const cle = normaliserLibelle(p.name);
    if (!parNom.has(cle)) parNom.set(cle, []);
    parNom.get(cle).push(p);
  }
  const parAlias = new Map(alias.map((a) => [a.alias_norm, { id: a.product_id, name: a.name }]));
  return { parNom, parAlias };
}

/**
 * Rapproche un libellé du classeur d'un produit existant.
 *
 * Trois degrés seulement, et aucun « à peu près » : un alias déjà confirmé,
 * un nom identique une fois normalisé, ou rien. « SPEACKER » et « SPEAKER »
 * se ressemblent, « MAMBRANE » et « MEMBRANE » aussi — les rapprocher tout
 * seul fusionnerait peut-être deux articles réellement différents, et
 * personne ne s'en apercevrait avant l'inventaire.
 */
function trouverProduit(index, libelle) {
  const norm = normaliserLibelle(libelle);
  if (!norm) return { statut: "VIDE", produit: null };

  const alias = index.parAlias.get(norm);
  if (alias) return { statut: "ALIAS", produit: alias };

  const candidats = index.parNom.get(norm) || [];
  if (candidats.length === 1) return { statut: "NOM_EXACT", produit: candidats[0] };
  if (candidats.length > 1) return { statut: "AMBIGU", produit: null, candidats };
  return { statut: "NOUVEAU", produit: null };
}

/* ─────────────────────────────────────────────────── emplacements ── */

/**
 * Retrouve l'emplacement décrit par une ligne du classeur. Une zone au sol
 * n'a ni niveau ni bac : elle se cherche sur son seul code.
 */
async function trouverEmplacement(client, companyId, ligne) {
  if (!ligne.rayon && !ligne.location) return { statut: "SANS_EMPLACEMENT", emplacement: null };

  if (ligne.zoneSansRack) {
    const { rows } = await client.query(
      `SELECT id, full_code, emplacement_code FROM locations
        WHERE company_id = $1
          AND upper(btrim(COALESCE(NULLIF(full_code,''), emplacement_code))) = upper(btrim($2))
        LIMIT 2`,
      [companyId, ligne.location || ligne.rayon]
    );
    if (rows.length === 1) return { statut: "EXISTANT", emplacement: rows[0] };
    if (rows.length > 1) return { statut: "AMBIGU", emplacement: null, candidats: rows };
    return { statut: "NOUVEAU", emplacement: null };
  }

  const bin = ligne.bins.length === 1 ? ligne.bins[0] : null;
  const { rows } = await client.query(
    `SELECT id, full_code, emplacement_code FROM locations
      WHERE company_id = $1
        AND upper(btrim(COALESCE(NULLIF(rayon_code,''), zone, ''))) = upper(btrim($2))
        AND upper(btrim(COALESCE(NULLIF(case_code,''), rayon, ''))) = upper(btrim($3))
        AND upper(btrim(COALESCE(level_code, ''))) = upper(btrim($4))
        AND ($5::text IS NULL OR upper(btrim(COALESCE(bin_code,''))) = upper(btrim($5)))
      LIMIT 2`,
    [companyId, ligne.rayon || "", ligne.location || "", ligne.niveau || "", bin]
  );
  if (rows.length === 1) return { statut: "EXISTANT", emplacement: rows[0] };
  if (rows.length > 1) return { statut: "AMBIGU", emplacement: null, candidats: rows };
  return { statut: "NOUVEAU", emplacement: null };
}

/* ═════════════════════════════════════════════════ PRÉVISUALISATION ══ */

/**
 * Ce que le classeur produirait, sans rien écrire.
 *
 * On y voit ce qui existe déjà, ce qui serait créé, ce qui est ambigu, et ce
 * qui reste bloqué. Une prévisualisation qui cache les blocages ne sert à
 * rien : c'est justement ce qu'il faut regarder avant de valider.
 */
async function previsualiser(client, { companyId, buffer, nomFichier }) {
  const lecture = P.lireClasseur(buffer, { nomFichier });
  const sha = lecture.fichier.sha256;
  const indexProduits = await chargerIndexProduits(client, companyId);

  /* Ce que ce fichier a déjà produit ici, s'il est déjà passé. */
  const { rows: dejaFaites } = await client.query(
    `SELECT idempotency_key, kind FROM stock_import_operations
      WHERE company_id = $1 AND file_sha256 = $2`,
    [companyId, sha]
  );
  const dejaVues = new Set(dejaFaites.map((o) => o.idempotency_key));

  /* ── Réceptions ─────────────────────────────────────────────────── */
  const receptions = [];
  for (const r of lecture.receptions.liste) {
    const cle = cleIdempotence({ sha, kind: "RECEPTION", conteneur: r.conteneur, date: r.date });

    const existante = await client.query(
      `SELECT id, reception_number, status FROM stock_receptions
        WHERE company_id = $1 AND upper(btrim(container_number)) = upper(btrim($2)) LIMIT 1`,
      [companyId, r.conteneur || ""]
    );

    const lignes = [];
    for (const l of r.lignes) {
      const p = trouverProduit(indexProduits, l.libelle);
      lignes.push({
        ...l,
        produit: p.produit, statutProduit: p.statut, candidats: p.candidats || [],
        cle: cleIdempotence({
          sha, kind: "RECEPTION_LINE", conteneur: r.conteneur, entrepot: l.entrepot,
          libelle: l.libelle, quantite: l.quantite,
          feuille: l.provenance.feuille, ligne: l.provenance.ligne,
        }),
      });
    }

    receptions.push({
      ...r, cle,
      dejaImportee: dejaVues.has(cle),
      receptionExistante: existante.rows[0] || null,
      lignes,
      produitsNouveaux: lignes.filter((l) => l.statutProduit === "NOUVEAU").length,
      produitsAmbigus: lignes.filter((l) => l.statutProduit === "AMBIGU").length,
    });
  }

  /* ── Mouvements et anomalies ────────────────────────────────────── */
  const mouvements = [];
  const anomalies = [];

  for (const ligne of lecture.stock.lignes) {
    const bloquantes = ligne.anomalies.filter((a) =>
      ["MULTI_BIN", "DATES_MULTIPLES", "NEW_STOCK_INCOHERENT"].includes(a.type));

    for (const a of ligne.anomalies) {
      anomalies.push({
        type: a.type, message: a.message, description: ligne.description,
        feuille: ligne.provenance.feuille, ligne: ligne.provenance.ligne,
        cellule: a.provenance.cellule,
        payload: {
          bins: a.bins, dates: a.dates,
          quantiteAttendue: a.quantiteAttendue,
          attendu: a.attendu, affiche: a.affiche,
          rayon: ligne.rayon, location: ligne.location, niveau: ligne.niveau,
          stockInitial: ligne.stockInitial, entrees: ligne.entrees, sorties: ligne.sorties,
          nouveauStock: ligne.nouveauStock, unite: ligne.unite,
        },
      });
    }

    for (const m of ligne.mouvements) {
      /* Seules les couleurs « nouvelles » donnent lieu à un mouvement. Les
         anciennes décrivent ce qui a déjà eu lieu : les rejouer doublerait
         le stock. */
      if (!m.nouveau) continue;

      const p = trouverProduit(indexProduits, ligne.description);
      const e = await trouverEmplacement(client, companyId, ligne);
      const cle = cleIdempotence({
        sha, kind: "MOVEMENT", libelle: ligne.description, sens: m.sens,
        quantite: m.quantite, date: ligne.dateUnique,
        emplacement: `${ligne.rayon}/${ligne.location}/${ligne.niveau}/${ligne.bins.join("+")}`,
        feuille: m.provenance.feuille, ligne: m.provenance.ligne,
      });

      mouvements.push({
        description: ligne.description, sens: m.sens, quantite: m.quantite,
        couleur: m.couleur, classe: m.classe,
        date: ligne.dateUnique, datesProposees: ligne.datesProposees,
        rayon: ligne.rayon, location: ligne.location, niveau: ligne.niveau,
        bins: ligne.bins, zoneSansRack: ligne.zoneSansRack, unite: ligne.unite,
        produit: p.produit, statutProduit: p.statut,
        emplacement: e.emplacement, statutEmplacement: e.statut,
        provenance: m.provenance,
        cle, dejaImporte: dejaVues.has(cle),
        bloque: bloquantes.length > 0,
        motifsBlocage: bloquantes.map((a) => a.type),
      });
    }
  }

  const compte = (liste, f) => liste.filter(f).length;
  return {
    fichier: lecture.fichier,
    feuilles: lecture.feuilles,
    receptions: {
      total: receptions.length,
      fusionnees: compte(receptions, (r) => r.fusionne),
      dejaImportees: compte(receptions, (r) => r.dejaImportee || r.receptionExistante),
      aCreer: compte(receptions, (r) => !r.dejaImportee && !r.receptionExistante),
      liste: receptions,
    },
    mouvements: {
      total: mouvements.length,
      importables: compte(mouvements, (m) => !m.bloque && !m.dejaImporte),
      bloques: compte(mouvements, (m) => m.bloque),
      dejaImportes: compte(mouvements, (m) => m.dejaImporte),
      liste: mouvements,
    },
    couleurs: lecture.stock.couleurs,
    anomalies: {
      total: anomalies.length,
      parType: anomalies.reduce((acc, a) => ({ ...acc, [a.type]: (acc[a.type] || 0) + 1 }), {}),
      liste: anomalies,
    },
    produits: {
      nouveaux: new Set(mouvements.filter((m) => m.statutProduit === "NOUVEAU")
        .map((m) => m.description)).size,
      ambigus: new Set(mouvements.filter((m) => m.statutProduit === "AMBIGU")
        .map((m) => m.description)).size,
    },
  };
}

/* ═══════════════════════════════════════════════════════ ÉCRITURE ══ */

const NUMERO_RECEPTION = (conteneur, date) =>
  `REC-${String(date || "").replace(/-/g, "")}-${String(conteneur || "").replace(/[^A-Z0-9]/gi, "")}`;

/**
 * Écrit les réceptions prévisualisées. AUCUN stock n'est touché : une
 * réception constate une arrivée, elle ne range rien.
 *
 * `client` est déjà dans une transaction ouverte par l'appelant : si une
 * ligne échoue, tout le lot est annulé, sans demi-réception.
 */
async function ecrireReceptions(client, { companyId, batchId, sha, apercu, utilisateur }) {
  const resultat = { creees: 0, dejaPresentes: 0, lignes: 0, details: [] };

  for (const r of apercu.receptions.liste) {
    if (r.dejaImportee || r.receptionExistante) {
      resultat.dejaPresentes += 1;
      resultat.details.push({ conteneur: r.conteneur, etat: "déjà présent",
                              receptionId: r.receptionExistante?.id || null });
      continue;
    }

    const { rows } = await client.query(
      `INSERT INTO stock_receptions
         (company_id, reception_number, container_number, reception_date,
          source, source_file, file_sha256, import_batch_id, warehouses,
          status, created_by)
       VALUES ($1,$2,$3,$4,'EM2S',$5,$6,$7,$8,'RECEIVED_PENDING_PUTAWAY',$9)
       RETURNING id, reception_number`,
      [companyId, NUMERO_RECEPTION(r.conteneur, r.date), r.conteneur, r.date,
       apercu.fichier.nom, sha, batchId, r.entrepots, utilisateur?.id || null]
    );
    const reception = rows[0];

    await client.query(
      `INSERT INTO stock_import_operations
         (company_id, batch_id, idempotency_key, kind, file_sha256,
          container_number, business_date, reception_id, created_by)
       VALUES ($1,$2,$3,'RECEPTION',$4,$5,$6,$7,$8)`,
      [companyId, batchId, r.cle, sha, r.conteneur, r.date, reception.id, utilisateur?.id || null]
    );

    let numero = 0;
    for (const l of r.lignes) {
      numero += 1;
      const { rows: lignes } = await client.query(
        `INSERT INTO stock_reception_lines
           (company_id, reception_id, line_no, received_label, product_id,
            match_status, unit, quantity_received, warehouse_code,
            excel_sheet, excel_row, excel_cell, import_batch_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING id`,
        [companyId, reception.id, numero, l.libelle, l.produit?.id || null,
         l.statutProduit === "AMBIGU" ? "AMBIGUOUS" : (l.produit ? "MATCHED" : "TO_REVIEW"),
         l.unite, l.quantite, l.entrepot,
         l.provenance.feuille, l.provenance.ligne, l.provenance.cellule, batchId]
      );

      await client.query(
        `INSERT INTO stock_import_operations
           (company_id, batch_id, idempotency_key, kind, file_sha256, excel_sheet,
            excel_row, excel_cell, container_number, warehouse_code, product_id,
            product_label, quantity, reception_id, reception_line_id, created_by)
         VALUES ($1,$2,$3,'RECEPTION_LINE',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [companyId, batchId, l.cle, sha, l.provenance.feuille, l.provenance.ligne,
         l.provenance.cellule, r.conteneur, l.entrepot, l.produit?.id || null,
         l.libelle, l.quantite, reception.id, lignes[0].id, utilisateur?.id || null]
      );
      resultat.lignes += 1;
    }

    resultat.creees += 1;
    resultat.details.push({ conteneur: r.conteneur, etat: "créée",
                            receptionId: reception.id, numero: reception.reception_number,
                            lignes: r.lignes.length });
  }

  return resultat;
}

/** Ouvre les anomalies du lot. Une anomalie déjà ouverte n'est pas rouverte. */
async function ecrireAnomalies(client, { companyId, batchId, sha, apercu }) {
  let ouvertes = 0, deja = 0;
  for (const a of apercu.anomalies.liste) {
    /* Une anomalie s'identifie par le FICHIER et la cellule, pas par le lot :
       rejouer le même classeur crée un nouveau lot, et une clé fondée sur le
       lot rouvrirait chaque fois les mêmes anomalies. Celle qui attend déjà
       une décision doit rester une seule ligne à traiter. */
    const { rowCount } = await client.query(
      `INSERT INTO stock_import_anomalies
         (company_id, batch_id, file_sha256, anomaly_type, excel_sheet, excel_row,
          excel_cell, description, message, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (company_id, file_sha256, anomaly_type, excel_sheet, excel_row)
       DO NOTHING`,
      [companyId, batchId, sha, a.type, a.feuille, a.ligne, a.cellule,
       a.description, a.message, JSON.stringify(a.payload)]
    );
    if (rowCount) ouvertes += 1; else deja += 1;
  }
  return { ouvertes, dejaOuvertes: deja };
}

module.exports = {
  cleIdempotence, normaliserLibelle, chargerIndexProduits, trouverProduit, trouverEmplacement,
  previsualiser, ecrireReceptions, ecrireAnomalies, NUMERO_RECEPTION,
};

"use strict";

/**
 * LECTURE SEULE — GARANTIE PAR POSTGRESQL, PAS PAR LA BONNE VOLONTÉ DU CODE.
 *
 * Un diagnostic qu'on lance sur une base de production doit être incapable
 * d'écrire, et cette incapacité doit être DÉMONTRABLE — pas affirmée dans un
 * commentaire. Promettre « ce script ne contient pas d'INSERT » n'engage que la
 * relecture ; un verrou posé par le serveur engage le serveur.
 *
 * DEUX BARRIÈRES, ET ELLES NE SE REMPLACENT PAS
 *
 *   1. `BEGIN TRANSACTION READ ONLY`. C'est PostgreSQL qui refuse, avec le code
 *      25006, tout INSERT, UPDATE, DELETE, CREATE, ALTER, DROP ou TRUNCATE —
 *      même celui qu'un bug introduirait, même celui caché dans une fonction
 *      appelée trois niveaux plus bas. Aucune ligne de JavaScript ne peut
 *      contourner cela.
 *
 *   2. Un garde en amont, qui refuse d'ENVOYER autre chose qu'une lecture. Il
 *      ne protège pas mieux que le premier : il donne un message clair, nommant
 *      le verbe fautif, au lieu d'une erreur PostgreSQL brute. Et il interdit
 *      les requêtes que la première barrière laisserait passer parce qu'elles
 *      n'écrivent pas vraiment — un `SET`, un `LOCK` — mais qui changent l'état
 *      de la session.
 *
 * CE QUE CE MODULE NE FAIT PAS : il ne valide jamais. Il termine par ROLLBACK,
 * parce qu'une transaction sans écriture n'a rien à valider, et qu'un COMMIT
 * laisserait croire le contraire.
 */

/* Les premiers mots d'une requête de lecture. Tout le reste est refusé. */
const DEBUTS_AUTORISES = /^\s*(?:\(\s*)*(SELECT|WITH|TABLE|VALUES|EXPLAIN|SHOW)\b/i;
/* Les verbes qui écrivent, nommés pour que le refus soit lisible. */
const VERBES_INTERDITS = /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|LOCK|SET|RESET|VACUUM|REINDEX|CLUSTER|REFRESH|CALL|DO)\b/i;

class EcritureRefusee extends Error {
  constructor(verbe, texte) {
    super(`Écriture refusée en mode lecture seule : « ${verbe} ». `
      + `Requête : ${String(texte).replace(/\s+/g, " ").slice(0, 120)}…`);
    this.code = "LECTURE_SEULE_VIOLATION";
    this.verbe = verbe;
  }
}

/**
 * Un `WITH` peut cacher une écriture : `WITH x AS (INSERT … RETURNING *) SELECT`.
 * On refuse donc le verbe interdit OÙ QU'IL SOIT, pas seulement en tête.
 *
 * Les chaînes littérales et les commentaires sont retirés avant l'examen : une
 * réception dont le libellé contient le mot « UPDATE » ne doit pas faire échouer
 * un diagnostic.
 */
function examiner(texte) {
  const t = String(texte || "");
  const nu = t
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\$\$[\s\S]*?\$\$/g, "''");
  if (!DEBUTS_AUTORISES.test(nu)) {
    const m = nu.match(VERBES_INTERDITS);
    throw new EcritureRefusee(m ? m[1].toUpperCase() : nu.trim().split(/\s+/)[0] || "(vide)", t);
  }
  const m = nu.match(VERBES_INTERDITS);
  if (m) throw new EcritureRefusee(m[1].toUpperCase(), t);
  return nu;
}

/** Enveloppe un client : même interface, mais il ne transmet que des lectures. */
function clientLectureSeule(client, journal = null) {
  return {
    query: async (texte, params) => {
      const sql = typeof texte === "string" ? texte : texte && texte.text;
      examiner(sql);
      if (journal) journal.push(String(sql).replace(/\s+/g, " ").trim().slice(0, 160));
      return client.query(texte, params);
    },
    /* Volontairement absent : `release` appartient à qui a ouvert la connexion. */
  };
}

/**
 * Exécute `travail` dans une transaction que PostgreSQL tient pour lecture
 * seule, et retourne son résultat avec le journal des requêtes envoyées.
 *
 * Le journal n'est pas décoratif : il permet de PROUVER après coup ce qui a été
 * envoyé, au lieu d'avoir à relire le code.
 */
async function dansUneTransactionLectureSeule(pool, travail) {
  const client = await pool.connect();
  const journal = [];
  try {
    /* Posé sur le client brut : `BEGIN` n'est pas une lecture, et c'est lui qui
       installe la barrière. */
    await client.query("BEGIN TRANSACTION READ ONLY");
    const resultat = await travail(clientLectureSeule(client, journal), journal);
    /* ROLLBACK, jamais COMMIT : il n'y a rien à valider, et le dire ainsi évite
       de laisser croire qu'il y avait quelque chose. */
    await client.query("ROLLBACK");
    return { resultat, journal };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * La preuve, exécutée plutôt qu'affirmée : on TENTE une écriture inoffensive
 * dans la transaction en lecture seule et on vérifie que PostgreSQL la refuse.
 * Si elle passait, le mode ne protégerait rien et il vaut mieux le savoir avant
 * de lancer le diagnostic que de le découvrir après.
 */
async function prouverLeVerrou(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    let refuseParPostgres = null;
    try {
      /* Une table temporaire : aucune donnée métier en jeu, et c'est bien une
         écriture au sens de PostgreSQL. */
      await client.query("CREATE TEMP TABLE preuve_lecture_seule (x int)");
      refuseParPostgres = false;
    } catch (e) {
      refuseParPostgres = e.code === "25006";
      if (!refuseParPostgres) throw e;
    }
    await client.query("ROLLBACK");

    let refuseParLeGarde = false;
    try {
      await clientLectureSeule(client).query("UPDATE stock_receptions SET notes = 'x'");
    } catch (e) {
      refuseParLeGarde = e.code === "LECTURE_SEULE_VIOLATION";
    }
    return { refuseParPostgres, refuseParLeGarde,
             solide: refuseParPostgres === true && refuseParLeGarde === true };
  } finally { client.release(); }
}

module.exports = { clientLectureSeule, dansUneTransactionLectureSeule, prouverLeVerrou,
                   examiner, EcritureRefusee };

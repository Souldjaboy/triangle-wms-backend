"use strict";

/**
 * LES PIÈCES JOINTES DU CHAT : QUI A LE DROIT DE LES LIRE.
 *
 * LE DÉFAUT D'ORIGINE, ET POURQUOI IL ÉTAIT DOUBLE.
 *
 * Le serveur renvoyait, après téléversement, une adresse « /uploads/chat/<nom> ».
 * Le navigateur du destinataire la demandait à l'origine du FRONTEND, qui ne
 * réécrit que « /api/:path* » vers le backend : réponse 404. C'était le
 * symptôme visible, celui du clic sur un classeur Excel.
 *
 * Derrière, un second défaut, muet : `app.use("/uploads", express.static(…))`
 * servait ce dossier à QUICONQUE connaissait un nom de fichier. Pas de jeton,
 * pas de société, pas de conversation. Rendre le dossier « encore plus
 * public » pour corriger le 404 aurait donc aggravé le second.
 *
 * CE MODULE RÉPOND À UNE SEULE QUESTION : ce fichier appartient-il à un
 * message d'une conversation à laquelle cette personne participe, dans SA
 * société ? Trois conditions, toutes vérifiées côté serveur, à chaque
 * téléchargement.
 *
 * CE QU'IL NE FAIT PAS. Il ne devine rien à partir du nom de fichier. Un nom
 * qui ne correspond à aucun message est introuvable, même s'il existe sur le
 * disque — c'est ce qui ferme la porte aux fichiers orphelins laissés par un
 * téléversement interrompu.
 */

const fs = require("fs");
const path = require("path");

/* Le dossier des pièces jointes, résolu une fois. Tout chemin calculé devra
   rester dessous : c'est le contrôle anti-traversée. */
const DOSSIER = path.resolve(path.join(__dirname, "..", "uploads", "chat"));

const RESULTATS = Object.freeze({
  SERVI: "SERVI",
  HORS_CONVERSATION: "REFUSE_HORS_CONVERSATION",
  AUTRE_SOCIETE: "REFUSE_AUTRE_SOCIETE",
  INTROUVABLE: "INTROUVABLE",
});

/**
 * Le nom de fichier, nettoyé de tout ce qui pourrait sortir du dossier.
 *
 * `path.basename` seul ne suffit pas : un nom encodé « ..%2Fetc%2Fpasswd »
 * redevient « ../etc/passwd » après décodage, et le basename d'une chaîne
 * contenant un antislash passe sous Windows. On refuse donc tout ce qui n'a
 * pas la forme attendue au lieu de tenter de réparer.
 */
function nomSur(brut) {
  let nom = String(brut || "");
  try { nom = decodeURIComponent(nom); } catch { /* laissé tel quel */ }
  if (!nom || nom.includes("/") || nom.includes("\\") || nom.includes("\0")) return null;
  if (nom === "." || nom === ".." || nom.startsWith(".")) return null;
  /* Les noms produits par le téléversement : <horodatage>-<hexa>-<base>.<ext> */
  if (!/^[\w.\-]{1,200}$/.test(nom)) return null;
  return nom;
}

/**
 * Le message qui porte ce fichier, si la personne y a droit.
 *
 * @returns {{resultat: string, message?: object, chemin?: string}}
 */
async function resoudre(pool, { companyId, userId, nomFichier }) {
  const nom = nomSur(nomFichier);
  if (!nom) return { resultat: RESULTATS.INTROUVABLE };

  /* On cherche le message par le NOM DE FICHIER, quel que soit le préfixe de
     son URL. Deux préfixes coexistent et doivent continuer de coexister :

        /uploads/chat/<nom>      les messages déjà envoyés,
        /chat/attachments/<nom>  ceux envoyés depuis la correction.

     Et chacun peut apparaître sous sa forme encodée, le téléversement
     renvoyant une adresse passée par encodeURIComponent. Chercher un seul
     préfixe laissait les nouveaux messages introuvables — ce que les essais
     ont montré aussitôt. */
  const formes = [
    `/uploads/chat/${nom}`,
    `/uploads/chat/${encodeURIComponent(nom)}`,
    `/chat/attachments/${nom}`,
    `/chat/attachments/${encodeURIComponent(nom)}`,
  ];
  const { rows } = await pool.query(
    `SELECT m.id, m.conversation_id, m.company_id, m.file_name, m.file_mime,
            m.file_size, m.file_url, m.sender_id
       FROM messages m
      WHERE m.file_url = ANY($1::text[])
      ORDER BY m.id DESC
      LIMIT 1`,
    [formes]);
  const message = rows[0];
  if (!message) return { resultat: RESULTATS.INTROUVABLE };

  /* La société d'abord : une pièce jointe ne traverse jamais la frontière
     entre Triangle et FAT & MAT, même pour un super-administrateur qui aurait
     basculé d'entreprise. */
  if (Number(message.company_id) !== Number(companyId)) {
    return { resultat: RESULTATS.AUTRE_SOCIETE, message };
  }

  /* Puis la conversation. Participer est la condition : ni le rôle, ni le
     fait d'être l'expéditeur ne suffisent à eux seuls — un expéditeur retiré
     de la conversation n'y a plus accès. */
  const { rows: part } = await pool.query(
    `SELECT 1
       FROM conversation_participants cp
       JOIN conversations c ON c.id = cp.conversation_id
      WHERE cp.conversation_id = $1 AND cp.user_id = $2 AND c.company_id = $3
      LIMIT 1`,
    [message.conversation_id, userId, companyId]);
  if (!part.length) return { resultat: RESULTATS.HORS_CONVERSATION, message };

  const chemin = path.resolve(path.join(DOSSIER, nom));
  /* La ceinture après les bretelles : même si `nomSur` laissait passer
     quelque chose, le chemin final doit rester sous le dossier. */
  if (!chemin.startsWith(DOSSIER + path.sep)) return { resultat: RESULTATS.INTROUVABLE, message };
  if (!fs.existsSync(chemin)) return { resultat: RESULTATS.INTROUVABLE, message };

  return { resultat: RESULTATS.SERVI, message, chemin, nom };
}

/** Une ligne au journal des accès. Les refus comptent autant que les succès. */
async function journaliser(pool, { companyId, message, nomFichier, resultat, utilisateur, ip }) {
  try {
    await pool.query(
      `INSERT INTO chat_attachment_access
         (company_id, message_id, conversation_id, file_name, outcome, user_id, user_name, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [companyId || 0, message?.id || null, message?.conversation_id || null,
        String(nomFichier || "").slice(0, 300), resultat,
        utilisateur?.id || null, String(utilisateur?.name || "").slice(0, 120),
        String(ip || "").slice(0, 60)]);
  } catch (e) {
    /* Le journal ne doit jamais empêcher un téléchargement légitime. */
    console.error("journal des pièces jointes :", e.message);
  }
}

/**
 * Les en-têtes d'un téléchargement sûr.
 *
 * `Content-Disposition` porte le nom d'ORIGINE, celui que l'utilisateur
 * reconnaîtra, et non le nom de stockage. On l'écrit deux fois : une version
 * repliée sur l'ASCII pour les navigateurs anciens, et la forme `filename*`
 * en UTF-8 pour les autres — sans quoi « Bilan septembre.xlsx » arrive
 * tronqué ou mal accentué.
 *
 * `X-Content-Type-Options: nosniff` empêche le navigateur de deviner un type
 * plus dangereux que celui annoncé : un fichier déclaré tableur ne doit pas
 * être interprété comme du HTML.
 */
function entetes(res, { nomOrigine, mime, taille, enLigne }) {
  const sur = String(nomOrigine || "fichier").replace(/[\r\n"]/g, "").slice(0, 200);
  const ascii = sur.normalize("NFKD").replace(/[^\x20-\x7E]/g, "_") || "fichier";
  res.setHeader("Content-Type", mime || "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition",
    `${enLigne ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(sur)}`);
  if (taille) res.setHeader("Content-Length", String(taille));
  /* Une pièce jointe est privée : aucun cache partagé ne doit la garder. */
  res.setHeader("Cache-Control", "private, no-store");
}

/* Les types que l'on accepte d'afficher DANS le navigateur. Tout le reste se
   télécharge : afficher un HTML ou un SVG venu d'un tiers reviendrait à
   exécuter son script sur notre domaine. */
const AFFICHABLES = new Set([
  "application/pdf",
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
  "video/mp4", "video/webm", "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm",
  "text/plain",
]);

module.exports = { DOSSIER, RESULTATS, nomSur, resoudre, journaliser, entetes, AFFICHABLES };

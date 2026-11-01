"use strict";
/**
 * LES DIMENSIONS D'UNE IMAGE, LUES DANS SES PREMIERS OCTETS.
 *
 * Pourquoi ne pas installer une bibliothèque : il faut ici répondre à UNE
 * question — cette page est-elle debout ou couchée — pour choisir
 * l'orientation du PDF. Les en-têtes PNG, JPEG et WebP portent la réponse
 * dans leurs premiers octets. Ajouter une dépendance pour cela, c'est une
 * chose de plus à installer sur le serveur, à mettre à jour, et à expliquer
 * le jour où elle casse.
 *
 * CE MODULE NE DEVINE PAS. S'il ne sait pas lire le format, il rend null, et
 * l'appelant choisit alors un format par défaut en le disant. Rendre des
 * dimensions inventées ferait coucher des pages debout.
 */

/* PNG : la taille est dans le bloc IHDR, toujours le premier, à l'octet 16. */
function png(b) {
  if (b.length < 24) return null;
  if (b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (b.toString("latin1", 12, 16) !== "IHDR") return null;
  return { largeur: b.readUInt32BE(16), hauteur: b.readUInt32BE(20), format: "png" };
}

/* JPEG : il faut parcourir les marqueurs jusqu'au « start of frame », dont il
   existe plusieurs variantes selon le mode de compression. */
function jpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }       /* octets de bourrage */
    const marqueur = b[i + 1];
    if (marqueur === 0xff) { i += 1; continue; }
    /* SOF0 à SOF15, sauf 0xC4 (table de Huffman), 0xC8 et 0xCC qui n'en
       sont pas : les confondre donnerait des dimensions absurdes. */
    const estSOF = marqueur >= 0xc0 && marqueur <= 0xcf &&
      marqueur !== 0xc4 && marqueur !== 0xc8 && marqueur !== 0xcc;
    if (estSOF) {
      return {
        hauteur: b.readUInt16BE(i + 5),
        largeur: b.readUInt16BE(i + 7),
        format: "jpeg",
      };
    }
    /* Les marqueurs sans charge utile n'ont pas de longueur à sauter. */
    if (marqueur === 0xd8 || marqueur === 0xd9 ||
        (marqueur >= 0xd0 && marqueur <= 0xd7) || marqueur === 0x01) { i += 2; continue; }
    const longueur = b.readUInt16BE(i + 2);
    if (longueur < 2) return null;                  /* en-tête incohérent */
    i += 2 + longueur;
  }
  return null;
}

/* WebP : trois variantes, chacune avec son bloc. */
function webp(b) {
  if (b.length < 30) return null;
  if (b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null;
  const bloc = b.toString("latin1", 12, 16);
  if (bloc === "VP8X") {
    return {
      largeur: 1 + (b.readUIntLE(24, 3) & 0xffffff),
      hauteur: 1 + (b.readUIntLE(27, 3) & 0xffffff),
      format: "webp",
    };
  }
  if (bloc === "VP8 ") {
    return {
      largeur: b.readUInt16LE(26) & 0x3fff,
      hauteur: b.readUInt16LE(28) & 0x3fff,
      format: "webp",
    };
  }
  if (bloc === "VP8L") {
    const n = b.readUInt32LE(21);
    return { largeur: 1 + (n & 0x3fff), hauteur: 1 + ((n >> 14) & 0x3fff), format: "webp" };
  }
  return null;
}

/** Rend { largeur, hauteur, format } ou null si le format est inconnu. */
function dimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  for (const lire of [png, jpeg, webp]) {
    try {
      const d = lire(buffer);
      /* Zéro n'est pas une dimension : on préfère ne rien dire. */
      if (d && d.largeur > 0 && d.hauteur > 0) return d;
    } catch { /* en-tête tronqué : on essaie le format suivant */ }
  }
  return null;
}

module.exports = { dimensions };

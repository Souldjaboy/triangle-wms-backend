"use strict";
/**
 * FABRIQUER UN PNG DONT ON CONNAÎT CHAQUE PIXEL.
 *
 * POURQUOI NE PAS ÉCRIRE UN BASE64 À LA MAIN. Un essai l'a fait : une
 * vingtaine de caractères recopiés pour « un PNG de 2×2, rouge en haut à
 * gauche ». Le fichier avait bien la signature PNG et les bonnes dimensions
 * dans son en-tête, mais son flux compressé échouait à sa somme de contrôle.
 * LibreOffice l'a donc transporté dans l'archive sans jamais le dessiner —
 * et l'essai, qui cherchait du rouge, trouvait du blanc. Ce n'est pas
 * l'export qui était faux : c'était l'image d'essai.
 *
 * Un fichier d'essai fabriqué par du code qu'on relit vaut mieux qu'un
 * fichier d'essai recopié : on sait ce qu'il contient, et il ne peut pas
 * être à demi valide.
 */
const zlib = require("zlib");

let TABLE = null;
function crc32(octets) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c;
    }
  }
  let c = 0xFFFFFFFF;
  for (const x of octets) c = TABLE[(c ^ x) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function bloc(type, donnees) {
  const taille = Buffer.alloc(4); taille.writeUInt32BE(donnees.length);
  const t = Buffer.from(type, "latin1");
  const somme = Buffer.alloc(4); somme.writeUInt32BE(crc32(Buffer.concat([t, donnees])));
  return Buffer.concat([taille, t, donnees, somme]);
}

/**
 * @param largeur  en pixels
 * @param hauteur  en pixels
 * @param peintre  (x, y) → [rouge, vert, bleu], chacun de 0 à 255
 */
function png(largeur, hauteur, peintre) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largeur, 0);
  ihdr.writeUInt32BE(hauteur, 4);
  ihdr[8] = 8;   /* huit bits par composante */
  ihdr[9] = 2;   /* couleur vraie, sans transparence */

  const lignes = [];
  for (let y = 0; y < hauteur; y += 1) {
    /* Le premier octet de chaque ligne est le type de filtre : zéro, aucun. */
    const l = Buffer.alloc(1 + largeur * 3);
    for (let x = 0; x < largeur; x += 1) {
      const [r, v, b] = peintre(x, y);
      l[1 + x * 3] = r; l[2 + x * 3] = v; l[3 + x * 3] = b;
    }
    lignes.push(l);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    bloc("IHDR", ihdr),
    bloc("IDAT", zlib.deflateSync(Buffer.concat(lignes))),
    bloc("IEND", Buffer.alloc(0)),
  ]);
}

/** Un repère : rouge en haut à gauche, blanc partout ailleurs. */
function repereRouge(cote = 40) {
  return png(cote, cote, (x, y) =>
    (x < cote / 2 && y < cote / 2) ? [220, 20, 20] : [255, 255, 255]);
}

module.exports = { png, repereRouge, crc32 };

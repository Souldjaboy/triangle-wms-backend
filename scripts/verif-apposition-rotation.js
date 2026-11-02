"use strict";
/**
 * LA SIGNATURE EST-ELLE DROITE, ET AU BON ENDROIT, SUR UNE PAGE TOURNÉE ?
 *
 * Un PDF porte un attribut « /Rotate » : les scanners en produisent sans
 * arrêt. Le contenu n'est pas tourné, seul l'affichage l'est. Poser une
 * image sans en tenir compte donne une signature couchée dans un coin — et
 * personne ne s'en aperçoit avant d'imprimer.
 *
 * Lire la matrice de transformation dans le PDF ne prouve rien d'utile : on
 * vérifierait un calcul contre lui-même. On REND donc chaque page comme un
 * lecteur le ferait, et on regarde les pixels.
 *
 * L'image d'essai n'est pas symétrique — moitié rouge à gauche, moitié bleue
 * à droite, et deux fois plus large que haute. Une signature retournée,
 * couchée ou en miroir se verrait immédiatement : le rouge et le bleu ne
 * seraient pas du bon côté.
 */
const path = require("path");
const zlib = require("zlib");
const { PDFDocument, degrees } = require("pdf-lib");
const { apposer } = require("../services/pdf-apposition");
const { lancer } = require(
  path.join(__dirname, "..", "..", "triangle-wms-frontend", "scripts", "navigateur"));

const FRONT = path.join(__dirname, "..", "..", "triangle-wms-frontend");

let ok = 0, ko = 0;
const v = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ✔ ${n}`); }
  else { ko++; console.log(`  ✘ ${n}${d ? `\n      → ${d}` : ""}`); }
};
const titre = (t) => console.log(`\n── ${t}`);

/* ──────────────── UNE IMAGE QU'ON NE PEUT PAS CONFONDRE ──────────────── */
let TABLE = null;
function crc32(b) {
  if (!TABLE) {
    TABLE = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (const x of b) c = TABLE[(c ^ x) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function png(largeur, hauteur) {
  const bloc = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, "latin1");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(largeur, 0); ihdr.writeUInt32BE(hauteur, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const lignes = [];
  for (let y = 0; y < hauteur; y++) {
    const l = Buffer.alloc(1 + largeur * 3);
    for (let x = 0; x < largeur; x++) {
      /* Gauche rouge, droite bleue. Le haut est plus clair que le bas, pour
         repérer aussi un retournement vertical. */
      const clair = y < hauteur / 2 ? 255 : 120;
      if (x < largeur / 2) { l[1 + x * 3] = clair; }
      else { l[3 + x * 3] = clair; }
    }
    lignes.push(l);
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    bloc("IHDR", ihdr),
    bloc("IDAT", zlib.deflateSync(Buffer.concat(lignes))),
    bloc("IEND", Buffer.alloc(0)),
  ]);
}

/* La page : 400 × 600 points. Le rectangle visé, en espace PDF. */
const PAGE = { largeur: 400, hauteur: 600 };
const RECT = { x: 100, y: 450, largeur: 160, hauteur: 80 };

(async () => {
  const nav = await lancer();
  const page = await nav.newPage();
  page.on("pageerror", (e) => console.log("  pageerror:", e.message.slice(0, 160)));

  /* On sert pdf.js depuis le disque : pas de réseau, pas de CDN. */
  await page.route("**/*", (route) => {
    const u = route.request().url();
    const fs = require("fs");
    const servir = (rel, type) => route.fulfill({
      body: fs.readFileSync(path.join(FRONT, "node_modules/pdfjs-dist", rel)),
      contentType: type,
    });
    if (u.endsWith("/pdf.mjs")) return servir("build/pdf.mjs", "text/javascript");
    if (u.endsWith("/pdf.worker.mjs")) return servir("build/pdf.worker.mjs", "text/javascript");
    return route.fulfill({
      body: "<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>",
      contentType: "text/html",
    });
  });
  await page.goto("http://essai.local/");

  const image = png(40, 20);

  for (const rotation of [0, 90, 180, 270]) {
    titre(`Page tournée de ${rotation}°`);

    const vierge = await PDFDocument.create();
    const p = vierge.addPage([PAGE.largeur, PAGE.hauteur]);
    p.setRotation(degrees(rotation));
    const base = Buffer.from(await vierge.save());

    const res = await apposer({
      pdf: base, image, mime: "image/png", page: 1, rect: RECT });
    v("l'apposition produit un PDF", res.buffer.subarray(0, 5).toString("latin1") === "%PDF-");
    v("la rotation de la page est bien relevée", res.rotation === rotation, `${res.rotation}`);

    /* ─── On rend la page comme un lecteur, et on regarde ─── */
    const vu = await page.evaluate(async ([octets, rect, taillePage]) => {
      const { getDocument, GlobalWorkerOptions } = await import("/pdf.mjs");
      GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";
      const doc = await getDocument({ data: new Uint8Array(octets) }).promise;
      const pg = await doc.getPage(1);
      /* `rotation: 0` dans la vue signifie « comme le lecteur l'affiche » :
         la rotation de la page est déjà prise en compte par pdf.js. */
      const vue = pg.getViewport({ scale: 2 });
      const c = document.createElement("canvas");
      c.width = Math.ceil(vue.width); c.height = Math.ceil(vue.height);
      const g = c.getContext("2d");
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: g, viewport: vue, canvas: c }).promise;

      /* Où le rectangle demandé se trouve-t-il À L'ÉCRAN ? pdf.js sait
         convertir : c'est exactement la conversion que fera l'interface. */
      const coins = [
        vue.convertToViewportPoint(rect.x, rect.y),
        vue.convertToViewportPoint(rect.x + rect.largeur, rect.y + rect.hauteur),
      ];
      const gx = Math.min(coins[0][0], coins[1][0]);
      const dx = Math.max(coins[0][0], coins[1][0]);
      const hy = Math.min(coins[0][1], coins[1][1]);
      const by = Math.max(coins[0][1], coins[1][1]);

      const lire = (px, py) => {
        const d = g.getImageData(Math.round(px), Math.round(py), 1, 1).data;
        return [d[0], d[1], d[2]];
      };
      /* Quatre points bien à l'intérieur du rectangle : gauche-haut,
         droite-haut, gauche-bas, droite-bas, tels qu'on les VOIT. */
      const lx = gx + (dx - gx) * 0.25, rx = gx + (dx - gx) * 0.75;
      const ty = hy + (by - hy) * 0.25, byy = hy + (by - hy) * 0.75;
      /* Un point nettement en dehors, pour vérifier qu'on n'a pas peint
         toute la page. */
      const dehors = [c.width * 0.5, c.height * 0.92];

      return {
        vue: { l: Math.round(vue.width), h: Math.round(vue.height), rotation: vue.rotation },
        boite: { gx: Math.round(gx), dx: Math.round(dx), hy: Math.round(hy), by: Math.round(by) },
        hautGauche: lire(lx, ty), hautDroite: lire(rx, ty),
        basGauche: lire(lx, byy), basDroite: lire(rx, byy),
        dehors: lire(dehors[0], dehors[1]),
      };
    }, [Array.from(res.buffer), RECT, PAGE]);

    /* ROUGE OU BLEU SE JUGE PAR L'ÉCART, PAS PAR UN SEUIL ABSOLU. La moitié
       basse de l'image est volontairement plus sombre — c'est ce qui permet
       de repérer un retournement vertical — et un seuil fixe la déclarait
       « ni rouge ni bleue » alors qu'elle est bien rouge, en plus sombre.
       Le premier jet accusait ainsi le code d'un défaut qui n'était que dans
       la sonde. */
    const rouge = (c) => c[0] > c[2] + 60 && c[0] > 80;
    const bleu = (c) => c[2] > c[0] + 60 && c[2] > 80;
    const clair = (c) => Math.max(...c) > 200;

    /* LA VUE EST TOURNÉE : 90° et 270° échangent largeur et hauteur. */
    const attenduL = rotation % 180 === 0 ? PAGE.largeur * 2 : PAGE.hauteur * 2;
    v("le lecteur affiche la page dans le bon sens",
      Math.abs(vu.vue.l - attenduL) <= 2, `${vu.vue.l}×${vu.vue.h} pour ${attenduL} attendu`);

    /* LE CÔTÉ ROUGE EST À GAUCHE, LE BLEU À DROITE — tels qu'on les voit.
       Si la correction de rotation était omise, ils seraient en haut et en
       bas, ou inversés. */
    v("le rouge est à gauche, en haut", rouge(vu.hautGauche),
      `rvb ${vu.hautGauche.join(",")}`);
    v("le bleu est à droite, en haut", bleu(vu.hautDroite),
      `rvb ${vu.hautDroite.join(",")}`);
    v("le rouge est à gauche, en bas", rouge(vu.basGauche),
      `rvb ${vu.basGauche.join(",")}`);
    v("le bleu est à droite, en bas", bleu(vu.basDroite),
      `rvb ${vu.basDroite.join(",")}`);

    /* LE HAUT EST PLUS CLAIR QUE LE BAS : attrape un retournement vertical,
       que la seule répartition gauche/droite ne verrait pas. */
    v("le haut de l'image est bien en haut",
      clair(vu.hautGauche) && !clair(vu.basGauche),
      `haut ${vu.hautGauche.join(",")} / bas ${vu.basGauche.join(",")}`);

    v("le reste de la page est resté blanc",
      vu.dehors.every((x) => x > 240), `rvb ${vu.dehors.join(",")}`);
  }

  /* ──────────────────── CE QUI DOIT ÊTRE REFUSÉ ───────────────────── */
  titre("Ce qui doit être refusé");
  const vierge = await PDFDocument.create();
  vierge.addPage([PAGE.largeur, PAGE.hauteur]);
  const base = Buffer.from(await vierge.save());

  const refus = async (nom, args, code) => {
    try {
      await apposer({ pdf: base, image, mime: "image/png", page: 1, ...args });
      v(nom, false, "accepté alors qu'il fallait refuser");
    } catch (e) {
      v(nom, e.code === code, `code ${e.code} au lieu de ${code} — ${e.message}`);
    }
  };
  await refus("une signature qui déborde la page",
    { rect: { x: 350, y: 100, largeur: 120, hauteur: 60 } }, "HORS_PAGE");
  await refus("une signature de largeur nulle",
    { rect: { x: 10, y: 10, largeur: 0, hauteur: 60 } }, "TAILLE_INVALIDE");
  await refus("une position incomplète",
    { rect: { x: 10, y: 10, largeur: 100 } }, "POSITION_INVALIDE");
  await refus("une page qui n'existe pas",
    { page: 7, rect: { x: 10, y: 10, largeur: 100, hauteur: 50 } }, "PAGE_INEXISTANTE");
  try {
    await apposer({ pdf: Buffer.from("<html>pas un pdf</html>"), image,
      mime: "image/png", page: 1, rect: { x: 10, y: 10, largeur: 50, hauteur: 25 } });
    v("un fichier qui n'est pas un PDF", false, "accepté");
  } catch (e) { v("un fichier qui n'est pas un PDF", e.code === "PAS_UN_PDF", e.code); }

  await nav.close();
  console.log(`\n  ${ok} réussis, ${ko} échoués\n`);
  process.exit(ko ? 1 : 0);
})().catch((e) => {
  console.error("\n  ✘ interrompu :", e.message, "\n", e.stack);
  process.exit(2);
});

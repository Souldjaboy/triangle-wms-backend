"use strict";
/**
 * LES ANNOTATIONS SONT-ELLES AU BON ENDROIT, ET DANS LE BON SENS,
 * SUR UNE PAGE TOURNÉE ?
 *
 * Lire la matrice de transformation du PDF ne prouverait rien : on
 * vérifierait un calcul contre lui-même. On REND donc chaque page comme un
 * lecteur le ferait, et on regarde les pixels.
 *
 * ET ON Y ARRIVE PAR UN AUTRE CHEMIN QUE LE SERVICE. Le service va du repère
 * de l'affichage au contenu du PDF, puis laisse le lecteur ramener le contenu
 * à l'écran. L'essai, lui, va directement du repère de l'affichage aux pixels
 * de la toile : largeur fois l'échelle, et l'ordonnée retournée. Deux chemins
 * indépendants qui doivent tomber au même endroit.
 *
 * CE QUI EST VRAIMENT ÉPROUVÉ ICI.
 *
 * 1. UN TABLEAU TRANSPOSÉ. C'est le défaut que seule une page tournée révèle :
 *    en ne transformant que le cadre extérieur, les lignes du tableau
 *    deviennent des colonnes. Le cadre est juste, et le tableau illisible.
 *    L'en-tête du tableau d'essai est sur fond gris : une BANDE HORIZONTALE
 *    en haut si tout va bien, une bande VERTICALE à gauche si c'est transposé.
 *
 * 2. DU TEXTE COUCHÉ. Une ligne de texte large et courte devient étroite et
 *    haute si l'angle est faux d'un quart de tour. On mesure donc la boîte
 *    d'encre, et on exige qu'elle soit plus large que haute.
 *
 * 3. DU TEXTE À L'ENVERS. Faux de 180°, le texte part du mauvais côté et
 *    monte au lieu de descendre. On exige que l'encre commence près du bord
 *    gauche du cadre et occupe sa moitié haute.
 */
const path = require("path");
const fs = require("fs");
const { PDFDocument, degrees } = require("pdf-lib");
const { annoter, decrire } = require("../services/pdf-annotations");
const { lancer } = require(
  path.join(__dirname, "..", "..", "triangle-wms-frontend", "scripts", "navigateur"));

const FRONT = path.join(__dirname, "..", "..", "triangle-wms-frontend");
const PAGE = { largeur: 600, hauteur: 800 };
const ECHELLE = 2;

let ok = 0, ko = 0;
const v = (n, c, d = "") => {
  if (c) { ok++; console.log(`  ✔ ${n}`); }
  else { ko++; console.log(`  ✘ ${n}${d ? `\n      → ${d}` : ""}`); }
};
const titre = (t) => console.log(`\n── ${t}`);

/* Les quatre annotations, en coordonnées d'AFFICHAGE. Elles sont placées
   dans la moitié gauche et le haut de la page, pour qu'un décalage les
   envoie visiblement ailleurs. */
function plan(vue) {
  const L = vue.largeur, H = vue.hauteur;
  return {
    surlignage: { nature: "SURLIGNAGE", page: 1, x: 0.05 * L, y: 0.80 * H,
      largeur: 0.30 * L, hauteur: 0.08 * H, couleur: "#00c000", opacite: 1 },
    cadre: { nature: "CADRE", page: 1, x: 0.55 * L, y: 0.80 * H,
      largeur: 0.30 * L, hauteur: 0.08 * H, couleur: "#0000c0", epaisseur: 4 },
    texte: { nature: "TEXTE", page: 1, x: 0.05 * L, y: 0.60 * H,
      largeur: 0.70 * L, hauteur: 0.10 * H, taille: 20, couleur: "#000000",
      texte: "Bon de livraison verifie" },
    tableau: { nature: "TABLEAU", page: 1, x: 0.05 * L, y: 0.20 * H,
      largeur: 0.80 * L, hauteur: 0.30 * H, taille: 10, entete: true,
      couleurEntete: "#c00000", couleurFilet: "#000000",
      lignes: [
        ["Produit", "Quantite", "Unite"],
        ["Ciment", "320", "sacs"],
        ["Sable", "18", "tonnes"],
      ] },
  };
}

(async () => {
  const nav = await lancer();
  const onglet = await nav.newPage();
  onglet.on("pageerror", (e) => console.log("  pageerror:", e.message.slice(0, 160)));

  /* pdf.js est servi depuis le disque : pas de réseau, pas de CDN. */
  await onglet.route("**/*", (route) => {
    const u = route.request().url();
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
  await onglet.goto("http://essai.local/");

  for (const rotation of [0, 90, 180, 270]) {
    titre(`Page tournée de ${rotation}°`);

    const vierge = await PDFDocument.create();
    const p = vierge.addPage([PAGE.largeur, PAGE.hauteur]);
    p.setRotation(degrees(rotation));
    const base = Buffer.from(await vierge.save());

    const vues = await decrire(base);
    const attendue = (rotation === 90 || rotation === 270)
      ? { largeur: PAGE.hauteur, hauteur: PAGE.largeur }
      : { largeur: PAGE.largeur, hauteur: PAGE.hauteur };
    v("la page est décrite telle qu'on la voit",
      vues[0].largeur === attendue.largeur && vues[0].hauteur === attendue.hauteur,
      `${vues[0].largeur}×${vues[0].hauteur} au lieu de ${attendue.largeur}×${attendue.hauteur}`);

    const P = plan(attendue);
    const res = await annoter({ pdf: base, annotations: Object.values(P) });
    v("l'annotation produit un PDF", res.buffer.subarray(0, 5).toString("latin1") === "%PDF-");
    v("les quatre annotations sont posées", res.posees.length === 4, `${res.posees.length}`);

    const vu = await onglet.evaluate(async ([octets, plan, vue, echelle]) => {
      const { getDocument, GlobalWorkerOptions } = await import("/pdf.mjs");
      GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";
      const doc = await getDocument({ data: new Uint8Array(octets) }).promise;
      const pg = await doc.getPage(1);
      const v2 = pg.getViewport({ scale: echelle });
      const c = document.createElement("canvas");
      c.width = Math.ceil(v2.width); c.height = Math.ceil(v2.height);
      const g = c.getContext("2d");
      g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: g, viewport: v2, canvas: c }).promise;

      /* LE CHEMIN INDÉPENDANT : du repère de l'affichage aux pixels. La toile
         a l'origine en haut à gauche, le repère de l'affichage en bas à
         gauche : seule l'ordonnée se retourne. */
      const px = (xa) => xa * echelle;
      const py = (ya) => (vue.hauteur - ya) * echelle;
      const boite = (a) => ({
        gauche: px(a.x), droite: px(a.x + a.largeur),
        haut: py(a.y + a.hauteur), bas: py(a.y),
      });

      const data = g.getImageData(0, 0, c.width, c.height).data;
      const lire = (x, y) => {
        const i = (Math.round(Math.min(c.height - 1, Math.max(0, y))) * c.width
                 + Math.round(Math.min(c.width - 1, Math.max(0, x)))) * 4;
        return [data[i], data[i + 1], data[i + 2]];
      };
      const encre = (x, y) => { const [r, v3, b] = lire(x, y); return r + v3 + b < 600; };

      /* La boîte d'encre réellement occupée dans un cadre. */
      const encadrement = (a) => {
        const b = boite(a);
        let gx = Infinity, dx = -Infinity, hy = Infinity, by = -Infinity, n = 0;
        for (let y = Math.round(b.haut); y <= Math.round(b.bas); y += 1) {
          for (let x = Math.round(b.gauche); x <= Math.round(b.droite); x += 1) {
            if (!encre(x, y)) continue;
            n += 1;
            if (x < gx) gx = x; if (x > dx) dx = x;
            if (y < hy) hy = y; if (y > by) by = y;
          }
        }
        return n ? { gx, dx, hy, by, n, boite: b } : { n: 0, boite: b };
      };

      const centre = (a) => {
        const b = boite(a);
        return lire((b.gauche + b.droite) / 2, (b.haut + b.bas) / 2);
      };

      /* ─ LE TABLEAU ─ On balaie une croix au travers de son cadre et on
         note où se trouve le rouge de l'en-tête. */
      const bt = boite(plan.tableau);
      const rouge = (x, y) => { const [r, v3, b] = lire(x, y); return r > 140 && v3 < 110 && b < 110; };
      const colonneMilieu = [];
      for (let y = Math.round(bt.haut); y <= Math.round(bt.bas); y += 1) {
        colonneMilieu.push(rouge((bt.gauche + bt.droite) / 2, y) ? 1 : 0);
      }
      const ligneMilieu = [];
      for (let x = Math.round(bt.gauche); x <= Math.round(bt.droite); x += 1) {
        ligneMilieu.push(rouge(x, (bt.haut + bt.bas) / 2) ? 1 : 0);
      }
      /* En haut du tableau, l'en-tête doit S'ÉTENDRE sur toute la largeur.

         LE PREMIER JET AFFIRMAIT UNE FAUSSETÉ : il échantillonnait une seule
         ligne de pixels et exigeait qu'elle soit rouge sur 100 % de sa
         longueur. Or l'en-tête porte du TEXTE NOIR — « Produit »,
         « Quantite », « Unite ». Selon la hauteur du cadre, la ligne tirée
         au hasard tombait dans la bande des lettres ou juste au-dessus :
         l'essai réussissait à 90° et échouait à 0°, pour une raison qui
         n'avait rien à voir avec la rotation.

         Ce qui se vérifie vraiment, c'est l'ÉTENDUE de la bande. On balaie
         donc toute la hauteur de la ligne d'en-tête, et une colonne compte
         comme couverte dès qu'un seul de ses pixels y est rouge : une lettre
         noire n'évide plus la mesure. Un tableau transposé, lui, n'aurait
         aucun rouge au milieu — ce que la vérification verticale attrape. */
      const hauteurEntete = (plan.tableau.taille * 1.25 + 6) * echelle;
      const hautDuTableau = [];
      for (let x = Math.round(bt.gauche) + 2; x <= Math.round(bt.droite) - 2; x += 1) {
        let couvert = 0;
        for (let y = Math.round(bt.haut) + 2; y <= Math.round(bt.haut + hauteurEntete) - 2; y += 1) {
          if (rouge(x, y)) { couvert = 1; break; }
        }
        hautDuTableau.push(couvert);
      }

      return {
        toile: { l: c.width, h: c.height, rotationVue: v2.rotation },
        surlignage: centre(plan.surlignage),
        /* Le cadre : son bord gauche doit être bleu, son centre blanc. */
        cadreBord: lire(boite(plan.cadre).gauche + 3, (boite(plan.cadre).haut + boite(plan.cadre).bas) / 2),
        cadreCentre: centre(plan.cadre),
        texte: encadrement(plan.texte),
        tableau: {
          boite: bt,
          rougeColonne: colonneMilieu.reduce((s, x) => s + x, 0),
          rougeLigne: ligneMilieu.reduce((s, x) => s + x, 0),
          /* Où commence et où finit le rouge le long de la verticale. */
          premierRouge: colonneMilieu.indexOf(1),
          hauteurTableau: colonneMilieu.length,
          largeurTableau: ligneMilieu.length,
          hautCouvert: hautDuTableau.reduce((s, x) => s + x, 0) / hautDuTableau.length,
        },
        /* Un coin loin de tout : rien n'a dû être peint là. */
        coinVide: lire(c.width * 0.95, c.height * 0.97),
      };
    }, [Array.from(res.buffer), P, attendue, ECHELLE]);

    /* ─────────── Ce que la page doit montrer ─────────── */
    v("la toile fait la taille de la page vue",
      Math.abs(vu.toile.l - attendue.largeur * ECHELLE) <= 2
      && Math.abs(vu.toile.h - attendue.hauteur * ECHELLE) <= 2,
      `${vu.toile.l}×${vu.toile.h}`);

    const [sr, sv, sb] = vu.surlignage;
    v("le surlignage est vert, à sa place",
      sv > 140 && sr < 110 && sb < 110, `rvb ${sr},${sv},${sb}`);

    const [cr, cv, cb] = vu.cadreBord;
    v("le bord gauche du cadre est bleu", cb > 130 && cr < 110 && cv < 110, `rvb ${cr},${cv},${cb}`);
    const [kr, kv, kb] = vu.cadreCentre;
    v("le centre du cadre est resté blanc", kr > 240 && kv > 240 && kb > 240, `rvb ${kr},${kv},${kb}`);

    /* ─ Le texte : présent, couché dans le bon sens, du bon côté ─ */
    const t = vu.texte;
    v("le texte a laissé de l'encre dans son cadre", t.n > 200, `${t.n} pixels`);
    if (t.n) {
      const largeurEncre = t.dx - t.gx, hauteurEncre = t.by - t.hy;
      v("le texte est plus large que haut : il n'est pas couché",
        largeurEncre > hauteurEncre * 2,
        `encre ${largeurEncre}×${hauteurEncre} px`);
      const b = t.boite;
      v("le texte commence près du bord gauche du cadre",
        t.gx - b.gauche < (b.droite - b.gauche) * 0.1,
        `${Math.round(t.gx - b.gauche)} px du bord, cadre large de ${Math.round(b.droite - b.gauche)}`);
      v("le texte occupe la moitié haute du cadre : il n'est pas retourné",
        t.by < b.haut + (b.bas - b.haut) * 0.75,
        `encre jusqu'à ${Math.round(t.by - b.haut)} px sous le haut, cadre haut de ${Math.round(b.bas - b.haut)}`);
    }

    /* ─ Le tableau : l'en-tête est une bande HORIZONTALE, en haut ─ */
    const T = vu.tableau;
    v("l'en-tête du tableau s'étend sur toute sa largeur",
      T.hautCouvert > 0.98, `${Math.round(T.hautCouvert * 100)} % de la largeur couverte`);
    v("l'en-tête commence tout en haut du tableau",
      T.premierRouge >= 0 && T.premierRouge < T.hauteurTableau * 0.05,
      `première ligne rouge à ${T.premierRouge} sur ${T.hauteurTableau}`);
    v("l'en-tête ne descend pas plus bas qu'une ligne : le tableau n'est pas transposé",
      T.rougeColonne > 0 && T.rougeColonne < T.hauteurTableau * 0.2,
      `${T.rougeColonne} px de rouge sur ${T.hauteurTableau} px de haut`);

    const [vr, vv, vb] = vu.coinVide;
    v("rien n'a été peint dans le coin resté libre",
      vr > 240 && vv > 240 && vb > 240, `rvb ${vr},${vv},${vb}`);
  }

  await nav.close();

  /* ═════════ CE QUI DOIT ÊTRE REFUSÉ, SANS NAVIGATEUR ═════════ */
  titre("Ce qui doit être refusé");
  const vierge = await PDFDocument.create();
  vierge.addPage([PAGE.largeur, PAGE.hauteur]);
  const base = Buffer.from(await vierge.save());
  const refus = async (nom, annotation, code) => {
    try {
      await annoter({ pdf: base, annotations: [annotation] });
      v(nom, false, "accepté alors qu'il fallait refuser");
    } catch (e) { v(nom, e.code === code, `code ${e.code} au lieu de ${code}`); }
  };

  await refus("un texte qui ne tient pas dans son cadre",
    { nature: "TEXTE", page: 1, x: 10, y: 10, largeur: 100, hauteur: 12, taille: 11,
      texte: "Un texte beaucoup trop long pour tenir sur une seule ligne de cent points." },
    "TEXTE_DEBORDE");
  await refus("un tableau qui ne tient pas dans son cadre",
    { nature: "TABLEAU", page: 1, x: 10, y: 10, largeur: 300, hauteur: 20,
      lignes: [["a", "b"], ["c", "d"], ["e", "f"], ["g", "h"]] },
    "TABLEAU_DEBORDE");
  await refus("une annotation qui sort de la page",
    { nature: "CADRE", page: 1, x: 500, y: 10, largeur: 300, hauteur: 50 }, "HORS_PAGE");
  await refus("une page qui n'existe pas",
    { nature: "CADRE", page: 7, x: 10, y: 10, largeur: 50, hauteur: 50 }, "PAGE_INEXISTANTE");
  await refus("une nature inventée",
    { nature: "TAMPON", page: 1, x: 10, y: 10, largeur: 50, hauteur: 50 }, "NATURE_INCONNUE");
  await refus("une police qui n'existe pas",
    { nature: "TEXTE", page: 1, x: 10, y: 10, largeur: 200, hauteur: 40, texte: "Bonjour",
      police: "comic" }, "POLICE_INCONNUE");
  await refus("une couleur qui n'en est pas",
    { nature: "CADRE", page: 1, x: 10, y: 10, largeur: 50, hauteur: 50, couleur: "rouge vif" },
    "COULEUR_INVALIDE");
  await refus("un caractère qu'aucune police standard n'écrit",
    { nature: "TEXTE", page: 1, x: 10, y: 10, largeur: 300, hauteur: 60, taille: 12,
      texte: "Livraison пример" }, "CARACTERE_INECRIVABLE");
  await refus("un texte vide",
    { nature: "TEXTE", page: 1, x: 10, y: 10, largeur: 200, hauteur: 40, texte: "   " },
    "TEXTE_VIDE");
  await refus("un tableau sans lignes",
    { nature: "TABLEAU", page: 1, x: 10, y: 10, largeur: 200, hauteur: 80, lignes: [] },
    "TABLEAU_VIDE");

  /* LES ACCENTS FRANÇAIS, EUX, DOIVENT PASSER : c'est la moitié du texte
     d'un bon de livraison malien. */
  try {
    const r = await annoter({ pdf: base, annotations: [{
      nature: "TEXTE", page: 1, x: 20, y: 20, largeur: 500, hauteur: 60, taille: 12,
      texte: "Reçu à Sébénikoro — cœur de l'entrepôt, coût 1 500 € déjà réglé" }] });
    v("les accents, le tiret cadratin, l'œ et l'euro passent", r.posees.length === 1);
  } catch (e) { v("les accents, le tiret cadratin, l'œ et l'euro passent", false, e.message); }

  console.log(`\n  ${ok} réussis, ${ko} échoués`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error("INTERROMPU:", e); process.exit(1); });

"use strict";
/**
 * PASSER DE CE QUE L'UTILISATEUR VOIT À CE QUE LE PDF CONTIENT.
 *
 * Un PDF porte un attribut « /Rotate » : le nombre de degrés dont la page
 * doit être tournée DANS LE SENS DES AIGUILLES D'UNE MONTRE à l'affichage.
 * Les scanners en produisent sans arrêt. Le contenu, lui, n'est pas tourné :
 * seules les coordonnées de l'affichage le sont.
 *
 * POURQUOI UN MODULE SÉPARÉ, ET PAS LE CALCUL DE L'APPOSITION.
 *
 * Pour une signature, la question est simple : une image doit paraître droite.
 * `pdf-apposition.js` reçoit un rectangle déjà converti par le navigateur et
 * ne tourne que l'image.
 *
 * Pour une annotation, cela ne suffit plus, parce qu'une annotation a un
 * SENS DE LECTURE INTERNE. Un tableau a des lignes qui vont de gauche à
 * droite et des lignes qui s'empilent de haut en bas ; un paragraphe a des
 * lignes qui se suivent vers le bas. Si l'on convertit seulement le cadre
 * extérieur et qu'on dispose le contenu dans l'espace du PDF, sur une page
 * tournée d'un quart de tour les lignes du tableau deviennent des colonnes.
 * Le cadre est juste, et le tableau est illisible.
 *
 * LE CHOIX FAIT ICI. Tout se calcule dans le REPÈRE DE L'AFFICHAGE — celui
 * que l'utilisateur a sous les yeux, origine en bas à gauche de la page
 * telle qu'elle apparaît —, et ce repère n'est quitté qu'au dernier moment,
 * pour chaque trait et chaque ligne de texte. Le navigateur envoie donc des
 * coordonnées d'AFFICHAGE, sans conversion : c'est aussi la seule chose
 * qu'il sache dire sans se tromper.
 *
 * Conséquence à ne pas perdre de vue : le contrat n'est pas celui de
 * `pdf-apposition.js`. Là-bas, le navigateur convertit ; ici, il ne convertit
 * rien. Mélanger les deux donne des annotations à l'autre bout de la page.
 */

/** La page telle qu'elle apparaît : sous un quart de tour, tout s'échange. */
function affichage({ largeur, hauteur, rotation }) {
  const r = normaliser(rotation);
  return (r === 90 || r === 270)
    ? { largeur: hauteur, hauteur: largeur, rotation: r }
    : { largeur, hauteur, rotation: r };
}

function normaliser(rotation) {
  const r = ((Math.round(Number(rotation) || 0) % 360) + 360) % 360;
  /* Un /Rotate hors des quarts de tour est hors spécification PDF. On le
     ramène au quart le plus proche plutôt que de produire des coordonnées
     fausses sans le dire. */
  return [0, 90, 180, 270].includes(r) ? r : Math.round(r / 90) % 4 * 90;
}

/**
 * Un fabricant de repère pour une page donnée.
 *
 * @param largeur  largeur de la page dans le PDF, en points
 * @param hauteur  hauteur de la page dans le PDF, en points
 * @param rotation /Rotate de la page, en degrés horaires
 */
function repere({ largeur: L, hauteur: H, rotation }) {
  const r = normaliser(rotation);
  const vue = affichage({ largeur: L, hauteur: H, rotation: r });

  /* ── UN POINT ──
     Les quatre formules se dérivent une fois et se vérifient sur les coins.
     Pour r = 90, le contenu est tourné d'un quart de tour horaire : l'axe des
     x du contenu descend à l'écran, l'axe des y va vers la droite. Le coin
     (0,0) du contenu se retrouve donc en haut à gauche de l'affichage. */
  function point(xa, ya) {
    switch (r) {
      case 90:  return { x: L - ya, y: xa };
      case 180: return { x: L - xa, y: H - ya };
      case 270: return { x: ya,     y: H - xa };
      default:  return { x: xa,     y: ya };
    }
  }

  /* ── UN RECTANGLE ──
     Sous un quart de tour, largeur et hauteur s'échangent : c'est exactement
     ce qu'on oublie en ne transformant que le coin. */
  function rect(xa, ya, largeur, hauteur) {
    switch (r) {
      case 90:  return { x: L - ya - hauteur, y: xa, largeur: hauteur, hauteur: largeur };
      case 180: return { x: L - xa - largeur, y: H - ya - hauteur, largeur, hauteur };
      case 270: return { x: ya, y: H - xa - largeur, largeur: hauteur, hauteur: largeur };
      default:  return { x: xa, y: ya, largeur, hauteur };
    }
  }

  /* ── L'ANGLE D'UN TEXTE ──
     De combien tourner les lettres pour qu'elles se lisent horizontalement
     à l'écran.

     DEUX CONVENTIONS OPPOSÉES SE CROISENT ICI, et s'y tromper donne un
     texte couché du mauvais côté — faux de 180° dans les deux cas tournés,
     donc parfaitement invisible sur une page non tournée.

     « /Rotate » compte dans le sens HORAIRE. `pdf-lib`, comme les
     mathématiques, compte dans le sens TRIGONOMÉTRIQUE. Contrer une
     rotation horaire de r, c'est donc tourner de +r dans l'autre sens :
     l'angle vaut r, et non 360 - r.

     La dérivation qui le prouve : pour r = 90, la formule du point ci-dessus
     envoie le +x de l'affichage sur le +y du contenu. Une ligne de texte
     qui avance vers la droite à l'écran avance donc vers le haut dans le
     contenu, et passer de +x à +y est un quart de tour trigonométrique,
     c'est-à-dire +90. */
  const angleTexte = r;

  return {
    rotation: r,
    page: { largeur: L, hauteur: H },
    vue: { largeur: vue.largeur, hauteur: vue.hauteur },
    point, rect, angleTexte,
    /** Le rectangle tient-il dans la page telle qu'on la voit ? */
    dedans(xa, ya, largeur, hauteur, marge = 0.5) {
      return xa >= -marge && ya >= -marge
        && xa + largeur <= vue.largeur + marge
        && ya + hauteur <= vue.hauteur + marge;
    },
  };
}

module.exports = { repere, affichage, normaliser };

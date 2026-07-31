"use strict";

/**
 * Extraction de TABLEAUX depuis un DOCX (via mammoth). Refuse les documents
 * sans tableau exploitable. Ne traite jamais du texte libre comme un import.
 */
const mammoth = require("mammoth");

// Décode les entités HTML de base produites par mammoth.
function decode(s) {
  return String(s)
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .trim();
}

/** Parse les <table> d'un HTML en matrices de cellules. */
function tablesFromHtml(html) {
  const tables = [];
  const tableRe = /<table[\s\S]*?<\/table>/gi;
  let tm;
  while ((tm = tableRe.exec(html))) {
    const rows = [];
    const rowRe = /<tr[\s\S]*?<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(tm[0]))) {
      const cells = [];
      const cellRe = /<t[dh][\s\S]*?<\/t[dh]>/gi;
      let cm;
      while ((cm = cellRe.exec(rm[0]))) cells.push(decode(cm[0]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

/**
 * @returns { tables: Array<matrix> } ou lève une erreur si aucun tableau.
 */
async function extractDocxTables(buffer) {
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const tables = tablesFromHtml(html);
  if (tables.length === 0) {
    const err = new Error("Le document Word ne contient aucun tableau exploitable. Seuls les tableaux structurés sont acceptés.");
    err.statusCode = 400;
    err.code = "NO_TABLE";
    throw err;
  }
  return { tables, count: tables.length };
}

// Convertit une matrice de tableau en { header, rows } (comme le parser tableur).
function tableToRows(matrix, headerRowIndex = 0) {
  if (!matrix || matrix.length === 0) return { header: [], rows: [] };
  const header = (matrix[headerRowIndex] || []).map((c, i) => String(c || "").trim() || `Colonne ${i + 1}`);
  const rows = [];
  for (let i = headerRowIndex + 1; i < matrix.length; i++) {
    const arr = matrix[i] || [];
    if (arr.every((c) => !c || String(c).trim() === "")) continue;
    const obj = {};
    header.forEach((h, ci) => { obj[h] = (arr[ci] ?? "").toString(); });
    obj.__row = i + 1;
    rows.push(obj);
  }
  return { header, rows };
}

module.exports = { extractDocxTables, tablesFromHtml, tableToRows, decode };

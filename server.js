const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const QRCode = require("qrcode");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    const uniqueName =
      Date.now() + "-" + file.originalname.replace(/\s+/g, "-");
    cb(null, uniqueName);
  }
});

const upload = multer({ storage });

const pool = new Pool({
  user: "souleymanediallo",
  host: "localhost",
  database: "triangle_wms_db",
  password: "",
  port: 5432
});

const JWT_SECRET = "triangle_wms_secret_key";

async function logActivity(user_name, user_role, action, module, details) {
  try {
    await pool.query(
      `INSERT INTO user_activities
      (user_name, user_role, action, module, details)
      VALUES ($1, $2, $3, $4, $5)`,
      [
        user_name || "Système",
        user_role || "Non défini",
        action,
        module,
        details || ""
      ]
    );
  } catch (error) {
    console.error("Erreur activité :", error);
  }
}

app.get("/", (req, res) => {
  res.send("Triangle WMS Backend sécurisé OK");
});

/* UPLOAD LOGO */
app.post("/upload-logo", upload.single("logo"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Aucun fichier reçu" });
    }

    const logoUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

    res.json({
      message: "Logo uploadé avec succès",
      logo_url: logoUrl
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur upload logo" });
  }
});

/* UPLOAD PHOTO UTILISATEUR */
app.post("/upload-user-photo", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Aucune photo reçue" });
    }

    const photoUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

    res.json({
      message: "Photo utilisateur uploadée avec succès",
      profile_image_url: photoUrl
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur upload photo utilisateur" });
  }
});

/* PARAMÈTRES ENTREPRISE */
app.get("/company-settings", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM company_settings ORDER BY id ASC LIMIT 1"
    );

    res.json(result.rows[0] || null);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture paramètres entreprise" });
  }
});

app.put("/company-settings", async (req, res) => {
  try {
    const { company_name, address, phone, email, website, logo_url, slogan } =
      req.body;

    const existing = await pool.query(
      "SELECT id FROM company_settings ORDER BY id ASC LIMIT 1"
    );

    if (existing.rows.length === 0) {
      const created = await pool.query(
        `INSERT INTO company_settings
        (company_name, address, phone, email, website, logo_url, slogan)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING *`,
        [company_name, address, phone, email, website, logo_url, slogan]
      );

      return res.json(created.rows[0]);
    }

    const id = existing.rows[0].id;

    const updated = await pool.query(
      `UPDATE company_settings
       SET company_name=$1,
           address=$2,
           phone=$3,
           email=$4,
           website=$5,
           logo_url=$6,
           slogan=$7,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$8
       RETURNING *`,
      [company_name, address, phone, email, website, logo_url, slogan, id]
    );

    await logActivity(
      "Administrateur",
      "admin",
      "Modification paramètres entreprise",
      "Paramètres",
      `Paramètres entreprise modifiés : ${company_name}`
    );

    res.json(updated.rows[0]);
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ error: "Erreur modification paramètres entreprise" });
  }
});

/* LOGIN */
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query("SELECT * FROM users WHERE email = $1", [
      email
    ]);
    const user = result.rows[0];

    if (!user) return res.status(401).json({ error: "Email incorrect" });
    if (user.is_active === false)
      return res.status(403).json({ error: "Compte désactivé" });
    if (password !== user.password)
      return res.status(401).json({ error: "Mot de passe incorrect" });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: "1d" }
    );

    await logActivity(
      user.fullname,
      user.role,
      "Connexion utilisateur",
      "Authentification",
      `${user.fullname} s'est connecté`
    );

    res.json({
      message: "Connexion réussie",
      token,
      user: {
        id: user.id,
        fullname: user.fullname,
        email: user.email,
        role: user.role,
        profile_image_url: user.profile_image_url || ""
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur login" });
  }
});

/* UTILISATEURS */
app.get("/users", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, fullname, email, role, is_active, profile_image_url, created_at
       FROM users
       ORDER BY id DESC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture utilisateurs" });
  }
});

app.post("/users", async (req, res) => {
  try {
    const { fullname, email, password, role, is_active, profile_image_url } =
      req.body;

    const result = await pool.query(
      `INSERT INTO users
      (fullname, email, password, role, is_active, profile_image_url)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, fullname, email, role, is_active, profile_image_url, created_at`,
      [
        fullname,
        email,
        password || "123456",
        role || "magasinier",
        is_active !== false,
        profile_image_url || ""
      ]
    );

    await logActivity(
      "Administrateur",
      "admin",
      "Ajout utilisateur",
      "Utilisateurs",
      `Utilisateur ajouté : ${fullname}`
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur ajout utilisateur" });
  }
});

app.put("/users/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { fullname, email, password, role, is_active, profile_image_url } =
      req.body;

    let result;

    if (password && password.trim() !== "") {
      result = await pool.query(
        `UPDATE users
         SET fullname=$1,
             email=$2,
             password=$3,
             role=$4,
             is_active=$5,
             profile_image_url=$6
         WHERE id=$7
         RETURNING id, fullname, email, role, is_active, profile_image_url, created_at`,
        [
          fullname,
          email,
          password,
          role,
          is_active !== false,
          profile_image_url || "",
          id
        ]
      );
    } else {
      result = await pool.query(
        `UPDATE users
         SET fullname=$1,
             email=$2,
             role=$3,
             is_active=$4,
             profile_image_url=$5
         WHERE id=$6
         RETURNING id, fullname, email, role, is_active, profile_image_url, created_at`,
        [
          fullname,
          email,
          role,
          is_active !== false,
          profile_image_url || "",
          id
        ]
      );
    }

    await logActivity(
      "Administrateur",
      "admin",
      "Modification utilisateur",
      "Utilisateurs",
      `Utilisateur modifié : ${fullname}`
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur modification utilisateur" });
  }
});

app.delete("/users/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM users WHERE id=$1", [req.params.id]);

    await logActivity(
      "Administrateur",
      "admin",
      "Suppression utilisateur",
      "Utilisateurs",
      `Utilisateur supprimé ID : ${req.params.id}`
    );

    res.json({ message: "Utilisateur supprimé" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur suppression utilisateur" });
  }
});

/* PRODUITS */
app.get("/products", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT products.*, locations.emplacement_code
      FROM products
      LEFT JOIN locations ON products.location_id = locations.id
      ORDER BY products.id DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur serveur produits" });
  }
});

app.post("/products", async (req, res) => {
  try {
    const {
      reference,
      name,
      category,
      stock,
      warehouse,
      status,
      unit,
      weight,
      dimensions,
      barcode,
      description,
      is_active,
      location_id,
      location_code,
      minimum_stock,
      image_url,
      user_name,
      user_role
    } = req.body;

    const result = await pool.query(
      `INSERT INTO products
      (reference, name, category, stock, warehouse, status, unit, weight,
       dimensions, barcode, description, is_active, location_id, location_code,
       minimum_stock, image_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *`,
      [
        reference,
        name,
        category,
        Number(stock || 0),
        warehouse,
        status || "Disponible",
        unit || "pièce",
        Number(weight || 0),
        dimensions || "",
        barcode || "",
        description || "",
        is_active !== false,
        location_id || null,
        location_code || "",
        Number(minimum_stock || 5),
        image_url || ""
      ]
    );

    await logActivity(
      user_name,
      user_role,
      "Ajout produit",
      "Produits",
      `Produit ajouté : ${reference} - ${name}`
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur ajout produit" });
  }
});

app.put("/products/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      reference,
      name,
      category,
      stock,
      warehouse,
      status,
      unit,
      weight,
      dimensions,
      barcode,
      description,
      is_active,
      location_id,
      location_code,
      minimum_stock,
      image_url,
      user_name,
      user_role
    } = req.body;

    const result = await pool.query(
      `UPDATE products
       SET reference=$1, name=$2, category=$3, stock=$4, warehouse=$5,
           status=$6, unit=$7, weight=$8, dimensions=$9, barcode=$10,
           description=$11, is_active=$12, location_id=$13, location_code=$14,
           minimum_stock=$15, image_url=$16
       WHERE id=$17
       RETURNING *`,
      [
        reference,
        name,
        category,
        Number(stock || 0),
        warehouse,
        status,
        unit || "pièce",
        Number(weight || 0),
        dimensions || "",
        barcode || "",
        description || "",
        is_active !== false,
        location_id || null,
        location_code || "",
        Number(minimum_stock || 5),
        image_url || "",
        id
      ]
    );

    await logActivity(
      user_name,
      user_role,
      "Modification produit",
      "Produits",
      `Produit modifié : ${reference} - ${name}`
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur modification produit" });
  }
});

app.delete("/products/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM products WHERE id=$1", [req.params.id]);

    await logActivity(
      "Administrateur",
      "admin",
      "Suppression produit",
      "Produits",
      `Produit supprimé ID : ${req.params.id}`
    );

    res.json({ message: "Produit supprimé" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur suppression produit" });
  }
});

/* MOUVEMENTS STOCK */
app.get("/stock-movements", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM stock_movements ORDER BY id DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur mouvements stock" });
  }
});

app.post("/stock-movements", async (req, res) => {
  try {
    const {
      type,
      product_reference,
      product_name,
      quantity,
      source_warehouse,
      destination_warehouse,
      reason,
      user_name,
      user_role
    } = req.body;

    const result = await pool.query(
      `INSERT INTO stock_movements
      (type, product_reference, product_name, quantity, source_warehouse,
       destination_warehouse, reason, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [
        type,
        product_reference,
        product_name,
        Number(quantity),
        source_warehouse,
        destination_warehouse,
        reason,
        "En attente"
      ]
    );

    if (type === "Inventaire") {
      const productResult = await pool.query(
        "SELECT stock, warehouse, location_code FROM products WHERE reference=$1",
        [product_reference]
      );

      const product = productResult.rows[0];
      const systemStock = Number(product?.stock || 0);
      const realStock = Number(quantity || 0);
      const difference = realStock - systemStock;

      await pool.query(
        `INSERT INTO inventory_history
        (product_reference, product_name, system_stock, real_stock, difference,
         warehouse, location_code, user_name, user_role, status, observation)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          product_reference,
          product_name,
          systemStock,
          realStock,
          difference,
          source_warehouse || product?.warehouse || "",
          product?.location_code || "",
          user_name || "Magasinier",
          user_role || "magasinier",
          "En attente",
          reason || ""
        ]
      );
    }

    await logActivity(
      user_name,
      user_role,
      "Création mouvement stock",
      "Stocks",
      `${type} créée pour ${product_reference}`
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur création mouvement" });
  }
});

app.put("/stock-movements/:id/validate", async (req, res) => {
  try {
    const { id } = req.params;

    const movementResult = await pool.query(
      "SELECT * FROM stock_movements WHERE id=$1",
      [id]
    );

    const movement = movementResult.rows[0];

    if (!movement)
      return res.status(404).json({ error: "Mouvement introuvable" });

    if (movement.status !== "En attente") {
      return res.status(400).json({ error: "Mouvement déjà traité" });
    }

    if (movement.type === "Entrée") {
      await pool.query(
        "UPDATE products SET stock = stock + $1 WHERE reference = $2",
        [movement.quantity, movement.product_reference]
      );
    }

    if (movement.type === "Sortie") {
      await pool.query(
        "UPDATE products SET stock = stock - $1 WHERE reference = $2",
        [movement.quantity, movement.product_reference]
      );
    }

    if (movement.type === "Inventaire") {
      await pool.query("UPDATE products SET stock = $1 WHERE reference = $2", [
        movement.quantity,
        movement.product_reference
      ]);

      await pool.query(
        `UPDATE inventory_history
         SET status='Validé'
         WHERE product_reference=$1 AND status='En attente'`,
        [movement.product_reference]
      );
    }

    const updated = await pool.query(
      "UPDATE stock_movements SET status='Validé' WHERE id=$1 RETURNING *",
      [id]
    );

    await logActivity(
      "Administrateur",
      "admin",
      "Validation mouvement stock",
      "Stocks",
      `${movement.type} validé pour ${movement.product_reference}`
    );

    res.json(updated.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur validation mouvement" });
  }
});

app.put("/stock-movements/:id/reject", async (req, res) => {
  try {
    const movementResult = await pool.query(
      "SELECT * FROM stock_movements WHERE id=$1",
      [req.params.id]
    );

    const movement = movementResult.rows[0];

    const updated = await pool.query(
      "UPDATE stock_movements SET status='Refusé' WHERE id=$1 RETURNING *",
      [req.params.id]
    );

    if (movement?.type === "Inventaire") {
      await pool.query(
        `UPDATE inventory_history
         SET status='Refusé'
         WHERE product_reference=$1 AND status='En attente'`,
        [movement.product_reference]
      );
    }

    await logActivity(
      "Administrateur",
      "admin",
      "Refus mouvement stock",
      "Stocks",
      `Mouvement refusé ID : ${req.params.id}`
    );

    res.json(updated.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur refus mouvement" });
  }
});

/* DOCUMENTS : BL / BR / FACTURE / PROFORMA */
app.get("/documents", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM documents ORDER BY id DESC");

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture documents" });
  }
});

app.get("/documents/:id", async (req, res) => {
  try {
    const documentResult = await pool.query(
      "SELECT * FROM documents WHERE id=$1",
      [req.params.id]
    );

    const itemsResult = await pool.query(
      "SELECT * FROM document_items WHERE document_id=$1 ORDER BY id ASC",
      [req.params.id]
    );

    res.json({
      document: documentResult.rows[0],
      items: itemsResult.rows
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur détail document" });
  }
});

app.post("/documents", async (req, res) => {
  try {
    const {
      document_type,
      client_name,
      client_phone,
      client_address,
      observation,
      created_by,
      items
    } = req.body;

    const prefix =
      document_type === "Facture"
        ? "FAC"
        : document_type === "Proforma"
          ? "PRO"
          : document_type === "Bon de réception"
            ? "BR"
            : "BL";

    const document_number = `${prefix}-${Date.now()}`;

    const total_amount = (items || []).reduce((sum, item) => {
      return sum + Number(item.quantity || 0) * Number(item.unit_price || 0);
    }, 0);

    const documentResult = await pool.query(
      `INSERT INTO documents
      (
        document_type,
        document_number,
        client_name,
        client_phone,
        client_address,
        total_amount,
        observation,
        created_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [
        document_type,
        document_number,
        client_name,
        client_phone,
        client_address,
        total_amount,
        observation,
        created_by || "Administrateur"
      ]
    );

    const document = documentResult.rows[0];

    for (const item of items || []) {
      const total_price =
        Number(item.quantity || 0) * Number(item.unit_price || 0);

      await pool.query(
        `INSERT INTO document_items
        (
          document_id,
          product_reference,
          product_name,
          quantity,
          unit_price,
          total_price
        )
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          document.id,
          item.product_reference,
          item.product_name,
          Number(item.quantity || 0),
          Number(item.unit_price || 0),
          total_price
        ]
      );
    }

    await logActivity(
      "Administrateur",
      "admin",
      "Création document",
      "Documents",
      `${document_type} créé : ${document_number}`
    );

    res.status(201).json(document);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur création document" });
  }
});

app.delete("/documents/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM documents WHERE id=$1", [req.params.id]);

    await logActivity(
      "Administrateur",
      "admin",
      "Suppression document",
      "Documents",
      `Document supprimé ID : ${req.params.id}`
    );

    res.json({ message: "Document supprimé" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur suppression document" });
  }
});

/* GÉNÉRER DOCUMENT DEPUIS MOUVEMENT STOCK */
app.post("/documents/from-movement/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      document_type,
      client_name,
      client_phone,
      client_address,
      created_by
    } = req.body;

    const movementResult = await pool.query(
      "SELECT * FROM stock_movements WHERE id=$1",
      [id]
    );

    const movement = movementResult.rows[0];

    if (!movement) {
      return res.status(404).json({
        error: "Mouvement introuvable"
      });
    }

    if (movement.status !== "Validé") {
      return res.status(400).json({
        error: "Le mouvement doit être validé avant de générer un document"
      });
    }

    let finalType = document_type;

    if (!finalType) {
      if (movement.type === "Entrée") {
        finalType = "Bon de réception";
      } else if (movement.type === "Sortie") {
        finalType = "Bon de livraison";
      } else if (movement.type === "Transfert") {
        finalType = "Bon de transfert";
      } else if (movement.type === "Inventaire") {
        finalType = "Fiche inventaire";
      } else {
        finalType = "Document stock";
      }
    }

    const prefix =
      finalType === "Facture"
        ? "FAC"
        : finalType === "Proforma"
          ? "PRO"
          : finalType === "Bon de réception"
            ? "BR"
            : finalType === "Bon de sortie"
              ? "BS"
              : finalType === "Bon de transfert"
                ? "BT"
                : finalType === "Fiche inventaire"
                  ? "INV"
                  : "BL";

    const document_number = `${prefix}-${Date.now()}`;

    const documentResult = await pool.query(
      `INSERT INTO documents
      (
        document_type,
        document_number,
        client_name,
        client_phone,
        client_address,
        total_amount,
        observation,
        created_by
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [
        finalType,
        document_number,
        client_name || "",
        client_phone || "",
        client_address || "",
        0,
        `Document généré depuis mouvement stock ID ${movement.id} - ${movement.type}`,
        created_by || "Administrateur"
      ]
    );

    const document = documentResult.rows[0];

    await pool.query(
      `INSERT INTO document_items
      (
        document_id,
        product_reference,
        product_name,
        quantity,
        unit_price,
        total_price
      )
      VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        document.id,
        movement.product_reference,
        movement.product_name,
        Number(movement.quantity || 0),
        0,
        0
      ]
    );

    await logActivity(
      "Administrateur",
      "admin",
      "Document généré depuis mouvement",
      "Documents",
      `${finalType} généré : ${document_number}`
    );

    res.status(201).json(document);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur génération document depuis mouvement"
    });
  }
});

/* HISTORIQUE INVENTAIRE */
app.get("/inventory-history", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM inventory_history ORDER BY id DESC"
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture historique inventaire" });
  }
});

/* ENTREPÔTS */
app.get("/warehouses", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM warehouses ORDER BY id DESC"
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture entrepôts" });
  }
});

app.post("/warehouses", async (req, res) => {
  try {
    const { code, name, location, manager, racks_count, status } = req.body;

    const result = await pool.query(
      `INSERT INTO warehouses
      (code, name, location, manager, racks_count, status)
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *`,
      [
        code,
        name,
        location,
        manager,
        Number(racks_count || 0),
        status || "Actif"
      ]
    );

    await logActivity(
      "Administrateur",
      "admin",
      "Ajout entrepôt",
      "Entrepôts",
      `Entrepôt ajouté : ${code} - ${name}`
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur ajout entrepôt" });
  }
});

app.put("/warehouses/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { code, name, location, manager, racks_count, status } = req.body;

    const result = await pool.query(
      `UPDATE warehouses
      SET code=$1, name=$2, location=$3, manager=$4, racks_count=$5, status=$6
      WHERE id=$7
      RETURNING *`,
      [code, name, location, manager, Number(racks_count || 0), status, id]
    );

    await logActivity(
      "Administrateur",
      "admin",
      "Modification entrepôt",
      "Entrepôts",
      `Entrepôt modifié : ${code} - ${name}`
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur modification entrepôt" });
  }
});

app.delete("/warehouses/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM warehouses WHERE id=$1", [req.params.id]);

    await logActivity(
      "Administrateur",
      "admin",
      "Suppression entrepôt",
      "Entrepôts",
      `Entrepôt supprimé ID : ${req.params.id}`
    );

    res.json({ message: "Entrepôt supprimé" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur suppression entrepôt" });
  }
});

/* EMPLACEMENTS */
app.get("/locations", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT locations.*, warehouses.name AS warehouse_name
       FROM locations
       LEFT JOIN warehouses ON locations.warehouse_id = warehouses.id
       ORDER BY locations.id DESC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture emplacements" });
  }
});

app.post("/locations", async (req, res) => {
  try {
    const { warehouse_id, zone, rayon, etagere, status } = req.body;

    const warehouseResult = await pool.query(
      "SELECT * FROM warehouses WHERE id=$1",
      [warehouse_id]
    );

    const warehouse = warehouseResult.rows[0];

    if (!warehouse)
      return res.status(404).json({ error: "Entrepôt introuvable" });

    const emplacement_code = `${warehouse.code}-${zone}-${rayon}-${etagere}`;
    const qr_code = await QRCode.toDataURL(emplacement_code);

    const result = await pool.query(
      `INSERT INTO locations
      (warehouse_id, warehouse_code, zone, rayon, etagere, emplacement_code, qr_code, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *`,
      [
        warehouse_id,
        warehouse.code,
        zone,
        rayon,
        etagere,
        emplacement_code,
        qr_code,
        status || "Disponible"
      ]
    );

    await logActivity(
      "Administrateur",
      "admin",
      "Création emplacement",
      "Emplacements",
      `Emplacement créé : ${emplacement_code}`
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur ajout emplacement" });
  }
});

app.delete("/locations/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM locations WHERE id=$1", [req.params.id]);

    await logActivity(
      "Administrateur",
      "admin",
      "Suppression emplacement",
      "Emplacements",
      `Emplacement supprimé ID : ${req.params.id}`
    );

    res.json({ message: "Emplacement supprimé" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur suppression emplacement" });
  }
});

/* ACTIVITÉS */
app.get("/activities", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM user_activities ORDER BY id DESC"
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture activités" });
  }
});

/* ALERTES */
app.get("/alerts", async (req, res) => {
  try {
    const stockFaible = await pool.query(
      `SELECT reference, name, stock, minimum_stock, warehouse, location_code
       FROM products
       WHERE stock > 0 AND stock <= minimum_stock
       ORDER BY stock ASC`
    );

    const rupture = await pool.query(
      `SELECT reference, name, stock, minimum_stock, warehouse, location_code
       FROM products
       WHERE stock <= 0
       ORDER BY name ASC`
    );

    const validations = await pool.query(
      `SELECT id, type, product_reference, product_name, quantity, status, created_at
       FROM stock_movements
       WHERE status = 'En attente'
       ORDER BY id DESC`
    );

    const refuses = await pool.query(
      `SELECT id, type, product_reference, product_name, quantity, status, created_at
       FROM stock_movements
       WHERE status = 'Refusé'
       ORDER BY id DESC`
    );

    res.json({
      stock_faible: stockFaible.rows,
      rupture_stock: rupture.rows,
      validations_en_attente: validations.rows,
      mouvements_refuses: refuses.rows,
      totals: {
        stock_faible: stockFaible.rows.length,
        rupture_stock: rupture.rows.length,
        validations_en_attente: validations.rows.length,
        mouvements_refuses: refuses.rows.length
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture alertes" });
  }
});

/* RECHERCHE GLOBALE INTELLIGENTE */
app.get("/search", async (req, res) => {
  try {
    const q = req.query.q;

    if (!q || String(q).trim() === "") {
      return res.json({
        products: [],
        movements: [],
        inventories: [],
        documents: [],
        locations: []
      });
    }

    const search = `%${String(q).trim()}%`;

    const products = await pool.query(
      `SELECT products.*, locations.emplacement_code
       FROM products
       LEFT JOIN locations ON products.location_id = locations.id
       WHERE products.reference ILIKE $1
          OR products.name ILIKE $1
          OR products.category ILIKE $1
          OR products.warehouse ILIKE $1
          OR products.location_code ILIKE $1
          OR locations.emplacement_code ILIKE $1
       ORDER BY products.id DESC`,
      [search]
    );

    const movements = await pool.query(
      `SELECT *
       FROM stock_movements
       WHERE product_reference ILIKE $1
          OR product_name ILIKE $1
          OR type ILIKE $1
          OR source_warehouse ILIKE $1
          OR destination_warehouse ILIKE $1
          OR reason ILIKE $1
          OR status ILIKE $1
       ORDER BY id DESC`,
      [search]
    );

    const inventories = await pool.query(
      `SELECT *
       FROM inventory_history
       WHERE product_reference ILIKE $1
          OR product_name ILIKE $1
          OR warehouse ILIKE $1
          OR location_code ILIKE $1
          OR user_name ILIKE $1
          OR status ILIKE $1
          OR observation ILIKE $1
       ORDER BY id DESC`,
      [search]
    );

    const documents = await pool.query(
      `SELECT *
       FROM documents
       WHERE document_type ILIKE $1
          OR document_number ILIKE $1
          OR client_name ILIKE $1
          OR client_phone ILIKE $1
          OR client_address ILIKE $1
          OR observation ILIKE $1
          OR created_by ILIKE $1
       ORDER BY id DESC`,
      [search]
    );

    const locations = await pool.query(
      `SELECT locations.*, warehouses.name AS warehouse_name
       FROM locations
       LEFT JOIN warehouses ON locations.warehouse_id = warehouses.id
       WHERE locations.emplacement_code ILIKE $1
          OR locations.warehouse_code ILIKE $1
          OR locations.zone ILIKE $1
          OR locations.rayon ILIKE $1
          OR locations.etagere ILIKE $1
          OR warehouses.name ILIKE $1
       ORDER BY locations.id DESC`,
      [search]
    );

    res.json({
      products: products.rows,
      movements: movements.rows,
      inventories: inventories.rows,
      documents: documents.rows,
      locations: locations.rows,
      totals: {
        products: products.rows.length,
        movements: movements.rows.length,
        inventories: inventories.rows.length,
        documents: documents.rows.length,
        locations: locations.rows.length
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur recherche globale"
    });
  }
});

/* CHAT INTERNE & NOTIFICATIONS */
app.get("/chat/conversations/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `SELECT c.*
       FROM conversations c
       INNER JOIN conversation_participants cp
       ON c.id = cp.conversation_id
       WHERE cp.user_id = $1
       ORDER BY c.id DESC`,
      [userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture conversations" });
  }
});

app.post("/chat/conversations", async (req, res) => {
  try {
    const { title, type, created_by, participants } = req.body;

    const conversationResult = await pool.query(
      `INSERT INTO conversations
       (title, type, created_by)
       VALUES ($1,$2,$3)
       RETURNING *`,
      [title, type || "private", created_by]
    );

    const conversation = conversationResult.rows[0];

    for (const userId of participants || []) {
      await pool.query(
        `INSERT INTO conversation_participants
         (conversation_id, user_id)
         VALUES ($1,$2)`,
        [conversation.id, userId]
      );
    }

    await logActivity(
      "Système",
      "chat",
      "Création conversation",
      "Chat",
      `Conversation créée : ${title}`
    );

    res.status(201).json(conversation);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur création conversation" });
  }
});

app.get("/chat/messages/:conversationId", async (req, res) => {
  try {
    const { conversationId } = req.params;

    const result = await pool.query(
      `SELECT m.*, u.fullname AS sender_name, u.role AS sender_role, u.profile_image_url
       FROM messages m
       LEFT JOIN users u ON m.sender_id = u.id
       WHERE m.conversation_id = $1
       ORDER BY m.id ASC`,
      [conversationId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture messages" });
  }
});

app.post("/chat/messages", async (req, res) => {
  try {
    const { conversation_id, sender_id, receiver_id, content } = req.body;

    const messageResult = await pool.query(
      `INSERT INTO messages
       (conversation_id, sender_id, receiver_id, content)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [conversation_id, sender_id, receiver_id || null, content]
    );

    const message = messageResult.rows[0];

    if (receiver_id) {
      await pool.query(
        `INSERT INTO notifications
         (user_id, title, message, type)
         VALUES ($1,$2,$3,$4)`,
        [
          receiver_id,
          "Nouveau message",
          "Vous avez reçu un nouveau message interne.",
          "message"
        ]
      );
    }

    res.status(201).json(message);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur envoi message" });
  }
});

app.put("/chat/messages/:id/read", async (req, res) => {
  try {
    const updated = await pool.query(
      `UPDATE messages
       SET is_read = true
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    res.json(updated.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture message" });
  }
});

app.get("/notifications/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *
       FROM notifications
       WHERE user_id = $1
       ORDER BY id DESC`,
      [req.params.userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture notifications" });
  }
});

app.put("/notifications/:id/read", async (req, res) => {
  try {
    const updated = await pool.query(
      `UPDATE notifications
       SET is_read = true
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );

    res.json(updated.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur notification lue" });
  }
});

/* POINTAGE INTELLIGENT */
app.get("/attendance/schedule-groups", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM schedule_groups ORDER BY id ASC"
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture groupes horaires" });
  }
});

app.get("/attendance/today", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ar.*, u.fullname, u.email, u.role, u.profile_image_url
       FROM attendance_records ar
       LEFT JOIN users u ON ar.user_id = u.id
       WHERE ar.work_date = CURRENT_DATE
       ORDER BY ar.id DESC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture pointages du jour" });
  }
});

app.get("/attendance/history/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *
       FROM attendance_history
       WHERE user_id = $1
       ORDER BY id DESC`,
      [req.params.userId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur historique pointage" });
  }
});

app.post("/attendance/check", async (req, res) => {
  try {
    const { user_id, action_type, device_info, ip_address, location_info } =
      req.body;

    if (!user_id || !action_type) {
      return res.status(400).json({
        error: "Utilisateur et type d'action obligatoires"
      });
    }

    const existingResult = await pool.query(
      `SELECT *
       FROM attendance_records
       WHERE user_id=$1 AND work_date=CURRENT_DATE
       LIMIT 1`,
      [user_id]
    );

    let attendance = existingResult.rows[0];

    if (!attendance) {
      const created = await pool.query(
        `INSERT INTO attendance_records
        (user_id, work_date, status)
        VALUES ($1, CURRENT_DATE, 'Absent')
        RETURNING *`,
        [user_id]
      );

      attendance = created.rows[0];
    }

    let updateQuery = "";
    let status = attendance.status || "Absent";

    if (action_type === "ARRIVEE") {
      if (attendance.check_in) {
        return res.status(400).json({ error: "Arrivée déjà pointée" });
      }

      const now = new Date();
      const startLimit = new Date();
      startLimit.setHours(8, 0, 0, 0);

      const lateMinutes = Math.max(
        0,
        Math.round((now.getTime() - startLimit.getTime()) / 60000)
      );

      status = lateMinutes > 0 ? "En retard" : "Présent";

      updateQuery = `
        UPDATE attendance_records
        SET check_in=CURRENT_TIMESTAMP,
            status=$1,
            late_minutes=$2,
            updated_at=CURRENT_TIMESTAMP
        WHERE id=$3
        RETURNING *
      `;

      attendance = (
        await pool.query(updateQuery, [status, lateMinutes, attendance.id])
      ).rows[0];
    }

    if (action_type === "DEPART_PAUSE") {
      if (!attendance.check_in) {
        return res.status(400).json({ error: "Arrivée non pointée" });
      }

      if (attendance.break_out) {
        return res.status(400).json({ error: "Départ pause déjà pointé" });
      }

      attendance = (
        await pool.query(
          `UPDATE attendance_records
           SET break_out=CURRENT_TIMESTAMP,
               status='En pause',
               updated_at=CURRENT_TIMESTAMP
           WHERE id=$1
           RETURNING *`,
          [attendance.id]
        )
      ).rows[0];
    }

    if (action_type === "RETOUR_PAUSE") {
      if (!attendance.break_out) {
        return res.status(400).json({ error: "Départ pause non pointé" });
      }

      if (attendance.break_in) {
        return res.status(400).json({ error: "Retour pause déjà pointé" });
      }

      attendance = (
        await pool.query(
          `UPDATE attendance_records
           SET break_in=CURRENT_TIMESTAMP,
               status='Présent',
               updated_at=CURRENT_TIMESTAMP
           WHERE id=$1
           RETURNING *`,
          [attendance.id]
        )
      ).rows[0];
    }

    if (action_type === "DEBAUCHE") {
      if (!attendance.check_in) {
        return res.status(400).json({ error: "Arrivée non pointée" });
      }

      if (attendance.check_out) {
        return res.status(400).json({ error: "Débauche déjà pointée" });
      }

      const updated = await pool.query(
        `UPDATE attendance_records
         SET check_out=CURRENT_TIMESTAMP,
             status='Terminé',
             total_work_minutes = GREATEST(
               0,
               EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - check_in)) / 60
             ),
             updated_at=CURRENT_TIMESTAMP
         WHERE id=$1
         RETURNING *`,
        [attendance.id]
      );

      attendance = updated.rows[0];
    }

    await pool.query(
      `INSERT INTO attendance_history
       (user_id, action_type, device_info, ip_address, location_info)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        user_id,
        action_type,
        device_info || "",
        ip_address || "",
        location_info || ""
      ]
    );

    await logActivity(
      "Utilisateur",
      "pointage",
      `Pointage ${action_type}`,
      "Pointage",
      `Utilisateur ID ${user_id} a effectué : ${action_type}`
    );

    res.json(attendance);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur pointage" });
  }
});

/* PARAMÈTRES POINTAGE */
app.get("/attendance/settings/schedule-groups", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM schedule_groups ORDER BY id ASC"
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur lecture groupes horaires" });
  }
});

app.post("/attendance/settings/schedule-groups", async (req, res) => {
  try {
    const { name, start_time, end_time, break_start, break_end } = req.body;

    const result = await pool.query(
      `INSERT INTO schedule_groups
      (name, start_time, end_time, break_start, break_end)
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *`,
      [name, start_time, end_time, break_start || null, break_end || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur création groupe horaire" });
  }
});

app.put("/attendance/settings/schedule-groups/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, start_time, end_time, break_start, break_end } = req.body;

    const result = await pool.query(
      `UPDATE schedule_groups
       SET name=$1,
           start_time=$2,
           end_time=$3,
           break_start=$4,
           break_end=$5
       WHERE id=$6
       RETURNING *`,
      [name, start_time, end_time, break_start || null, break_end || null, id]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur modification groupe horaire" });
  }
});

app.put("/attendance/settings/users/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const {
      schedule_group_id,
      salary_type,
      hourly_rate,
      daily_rate,
      monthly_salary
    } = req.body;

    const result = await pool.query(
      `UPDATE users
       SET schedule_group_id=$1,
           salary_type=$2,
           hourly_rate=$3,
           daily_rate=$4,
           monthly_salary=$5
       WHERE id=$6
       RETURNING id, fullname, email, role, schedule_group_id, salary_type, hourly_rate, daily_rate, monthly_salary`,
      [
        schedule_group_id || null,
        salary_type || "horaire",
        Number(hourly_rate || 0),
        Number(daily_rate || 0),
        Number(monthly_salary || 0),
        id
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur paramètres utilisateur pointage" });
  }
});

/* LISTE GROUPES HORAIRES */
app.get("/attendance/groups", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *
       FROM schedule_groups
       ORDER BY id ASC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur lecture groupes horaires"
    });
  }
});

/* AJOUT GROUPE HORAIRE */
app.post("/attendance/groups", async (req, res) => {
  try {
    const { name, start_time, end_time, break_start, break_end } = req.body;

    const result = await pool.query(
      `INSERT INTO schedule_groups
      (
        name,
        start_time,
        end_time,
        break_start,
        break_end
      )
      VALUES ($1,$2,$3,$4,$5)
      RETURNING *`,
      [name, start_time, end_time, break_start, break_end]
    );

    await logActivity(
      "Administrateur",
      "pointage",
      "Ajout groupe horaire",
      "Pointage",
      `Nouveau groupe : ${name}`
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur ajout groupe horaire"
    });
  }
});

/* MODIFICATION GROUPE */
app.put("/attendance/groups/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { name, start_time, end_time, break_start, break_end } = req.body;

    const result = await pool.query(
      `UPDATE schedule_groups
       SET
         name=$1,
         start_time=$2,
         end_time=$3,
         break_start=$4,
         break_end=$5
       WHERE id=$6
       RETURNING *`,
      [name, start_time, end_time, break_start, break_end, id]
    );

    await logActivity(
      "Administrateur",
      "pointage",
      "Modification groupe horaire",
      "Pointage",
      `Modification groupe : ${name}`
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur modification groupe"
    });
  }
});

/* SUPPRESSION GROUPE */
app.delete("/attendance/groups/:id", async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM schedule_groups
       WHERE id=$1`,
      [req.params.id]
    );

    await logActivity(
      "Administrateur",
      "pointage",
      "Suppression groupe horaire",
      "Pointage",
      `Suppression groupe ID : ${req.params.id}`
    );

    res.json({
      message: "Groupe supprimé"
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur suppression groupe"
    });
  }
});

/* AFFECTATION HORAIRE EMPLOYÉ */
app.put("/attendance/assign-user/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { schedule_group_id, hourly_rate, daily_rate, payment_type } =
      req.body;

    const result = await pool.query(
      `UPDATE users
       SET
         schedule_group_id=$1,
         hourly_rate=$2,
         daily_rate=$3,
         payment_type=$4
       WHERE id=$5
       RETURNING *`,
      [
        schedule_group_id,
        hourly_rate || 0,
        daily_rate || 0,
        payment_type || "horaire",
        id
      ]
    );

    await logActivity(
      "Administrateur",
      "pointage",
      "Affectation horaire employé",
      "Pointage",
      `Employé ID ${id} affecté au groupe ${schedule_group_id}`
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Erreur affectation employé"
    });
  }
});

/* ASSISTANT IA OPENROUTER */
app.post("/ai/chat", async (req, res) => {
  try {
    const { message, user } = req.body;

    if (!message || String(message).trim() === "") {
      return res.status(400).json({
        error: "Message obligatoire"
      });
    }

    if (!process.env.OPENROUTER_API_KEY) {
      return res.status(500).json({
        error: "Clé OpenRouter manquante dans .env"
      });
    }

    const aiResponse = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:3000",
          "X-Title": "Triangle WMS Pro"
        },
        body: JSON.stringify({
          model: "openrouter/auto",
          messages: [
            {
              role: "system",
              content:
                "Tu es l'assistant IA officiel de Triangle WMS Pro. Tu aides les utilisateurs en français simple et professionnel. Tu es spécialisé en logistique, gestion de stock, entreposage, transport, inventaire, documents logistiques, pointage, RH, tableaux de bord et organisation opérationnelle. Tu dois répondre clairement, étape par étape, sans inventer de données internes si elles ne sont pas fournies."
            },
            {
              role: "user",
              content: `Utilisateur connecté : ${user?.fullname || "Utilisateur"} | Rôle : ${user?.role || "non défini"}\n\nQuestion : ${message}`
            }
          ]
        })
      }
    );

    const data = await aiResponse.json();

    if (!aiResponse.ok) {
      return res.status(500).json({
        error: "Erreur OpenRouter",
        details: data
      });
    }

    const answer =
      data?.choices?.[0]?.message?.content ||
      "Je n'ai pas pu générer une réponse.";

    res.json({
      answer
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Erreur assistant IA"
    });
  }
});

/* DASHBOARD STATS */
app.get("/dashboard-stats", async (req, res) => {
  try {
    const totalProduits = await pool.query("SELECT COUNT(*) FROM products");
    const totalEntrepots = await pool.query("SELECT COUNT(*) FROM warehouses");
    const totalEmplacements = await pool.query(
      "SELECT COUNT(*) FROM locations"
    );
    const totalUsers = await pool.query("SELECT COUNT(*) FROM users");
    const totalInventaires = await pool.query(
      "SELECT COUNT(*) FROM inventory_history"
    );

    const mouvementsAttente = await pool.query(
      "SELECT COUNT(*) FROM stock_movements WHERE status='En attente'"
    );

    const stockFaible = await pool.query(
      "SELECT COUNT(*) FROM products WHERE stock > 0 AND stock <= minimum_stock"
    );

    const ruptureStock = await pool.query(
      "SELECT COUNT(*) FROM products WHERE stock <= 0"
    );

    const activitesRecentes = await pool.query(
      "SELECT * FROM user_activities ORDER BY id DESC LIMIT 5"
    );

    const derniersMouvements = await pool.query(
      "SELECT * FROM stock_movements ORDER BY id DESC LIMIT 5"
    );

    res.json({
      total_produits: Number(totalProduits.rows[0].count),
      total_entrepots: Number(totalEntrepots.rows[0].count),
      total_emplacements: Number(totalEmplacements.rows[0].count),
      total_utilisateurs: Number(totalUsers.rows[0].count),
      total_inventaires: Number(totalInventaires.rows[0].count),
      mouvements_attente: Number(mouvementsAttente.rows[0].count),
      alertes:
        Number(stockFaible.rows[0].count) + Number(ruptureStock.rows[0].count),
      stock_faible: Number(stockFaible.rows[0].count),
      rupture_stock: Number(ruptureStock.rows[0].count),
      activites_recentes: activitesRecentes.rows,
      derniers_mouvements: derniersMouvements.rows
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Erreur dashboard stats" });
  }
});

app.listen(5050, () => {
  console.log("Backend sécurisé démarré sur le port 5050");
});

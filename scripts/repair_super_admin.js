const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
require("dotenv").config();

const SUPER_ADMIN_EMAIL = "Diallogcif@gmail.com";
const normalizedEmail = SUPER_ADMIN_EMAIL.toLowerCase();
const password = process.env.SUPER_ADMIN_PASSWORD;

if (!password || password.length < 8) {
  console.error("SUPER_ADMIN_PASSWORD obligatoire (minimum 8 caractères).");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

(async () => {
  const hashedPassword = await bcrypt.hash(password, 12);

  const existing = await pool.query(
    "SELECT id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1",
    [normalizedEmail]
  );

  let result;

  if (existing.rows[0]) {
    result = await pool.query(
      `UPDATE users
       SET email=$1,
           password=$2,
           role='super_admin',
           is_super_admin=true,
           is_active=true,
           company_id=NULL,
           force_password_change=true,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=$3
       RETURNING id, email, role, is_super_admin, is_active, company_id`,
      [normalizedEmail, hashedPassword, existing.rows[0].id]
    );
  } else {
    result = await pool.query(
      `INSERT INTO users
       (fullname, email, password, role, company_id, is_super_admin, is_active,
        force_password_change, badge_code)
       VALUES ($1,$2,$3,'super_admin',NULL,true,true,true,$4)
       RETURNING id, email, role, is_super_admin, is_active, company_id`,
      [
        "Super Admin Triangle WMS Pro",
        normalizedEmail,
        hashedPassword,
        `TRIANGLE-SUPER-ADMIN-${Date.now()}`,
      ]
    );
  }

  console.log(JSON.stringify({
    message: "Super Admin principal réparé.",
    user: result.rows[0],
  }, null, 2));
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

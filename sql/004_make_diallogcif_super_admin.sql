-- Triangle WMS Pro - Donner le statut super admin au compte principal

UPDATE users
SET
  role = 'super_admin',
  is_super_admin = true,
  is_active = true
WHERE LOWER(email) = 'diallogcif@gmail.com';

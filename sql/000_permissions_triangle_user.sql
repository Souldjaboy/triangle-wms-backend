-- Triangle WMS Pro - Permissions PostgreSQL production
-- À exécuter avec l'utilisateur postgres, pas avec triangle_user.
-- Exemple :
-- sudo -u postgres psql -d triangle_wms -f sql/000_permissions_triangle_user.sql

ALTER DATABASE triangle_wms OWNER TO triangle_user;
ALTER SCHEMA public OWNER TO triangle_user;

GRANT CONNECT ON DATABASE triangle_wms TO triangle_user;
GRANT USAGE, CREATE ON SCHEMA public TO triangle_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO triangle_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO triangle_user;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO triangle_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT ALL PRIVILEGES ON TABLES TO triangle_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT ALL PRIVILEGES ON SEQUENCES TO triangle_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT ALL PRIVILEGES ON FUNCTIONS TO triangle_user;

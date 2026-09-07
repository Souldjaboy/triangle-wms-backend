BEGIN;

/*
 * Le prix du ciment doit être strictement positif.
 *
 * Le transport reste facultatif :
 * transport_price peut rester à 0.
 *
 * Aucun UPDATE d'historique n'est effectué.
 */

DO $$
BEGIN

  /*
   * Vérification avant création des contraintes.
   */
  IF EXISTS (
    SELECT 1
    FROM cement_prices
    WHERE cement_price IS NULL
       OR cement_price <= 0
  ) THEN
    RAISE EXCEPTION
      'Impossible d''activer la règle : un tarif ciment <= 0 existe.';
  END IF;


  IF EXISTS (
    SELECT 1
    FROM cement_sales
    WHERE unit_price IS NULL
       OR unit_price <= 0
  ) THEN
    RAISE EXCEPTION
      'Impossible d''activer la règle : une vente ciment possède un prix <= 0.';
  END IF;


  IF EXISTS (
    SELECT 1
    FROM cement_proforma_lines
    WHERE UPPER(COALESCE(line_type,''))='CIMENT'
      AND (
        unit_price IS NULL
        OR unit_price <= 0
      )
  ) THEN
    RAISE EXCEPTION
      'Impossible d''activer la règle : une ligne ciment de proforma possède un prix <= 0.';
  END IF;

END
$$;


/*
 * TARIFS
 */
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname='cement_prices_cement_price_positive_chk'
  ) THEN
    ALTER TABLE cement_prices
      ADD CONSTRAINT cement_prices_cement_price_positive_chk
      CHECK (cement_price > 0);
  END IF;
END
$$;


/*
 * VENTES
 */
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname='cement_sales_unit_price_positive_chk'
  ) THEN
    ALTER TABLE cement_sales
      ADD CONSTRAINT cement_sales_unit_price_positive_chk
      CHECK (unit_price > 0);
  END IF;
END
$$;


/*
 * PROFORMAS :
 * seule une ligne de type CIMENT doit obligatoirement
 * avoir un prix strictement positif.
 */
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname='cement_proforma_cement_price_positive_chk'
  ) THEN
    ALTER TABLE cement_proforma_lines
      ADD CONSTRAINT cement_proforma_cement_price_positive_chk
      CHECK (
        UPPER(COALESCE(line_type,'')) <> 'CIMENT'
        OR unit_price > 0
      );
  END IF;
END
$$;


/*
 * Le transport reste explicitement autorisé à zéro.
 */
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname='cement_sales_transport_nonnegative_chk'
  ) THEN
    ALTER TABLE cement_sales
      ADD CONSTRAINT cement_sales_transport_nonnegative_chk
      CHECK (transport_price >= 0);
  END IF;
END
$$;


COMMIT;

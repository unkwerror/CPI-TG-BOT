CREATE OR REPLACE FUNCTION "bootstrap_default_wallet_for_user"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  selected_program_id uuid;
  selected_season_id uuid;
  selected_welcome_amount bigint;
  welcome_account_id uuid;
  user_account_id uuid;
  transaction_id uuid;
  welcome_balance_after bigint;
  user_balance_after bigint;
  welcome_key text;
BEGIN
  SELECT program."id", program."active_season_id", program."welcome_amount"
    INTO selected_program_id, selected_season_id, selected_welcome_amount
    FROM "point_programs" program
   WHERE program."is_default" = true
   FOR SHARE;

  IF selected_program_id IS NULL OR selected_season_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO "wallet_accounts" (
    "program_id", "season_id", "owner_kind", "user_id", "title", "balance", "allow_negative"
  ) VALUES (
    selected_program_id,
    selected_season_id,
    'user',
    NEW.id,
    COALESCE(
      NULLIF(BTRIM(NEW.full_name), ''),
      CASE WHEN NEW.telegram_username IS NOT NULL THEN '@' || NEW.telegram_username END,
      NEW.telegram_user_id::text,
      'Участник ' || LEFT(NEW.id::text, 8)
    ),
    0,
    false
  )
  ON CONFLICT DO NOTHING
  RETURNING "id" INTO user_account_id;

  IF user_account_id IS NULL THEN
    SELECT account."id"
      INTO user_account_id
      FROM "wallet_accounts" account
     WHERE account."program_id" = selected_program_id
       AND account."season_id" = selected_season_id
       AND account."user_id" = NEW.id;
  END IF;

  IF selected_welcome_amount = 0 THEN
    RETURN NEW;
  END IF;

  welcome_key := 'welcome:' || selected_program_id::text || ':' || NEW.id::text;
  INSERT INTO "ledger_transactions" (
    "program_id", "season_id", "kind", "idempotency_key", "subject_user_id", "reason", "metadata"
  ) VALUES (
    selected_program_id,
    selected_season_id,
    'welcome_grant',
    welcome_key,
    NEW.id,
    'Стартовое начисление',
    '{"bootstrap":true}'::jsonb
  )
  ON CONFLICT ("program_id", "idempotency_key") DO NOTHING
  RETURNING "id" INTO transaction_id;

  IF transaction_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT account."id"
    INTO welcome_account_id
    FROM "wallet_accounts" account
   WHERE account."program_id" = selected_program_id
     AND account."season_id" = selected_season_id
     AND account."system_key" = 'welcome'
   FOR UPDATE;

  IF welcome_account_id IS NULL THEN
    RAISE EXCEPTION 'Active point season has no WELCOME account'
      USING ERRCODE = '23514';
  END IF;

  UPDATE "wallet_accounts"
     SET "balance" = "balance" - selected_welcome_amount,
         "version" = "version" + 1,
         "updated_at" = now()
   WHERE "id" = welcome_account_id
  RETURNING "balance" INTO welcome_balance_after;

  UPDATE "wallet_accounts"
     SET "balance" = "balance" + selected_welcome_amount,
         "version" = "version" + 1,
         "updated_at" = now()
   WHERE "id" = user_account_id
  RETURNING "balance" INTO user_balance_after;

  INSERT INTO "ledger_entries" ("transaction_id", "account_id", "delta", "balance_after")
  VALUES
    (transaction_id, welcome_account_id, -selected_welcome_amount, welcome_balance_after),
    (transaction_id, user_account_id, selected_welcome_amount, user_balance_after);

  UPDATE "ledger_transactions"
     SET "sealed_at" = now()
   WHERE "id" = transaction_id;

  RETURN NEW;
END;
$$;

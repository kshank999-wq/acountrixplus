-- Phase 40: one bank account, one ledger account.
--
-- Until now `connectInstitution` pointed every account that was not a credit
-- card at `1000 Checking Account`, so a business with a current account and a
-- deposit account had one balance-sheet line covering both. The ledger could
-- report what the two of them held together and could not report what either
-- held, which is the only question a bank statement asks.
--
-- The unique constraint at the bottom is the fix. It cannot be added to books
-- that already have a sharing pair, so this repairs them first: each account
-- after the first gets a ledger account of its own, in the band its kind
-- belongs to, and the postings that provably belong to it move across.
--
-- "Provably" is doing real work. Only lines on entries derived from that
-- account's *own* bank transactions are moved. A payment somebody recorded
-- against an invoice, or a manual journal, names a chart account and nothing
-- else — nobody can now say which of the two real accounts the money went
-- into, so those lines stay where they are rather than being guessed at.

DO $$
DECLARE
  extra RECORD;
  band_from INT;
  band_to INT;
  band_type account_type;
  band_subtype TEXT;
  candidate INT;
  new_number TEXT;
  new_chart_id UUID;
  old_chart_id UUID;
  moved INT;
BEGIN
  FOR extra IN
    SELECT fa.id, fa.company_id, fa.kind::text AS kind, fa.name, fa.mask,
           fa.chart_account_id, fa.is_active
    FROM financial_accounts fa
    WHERE EXISTS (
      SELECT 1 FROM financial_accounts other
      WHERE other.company_id = fa.company_id
        AND other.chart_account_id = fa.chart_account_id
        AND (other.created_at, other.id) < (fa.created_at, fa.id)
    )
    ORDER BY fa.company_id, fa.created_at, fa.id
  LOOP
    -- Mirrors bandFor() in src/modules/banking/numbering.ts. Two copies of one
    -- rule, which is a cost; the alternative is a migration that cannot run
    -- without the application, which is a worse one.
    CASE extra.kind
      WHEN 'checking'    THEN band_from := 1000; band_to := 1009; band_type := 'asset';     band_subtype := 'bank';
      WHEN 'savings'     THEN band_from := 1010; band_to := 1039; band_type := 'asset';     band_subtype := 'bank';
      WHEN 'cash'        THEN band_from := 1050; band_to := 1069; band_type := 'asset';     band_subtype := 'cash';
      WHEN 'other'       THEN band_from := 1070; band_to := 1099; band_type := 'asset';     band_subtype := 'bank';
      WHEN 'credit_card' THEN band_from := 2100; band_to := 2139; band_type := 'liability'; band_subtype := 'credit_card';
      WHEN 'loan'        THEN band_from := 2400; band_to := 2439; band_type := 'liability'; band_subtype := 'long_term_liability';
      ELSE band_from := 1070; band_to := 1099; band_type := 'asset'; band_subtype := 'bank';
    END CASE;

    old_chart_id := extra.chart_account_id;
    new_number := NULL;
    new_chart_id := NULL;

    -- The standard chart already names the first of each kind — 1010 Savings
    -- Account, 2100 Credit Card. A deposit account whose ledger line is called
    -- "Savings Account" belongs on that one, not on a second line beside an
    -- empty one.
    --
    -- Only that one number, and only when it is genuinely free: no bank
    -- account on it and nothing ever posted to it. An account somebody created
    -- themselves at 1015 is theirs, and renaming an account that already
    -- carries a balance would relabel history.
    SELECT ca.id, ca.number INTO new_chart_id, new_number
    FROM chart_accounts ca
    WHERE ca.company_id = extra.company_id
      AND ca.number = band_from::text
      AND ca.is_active
      AND ca.id <> old_chart_id
      AND NOT EXISTS (SELECT 1 FROM financial_accounts fa WHERE fa.chart_account_id = ca.id)
      AND NOT EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.chart_account_id = ca.id)
    LIMIT 1;

    IF new_chart_id IS NULL THEN
      FOR candidate IN band_from..band_to LOOP
        IF NOT EXISTS (
          SELECT 1 FROM chart_accounts
          WHERE company_id = extra.company_id AND number = candidate::text
        ) THEN
          new_number := candidate::text;
          EXIT;
        END IF;
      END LOOP;

      IF new_number IS NULL THEN
        RAISE EXCEPTION
          'No free account number in % to % for "%" — split it by hand before migrating.',
          band_from, band_to, extra.name;
      END IF;

      INSERT INTO chart_accounts (company_id, number, name, type, subtype, is_system, is_active)
      VALUES (
        extra.company_id,
        new_number,
        CASE WHEN coalesce(extra.mask, '') = '' THEN extra.name
             ELSE extra.name || ' ••' || extra.mask END,
        band_type,
        band_subtype,
        false,
        extra.is_active
      )
      RETURNING id INTO new_chart_id;
    ELSE
      -- Reused. Rename it after the bank account, for the reason
      -- `ledgerNameFor` exists: one thing under two names is how somebody
      -- reconciles the wrong one.
      UPDATE chart_accounts
      SET name = CASE WHEN coalesce(extra.mask, '') = '' THEN extra.name
                      ELSE extra.name || ' ••' || extra.mask END
      WHERE id = new_chart_id;
    END IF;

    UPDATE financial_accounts SET chart_account_id = new_chart_id WHERE id = extra.id;

    -- Only what came from this account's own feed. Everything else stays.
    UPDATE journal_lines jl
    SET chart_account_id = new_chart_id
    FROM journal_entries je, bank_transactions bt
    WHERE jl.journal_entry_id = je.id
      AND jl.chart_account_id = old_chart_id
      AND je.source_type = 'bank_transaction'
      AND je.source_id = bt.id
      AND bt.financial_account_id = extra.id;

    GET DIAGNOSTICS moved = ROW_COUNT;

    RAISE NOTICE 'Split "%" onto account % — % posting(s) moved.',
      extra.name, new_number, moved;
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE "financial_accounts" ADD CONSTRAINT "financial_accounts_chart_account_unique" UNIQUE("company_id","chart_account_id");

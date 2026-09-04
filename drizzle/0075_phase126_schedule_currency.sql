-- Phase 126 — a recurring schedule can bill in a currency.
--
-- `createInvoice` has taken a currency since Phase 64 and the composer offers
-- the choice on screen, but `raiseInvoiceFor` never passed one and
-- `recurring_invoices` had no column to pass. So a European customer on a
-- monthly retainer got dollar invoices, or the schedule had to be switched off
-- and twelve invoices raised by hand.
--
-- Both columns are backfilled rather than defaulted blindly:
--
--   * a schedule takes its company's own currency, which is what every existing
--     schedule has in fact been billing in — this is a record of what already
--     happened, not a change to it;
--   * an occurrence takes the currency of the invoice it raised where it raised
--     one, and its schedule's otherwise. ADR 0125 called an occurrence's total
--     `unrecorded` precisely because neither was written down.
--
-- Nothing here changes an amount. Every row keeps the number it had; this only
-- writes down what that number was always denominated in.

ALTER TABLE recurring_invoices
  ADD COLUMN currency text;

UPDATE recurring_invoices r
   SET currency = c.currency
  FROM companies c
 WHERE c.id = r.company_id
   AND r.currency IS NULL;

ALTER TABLE recurring_invoices
  ALTER COLUMN currency SET NOT NULL,
  ALTER COLUMN currency SET DEFAULT 'USD';

ALTER TABLE recurring_invoice_occurrences
  ADD COLUMN currency text;

-- 1. What the raised invoice actually says. A fact rather than an intention.
UPDATE recurring_invoice_occurrences o
   SET currency = i.currency
  FROM invoices i
 WHERE i.id = o.invoice_id
   AND o.currency IS NULL;

-- 2. What the schedule will bill, for a period nobody has raised yet.
UPDATE recurring_invoice_occurrences o
   SET currency = r.currency
  FROM recurring_invoices r
 WHERE r.id = o.recurring_invoice_id
   AND o.currency IS NULL;

ALTER TABLE recurring_invoice_occurrences
  ALTER COLUMN currency SET NOT NULL,
  ALTER COLUMN currency SET DEFAULT 'USD';

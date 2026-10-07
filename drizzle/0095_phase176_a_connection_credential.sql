-- Phase 176: somewhere to keep a bank credential.
--
-- `BankProvider` has had four methods and one implementation since Phase 2, and
-- the comment on it says the point: "Swapping Plaid for another aggregator means
-- writing one new adapter." Writing the first real one found the gap that
-- comment could not: **there is nowhere to put the credential.**
--
-- ## What Plaid's flow actually needs
--
--   /link/token/create          -> link_token      short-lived, for the widget
--   (the widget)                -> public_token    short-lived, one use
--   /item/public_token/exchange -> access_token    durable, and the real secret
--                                  item_id
--
-- Every later call — accounts, transactions, balances — carries the
-- `access_token`. `bank_connections` stores `provider_item_id`, `sync_cursor`,
-- `institution_name` and `status`, and nothing that could hold it.
--
-- `ExchangeResult` returned `{ providerItemId, institutionName }`, so the token
-- had nowhere to go even in memory. The mock never noticed, because a mock has
-- no secret.
--
-- ## Encrypted, and why that is not optional here
--
-- An `access_token` is a long-lived bearer credential for somebody's bank
-- transaction history. §19 requires encryption of sensitive data at rest, and
-- this is the most sensitive single value the application will ever hold — a
-- leaked database without it is embarrassing, and with it is a disclosure of
-- the business's entire banking history.
--
-- So the column holds `modules/auth/secret-box` output, the same envelope that
-- protects TOTP seeds. The consequence is the one the deployment readiness
-- check already states for `ENCRYPTION_KEY`: rotating that key does not raise
-- an error about keys, it makes every stored credential undecryptable. For a
-- second factor that locks people out of their accounts; for a bank credential
-- it silently stops every sync. Generate once, keep it.
--
-- ## Nullable, because the mock has no credential
--
-- Not a default of empty string. A connection with no credential and a
-- connection with an empty one are different states, and the adapter that needs
-- one must be able to tell them apart — `plaid` refuses to sync without it and
-- says so, rather than calling Plaid with `access_token: ""` and reporting
-- whatever Plaid says about a malformed request.

ALTER TABLE bank_connections
  ADD COLUMN credential_cipher text;

COMMENT ON COLUMN bank_connections.credential_cipher IS
  'Provider credential, encrypted with modules/auth/secret-box. Null for adapters that need none (the mock). Never logged, never returned to a client.';

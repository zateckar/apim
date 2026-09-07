-- ---------------------------------------------------------------------------------------------
-- A subscription has two keys, and until now it had one date between them.
--
-- `key_rotated_at` was written by every rotation of either slot, so it answered "when was this
-- subscription last touched" and was read as "how old is the key" — by the attention rule, by the
-- dashboard, and by anybody looking at the number they produced. The two are not the same question
-- and the difference is the whole point of having two slots: rotating the secondary is exactly the
-- move that leaves the primary old, and it reset the only clock that was watching the primary.
-- An estate that rotated its secondary every month reported a key age of days while the key most
-- of its callers actually present had not been replaced since it was minted.
--
-- So each slot gets the date its *current* key was minted:
--
--   `primary_key_at`   — never null. A subscription cannot exist without a primary key.
--   `secondary_key_at` — null exactly when `secondary_key_enc` is null, which is the ordinary
--                        state until somebody rotates for the first time.
--
-- And each slot gets the moment it was retired, written by the job that enforces the policy:
--
--   `primary_key_expired_at`   — set when the key aged past `SUBSCRIPTION_KEY_EXPIRE_DAYS`,
--   `secondary_key_expired_at`   cleared again when that slot is rotated. A slot with this set is
--                                left out of the environment's configuration document, so the
--                                gateway — which has never heard of an expiry — simply does not
--                                know the key and answers 401.
--
-- There is a deliberate asymmetry between the *deadline* and the *expiring*. The deadline is not
-- stored: it is the minting date plus a policy read when the job runs, so an administrator who
-- changes the number changes it for the keys that already exist rather than only for the ones
-- minted afterwards. The expiring **is** stored, because it is an event rather than a policy —
-- it is what makes the configuration document a function of the database instead of a function of
-- the database and the wall clock, and it is what leaves a date to show the consumer and to write
-- into the audit log. `tls_exception` takes the other route, storing `expires_at` and filtering on
-- `now` at build time; that suits an exception granted with an end date agreed up front, and does
-- not suit a fleet-wide policy somebody may shorten.
--
-- `primary_key_enc` is NOT NULL and stays that way. Expiring a key does not destroy it — a slot
-- whose material was thrown away could not be described, only replaced.
--
-- Backfill: the best available truth for the minting dates is the existing single date, falling
-- back to when the subscription was created. That is right for whichever slot was rotated last and
-- generous to the other — it can understate a key's age but never overstate it, so the migration
-- cannot expire a key that a reading of the old data would have called current.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE subscription ADD COLUMN primary_key_at           TEXT;
ALTER TABLE subscription ADD COLUMN secondary_key_at         TEXT;
ALTER TABLE subscription ADD COLUMN primary_key_expired_at   TEXT;
ALTER TABLE subscription ADD COLUMN secondary_key_expired_at TEXT;

UPDATE subscription
   SET primary_key_at = COALESCE(key_rotated_at, created_at)
 WHERE primary_key_at IS NULL;

UPDATE subscription
   SET secondary_key_at = COALESCE(key_rotated_at, created_at)
 WHERE secondary_key_at IS NULL AND secondary_key_enc IS NOT NULL;

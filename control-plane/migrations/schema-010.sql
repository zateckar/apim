-- ---------------------------------------------------------------------------------------------
-- Body capture: an hour of an API's request and response bodies in the access log, and not a
-- minute more.
--
-- Every request through a gateway is logged — that is a compliance obligation and there is no
-- sampling anywhere in it — but a log line carries *about* a request, never the request. Bodies
-- are the exception, and they are the exception because a body is the one part of a call that
-- contains whatever the caller put in it: personal data, a customer's order, a claim. So the
-- default is off, and switching it on is a dated, audited, per-(resource, environment) act with a
-- reason attached, exactly like `tls_exception`.
--
-- The table is shaped after `tls_exception` deliberately, and takes the same two decisions:
--
--   `expires_at` is **stored** rather than derived, so it travels to the gateway inside the config
--   document as `route.logBodiesUntil` and the instance stops capturing on its own clock. A
--   gateway serving its last config through a control-plane outage therefore still closes the
--   window on time; nothing has to reach it for capture to end. This is the same reasoning
--   schema-009 gives for `tls_exception` taking this route while key expiry takes the other one:
--   a window agreed with an end date up front stores the date.
--
--   `revoked_at` rather than a DELETE. "Whose bodies were being written to the log index between
--   09:15 and 09:44 on the 3rd, and who asked for that" is the question this table exists to
--   answer, and a row that is gone answers nothing. Closing a window early sets the column.
--
-- There is no `max_bytes` column. The cap is 8 KiB, it is the gateway's constant, and a per-window
-- number would be a knob whose only use is making the cap larger.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE body_capture (
  id          TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  reason      TEXT NOT NULL,             -- the ticket and the symptom; read by whoever audits this
  opened_by   TEXT NOT NULL,
  opened_at   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT
);

-- The config build asks "is there a live window for this resource in this environment" once per
-- route per build, which is this index exactly.
CREATE INDEX body_capture_live ON body_capture(resource_id, environment, expires_at);

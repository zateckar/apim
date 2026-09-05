-- ---------------------------------------------------------------------------------------------
-- schema-006 renamed `team` to `application` but left the well-known development ids spelled
-- `team_…`, while the code in the same commit started writing `application_…`. On an existing
-- database `ensureDevDirectory` then inserted a *new* row whose id had never been seen and whose
-- name was already held by the surviving `team_platform` row, so boot died with
-- `UNIQUE constraint failed: application.name` before anything could say why (finding 1).
--
-- Renaming the id here rather than teaching the directory two spellings: two ids for one
-- application would leak into every URL, every audit subject and every session's claim list, and
-- the pair would have to be kept in step forever.
--
-- Written as a remap table so a further rename is one row, and so the whole thing is a no-op on a
-- database that never had the old ids (every fresh install).
-- ---------------------------------------------------------------------------------------------

CREATE TABLE application_id_remap (old TEXT PRIMARY KEY, new TEXT NOT NULL);
INSERT INTO application_id_remap (old, new) VALUES
  ('team_platform', 'application_platform'),
  ('team_orders',   'application_orders');

-- Only rows that actually need moving, and only when the destination is free: a database that has
-- already been repaired by hand must not be corrupted by repairing it twice.
DELETE FROM application_id_remap
 WHERE old NOT IN (SELECT id FROM application)
    OR new IN (SELECT id FROM application);

UPDATE membership        SET application_id = (SELECT new FROM application_id_remap WHERE old = application_id) WHERE application_id IN (SELECT old FROM application_id_remap);
UPDATE resource          SET application_id = (SELECT new FROM application_id_remap WHERE old = application_id) WHERE application_id IN (SELECT old FROM application_id_remap);
UPDATE product           SET application_id = (SELECT new FROM application_id_remap WHERE old = application_id) WHERE application_id IN (SELECT old FROM application_id_remap);
UPDATE certificate       SET application_id = (SELECT new FROM application_id_remap WHERE old = application_id) WHERE application_id IN (SELECT old FROM application_id_remap);
UPDATE subscription      SET application_id = (SELECT new FROM application_id_remap WHERE old = application_id) WHERE application_id IN (SELECT old FROM application_id_remap);
UPDATE operation         SET application_id = (SELECT new FROM application_id_remap WHERE old = application_id) WHERE application_id IN (SELECT old FROM application_id_remap);
UPDATE integration_event SET application_id = (SELECT new FROM application_id_remap WHERE old = application_id) WHERE application_id IN (SELECT old FROM application_id_remap);
UPDATE kafka_topic       SET application_id = (SELECT new FROM application_id_remap WHERE old = application_id) WHERE application_id IN (SELECT old FROM application_id_remap);
UPDATE kafka_access      SET application_id = (SELECT new FROM application_id_remap WHERE old = application_id) WHERE application_id IN (SELECT old FROM application_id_remap);
UPDATE kafka_message     SET application_id = (SELECT new FROM application_id_remap WHERE old = application_id) WHERE application_id IN (SELECT old FROM application_id_remap);
UPDATE application       SET id             = (SELECT new FROM application_id_remap WHERE old = id)             WHERE id             IN (SELECT old FROM application_id_remap);

-- A live session carries its applications as a JSON array of ids. Left alone it would hold ids
-- that no longer resolve, which reads as "you are in no application" rather than as an error.
UPDATE session SET applications_json =
  replace(replace(applications_json, '"team_platform"', '"application_platform"'), '"team_orders"', '"application_orders"')
 WHERE applications_json LIKE '%"team_platform"%' OR applications_json LIKE '%"team_orders"%';

DROP TABLE application_id_remap;

-- ---------------------------------------------------------------------------------------------
-- Domains (the catalogue's taxonomy).
--
-- Every published thing — REST, SOAP, MCP, A2A, and a Kafka topic — belongs to exactly one domain
-- and optionally to one sub-domain, and the domain is the first segment of the published path.
-- Nullable, and enforced above rather than here: a database predating this column holds resources
-- whose base path was chosen before domains existed, and rewriting those paths silently would
-- move URLs consumers are already calling. `domain IS NULL` therefore means "published before
-- domains", reads as a warning in the workspace, and is refused on the next save.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE resource ADD COLUMN domain     TEXT;
ALTER TABLE resource ADD COLUMN subdomain  TEXT;
ALTER TABLE kafka_topic ADD COLUMN domain    TEXT;
ALTER TABLE kafka_topic ADD COLUMN subdomain TEXT;

-- ---------------------------------------------------------------------------------------------
-- A gateway is the proxy, not the replica.
--
-- One `target` already means "one environment's gateway", and `gateway_instance` already means
-- "one replica of it". What was missing is the fact that makes the distinction visible: replicas
-- sit behind a TLS-terminating L7 proxy, and the proxy's hostname — never a replica's — is the
-- host in every API URL this portal shows a consumer.
--
-- `label` names the locality (cloud, on-prem) so two targets in one environment can be told apart
-- by something other than their adapter.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE target ADD COLUMN public_url TEXT;
ALTER TABLE target ADD COLUMN label      TEXT;

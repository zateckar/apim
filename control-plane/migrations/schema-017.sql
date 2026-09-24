-- ---------------------------------------------------------------------------------------------
-- v17 — a Kafka topic is a published thing with a name built from the convention, a size and a
-- schema of any of its three types; access to it is granted to a principal, one operation at a time
-- (kafka-workspace, kafka-playground).
--
-- Until now a topic was a free-typed name, a partition count and, for a JSON topic only, a schema;
-- and access was one row per application — which is not what a broker enforces. A broker binds an
-- ACL to a *principal* (a client certificate's DN, or an OAuth client id), grants READ and WRITE
-- separately, and gives a reader a consumer group. The table held none of those facts, so the
-- screen could not say who a consumer actually is or which group it reads through.
--
-- A topic row is still one environment's: staging it to the next stage of the chain writes a
-- second row under the same name, the way the broker holds one topic per cluster.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE kafka_topic ADD COLUMN display_name        TEXT;     -- the title; the name is built from it
ALTER TABLE kafka_topic ADD COLUMN replication         INTEGER NOT NULL DEFAULT 2;
ALTER TABLE kafka_topic ADD COLUMN retention_days      INTEGER;  -- NULL: the broker's default
ALTER TABLE kafka_topic ADD COLUMN min_insync_replicas INTEGER;  -- NULL: the broker's default
ALTER TABLE kafka_topic ADD COLUMN compatibility       TEXT;     -- BACKWARD | FORWARD | FULL | NONE | NULL
ALTER TABLE kafka_topic ADD COLUMN schema_text         TEXT;     -- the definition of an Avro or Protobuf topic
ALTER TABLE kafka_topic ADD COLUMN schema_version      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kafka_topic ADD COLUMN wiki_link           TEXT;

-- A schema that was already there is the subject's first version.
UPDATE kafka_topic SET schema_version = 1 WHERE schema_json IS NOT NULL;

-- One row per operation. A row written before this carried "may produce and consume" for its
-- application with no principal behind it; it is kept as the READ it most resembles, with no
-- principal, and the portal says it was granted before principals existed rather than inventing one.
ALTER TABLE kafka_access ADD COLUMN principal  TEXT;              -- a DN (mtls) or a client id (oauth)
ALTER TABLE kafka_access ADD COLUMN auth_type  TEXT;              -- 'mtls' | 'oauth'
ALTER TABLE kafka_access ADD COLUMN operation  TEXT NOT NULL DEFAULT 'read';  -- read | write | describe | delete
ALTER TABLE kafka_access ADD COLUMN group_id   TEXT;              -- a READ grant's consumer group
ALTER TABLE kafka_access ADD COLUMN request_id TEXT;              -- rows asked for together are decided together
UPDATE kafka_access SET request_id = id WHERE request_id IS NULL;

-- Live access is unique per principal and operation now, not per application: one application
-- holds a grant for each client it runs.
DROP INDEX kafka_access_current;
CREATE UNIQUE INDEX kafka_access_current
  ON kafka_access(topic_id, application_id, COALESCE(principal, ''), operation)
  WHERE state IN ('pending','activating','active','revoking');
CREATE INDEX kafka_access_request ON kafka_access(request_id);

-- A record lands on a partition at an offset of that partition, with an optional key and headers.
-- The row id kept being the offset for the records already there, which is increasing and unique.
ALTER TABLE kafka_message ADD COLUMN partition_no INTEGER NOT NULL DEFAULT 0;
ALTER TABLE kafka_message ADD COLUMN msg_offset   INTEGER;
ALTER TABLE kafka_message ADD COLUMN msg_key      TEXT;
ALTER TABLE kafka_message ADD COLUMN headers_json TEXT;
UPDATE kafka_message SET msg_offset = id WHERE msg_offset IS NULL;

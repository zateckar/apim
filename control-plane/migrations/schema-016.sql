-- ---------------------------------------------------------------------------------------------
-- v16 — a Kafka topic can be produced to over HTTP, through an API generated from its schema.
--
-- Until now the "Kafka REST proxy" was a flag on the topic and a curl command pointed at the
-- portal's own playground endpoint, authenticated by a session cookie. It never went through a
-- gateway, so nothing a gateway does — a subscription key, validation, a rate limit, telemetry —
-- applied to it, and a consumer could not be given one (kafka-rest-proxy).
--
-- It is two APIs now, both ordinary resources on the ordinary spine:
--
--   the shared Kafka proxy   one per estate, owned by the platform itself, whose backend is the
--                            Confluent REST Proxy and whose `kafkaProduce` unit writes the v3
--                            produce call. `platform_role = 'kafka-proxy'` names it.
--   a topic's API            one per topic, owned by the topic's application, generated from the
--                            topic's JSON schema. Its backend is the shared proxy's address, and it
--                            presents the topic's client certificate and the platform's own key to
--                            it. `kafka_topic` names the topic it fronts, by name, because a
--                            resource spans the chain and a topic row is one environment's.
--
-- `proxy_enabled` is left in place and no longer read: dropping a column in SQLite is a table
-- rebuild, and the flag's replacement is the existence of the topic's API rather than a new value.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE kafka_topic ADD COLUMN schema_type TEXT;        -- 'json' | 'avro' | 'protobuf' | NULL
ALTER TABLE kafka_topic ADD COLUMN schema_json TEXT;        -- the JSON Schema, when schema_type = 'json'
ALTER TABLE kafka_topic ADD COLUMN certificate_id TEXT REFERENCES certificate(id) ON DELETE SET NULL;

ALTER TABLE resource ADD COLUMN kafka_topic   TEXT;         -- the topic name a topic's API fronts
ALTER TABLE resource ADD COLUMN platform_role TEXT;         -- 'kafka-proxy' for the shared proxy

-- The platform's own application. Nobody is a member of it, so under the one authorization rule
-- only an administrator may change what it owns — which is exactly who should change the shared
-- proxy every topic's API depends on.
INSERT OR IGNORE INTO application (id, name, created_at, description)
VALUES ('platform', 'Integration Portal', '2026-09-23T00:00:00.000Z',
        'The portal itself. Owns what every application shares, like the Kafka proxy.');

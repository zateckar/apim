-- Unify publishing and consuming identities without a runtime alias layer.
-- Existing consumers retain their IDs and memberships; existing publishing owners
-- become applications. Colliding IDs/names deliberately fail atomically for review.
ALTER TABLE application RENAME TO consumer_application;
ALTER TABLE team RENAME TO application;
ALTER TABLE application ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE application ADD COLUMN description TEXT NOT NULL DEFAULT '';
INSERT INTO application (id, name, created_at)
SELECT id, name, created_at FROM consumer_application;
INSERT INTO membership (team_id, user_id, source, granted_by, granted_at)
SELECT a.id, m.user_id, m.source, m.granted_by, m.granted_at
FROM consumer_application a JOIN membership m ON m.team_id = a.team_id;
ALTER TABLE membership RENAME COLUMN team_id TO application_id;
ALTER TABLE resource RENAME COLUMN team_id TO application_id;
ALTER TABLE product RENAME COLUMN team_id TO application_id;
ALTER TABLE certificate RENAME COLUMN team_id TO application_id;
ALTER TABLE session RENAME COLUMN teams_json TO applications_json;
CREATE TABLE subscription_new (
 id TEXT PRIMARY KEY,
 product_id TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
 application_id TEXT NOT NULL REFERENCES application(id) ON DELETE CASCADE,
 environment TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending',
 primary_key_enc TEXT NOT NULL,
 secondary_key_enc TEXT,
 key_rotated_at TEXT,
 created_at TEXT NOT NULL,
 purpose TEXT NOT NULL DEFAULT '',
 requested_by TEXT,
 decision_by TEXT,
 decision_at TEXT,
 decision_reason TEXT
);
INSERT INTO subscription_new (id,product_id,application_id,environment,state,primary_key_enc,secondary_key_enc,key_rotated_at,created_at)
SELECT id,product_id,application_id,environment,state,primary_key_enc,secondary_key_enc,key_rotated_at,created_at FROM subscription;
DROP TABLE subscription;
ALTER TABLE subscription_new RENAME TO subscription;
CREATE UNIQUE INDEX subscription_current ON subscription(product_id,application_id,environment) WHERE state IN ('pending','activating','active','revoking');
DROP TABLE consumer_application;

CREATE TABLE operation (
 id TEXT PRIMARY KEY,
 application_id TEXT NOT NULL REFERENCES application(id),
 actor TEXT NOT NULL,
 kind TEXT NOT NULL,
 resource_id TEXT,
 environment TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued',
 input_json TEXT NOT NULL,
 result_json TEXT,
 error TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX operation_pending ON operation(state, next_attempt_at);
CREATE TABLE integration_event (
 id TEXT PRIMARY KEY,
 application_id TEXT NOT NULL REFERENCES application(id),
 integration TEXT NOT NULL,
 kind TEXT NOT NULL,
 subject TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued',
 payload_json TEXT NOT NULL,
 result_json TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(integration,kind,subject)
);
CREATE TABLE kafka_topic (
 id TEXT PRIMARY KEY,
 application_id TEXT NOT NULL REFERENCES application(id),
 environment TEXT NOT NULL,
 name TEXT NOT NULL,
 partitions INTEGER NOT NULL DEFAULT 3,
 description TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL DEFAULT 'provisioning',
 proxy_enabled INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 UNIQUE(environment,name)
);
CREATE TABLE kafka_access (
 id TEXT PRIMARY KEY,
 topic_id TEXT NOT NULL REFERENCES kafka_topic(id),
 application_id TEXT NOT NULL REFERENCES application(id),
 purpose TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending',
 requested_by TEXT NOT NULL,
 decision_by TEXT,
 created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX kafka_access_current ON kafka_access(topic_id,application_id) WHERE state IN ('pending','activating','active','revoking');
CREATE TABLE kafka_message (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 topic_id TEXT NOT NULL REFERENCES kafka_topic(id),
 application_id TEXT NOT NULL REFERENCES application(id),
 value TEXT NOT NULL,
 created_at TEXT NOT NULL
);
ALTER TABLE job ADD COLUMN next_attempt_at TEXT;
CREATE TABLE environment_override (
 resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
 environment TEXT NOT NULL,
 policy_json TEXT NOT NULL,
 PRIMARY KEY(resource_id,environment)
);

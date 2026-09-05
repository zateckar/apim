-- ---------------------------------------------------------------------------------------------
-- An environment has gateways, plural.
--
-- Until now `target` carried `UNIQUE (environment, adapter)`, which read as "one gateway per
-- environment" — and with one adapter shipped, that is exactly what it meant. The estate this
-- portal is modelled on does not work that way: DEV is served by a managed gateway in Azure *and*
-- an on-premise gateway in Mladá Boleslav, and an API says which of them it is published on. The
-- selection is not cosmetic. A gateway must be told about the routes it serves and no others,
-- otherwise "published on the managed gateway" is a label rather than a fact.
--
-- So `target` gains an identity of its own:
--
--   `name`     — stable within the environment, and the same across environments for the same
--                gateway. It is what a publish carries through the promotion chain: "published on
--                `managed`" has to mean something in TEST as well as DEV, and a target id does not
--                survive the trip.
--   `category` — `managed` | `samb` | `other`, matching the estate's own vocabulary. It decides
--                nothing; it groups the list and picks the icon.
--   `intranet_url` — the second DNS name. One physical on-premise gateway answers on two names,
--                one reachable from the internet and one only from inside; they are two addresses
--                for one gateway, not two gateways, so publishing binds to the gateway and both
--                addresses appear.
--
-- `name` is backfilled from `label` where the label is already a clean slug, and from the adapter
-- otherwise, so a database that has only ever had `standalone` targets comes out with gateways
-- named `local` (the seeded label) or `standalone`, and TARGETS_FILE keeps matching them.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE target_v8 (
  id                TEXT PRIMARY KEY,
  environment       TEXT NOT NULL,
  name              TEXT NOT NULL,
  category          TEXT NOT NULL DEFAULT 'other',
  adapter           TEXT NOT NULL,
  config_json       TEXT NOT NULL DEFAULT '{}',
  enforce           INTEGER NOT NULL DEFAULT 1,
  paused            INTEGER NOT NULL DEFAULT 0,
  lease_holder      TEXT,
  lease_expires_at  TEXT,
  public_url        TEXT,
  intranet_url      TEXT,
  label             TEXT,
  UNIQUE (environment, name)
);

INSERT INTO target_v8
  (id, environment, name, category, adapter, config_json, enforce, paused,
   lease_holder, lease_expires_at, public_url, intranet_url, label)
SELECT id,
       environment,
       CASE
         WHEN label IS NOT NULL AND label <> '' AND label GLOB '[a-z0-9]*'
              AND NOT label GLOB '*[^a-z0-9-]*' THEN label
         ELSE adapter
       END,
       'other',
       adapter, config_json, enforce, paused,
       lease_holder, lease_expires_at, public_url, NULL, label
  FROM target;

DROP TABLE target;
ALTER TABLE target_v8 RENAME TO target;

-- ---------------------------------------------------------------------------------------------
-- Which gateways serve a route.
--
-- Keyed on (resource, environment) to match `route` and `binding`: the same API can be on both
-- gateways in DEV and only the managed one in PROD, because that is a promotion decision like any
-- other. Rows are written by the reconciler from the publish snapshot, so they cannot drift from
-- the route they qualify.
--
-- Backfilled to every gateway the environment already has, because that is what "published in
-- DEV" meant when the row was written and narrowing it here would silently take routes off a
-- gateway that is currently serving them. A gateway added *later* starts empty instead: an API is
-- opted on to a new locality by someone who decided it belongs there.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE route_gateway (
  resource_id TEXT NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  target_id   TEXT NOT NULL REFERENCES target(id) ON DELETE CASCADE,
  PRIMARY KEY (resource_id, environment, target_id)
);

CREATE INDEX route_gateway_by_target ON route_gateway (target_id);

INSERT INTO route_gateway (resource_id, environment, target_id)
SELECT r.resource_id, r.environment, t.id
  FROM route r
  JOIN target t ON t.environment = r.environment;

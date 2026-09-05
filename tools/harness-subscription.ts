import type { App, Router } from "../control-plane/src/router.ts";
import { dispatch } from "../control-plane/src/router.ts";
import { runIntegrationEvents } from "../control-plane/src/integrations.ts";
import { runOperations } from "../control-plane/src/operations.ts";
import { buildConfig } from "../control-plane/src/config-build.ts";
import { CONFIG_VERSION } from "../shared/config-doc.ts";
import type { SeededInstance } from "../control-plane/src/seed.ts";

/** Benchmark bootstrap: exercise approval and simulate fleet acknowledgment before measuring traffic. */
export async function provisionHarnessSubscription(
  app: App,
  router: Router,
  consumer: string,
  publisher: string,
  productId: string,
  instances: SeededInstance[],
) {
  const call = async (
    path: string,
    body: unknown,
    cookie?: string,
    token?: string,
  ) => {
    const response = await dispatch(
      app,
      router,
      new Request(`${app.config.publicUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: app.config.publicUrl,
          ...(cookie ? { cookie } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
    if (!response.ok)
      throw new Error(
        `Benchmark provisioning ${path}: ${await response.text()}`,
      );
    return response.json();
  };
  const subscription = await call(
    "/api/subscriptions",
    {
      applicationId: "application_orders",
      productId,
      environment: "dev",
      purpose: "Benchmark traffic",
    },
    consumer,
  );
  runIntegrationEvents(app);
  const event = app.db
    .query<{ id: string }, [string]>(
      "SELECT id FROM integration_event WHERE subject=? AND integration='skonet'",
    )
    .get(subscription.id)!;
  await call(
    `/api/integration-events/${event.id}/decision`,
    { decision: "approved" },
    publisher,
  );
  const digest = buildConfig(
    app.db,
    app.kek,
    "dev",
    app.config.integrations,
  ).digest;
  for (const instance of instances.filter((i) => i.environment === "dev"))
    await call(
      "/api/gateway/poll",
      {
        wireVersion: CONFIG_VERSION,
        instance: {
          name: instance.name,
          runId: "benchmark-bootstrap",
          startedAt: new Date().toISOString(),
          activeDigest: digest,
          requestsTotal: 0,
          process: {},
        },
      },
      undefined,
      instance.token,
    );
  runOperations(app);
  return (
    await call(`/api/subscriptions/${subscription.id}/reveal`, {}, consumer)
  ).primaryKey as string;
}

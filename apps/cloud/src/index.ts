import { createCloudApp, runScheduledGarbageCollection } from "./app.js";
import { createCloudServices, type StatecaseEnvironment } from "./bindings.js";

export { VaultCoordinator } from "./bindings.js";

export default {
  async fetch(request: Request, environment: StatecaseEnvironment, executionContext: ExecutionContext): Promise<Response> {
    return createCloudApp(createCloudServices(environment)).fetch(request, environment, executionContext);
  },
  scheduled(controller: ScheduledController, environment: StatecaseEnvironment, executionContext: ExecutionContext): void {
    executionContext.waitUntil(
      runScheduledGarbageCollection(createCloudServices(environment), controller.scheduledTime)
        .then((summary) => { console.info(JSON.stringify({ component: "retention", ...summary })); })
        .catch(() => { console.error(JSON.stringify({ component: "retention", outcome: "failed" })); }),
    );
  },
} satisfies ExportedHandler<StatecaseEnvironment>;

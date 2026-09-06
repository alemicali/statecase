import { createCloudApp } from "./app.js";
import { createCloudServices, type StatecaseEnvironment } from "./bindings.js";

export { VaultCoordinator } from "./bindings.js";

export default {
  async fetch(request: Request, environment: StatecaseEnvironment, executionContext: ExecutionContext): Promise<Response> {
    return createCloudApp(createCloudServices(environment)).fetch(request, environment, executionContext);
  },
} satisfies ExportedHandler<StatecaseEnvironment>;

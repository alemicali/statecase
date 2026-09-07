interface Env {
  BETTER_AUTH_SECRET: string;
  STATECASE_ALLOWED_EMAILS: string;
  STATECASE_GC_GRACE_DAYS: string;
  TEST_MIGRATIONS: D1Migration[];
}

declare namespace Cloudflare {
  interface Env {
    BETTER_AUTH_SECRET: string;
    STATECASE_ALLOWED_EMAILS: string;
    STATECASE_GC_GRACE_DAYS: string;
    TEST_MIGRATIONS: D1Migration[];
  }

  interface GlobalProps {
    mainModule: typeof import("./src/index.js");
    durableNamespaces: "VaultCoordinator";
  }
}

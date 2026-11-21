import type { D1Migration } from "cloudflare:test";
import type { Secrets } from "../src/env";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("../src/index");
    }
    interface Env extends Secrets {
      TEST_INTERNAL_MIGRATIONS: D1Migration[];
      TEST_CLIENT_MIGRATIONS: D1Migration[];
    }
  }
}

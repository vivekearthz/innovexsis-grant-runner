import { createFileRoute } from "@tanstack/react-router";
import masterPatch from "../../../../../MASTER_PATCH.md?raw";

// v70 SS1 - single version source: parsed from the canonical patch document.
const PRODUCT = process.env.SLAVE_PRODUCT_KEY ?? "innovexsisgrantrunner";
const AGENT_VERSION = 6;
const PATCH_NUMBER = Number(masterPatch.match(/^#\s*MASTER\s+PATCH\s+v(\d+)/im)?.[1] ?? 0);
const PATCH_VERSION = PATCH_NUMBER ? `v${PATCH_NUMBER}` : "unknown";

export const Route = createFileRoute("/api/public/portal/version")({
  server: {
    handlers: {
      GET: async () =>
        Response.json(
          {
            ok: PATCH_NUMBER > 0,
            portalKey: PRODUCT,
            role: "slave",
            agentVersion: AGENT_VERSION,
            patchVersion: PATCH_VERSION,
            patchVersionNumber: PATCH_NUMBER,
          },
          { headers: { "Cache-Control": "no-store" } },
        ),
    },
  },
});

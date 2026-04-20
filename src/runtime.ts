/**
 * Plugin runtime store — singleton that holds the PluginRuntime
 * injected by the OpenClaw gateway at startup.
 */

import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";

const store = createPluginRuntimeStore<PluginRuntime>({
  key: "odoo",
  errorMessage: "Odoo runtime not initialized",
});

export const setOdooRuntime = store.setRuntime;
export const getOdooRuntime = store.getRuntime;

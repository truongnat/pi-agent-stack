import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRedmineExtension } from "./src/extension.ts";

export default function (pi: ExtensionAPI): void {
  registerRedmineExtension(pi);
}

export * from "./src/client.ts";
export * from "./src/tools.ts";

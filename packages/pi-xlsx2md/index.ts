import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerXlsx2MdExtension } from "./src/extension.ts";

export default function (pi: ExtensionAPI): void {
  registerXlsx2MdExtension(pi);
}

export * from "./src/cli.ts";
export * from "./src/tools.ts";

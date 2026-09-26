import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPersonaExtension } from "./src/extension.ts";

export default function (pi: ExtensionAPI) {
  createPersonaExtension(pi);
}

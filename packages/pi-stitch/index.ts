import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerStitchExtension } from "./src/extension.ts";

export default function (pi: ExtensionAPI): void {
  registerStitchExtension(pi);
}

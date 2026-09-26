import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerStitchExtension } from "./src/extension.ts";

export * from "./src/tokens.ts";
export * from "./src/transformer.ts";

export default function (pi: ExtensionAPI): void {
  registerStitchExtension(pi);
}

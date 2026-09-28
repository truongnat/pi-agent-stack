import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { redmineGetIssueTool, redmineSearchIssuesTool } from "./tools.ts";

export function registerRedmineExtension(pi: ExtensionAPI): void {
  pi.registerTool(redmineGetIssueTool);
  pi.registerTool(redmineSearchIssuesTool);
}

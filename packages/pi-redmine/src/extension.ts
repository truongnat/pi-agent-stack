import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  addCommentTool,
  getIssueTool,
  listIssuesTool,
  logTimeTool,
} from "./tools.ts";

export function registerRedmineExtension(pi: ExtensionAPI): void {
  pi.registerTool(getIssueTool);
  pi.registerTool(listIssuesTool);
  pi.registerTool(addCommentTool);
  pi.registerTool(logTimeTool);
}

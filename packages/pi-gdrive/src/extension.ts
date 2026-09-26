import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  gdriveDownloadTool,
  gdriveInfoTool,
  gdriveSearchTool,
} from "./tools.ts";

export function registerGDriveExtension(pi: ExtensionAPI): void {
  pi.registerTool(gdriveSearchTool);
  pi.registerTool(gdriveDownloadTool);
  pi.registerTool(gdriveInfoTool);
}

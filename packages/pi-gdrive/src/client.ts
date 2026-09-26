import { setDefaultResultOrder } from "node:dns";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

// Ensure IPv4 first to prevent IPv6 connect timeouts
try {
  setDefaultResultOrder("ipv4first");
} catch {
  // ignore if not supported in runtime
}

const DEFAULT_GDRIVE_DIR = join(homedir(), ".cursor", "mcp-gdrive");
const DEFAULT_OAUTH_KEYS = join(DEFAULT_GDRIVE_DIR, "gcp-oauth.keys.json");
const DEFAULT_CREDS_FILE = join(
  DEFAULT_GDRIVE_DIR,
  ".gdrive-server-credentials.json",
);

export interface GDriveConfig {
  oauthKeysPath?: string;
  credentialsPath?: string;
}

export interface GDriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
  parents?: string[];
}

interface OAuthCredentials {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expiry_date?: number;
  scope?: string;
}

interface OAuthClientKeys {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
}

export class GDriveClient {
  private oauthKeysPath: string;
  private credentialsPath: string;

  constructor(config?: GDriveConfig) {
    this.oauthKeysPath = config?.oauthKeysPath || DEFAULT_OAUTH_KEYS;
    this.credentialsPath = config?.credentialsPath || DEFAULT_CREDS_FILE;
  }

  private loadClientKeys(): OAuthClientKeys {
    if (!existsSync(this.oauthKeysPath)) {
      throw new Error(
        `Google Drive OAuth keys not found at ${this.oauthKeysPath}`,
      );
    }
    const raw = JSON.parse(readFileSync(this.oauthKeysPath, "utf8"));
    const block = raw.installed || raw.web || raw;
    if (!block.client_id || !block.client_secret) {
      throw new Error(
        `Invalid OAuth keys in ${this.oauthKeysPath}: missing client_id or client_secret`,
      );
    }
    return {
      client_id: block.client_id,
      client_secret: block.client_secret,
    };
  }

  private loadCredentials(): OAuthCredentials {
    if (!existsSync(this.credentialsPath)) {
      throw new Error(
        `Google Drive credentials token not found at ${this.credentialsPath}. Please run auth setup once.`,
      );
    }
    return JSON.parse(readFileSync(this.credentialsPath, "utf8"));
  }

  private saveCredentials(creds: OAuthCredentials): void {
    mkdirSync(dirname(this.credentialsPath), { recursive: true });
    writeFileSync(this.credentialsPath, JSON.stringify(creds, null, 2), "utf8");
  }

  public async getAccessToken(): Promise<string> {
    const creds = this.loadCredentials();
    const now = Date.now();

    if (
      creds.access_token &&
      creds.expiry_date &&
      now < creds.expiry_date - 60_000
    ) {
      return creds.access_token;
    }

    if (!creds.refresh_token) {
      if (creds.access_token) return creds.access_token;
      throw new Error(`No refresh_token found in ${this.credentialsPath}`);
    }

    const keys = this.loadClientKeys();
    const body = new URLSearchParams({
      client_id: keys.client_id,
      client_secret: keys.client_secret,
      refresh_token: creds.refresh_token,
      grant_type: "refresh_token",
    }).toString();

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!res.ok || !data.access_token) {
      throw new Error(
        `Failed to refresh Google Drive access token: ${data.error_description || data.error || res.statusText}`,
      );
    }

    creds.access_token = data.access_token;
    if (data.expires_in) {
      creds.expiry_date = Date.now() + data.expires_in * 1000;
    }
    this.saveCredentials(creds);
    return creds.access_token;
  }

  public async searchFiles(params: {
    query?: string;
    namePattern?: string;
    mimeType?: string;
    limit?: number;
    fields?: string;
  }): Promise<GDriveFile[]> {
    const token = await this.getAccessToken();
    const queryParts: string[] = ["trashed = false"];

    if (params.namePattern) {
      queryParts.push(
        `name contains '${params.namePattern.replace(/'/g, "\\'")}'`,
      );
    }
    if (params.mimeType) {
      if (params.mimeType === "folder") {
        queryParts.push("mimeType = 'application/vnd.google-apps.folder'");
      } else if (
        params.mimeType === "spreadsheet" ||
        params.mimeType === "excel"
      ) {
        queryParts.push(
          "(mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')",
        );
      } else if (params.mimeType === "document" || params.mimeType === "word") {
        queryParts.push(
          "(mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')",
        );
      } else {
        queryParts.push(`mimeType = '${params.mimeType.replace(/'/g, "\\'")}'`);
      }
    }
    if (params.query) {
      const escapedQuery = params.query.replaceAll("'", "\\'");
      if (
        params.query.includes("=") ||
        params.query.includes("contains") ||
        params.query.includes("and") ||
        params.query.includes("or")
      ) {
        queryParts.push(`(${params.query})`);
      } else {
        queryParts.push(
          `(name contains '${escapedQuery}' or fullText contains '${escapedQuery}')`,
        );
      }
    }

    const q = encodeURIComponent(queryParts.join(" and "));
    const fields = encodeURIComponent(
      params.fields ||
        "files(id, name, mimeType, size, modifiedTime, webViewLink, parents)",
    );
    const pageSize = Math.min(params.limit ?? 15, 100);

    const url = `https://www.googleapis.com/drive/v3/files?q=${q}&pageSize=${pageSize}&fields=${fields}&orderBy=modifiedTime desc`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = (await res.json()) as {
      files?: GDriveFile[];
      error?: { message: string };
    };
    if (!res.ok) {
      throw new Error(
        `Google Drive API error (${res.status}): ${data.error?.message || res.statusText}`,
      );
    }

    return data.files || [];
  }

  public async getFileMetadata(fileId: string): Promise<GDriveFile> {
    const token = await this.getAccessToken();
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType,size,modifiedTime,webViewLink,parents`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = (await res.json()) as GDriveFile & {
      error?: { message: string };
    };
    if (!res.ok) {
      throw new Error(
        `Google Drive API error (${res.status}): ${data.error?.message || res.statusText}`,
      );
    }

    return data;
  }

  public async downloadFile(
    fileId: string,
    destinationPath: string,
  ): Promise<{ path: string; bytes: number }> {
    const token = await this.getAccessToken();
    const meta = await this.getFileMetadata(fileId);

    mkdirSync(dirname(destinationPath), { recursive: true });

    let downloadUrl: string;
    if (meta.mimeType === "application/vnd.google-apps.spreadsheet") {
      downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`;
    } else if (meta.mimeType === "application/vnd.google-apps.document") {
      downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=application/vnd.openxmlformats-officedocument.wordprocessingml.document`;
    } else {
      downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    }

    const res = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => res.statusText);
      throw new Error(
        `Failed to download file ${fileId} (${res.status}): ${errText}`,
      );
    }

    const nodeStream = Readable.fromWeb(res.body as any);
    const fileStream = createWriteStream(destinationPath);
    await pipeline(nodeStream, fileStream);

    const stats = existsSync(destinationPath)
      ? readFileSync(destinationPath).byteLength
      : 0;
    return { path: destinationPath, bytes: stats };
  }
}

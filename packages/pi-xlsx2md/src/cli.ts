import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ConvertOptions {
  inputPath: string;
  outputPath?: string | undefined;
  sheet?: string | string[] | undefined;
  raw?: boolean | undefined;
  noMarkup?: boolean | undefined;
  keepXlsx?: string | undefined;
  metaPath?: string | undefined;
  quiet?: boolean | undefined;
}

export interface DiffOptions {
  basePath: string;
  otherPath: string;
  outputPath?: string | undefined;
  metaPath?: string | undefined;
  sheet?: string | string[] | undefined;
  quiet?: boolean | undefined;
}

export interface Xlsx2MdResult {
  success: boolean;
  markdown?: string | undefined;
  stats: string;
  outputPath?: string | undefined;
  metaPath?: string | undefined;
  meta?: Record<string, unknown> | undefined;
  error?: string | undefined;
}

function findBinary(): string {
  // 1. Check PATH
  return "xlsx2md";
}

export class Xlsx2MdRunner {
  private binary: string;

  constructor(binaryPath = findBinary()) {
    this.binary = binaryPath;
  }

  public async convert(options: ConvertOptions): Promise<Xlsx2MdResult> {
    if (!existsSync(options.inputPath)) {
      throw new Error(`File not found: ${options.inputPath}`);
    }

    const args: string[] = [];

    if (options.outputPath) {
      args.push("-o", options.outputPath);
    }
    if (options.metaPath) {
      args.push("--meta", options.metaPath);
    }
    if (options.sheet) {
      const sheets = Array.isArray(options.sheet)
        ? options.sheet
        : [options.sheet];
      for (const s of sheets) {
        args.push("--sheet", s);
      }
    }
    if (options.raw) {
      args.push("--raw");
    }
    if (options.noMarkup) {
      args.push("--no-markup");
    }
    if (options.keepXlsx) {
      args.push("--keep-xlsx", options.keepXlsx);
    }
    if (options.quiet) {
      args.push("-q");
    }

    args.push(options.inputPath);

    try {
      const { stdout, stderr } = await execFileAsync(this.binary, args, {
        maxBuffer: 20 * 1024 * 1024, // 20MB
      });

      let markdown = stdout;
      if (options.outputPath && existsSync(options.outputPath)) {
        markdown = readFileSync(options.outputPath, "utf8");
      }

      let meta: Record<string, unknown> | undefined;
      if (options.metaPath && existsSync(options.metaPath)) {
        try {
          meta = JSON.parse(readFileSync(options.metaPath, "utf8"));
        } catch {
          // ignore json parse error
        }
      }

      return {
        success: true,
        markdown,
        stats: stderr.trim(),
        outputPath: options.outputPath,
        metaPath: options.metaPath,
        meta,
      };
    } catch (err) {
      const e = err as Error & { stderr?: string; stdout?: string };
      return {
        success: false,
        stats: e.stderr || "",
        error: e.message,
      };
    }
  }

  public async diff(options: DiffOptions): Promise<Xlsx2MdResult> {
    if (!existsSync(options.basePath)) {
      throw new Error(`Base file not found: ${options.basePath}`);
    }
    if (!existsSync(options.otherPath)) {
      throw new Error(`Other file not found: ${options.otherPath}`);
    }

    const args: string[] = ["diff"];

    if (options.outputPath) {
      args.push("-o", options.outputPath);
    }
    if (options.metaPath) {
      args.push("--meta", options.metaPath);
    }
    if (options.sheet) {
      const sheets = Array.isArray(options.sheet)
        ? options.sheet
        : [options.sheet];
      for (const s of sheets) {
        args.push("--sheet", s);
      }
    }
    if (options.quiet) {
      args.push("-q");
    }

    args.push(options.basePath, options.otherPath);

    try {
      const { stdout, stderr } = await execFileAsync(this.binary, args, {
        maxBuffer: 20 * 1024 * 1024,
      });

      let markdown = stdout;
      if (options.outputPath && existsSync(options.outputPath)) {
        markdown = readFileSync(options.outputPath, "utf8");
      }

      let meta: Record<string, unknown> | undefined;
      if (options.metaPath && existsSync(options.metaPath)) {
        try {
          meta = JSON.parse(readFileSync(options.metaPath, "utf8"));
        } catch {
          // ignore json parse error
        }
      }

      return {
        success: true,
        markdown,
        stats: stderr.trim(),
        outputPath: options.outputPath,
        metaPath: options.metaPath,
        meta,
      };
    } catch (err) {
      const e = err as Error & { stderr?: string; stdout?: string };
      return {
        success: false,
        stats: e.stderr || "",
        error: e.message,
      };
    }
  }
}

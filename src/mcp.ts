import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { VERSION } from "./version.js";
import type { Commit } from "./git.js";
import { gradeCommit, type GradeResult } from "./grader.js";
import { loadPersona, type Persona } from "./personaLoader.js";
import {
  roastCommit,
  resolveConfigFromEnv,
  type RoasterConfig,
  type RoastResult,
} from "./roaster.js";
import { buildRewritePlan, type RewritePlan } from "./rewrite.js";
import { loadUserConfig, resolveDefaults } from "./config.js";

/**
 * Shape of the input args the MCP tools accept. We intentionally keep this
 * tiny and structural so we can validate without pulling zod in here — the
 * MCP SDK has its own version pinned and we don't want to fight it.
 */
interface RoastArgs {
  subject?: unknown;
  body?: unknown;
  persona?: unknown;
}

interface GradeArgs {
  subject?: unknown;
  body?: unknown;
}

interface RewriteArgs {
  sha?: unknown;
  force?: unknown;
}

function asString(v: unknown, field: string, required = true): string {
  if (v === undefined || v === null) {
    if (required) throw new Error(`Missing required field: ${field}`);
    return "";
  }
  if (typeof v !== "string") {
    throw new Error(`Field '${field}' must be a string, got ${typeof v}`);
  }
  return v;
}

function asBool(v: unknown, field: string): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`Field '${field}' must be a boolean`);
}

function toCommit(subject: string, body: string): Commit {
  return {
    sha: "",
    shortSha: "",
    subject,
    body,
    author: "",
    date: "",
  };
}

export interface BuildServerOptions {
  /** Override env for tests. */
  env?: NodeJS.ProcessEnv;
  /** Override roaster config (mainly for tests / fetch injection). */
  roasterConfig?: RoasterConfig;
  /** Resolver for personas — overridable in tests. */
  resolvePersona?: (name: string) => Promise<Persona>;
  /** Builder for rewrite plans — overridable in tests. */
  buildRewrite?: typeof buildRewritePlan;
}

interface ResolvedRoasterCtx {
  config: RoasterConfig;
  defaultPersona: string;
}

async function resolveCtx(env?: NodeJS.ProcessEnv): Promise<ResolvedRoasterCtx> {
  const userCfg = await loadUserConfig();
  const defaults = resolveDefaults(userCfg);
  const config = resolveConfigFromEnv(env ?? process.env, {
    model: defaults.model,
    apiBase: defaults.apiBase,
  });
  return { config, defaultPersona: defaults.persona };
}

export interface RoastToolResult {
  grade: GradeResult;
  roast: RoastResult;
  persona: string;
}

export async function handleRoast(
  args: RoastArgs,
  opts: BuildServerOptions = {}
): Promise<RoastToolResult> {
  const subject = asString(args.subject, "subject");
  const body = asString(args.body, "body", false);
  const ctx = await resolveCtx(opts.env);
  const personaName = (asString(args.persona, "persona", false) || ctx.defaultPersona).toLowerCase();
  const resolve = opts.resolvePersona ?? loadPersona;
  const persona = await resolve(personaName);
  const commit = toCommit(subject, body);
  const grade = gradeCommit(commit);
  const roast = await roastCommit(commit, persona, grade.grade, opts.roasterConfig ?? ctx.config);
  return { grade, roast, persona: persona.name };
}

export function handleGrade(args: GradeArgs): GradeResult {
  const subject = asString(args.subject, "subject");
  const body = asString(args.body, "body", false);
  return gradeCommit(toCommit(subject, body));
}

export async function handleRewrite(
  args: RewriteArgs,
  opts: BuildServerOptions = {}
): Promise<RewritePlan> {
  const sha = asString(args.sha, "sha");
  const force = asBool(args.force, "force");
  const build = opts.buildRewrite ?? buildRewritePlan;
  return build({ sha, force, env: opts.env });
}

const TOOL_DEFINITIONS = [
  {
    name: "roast",
    description:
      "Roast a commit message in the chosen persona's voice. Returns the letter grade, the roast text, and a Conventional Commits rewrite. Does not touch git.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Commit subject line." },
        body: { type: "string", description: "Optional commit body." },
        persona: {
          type: "string",
          description:
            "Persona name (e.g. linus, pm, bard, teacher). Defaults to the user's ~/.commit-roastrc default.",
        },
      },
      required: ["subject"],
      additionalProperties: false,
    },
  },
  {
    name: "grade",
    description:
      "Score a commit message against the Conventional Commits rubric. Returns letter grade, numeric score (0-100), reasons, and a canned roast string. Deterministic and offline.",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Commit subject line." },
        body: { type: "string", description: "Optional commit body." },
      },
      required: ["subject"],
      additionalProperties: false,
    },
  },
  {
    name: "rewrite",
    description:
      "Build a rewrite plan for a real commit in the current repo (resolved via simple-git). Returns the suggested Conventional Commits subject and the exact shell command to apply it (`git commit --amend` for HEAD, `git rebase --exec` snippet otherwise). Does NOT execute the command.",
    inputSchema: {
      type: "object",
      properties: {
        sha: { type: "string", description: "Commit SHA or ref (HEAD~1, branch name, etc)." },
        force: {
          type: "boolean",
          description: "Skip the dirty-working-tree check.",
          default: false,
        },
      },
      required: ["sha"],
      additionalProperties: false,
    },
  },
] as const;

function toToolResult(payload: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload as Record<string, unknown>,
  };
}

function toErrorResult(err: unknown): CallToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: msg }],
  };
}

/** Build (but do not connect) the MCP Server. */
export function buildMcpServer(opts: BuildServerOptions = {}): Server {
  const server = new Server(
    { name: "commit-roast", version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((t) => ({ ...t })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = (args ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "roast":
          return toToolResult(await handleRoast(a, opts));
        case "grade":
          return toToolResult(handleGrade(a));
        case "rewrite":
          return toToolResult(await handleRewrite(a, opts));
        default:
          return toErrorResult(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return toErrorResult(err);
    }
  });

  return server;
}

/** Start the MCP server over stdio. Blocks until the transport closes. */
export async function runMcpServer(opts: BuildServerOptions = {}): Promise<void> {
  const server = buildMcpServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Don't log anything to stdout — that's the MCP transport.
  process.stderr.write(`commit-roast MCP server v${VERSION} listening on stdio\n`);
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
}

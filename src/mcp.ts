// MCP at /mcp: JSON-RPC 2.0 over Streamable HTTP, answered as application/json. It speaks revision
// 2026-07-28 (server/discover, no session) and the handshake revisions through initialize. The tools act
// on the same store as REST, and tools/list is one cached body, so two calls are byte for byte equal.

import { sendJson, type Req } from './http.ts';
import { authed, makeRepo, mergePull, openPull } from './rest.ts';
import {
  VIEWER,
  addComment,
  createIssue,
  findRepo,
  issueJson,
  commentJson,
  pullJson,
  repoJson,
  repos,
  setIssueState,
  touchIssue,
  type Label,
  type Repo,
} from './store.ts';

type Json = Record<string, unknown>;

const REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'ghforge', title: 'ghforge GitHub-compatible forge', version: '1.0.0' };

interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
}

const OWNER = { type: 'string', description: 'Repository owner (user login)' };
const REPO = { type: 'string', description: 'Repository name' };

function schema(properties: Json, required: string[]): Json {
  return { type: 'object', properties, required, additionalProperties: false };
}

const TOOLS: Tool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: schema({ name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' }, autoInit: { type: 'boolean', description: 'Create an initial commit with a README' } }, ['name']),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: schema({ owner: OWNER, repo: REPO }, ['owner', 'repo']),
  },
  {
    name: 'list_repos',
    description: 'List the repositories of the authenticated user.',
    inputSchema: schema({}, []),
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: schema({ owner: OWNER, repo: REPO, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body (Markdown)' }, labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply' } }, ['owner', 'repo', 'title']),
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: schema({ owner: OWNER, repo: REPO, issue_number: { type: 'number', description: 'Issue number' } }, ['owner', 'repo', 'issue_number']),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, filtered by state.',
    inputSchema: schema({ owner: OWNER, repo: REPO, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state (default open)' } }, ['owner', 'repo']),
  },
  {
    name: 'update_issue',
    description: 'Update the title, body or state of an issue.',
    inputSchema: schema({ owner: OWNER, repo: REPO, issue_number: { type: 'number', description: 'Issue number' }, title: { type: 'string', description: 'New title' }, body: { type: 'string', description: 'New body' }, state: { type: 'string', enum: ['open', 'closed'], description: 'New state' } }, ['owner', 'repo', 'issue_number']),
  },
  {
    name: 'add_issue_comment',
    description: 'Add a comment to an issue or pull request.',
    inputSchema: schema({ owner: OWNER, repo: REPO, issue_number: { type: 'number', description: 'Issue number' }, body: { type: 'string', description: 'Comment text' } }, ['owner', 'repo', 'issue_number', 'body']),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: schema({ owner: OWNER, repo: REPO, title: { type: 'string', description: 'Pull request title' }, head: { type: 'string', description: 'Branch with the changes' }, base: { type: 'string', description: 'Branch to merge into' }, body: { type: 'string', description: 'Pull request description' } }, ['owner', 'repo', 'title', 'head', 'base']),
  },
  {
    name: 'get_pull_request',
    description: 'Get one pull request by its number.',
    inputSchema: schema({ owner: OWNER, repo: REPO, pull_number: { type: 'number', description: 'Pull request number' } }, ['owner', 'repo', 'pull_number']),
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, filtered by state.',
    inputSchema: schema({ owner: OWNER, repo: REPO, state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state (default open)' } }, ['owner', 'repo']),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: schema({ owner: OWNER, repo: REPO, pull_number: { type: 'number', description: 'Pull request number' }, merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method (default squash)' }, commit_title: { type: 'string', description: 'Title of the merge commit' } }, ['owner', 'repo', 'pull_number']),
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
const TOOLS_LIST = JSON.stringify({ tools: TOOLS });

class ToolError extends Error {}

function text(json: string): string {
  return JSON.stringify({ content: [{ type: 'text', text: json }], isError: false });
}

function toolError(message: string): string {
  return JSON.stringify({ content: [{ type: 'text', text: message }], isError: true });
}

function repoOf(args: Json): Repo {
  const owner = String(args.owner ?? '');
  const name = String(args.repo ?? '');
  const repo = findRepo(owner, name);
  if (repo === undefined) throw new ToolError(`Repository ${owner}/${name} not found`);
  return repo;
}

function numberArg(args: Json, key: string): number {
  const n = Number(args[key]);
  if (!Number.isInteger(n) || n < 1) throw new ToolError(`${key} must be a positive integer`);
  return n;
}

function runTool(name: string, args: Json): string {
  switch (name) {
    case 'create_repo': {
      const repo = makeRepo(String(args.name), typeof args.description === 'string' ? args.description : null, args.private === true, args.autoInit === true);
      if (repo === null) throw new ToolError(`Repository ${VIEWER.login}/${String(args.name)} already exists`);
      return repoJson(repo);
    }
    case 'get_repo':
      return repoJson(repoOf(args));
    case 'list_repos':
      return `[${[...repos.values()].map(repoJson).join(',')}]`;
    case 'create_issue': {
      const repo = repoOf(args);
      const labels: Label[] = [];
      if (Array.isArray(args.labels)) {
        for (const l of args.labels) {
          const label = repo.labels.get(String(l).toLowerCase());
          if (label === undefined) throw new ToolError(`Label ${String(l)} does not exist`);
          labels.push(label);
        }
      }
      return issueJson(createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : null, labels));
    }
    case 'get_issue': {
      const issue = repoOf(args).issues.get(numberArg(args, 'issue_number'));
      if (issue === undefined) throw new ToolError('Issue not found');
      return issueJson(issue);
    }
    case 'list_issues': {
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const list = [...repoOf(args).issues.values()].filter((i) => state === 'all' || i.state === state);
      return `[${list.map(issueJson).join(',')}]`;
    }
    case 'update_issue': {
      const issue = repoOf(args).issues.get(numberArg(args, 'issue_number'));
      if (issue === undefined) throw new ToolError('Issue not found');
      if (typeof args.title === 'string' && args.title !== '') issue.title = args.title;
      if (typeof args.body === 'string') issue.body = args.body;
      touchIssue(issue);
      if (args.state === 'open' || args.state === 'closed') setIssueState(issue, args.state, null);
      return issueJson(issue);
    }
    case 'add_issue_comment': {
      const repo = repoOf(args);
      const n = numberArg(args, 'issue_number');
      const target = repo.issues.get(n) ?? repo.pulls.get(n);
      if (target === undefined) throw new ToolError('Issue not found');
      return commentJson(addComment(target, String(args.body)));
    }
    case 'create_pull_request': {
      const pull = openPull(repoOf(args), String(args.title), typeof args.body === 'string' ? args.body : null, String(args.head), String(args.base));
      if (typeof pull === 'string') throw new ToolError(pull);
      return pullJson(pull);
    }
    case 'get_pull_request': {
      const pull = repoOf(args).pulls.get(numberArg(args, 'pull_number'));
      if (pull === undefined) throw new ToolError('Pull request not found');
      return pullJson(pull);
    }
    case 'list_pull_requests': {
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const list = [...repoOf(args).pulls.values()].filter((p) => state === 'all' || p.state === state);
      return `[${list.map(pullJson).join(',')}]`;
    }
    case 'merge_pull_request': {
      const pull = repoOf(args).pulls.get(numberArg(args, 'pull_number'));
      if (pull === undefined) throw new ToolError('Pull request not found');
      const result = mergePull(pull, typeof args.merge_method === 'string' ? args.merge_method : 'squash', typeof args.commit_title === 'string' ? args.commit_title : undefined);
      if (typeof result !== 'string') throw new ToolError(result.message);
      return `{"sha":"${result}","merged":true,"message":"Pull Request successfully merged","pull_number":${pull.number}}`;
    }
    default:
      throw new ToolError(`unknown tool ${name}`);
  }
}

function rpcResult(id: unknown, result: string): string {
  return `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${result}}`;
}

function rpcError(id: unknown, code: number, message: string): string {
  return `{"jsonrpc":"2.0","id":${JSON.stringify(id ?? null)},"error":{"code":${code},"message":${JSON.stringify(message)}}}`;
}

/** One JSON-RPC message's answer, or null for a notification. */
function dispatch(msg: unknown): string | null {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return rpcError(null, -32600, 'Invalid Request');
  const m = msg as Json;
  const id = m.id;
  const method = m.method;
  if (typeof method !== 'string') return id === undefined ? null : rpcError(id, -32600, 'Invalid Request');
  if (id === undefined) return null;
  const params = typeof m.params === 'object' && m.params !== null ? (m.params as Json) : {};
  switch (method) {
    case 'server/discover':
      return rpcResult(
        id,
        JSON.stringify({
          supportedVersions: REVISIONS,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: 'A GitHub-compatible forge: repositories, issues and pull requests.',
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        }),
      );
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = REVISIONS.includes(asked) ? asked : REVISIONS[1];
      return rpcResult(id, JSON.stringify({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO }));
    }
    case 'ping':
      return rpcResult(id, '{}');
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST);
    case 'resources/list':
      return rpcResult(id, '{"resources":[]}');
    case 'prompts/list':
      return rpcResult(id, '{"prompts":[]}');
    case 'tools/call': {
      const name = params.name;
      const tool = typeof name === 'string' ? TOOLS_BY_NAME.get(name) : undefined;
      if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
      const args = typeof params.arguments === 'object' && params.arguments !== null ? (params.arguments as Json) : {};
      const required = (tool.inputSchema.required as string[]) ?? [];
      const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
      try {
        return rpcResult(id, text(runTool(tool.name, args)));
      } catch (err) {
        if (err instanceof ToolError) return rpcResult(id, toolError(err.message));
        throw err;
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export function handleMcp(req: Req): void {
  if (!authed(req)) {
    sendJson(req, 401, '{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"Unauthorized: a bearer token is required"}}', 'WWW-Authenticate: Bearer\r\n');
    return;
  }
  if (req.method !== 'POST') {
    sendJson(req, 405, '{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"Method not allowed"}}', 'Allow: POST\r\n');
    return;
  }
  let msg: unknown;
  try {
    msg = JSON.parse(req.body.toString('utf8'));
  } catch {
    sendJson(req, 400, '{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}');
    return;
  }
  if (Array.isArray(msg)) {
    const answers = msg.map(dispatch).filter((a): a is string => a !== null);
    if (answers.length === 0) req.sock.write('HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n');
    else sendJson(req, 200, `[${answers.join(',')}]`);
    return;
  }
  const answer = dispatch(msg);
  if (answer === null) req.sock.write('HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n');
  else sendJson(req, 200, answer);
}

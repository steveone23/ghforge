// GraphQL v4 at /api/graphql: a small lexer and parser for the documents gh and github-mcp-server send
// (variables, aliases, fragments, inline fragments, directives, batching), a validation pass that
// reports unknown fields the way GitHub does, an executor over a table-driven schema, and introspection
// (__type and __schema) generated from that same table.

import { sendJson, type Req } from './http.ts';
import { authed, closePull, makeRepo, mergePull, openPull, pullFiles } from './rest.ts';
import {
  VIEWER,
  addComment,
  branchTip,
  createIssue,
  issuesByNode,
  pullBaseSha,
  pullHeadSha,
  pullsByNode,
  findRepo,
  reposByNode,
  setIssueState,
  touchIssue,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';
import { readCommit } from './git.ts';

type Json = Record<string, unknown>;

class GqlError extends Error {
  code: string;
  constructor(message: string, code = '') {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- lexer

interface Tok {
  k: 'p' | 'name' | 'int' | 'float' | 'str' | 'eof';
  v: string;
  line: number;
  col: number;
}

const PUNCT = '!$&()[]{}:=@|';

function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 10) {
      line += 1;
      i += 1;
      lineStart = i;
      continue;
    }
    if (c === 32 || c === 9 || c === 13 || c === 44 || c === 0xfeff) {
      i += 1;
      continue;
    }
    if (c === 35) {
      while (i < n && src.charCodeAt(i) !== 10) i += 1;
      continue;
    }
    const col = i - lineStart + 1;
    const ch = src[i];
    if (ch === '.' && src.startsWith('...', i)) {
      toks.push({ k: 'p', v: '...', line, col });
      i += 3;
      continue;
    }
    if (PUNCT.includes(ch)) {
      toks.push({ k: 'p', v: ch, line, col });
      i += 1;
      continue;
    }
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95) {
      let j = i + 1;
      while (j < n) {
        const d = src.charCodeAt(j);
        if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 95 || (d >= 48 && d <= 57)) j += 1;
        else break;
      }
      toks.push({ k: 'name', v: src.slice(i, j), line, col });
      i = j;
      continue;
    }
    if ((c >= 48 && c <= 57) || c === 45) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i, i + 64));
      if (m === null) throw new GqlError(`Parse error on "${ch}" (${line}:${col})`);
      toks.push({ k: m[1] !== undefined || m[2] !== undefined ? 'float' : 'int', v: m[0], line, col });
      i += m[0].length;
      continue;
    }
    if (ch === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        if (end < 0) throw new GqlError(`Unterminated string (${line}:${col})`);
        const raw = src.slice(i + 3, end).replace(/\\"""/g, '"""');
        const lines = raw.split('\n');
        let indent = Infinity;
        for (let k = 1; k < lines.length; k += 1) {
          const m = /^[ \t]*/.exec(lines[k]) as RegExpExecArray;
          if (m[0].length < lines[k].length) indent = Math.min(indent, m[0].length);
        }
        const out = lines.map((l, k) => (k === 0 || indent === Infinity ? l : l.slice(indent)));
        while (out.length > 0 && out[0].trim() === '') out.shift();
        while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
        for (const ch2 of raw) if (ch2 === '\n') line += 1;
        toks.push({ k: 'str', v: out.join('\n'), line, col });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= n || src[j] === '\n') throw new GqlError(`Unterminated string (${line}:${col})`);
        const d = src[j];
        if (d === '"') break;
        if (d === '\\') {
          const e = src[j + 1];
          if (e === 'u') {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
            continue;
          }
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === 'b' ? '\b' : e === 'f' ? '\f' : e;
          j += 2;
          continue;
        }
        out += d;
        j += 1;
      }
      toks.push({ k: 'str', v: out, line, col });
      i = j + 1;
      continue;
    }
    throw new GqlError(`Parse error on "${ch}" (${line}:${col})`);
  }
  toks.push({ k: 'eof', v: '', line, col: i - lineStart + 1 });
  return toks;
}

// ---------------------------------------------------------------- parser

type Value =
  | { k: 'var'; name: string }
  | { k: 'lit'; v: unknown }
  | { k: 'list'; items: Value[] }
  | { k: 'obj'; fields: [string, Value][] };

interface Directive {
  name: string;
  args: [string, Value][];
}

interface FieldSel {
  kind: 'field';
  alias: string;
  name: string;
  args: [string, Value][];
  dirs: Directive[];
  sels: Sel[] | null;
  line: number;
  col: number;
}

interface InlineSel {
  kind: 'inline';
  on: string | null;
  dirs: Directive[];
  sels: Sel[];
}

interface SpreadSel {
  kind: 'spread';
  name: string;
  dirs: Directive[];
}

type Sel = FieldSel | InlineSel | SpreadSel;

interface Operation {
  kind: string;
  name: string | null;
  vars: { name: string; def: Value | null }[];
  sels: Sel[];
}

interface Doc {
  ops: Operation[];
  frags: Map<string, { on: string; sels: Sel[] }>;
}

function parse(src: string): Doc {
  const toks = lex(src);
  let pos = 0;
  const peek = (): Tok => toks[pos];
  const fail = (t: Tok): never => {
    throw new GqlError(t.k === 'eof' ? 'Parse error on end of document' : `Parse error on "${t.v}" (${t.k === 'name' ? 'IDENTIFIER' : t.k.toUpperCase()}) at [${t.line}, ${t.col}]`);
  };
  const isP = (v: string): boolean => toks[pos].k === 'p' && toks[pos].v === v;
  const expectP = (v: string): void => {
    if (!isP(v)) fail(toks[pos]);
    pos += 1;
  };
  const name = (): string => {
    const t = toks[pos];
    if (t.k !== 'name') fail(t);
    pos += 1;
    return t.v;
  };
  const value = (): Value => {
    const t = toks[pos];
    if (t.k === 'p' && t.v === '$') {
      pos += 1;
      return { k: 'var', name: name() };
    }
    if (t.k === 'int') {
      pos += 1;
      return { k: 'lit', v: Number(t.v) };
    }
    if (t.k === 'float') {
      pos += 1;
      return { k: 'lit', v: Number(t.v) };
    }
    if (t.k === 'str') {
      pos += 1;
      return { k: 'lit', v: t.v };
    }
    if (t.k === 'name') {
      pos += 1;
      if (t.v === 'true') return { k: 'lit', v: true };
      if (t.v === 'false') return { k: 'lit', v: false };
      if (t.v === 'null') return { k: 'lit', v: null };
      return { k: 'lit', v: t.v };
    }
    if (t.k === 'p' && t.v === '[') {
      pos += 1;
      const items: Value[] = [];
      while (!isP(']')) items.push(value());
      pos += 1;
      return { k: 'list', items };
    }
    if (t.k === 'p' && t.v === '{') {
      pos += 1;
      const fields: [string, Value][] = [];
      while (!isP('}')) {
        const key = name();
        expectP(':');
        fields.push([key, value()]);
      }
      pos += 1;
      return { k: 'obj', fields };
    }
    return fail(t);
  };
  const args = (): [string, Value][] => {
    const out: [string, Value][] = [];
    if (!isP('(')) return out;
    pos += 1;
    while (!isP(')')) {
      const key = name();
      expectP(':');
      out.push([key, value()]);
    }
    pos += 1;
    return out;
  };
  const directives = (): Directive[] => {
    const out: Directive[] = [];
    while (isP('@')) {
      pos += 1;
      out.push({ name: name(), args: args() });
    }
    return out;
  };
  const typeRef = (): void => {
    if (isP('[')) {
      pos += 1;
      typeRef();
      expectP(']');
    } else name();
    if (isP('!')) pos += 1;
  };
  const selections = (): Sel[] => {
    expectP('{');
    const out: Sel[] = [];
    while (!isP('}')) {
      if (peek().k === 'eof') fail(peek());
      if (isP('...')) {
        pos += 1;
        const t = peek();
        if (t.k === 'name' && t.v === 'on') {
          pos += 1;
          const on = name();
          const dirs = directives();
          out.push({ kind: 'inline', on, dirs, sels: selections() });
        } else if (t.k === 'name') {
          pos += 1;
          out.push({ kind: 'spread', name: t.v, dirs: directives() });
        } else {
          const dirs = directives();
          out.push({ kind: 'inline', on: null, dirs, sels: selections() });
        }
        continue;
      }
      const t = peek();
      let alias = name();
      let fieldName = alias;
      if (isP(':')) {
        pos += 1;
        fieldName = name();
      }
      const a = args();
      const dirs = directives();
      const sels = isP('{') ? selections() : null;
      out.push({ kind: 'field', alias, name: fieldName, args: a, dirs, sels, line: t.line, col: t.col });
    }
    pos += 1;
    return out;
  };
  const doc: Doc = { ops: [], frags: new Map() };
  while (peek().k !== 'eof') {
    if (isP('{')) {
      doc.ops.push({ kind: 'query', name: null, vars: [], sels: selections() });
      continue;
    }
    const kw = name();
    if (kw === 'fragment') {
      const fname = name();
      if (name() !== 'on') fail(toks[pos - 1]);
      const on = name();
      directives();
      doc.frags.set(fname, { on, sels: selections() });
      continue;
    }
    if (kw !== 'query' && kw !== 'mutation' && kw !== 'subscription') fail(toks[pos - 1]);
    const op: Operation = { kind: kw, name: null, vars: [], sels: [] };
    if (peek().k === 'name') op.name = name();
    if (isP('(')) {
      pos += 1;
      while (!isP(')')) {
        expectP('$');
        const vname = name();
        expectP(':');
        typeRef();
        let def: Value | null = null;
        if (isP('=')) {
          pos += 1;
          def = value();
        }
        directives();
        op.vars.push({ name: vname, def });
      }
      pos += 1;
    }
    directives();
    op.sels = selections();
    doc.ops.push(op);
  }
  if (doc.ops.length === 0) throw new GqlError('No operation in the document');
  return doc;
}

// ---------------------------------------------------------------- schema

interface Ctx {
  vars: Json;
  errors: Json[];
  frags: Map<string, { on: string; sels: Sel[] }>;
}

interface FieldDef {
  type: string;
  list?: boolean;
  nonNull?: boolean;
  args?: string[];
  r: (src: any, args: Json, ctx: Ctx) => unknown;
}

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID', 'HTML', 'GitTimestamp', 'Base64String']);

const ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  IssueStateReason: ['COMPLETED', 'NOT_PLANNED', 'REOPENED', 'DUPLICATE'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  RepositoryVisibility: ['PRIVATE', 'PUBLIC', 'INTERNAL'],
  SearchType: ['ISSUE', 'ISSUE_ADVANCED', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PatchStatus: ['ADDED', 'DELETED', 'RENAMED', 'COPIED', 'MODIFIED', 'CHANGED'],
  __TypeKind: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
};

const INPUTS: Record<string, string[]> = {
  CreateIssueInput: ['repositoryId', 'title', 'body', 'assigneeIds', 'labelIds', 'milestoneId', 'clientMutationId'],
  CloseIssueInput: ['issueId', 'stateReason', 'clientMutationId'],
  ReopenIssueInput: ['issueId', 'clientMutationId'],
  UpdateIssueInput: ['id', 'title', 'body', 'state', 'labelIds', 'clientMutationId'],
  AddCommentInput: ['subjectId', 'body', 'clientMutationId'],
  CreatePullRequestInput: ['repositoryId', 'baseRefName', 'headRefName', 'title', 'body', 'draft', 'clientMutationId'],
  MergePullRequestInput: ['pullRequestId', 'mergeMethod', 'commitHeadline', 'commitBody', 'expectedHeadOid', 'clientMutationId'],
  ClosePullRequestInput: ['pullRequestId', 'clientMutationId'],
  CreateRepositoryInput: ['name', 'description', 'visibility', 'clientMutationId'],
  IssueOrder: ['field', 'direction'],
};

/** Interfaces and the object types that implement them. */
const INTERFACES: Record<string, string[]> = {
  Node: ['Repository', 'User', 'Issue', 'PullRequest', 'IssueComment', 'Label', 'Ref', 'Commit'],
  RepositoryOwner: ['User'],
  Actor: ['User'],
  Comment: ['Issue', 'PullRequest', 'IssueComment'],
  UniformResourceLocatable: ['Repository', 'User', 'Issue', 'PullRequest'],
  Closable: ['Issue', 'PullRequest'],
  GitObject: ['Commit'],
};

const SCHEMA: Record<string, Record<string, FieldDef>> = {};

function matches(cond: string, type: string): boolean {
  return cond === type || (INTERFACES[cond]?.includes(type) ?? false);
}

const VIEWER_NODE = { t: 'User' };
const BASE = 'https://github.com';

function s(type: string, r: FieldDef['r'], extra: Partial<FieldDef> = {}): FieldDef {
  return { type, r, ...extra };
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index + 1}`).toString('base64');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  const text = Buffer.from(cursor, 'base64').toString('utf8');
  if (!text.startsWith('cursor:')) return -1;
  const n = Number(text.slice(7));
  return Number.isInteger(n) ? n - 1 : -1;
}

interface Conn {
  t: string;
  items: unknown[];
  offset: number;
  total: number;
  hasNext: boolean;
  hasPrev: boolean;
  edge: string;
}

function connection(node: string, items: unknown[], args: Json): Conn {
  let start = 0;
  let end = items.length;
  const after = indexOfCursor(args.after);
  if (after >= 0) start = Math.min(items.length, after + 1);
  const before = indexOfCursor(args.before);
  if (before >= 0) end = Math.max(start, Math.min(end, before));
  let s0 = start;
  let e0 = end;
  if (typeof args.first === 'number') e0 = Math.min(e0, s0 + Math.max(0, args.first));
  if (typeof args.last === 'number') s0 = Math.max(s0, e0 - Math.max(0, args.last));
  return { t: `${node}Connection`, items: items.slice(s0, e0), offset: s0, total: items.length, hasNext: e0 < end, hasPrev: s0 > start, edge: `${node}Edge` };
}

function defineConnection(node: string): void {
  SCHEMA[`${node}Connection`] = {
    nodes: s(node, (c: Conn) => c.items, { list: true }),
    edges: s(`${node}Edge`, (c: Conn) => c.items.map((item, i) => ({ t: c.edge, node: item, cursor: cursorOf(c.offset + i) })), { list: true }),
    pageInfo: s('PageInfo', (c: Conn) => ({
      t: 'PageInfo',
      hasNextPage: c.hasNext,
      hasPreviousPage: c.hasPrev,
      startCursor: c.items.length === 0 ? null : cursorOf(c.offset),
      endCursor: c.items.length === 0 ? null : cursorOf(c.offset + c.items.length - 1),
    })),
    totalCount: s('Int', (c: Conn) => c.total),
  };
  SCHEMA[`${node}Edge`] = {
    node: s(node, (e: Json) => e.node),
    cursor: s('String', (e: Json) => e.cursor),
  };
}

function prop(name: string, type = 'String'): FieldDef {
  return s(type, (src: Json) => src[name] ?? null);
}

function repoById(id: unknown): Repo {
  const repo = typeof id === 'string' ? reposByNode.get(id) : undefined;
  if (repo === undefined) throw new GqlError(`Could not resolve to a node with the global id of '${String(id)}'`, 'NOT_FOUND');
  return repo;
}

function issueState(i: Issue): string {
  return i.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(p: Pull): string {
  return p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED';
}

function inputOf(args: Json): Json {
  const input = args.input;
  if (typeof input !== 'object' || input === null) throw new GqlError("Argument 'input' on Field is missing or not an object", 'argumentLiteralsIncompatible');
  return input as Json;
}

function orderList<T extends Issue | Pull>(list: T[], orderBy: unknown): T[] {
  const o = typeof orderBy === 'object' && orderBy !== null ? (orderBy as Json) : null;
  const field = o === null ? 'CREATED_AT' : String(o.field ?? 'CREATED_AT');
  const desc = o !== null && o.direction === 'DESC';
  const key = (x: T): number | string => (field === 'UPDATED_AT' ? x.updatedAt : field === 'COMMENTS' ? x.comments.length : x.number);
  const out = list.slice().sort((a, b) => {
    const x = key(a);
    const y = key(b);
    return x < y ? -1 : x > y ? 1 : a.number - b.number;
  });
  if (desc) out.reverse();
  return out;
}

function nodeById(id: unknown): unknown {
  if (typeof id !== 'string') return null;
  if (id === VIEWER.nodeId) return VIEWER_NODE;
  return reposByNode.get(id) ?? issuesByNode.get(id) ?? pullsByNode.get(id) ?? null;
}

function userFields(): Record<string, FieldDef> {
  return {
    id: s('ID', () => VIEWER.nodeId),
    databaseId: s('Int', () => VIEWER.id),
    login: s('String', () => VIEWER.login),
    name: s('String', () => VIEWER.name),
    email: s('String', () => VIEWER.email),
    url: s('URI', () => `${BASE}/${VIEWER.login}`),
    avatarUrl: s('URI', () => `${BASE}/${VIEWER.login}.png`, { args: ['size'] }),
  };
}

SCHEMA.User = userFields();
SCHEMA.RepositoryOwner = userFields();
SCHEMA.Actor = { login: s('String', () => VIEWER.login), avatarUrl: s('URI', () => `${BASE}/${VIEWER.login}.png`, { args: ['size'] }), url: s('URI', () => `${BASE}/${VIEWER.login}`) };
SCHEMA.Node = { id: s('ID', (src: Json) => (src as { nodeId?: string }).nodeId ?? VIEWER.nodeId) };
SCHEMA.PageInfo = { hasNextPage: prop('hasNextPage', 'Boolean'), hasPreviousPage: prop('hasPreviousPage', 'Boolean'), startCursor: prop('startCursor'), endCursor: prop('endCursor') };

SCHEMA.Label = {
  id: s('ID', (l: Label) => l.nodeId),
  name: s('String', (l: Label) => l.name),
  color: s('String', (l: Label) => l.color),
  description: s('String', (l: Label) => l.description),
};

SCHEMA.Commit = {
  id: s('ID', (c: Json) => `C_${String(c.oid)}`),
  oid: s('GitObjectID', (c: Json) => c.oid),
  abbreviatedOid: s('String', (c: Json) => String(c.oid).slice(0, 7)),
  message: s('String', (c: Json) => readCommit(String(c.oid))?.message.replace(/\n$/, '') ?? ''),
  messageHeadline: s('String', (c: Json) => (readCommit(String(c.oid))?.message ?? '').split('\n')[0]),
};

SCHEMA.Ref = {
  id: s('ID', (r: Json) => `REF_${Buffer.from(`${(r.repo as Repo).id}:${String(r.name)}`).toString('base64url')}`),
  name: s('String', (r: Json) => r.name),
  prefix: s('String', () => 'refs/heads/'),
  target: s('Commit', (r: Json) => ({ t: 'Commit', oid: r.oid })),
};

SCHEMA.IssueComment = {
  id: s('ID', (c: Comment) => c.nodeId),
  databaseId: s('Int', (c: Comment) => c.id),
  body: s('String', (c: Comment) => c.body),
  author: s('Actor', () => VIEWER_NODE),
  createdAt: s('DateTime', (c: Comment) => c.createdAt),
  url: s('URI', (c: Comment) => `${BASE}/${c.issue.repo.fullName}/issues/${c.issue.number}#issuecomment-${c.id}`),
};

function commentsField(): FieldDef {
  return s('IssueCommentConnection', (x: Issue | Pull, a: Json) => connection('IssueComment', x.comments, a), { args: ['first', 'last', 'after', 'before'] });
}

SCHEMA.Issue = {
  id: s('ID', (i: Issue) => i.nodeId),
  databaseId: s('Int', (i: Issue) => i.id),
  number: s('Int', (i: Issue) => i.number),
  title: s('String', (i: Issue) => i.title),
  body: s('String', (i: Issue) => i.body ?? ''),
  state: s('IssueState', issueState),
  stateReason: s('IssueStateReason', (i: Issue) => (i.stateReason === null ? null : i.stateReason.toUpperCase())),
  closed: s('Boolean', (i: Issue) => i.state === 'closed'),
  locked: s('Boolean', () => false),
  url: s('URI', (i: Issue) => `${BASE}/${i.repo.fullName}/issues/${i.number}`),
  createdAt: s('DateTime', (i: Issue) => i.createdAt),
  updatedAt: s('DateTime', (i: Issue) => i.updatedAt),
  closedAt: s('DateTime', (i: Issue) => i.closedAt),
  author: s('Actor', () => VIEWER_NODE),
  repository: s('Repository', (i: Issue) => i.repo),
  labels: s('LabelConnection', (i: Issue, a: Json) => connection('Label', i.labels, a), { args: ['first', 'last', 'after', 'before'] }),
  comments: commentsField(),
  assignees: s('UserConnection', (_i: Issue, a: Json) => connection('User', [], a), { args: ['first', 'after'] }),
};

SCHEMA.PullRequestChangedFile = {
  path: prop('path'),
  additions: prop('additions', 'Int'),
  deletions: prop('deletions', 'Int'),
  changeType: prop('changeType', 'PatchStatus'),
};

SCHEMA.PullRequest = {
  id: s('ID', (p: Pull) => p.nodeId),
  databaseId: s('Int', (p: Pull) => p.id),
  number: s('Int', (p: Pull) => p.number),
  title: s('String', (p: Pull) => p.title),
  body: s('String', (p: Pull) => p.body ?? ''),
  state: s('PullRequestState', pullState),
  closed: s('Boolean', (p: Pull) => p.state === 'closed'),
  merged: s('Boolean', (p: Pull) => p.merged),
  mergedAt: s('DateTime', (p: Pull) => p.mergedAt),
  isDraft: s('Boolean', () => false),
  url: s('URI', (p: Pull) => `${BASE}/${p.repo.fullName}/pull/${p.number}`),
  createdAt: s('DateTime', (p: Pull) => p.createdAt),
  updatedAt: s('DateTime', (p: Pull) => p.updatedAt),
  closedAt: s('DateTime', (p: Pull) => p.closedAt),
  headRefName: s('String', (p: Pull) => p.head),
  baseRefName: s('String', (p: Pull) => p.base),
  headRefOid: s('GitObjectID', pullHeadSha),
  baseRefOid: s('GitObjectID', pullBaseSha),
  mergeable: s('MergeableState', (p: Pull) => (p.state === 'open' ? 'MERGEABLE' : 'UNKNOWN')),
  mergeCommit: s('Commit', (p: Pull) => (p.mergeSha === null ? null : { t: 'Commit', oid: p.mergeSha })),
  author: s('Actor', () => VIEWER_NODE),
  repository: s('Repository', (p: Pull) => p.repo),
  headRepository: s('Repository', (p: Pull) => p.repo),
  baseRepository: s('Repository', (p: Pull) => p.repo),
  files: s(
    'PullRequestChangedFileConnection',
    (p: Pull, a: Json) =>
      connection(
        'PullRequestChangedFile',
        pullFiles(p).map((f) => ({ t: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'DELETED' : 'MODIFIED' })),
        a,
      ),
    { args: ['first', 'after'] },
  ),
  additions: s('Int', (p: Pull) => pullFiles(p).reduce((n, f) => n + f.additions, 0)),
  deletions: s('Int', (p: Pull) => pullFiles(p).reduce((n, f) => n + f.deletions, 0)),
  changedFiles: s('Int', (p: Pull) => pullFiles(p).length),
  labels: s('LabelConnection', (_p: Pull, a: Json) => connection('Label', [], a), { args: ['first', 'after'] }),
  comments: commentsField(),
};

SCHEMA.Repository = {
  id: s('ID', (r: Repo) => r.nodeId),
  databaseId: s('Int', (r: Repo) => r.id),
  name: s('String', (r: Repo) => r.name),
  nameWithOwner: s('String', (r: Repo) => r.fullName),
  owner: s('RepositoryOwner', () => VIEWER_NODE),
  description: s('String', (r: Repo) => r.description),
  isPrivate: s('Boolean', (r: Repo) => r.private),
  visibility: s('RepositoryVisibility', (r: Repo) => (r.private ? 'PRIVATE' : 'PUBLIC')),
  isFork: s('Boolean', () => false),
  isArchived: s('Boolean', () => false),
  isEmpty: s('Boolean', (r: Repo) => r.refs.size === 0),
  url: s('URI', (r: Repo) => `${BASE}/${r.fullName}`),
  sshUrl: s('String', (r: Repo) => `git@github.com:${r.fullName}.git`),
  createdAt: s('DateTime', (r: Repo) => r.createdAt),
  updatedAt: s('DateTime', (r: Repo) => r.updatedAt),
  pushedAt: s('DateTime', (r: Repo) => r.pushedAt),
  stargazerCount: s('Int', () => 0),
  forkCount: s('Int', () => 0),
  viewerPermission: s('RepositoryPermission', () => 'ADMIN'),
  hasIssuesEnabled: s('Boolean', () => true),
  hasWikiEnabled: s('Boolean', () => false),
  defaultBranchRef: s('Ref', (r: Repo) => {
    const oid = branchTip(r, r.defaultBranch);
    return oid === undefined ? null : { t: 'Ref', repo: r, name: r.defaultBranch, oid };
  }),
  ref: s(
    'Ref',
    (r: Repo, a: Json) => {
      const q = String(a.qualifiedName ?? '');
      const name = q.startsWith('refs/heads/') ? q.slice(11) : q;
      const oid = branchTip(r, name);
      return oid === undefined ? null : { t: 'Ref', repo: r, name, oid };
    },
    { args: ['qualifiedName'] },
  ),
  issue: s('Issue', (r: Repo, a: Json) => r.issues.get(Number(a.number)) ?? null, { args: ['number'] }),
  issues: s(
    'IssueConnection',
    (r: Repo, a: Json) => {
      let list = [...r.issues.values()];
      if (Array.isArray(a.states) && a.states.length > 0) list = list.filter((i) => (a.states as unknown[]).includes(issueState(i)));
      if (Array.isArray(a.labels) && a.labels.length > 0) {
        const wanted = (a.labels as unknown[]).map((x) => String(x).toLowerCase());
        list = list.filter((i) => i.labels.some((l) => wanted.includes(l.name.toLowerCase())));
      }
      return connection('Issue', orderList(list, a.orderBy), a);
    },
    { args: ['first', 'last', 'after', 'before', 'states', 'labels', 'orderBy', 'filterBy'] },
  ),
  pullRequest: s('PullRequest', (r: Repo, a: Json) => r.pulls.get(Number(a.number)) ?? null, { args: ['number'] }),
  pullRequests: s(
    'PullRequestConnection',
    (r: Repo, a: Json) => {
      let list = [...r.pulls.values()];
      if (Array.isArray(a.states) && a.states.length > 0) list = list.filter((p) => (a.states as unknown[]).includes(pullState(p)));
      if (typeof a.headRefName === 'string') list = list.filter((p) => p.head === a.headRefName);
      if (typeof a.baseRefName === 'string') list = list.filter((p) => p.base === a.baseRefName);
      return connection('PullRequest', orderList(list, a.orderBy), a);
    },
    { args: ['first', 'last', 'after', 'before', 'states', 'headRefName', 'baseRefName', 'orderBy'] },
  ),
  labels: s('LabelConnection', (r: Repo, a: Json) => connection('Label', [...r.labels.values()], a), { args: ['first', 'after'] }),
};

for (const node of ['Issue', 'PullRequest', 'IssueComment', 'Label', 'User', 'PullRequestChangedFile', 'Repository']) defineConnection(node);

function payload(type: string, fields: Record<string, string>): void {
  const defs: Record<string, FieldDef> = { clientMutationId: prop('clientMutationId') };
  for (const [name, t] of Object.entries(fields)) defs[name] = prop(name, t);
  SCHEMA[type] = defs;
}

payload('CreateIssuePayload', { issue: 'Issue' });
payload('CloseIssuePayload', { issue: 'Issue' });
payload('ReopenIssuePayload', { issue: 'Issue' });
payload('UpdateIssuePayload', { issue: 'Issue' });
payload('CreatePullRequestPayload', { pullRequest: 'PullRequest' });
payload('MergePullRequestPayload', { pullRequest: 'PullRequest' });
payload('ClosePullRequestPayload', { pullRequest: 'PullRequest' });
payload('CreateRepositoryPayload', { repository: 'Repository' });
payload('AddCommentPayload', { commentEdge: 'IssueCommentEdge', subject: 'Node', timelineEdge: 'IssueCommentEdge' });

SCHEMA.Query = {
  viewer: s('User', () => VIEWER_NODE),
  repository: s('Repository', (_s: unknown, a: Json) => findRepo(String(a.owner ?? ''), String(a.name ?? '')) ?? null, { args: ['owner', 'name', 'followRenames'] }),
  repositoryOwner: s('RepositoryOwner', (_s: unknown, a: Json) => (String(a.login).toLowerCase() === VIEWER.login.toLowerCase() ? VIEWER_NODE : null), { args: ['login'] }),
  user: s('User', (_s: unknown, a: Json) => (String(a.login).toLowerCase() === VIEWER.login.toLowerCase() ? VIEWER_NODE : null), { args: ['login'] }),
  node: s('Node', (_s: unknown, a: Json) => nodeById(a.id), { args: ['id'] }),
  nodes: s('Node', (_s: unknown, a: Json) => (Array.isArray(a.ids) ? a.ids.map(nodeById) : []), { list: true, args: ['ids'] }),
  __type: s('__Type', (_s: unknown, a: Json) => typeObj(String(a.name)), { args: ['name'] }),
  __schema: s('__Schema', () => ({ t: '__Schema' })),
};

function closeIssueBy(input: Json, state: 'open' | 'closed'): Json {
  const issue = typeof input.issueId === 'string' ? issuesByNode.get(input.issueId) : undefined;
  if (issue === undefined) throw new GqlError(`Could not resolve to a node with the global id of '${String(input.issueId)}'`, 'NOT_FOUND');
  setIssueState(issue, state, state === 'closed' ? (typeof input.stateReason === 'string' ? input.stateReason.toLowerCase() : null) : 'reopened');
  return { issue, clientMutationId: input.clientMutationId ?? null };
}

function pullById(id: unknown): Pull {
  const pull = typeof id === 'string' ? pullsByNode.get(id) : undefined;
  if (pull === undefined) throw new GqlError(`Could not resolve to a node with the global id of '${String(id)}'`, 'NOT_FOUND');
  return pull;
}

function restMessage(json: string): string {
  try {
    const v = JSON.parse(json) as Json;
    const errors = Array.isArray(v.errors) ? (v.errors as Json[]) : [];
    const detail = errors.map((e) => String(e.message ?? `${String(e.field)} ${String(e.code)}`)).join('; ');
    return detail === '' ? String(v.message) : detail;
  } catch {
    return json;
  }
}

SCHEMA.Mutation = {
  createIssue: s('CreateIssuePayload', (_s: unknown, a: Json) => {
    const input = inputOf(a);
    const repo = repoById(input.repositoryId);
    if (typeof input.title !== 'string' || input.title === '') throw new GqlError('Title can\'t be blank');
    const labels: Label[] = [];
    if (Array.isArray(input.labelIds)) {
      for (const id of input.labelIds) {
        const label = [...repo.labels.values()].find((l) => l.nodeId === id);
        if (label === undefined) throw new GqlError(`Could not resolve to a node with the global id of '${String(id)}'`, 'NOT_FOUND');
        labels.push(label);
      }
    }
    const issue = createIssue(repo, input.title, typeof input.body === 'string' ? input.body : null, labels);
    return { issue, clientMutationId: input.clientMutationId ?? null };
  }, { args: ['input'] }),
  closeIssue: s('CloseIssuePayload', (_s: unknown, a: Json) => closeIssueBy(inputOf(a), 'closed'), { args: ['input'] }),
  reopenIssue: s('ReopenIssuePayload', (_s: unknown, a: Json) => closeIssueBy(inputOf(a), 'open'), { args: ['input'] }),
  updateIssue: s('UpdateIssuePayload', (_s: unknown, a: Json) => {
    const input = inputOf(a);
    const issue = typeof input.id === 'string' ? issuesByNode.get(input.id) : undefined;
    if (issue === undefined) throw new GqlError(`Could not resolve to a node with the global id of '${String(input.id)}'`, 'NOT_FOUND');
    if (typeof input.title === 'string' && input.title !== '') issue.title = input.title;
    if (typeof input.body === 'string') issue.body = input.body;
    touchIssue(issue);
    if (input.state === 'OPEN' || input.state === 'CLOSED') setIssueState(issue, input.state === 'OPEN' ? 'open' : 'closed', null);
    return { issue, clientMutationId: input.clientMutationId ?? null };
  }, { args: ['input'] }),
  addComment: s('AddCommentPayload', (_s: unknown, a: Json) => {
    const input = inputOf(a);
    const id = input.subjectId;
    const subject = typeof id === 'string' ? issuesByNode.get(id) ?? pullsByNode.get(id) : undefined;
    if (subject === undefined) throw new GqlError(`Could not resolve to a node with the global id of '${String(id)}'`, 'NOT_FOUND');
    if (typeof input.body !== 'string' || input.body === '') throw new GqlError('Body can\'t be blank');
    const comment = addComment(subject, input.body);
    const edge = { t: 'IssueCommentEdge', node: comment, cursor: cursorOf(subject.comments.length - 1) };
    return { commentEdge: edge, subject, timelineEdge: edge, clientMutationId: input.clientMutationId ?? null };
  }, { args: ['input'] }),
  createPullRequest: s('CreatePullRequestPayload', (_s: unknown, a: Json) => {
    const input = inputOf(a);
    const repo = repoById(input.repositoryId);
    if (typeof input.title !== 'string' || input.title === '') throw new GqlError('Title can\'t be blank');
    const pull = openPull(repo, input.title, typeof input.body === 'string' ? input.body : null, String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
    if (typeof pull === 'string') throw new GqlError(restMessage(pull), 'UNPROCESSABLE');
    return { pullRequest: pull, clientMutationId: input.clientMutationId ?? null };
  }, { args: ['input'] }),
  mergePullRequest: s('MergePullRequestPayload', (_s: unknown, a: Json) => {
    const input = inputOf(a);
    const pull = pullById(input.pullRequestId);
    const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge';
    const result = mergePull(pull, method, typeof input.commitHeadline === 'string' ? input.commitHeadline : undefined, typeof input.commitBody === 'string' ? input.commitBody : undefined);
    if (typeof result !== 'string') throw new GqlError(result.message, 'UNPROCESSABLE');
    return { pullRequest: pull, clientMutationId: input.clientMutationId ?? null };
  }, { args: ['input'] }),
  closePullRequest: s('ClosePullRequestPayload', (_s: unknown, a: Json) => {
    const input = inputOf(a);
    const pull = pullById(input.pullRequestId);
    if (pull.state === 'open') closePull(pull);
    return { pullRequest: pull, clientMutationId: input.clientMutationId ?? null };
  }, { args: ['input'] }),
  createRepository: s('CreateRepositoryPayload', (_s: unknown, a: Json) => {
    const input = inputOf(a);
    const name = String(input.name ?? '');
    const repo = makeRepo(name, typeof input.description === 'string' ? input.description : null, input.visibility !== 'PUBLIC', false);
    if (repo === null) throw new GqlError('Name already exists on this account', 'UNPROCESSABLE');
    return { repository: repo, clientMutationId: input.clientMutationId ?? null };
  }, { args: ['input'] }),
};

// ---------------------------------------------------------------- introspection

function kindOf(name: string): string | null {
  if (SCHEMA[name] !== undefined) return INTERFACES[name] !== undefined ? 'INTERFACE' : 'OBJECT';
  if (ENUMS[name] !== undefined) return 'ENUM';
  if (SCALARS.has(name)) return 'SCALAR';
  if (INPUTS[name] !== undefined) return 'INPUT_OBJECT';
  return null;
}

function typeObj(name: string): Json | null {
  const kind = kindOf(name);
  return kind === null ? null : { t: '__Type', name, kind };
}

SCHEMA.__Type = {
  kind: s('__TypeKind', (x: Json) => x.kind),
  name: s('String', (x: Json) => x.name ?? null),
  description: s('String', () => null),
  specifiedByURL: s('String', () => null),
  fields: s(
    '__Field',
    (x: Json) => {
      const defs = typeof x.name === 'string' && (x.kind === 'OBJECT' || x.kind === 'INTERFACE') ? SCHEMA[x.name] : undefined;
      if (defs === undefined) return null;
      return Object.keys(defs)
        .filter((k) => !k.startsWith('__'))
        .map((k) => ({ t: '__Field', name: k, def: defs[k] }));
    },
    { list: true, args: ['includeDeprecated'] },
  ),
  enumValues: s('__EnumValue', (x: Json) => (x.kind === 'ENUM' ? (ENUMS[String(x.name)] ?? []).map((v) => ({ t: '__EnumValue', name: v })) : null), { list: true, args: ['includeDeprecated'] }),
  inputFields: s('__InputValue', (x: Json) => (x.kind === 'INPUT_OBJECT' ? (INPUTS[String(x.name)] ?? []).map((n) => ({ t: '__InputValue', name: n, type: 'String' })) : null), { list: true, args: ['includeDeprecated'] }),
  interfaces: s('__Type', (x: Json) => (x.kind === 'OBJECT' ? Object.keys(INTERFACES).filter((i) => INTERFACES[i].includes(String(x.name))).map((i) => typeObj(i)) : null), { list: true }),
  possibleTypes: s('__Type', (x: Json) => (x.kind === 'INTERFACE' ? (INTERFACES[String(x.name)] ?? []).map((i) => typeObj(i)) : null), { list: true }),
  ofType: s('__Type', (x: Json) => x.ofType ?? null),
};

SCHEMA.__Field = {
  name: s('String', (f: Json) => f.name),
  description: s('String', () => null),
  args: s('__InputValue', (f: Json) => ((f.def as FieldDef).args ?? []).map((n) => ({ t: '__InputValue', name: n, type: 'String' })), { list: true, args: ['includeDeprecated'] }),
  type: s('__Type', (f: Json) => {
    const def = f.def as FieldDef;
    const named = typeObj(def.type) ?? { t: '__Type', name: def.type, kind: 'OBJECT' };
    return def.list ? { t: '__Type', name: null, kind: 'LIST', ofType: named } : named;
  }),
  isDeprecated: s('Boolean', () => false),
  deprecationReason: s('String', () => null),
};

SCHEMA.__InputValue = {
  name: s('String', (f: Json) => f.name),
  description: s('String', () => null),
  type: s('__Type', (f: Json) => typeObj(String(f.type))),
  defaultValue: s('String', () => null),
  isDeprecated: s('Boolean', () => false),
  deprecationReason: s('String', () => null),
};

SCHEMA.__EnumValue = {
  name: s('String', (e: Json) => e.name),
  description: s('String', () => null),
  isDeprecated: s('Boolean', () => false),
  deprecationReason: s('String', () => null),
};

SCHEMA.__Directive = {
  name: s('String', (d: Json) => d.name),
  description: s('String', () => null),
  locations: s('String', () => [], { list: true }),
  args: s('__InputValue', () => [], { list: true }),
};

SCHEMA.__Schema = {
  queryType: s('__Type', () => typeObj('Query')),
  mutationType: s('__Type', () => typeObj('Mutation')),
  subscriptionType: s('__Type', () => null),
  description: s('String', () => null),
  types: s('__Type', () => [...Object.keys(SCHEMA), ...Object.keys(ENUMS), ...SCALARS, ...Object.keys(INPUTS)].map((n) => typeObj(n)), { list: true }),
  directives: s('__Directive', () => [{ t: '__Directive', name: 'include' }, { t: '__Directive', name: 'skip' }], { list: true }),
};

// ---------------------------------------------------------------- validation and execution

function validate(type: string, sels: Sel[], ctx: Ctx, path: string[], seen: Set<string>): void {
  const defs = SCHEMA[type];
  for (const sel of sels) {
    if (sel.kind === 'field') {
      if (sel.name === '__typename') continue;
      const def = defs?.[sel.name];
      if (def === undefined) {
        ctx.errors.push({
          path: [...path, sel.alias],
          extensions: { code: 'undefinedField', typeName: type, fieldName: sel.name },
          locations: [{ line: sel.line, column: sel.col }],
          message: `Field '${sel.name}' doesn't exist on type '${type}'`,
        });
        continue;
      }
      const objectType = SCHEMA[def.type] !== undefined;
      if (objectType && sel.sels === null) {
        ctx.errors.push({ path: [...path, sel.alias], locations: [{ line: sel.line, column: sel.col }], message: `Field must have selections (field '${sel.name}' returns ${def.type} but has no selections. Did you mean '${sel.name} { ... }'?)` });
      } else if (!objectType && sel.sels !== null) {
        ctx.errors.push({ path: [...path, sel.alias], locations: [{ line: sel.line, column: sel.col }], message: `Selections can't be made on scalars (field '${sel.name}' returns ${def.type} but has selections [${sel.sels.map((x) => (x.kind === 'field' ? x.name : '...')).join(', ')}])` });
      } else if (sel.sels !== null) {
        validate(def.type, sel.sels, ctx, [...path, sel.alias], seen);
      }
    } else if (sel.kind === 'inline') {
      const on = sel.on ?? type;
      if (SCHEMA[on] === undefined) ctx.errors.push({ message: `No such type ${on}, so it can't be a fragment condition` });
      else validate(on, sel.sels, ctx, path, seen);
    } else {
      const frag = ctx.frags.get(sel.name);
      if (frag === undefined) ctx.errors.push({ message: `Fragment ${sel.name} was used, but not defined` });
      else if (!seen.has(sel.name)) {
        seen.add(sel.name);
        if (SCHEMA[frag.on] === undefined) ctx.errors.push({ message: `No such type ${frag.on}, so it can't be a fragment condition` });
        else validate(frag.on, frag.sels, ctx, path, seen);
        seen.delete(sel.name);
      }
    }
  }
}

function evalValue(v: Value, vars: Json): unknown {
  if (v.k === 'lit') return v.v;
  if (v.k === 'var') return vars[v.name] ?? null;
  if (v.k === 'list') return v.items.map((item) => evalValue(item, vars));
  const out: Json = {};
  for (const [key, val] of v.fields) out[key] = evalValue(val, vars);
  return out;
}

function evalArgs(args: [string, Value][], vars: Json): Json {
  const out: Json = {};
  for (const [key, val] of args) out[key] = evalValue(val, vars);
  return out;
}

function included(dirs: Directive[], vars: Json): boolean {
  for (const d of dirs) {
    if (d.name === 'skip' && evalArgs(d.args, vars).if === true) return false;
    if (d.name === 'include' && evalArgs(d.args, vars).if !== true) return false;
  }
  return true;
}

function merge(into: Json, key: string, value: unknown): void {
  const prev = into[key];
  if (prev !== null && typeof prev === 'object' && !Array.isArray(prev) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Json)) merge(prev as Json, k, v);
  } else into[key] = value;
}

function execSels(type: string, src: unknown, sels: Sel[], out: Json, ctx: Ctx, path: (string | number)[]): void {
  const defs = SCHEMA[type];
  for (const sel of sels) {
    if (!included(sel.dirs, ctx.vars)) continue;
    if (sel.kind === 'field') {
      if (sel.name === '__typename') {
        out[sel.alias] = type;
        continue;
      }
      const def = defs[sel.name];
      const here = [...path, sel.alias];
      let value: unknown;
      try {
        value = def.r(src, evalArgs(sel.args, ctx.vars), ctx);
        value = complete(def, value, sel, ctx, here);
      } catch (err) {
        if (!(err instanceof GqlError)) throw err;
        ctx.errors.push({
          type: err.code === '' ? undefined : err.code,
          path: here,
          locations: [{ line: sel.line, column: sel.col }],
          message: err.message,
        });
        value = null;
      }
      merge(out, sel.alias, value);
    } else if (sel.kind === 'inline') {
      if (sel.on === null || matches(sel.on, type)) execSels(type, src, sel.sels, out, ctx, path);
    } else {
      const frag = ctx.frags.get(sel.name);
      if (frag !== undefined && matches(frag.on, type)) execSels(type, src, frag.sels, out, ctx, path);
    }
  }
}

function completeOne(type: string, value: unknown, sel: FieldSel, ctx: Ctx, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (SCHEMA[type] === undefined || sel.sels === null) return value;
  const runtime = INTERFACES[type] !== undefined ? ((value as { t?: string }).t ?? type) : type;
  const out: Json = {};
  execSels(runtime, value, sel.sels, out, ctx, path);
  return out;
}

function complete(def: FieldDef, value: unknown, sel: FieldSel, ctx: Ctx, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (def.list) return (value as unknown[]).map((item, i) => completeOne(def.type, item, sel, ctx, [...path, i]));
  return completeOne(def.type, value, sel, ctx, path);
}

/** Run one {query, variables, operationName} request and answer its {data, errors} body. */
function runOne(request: unknown): Json {
  if (typeof request !== 'object' || request === null) return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  const r = request as Json;
  if (typeof r.query !== 'string') return { errors: [{ message: 'A query attribute must be specified and must be a string.' }] };
  let doc: Doc;
  try {
    doc = parse(r.query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err), locations: [] }] };
  }
  let op = doc.ops[0];
  if (typeof r.operationName === 'string' && r.operationName !== '') {
    const found = doc.ops.find((o) => o.name === r.operationName);
    if (found === undefined) return { errors: [{ message: `No operation named "${r.operationName}"` }] };
    op = found;
  } else if (doc.ops.length > 1) {
    return { errors: [{ message: 'An operation name is required when a document holds several operations' }] };
  }
  const given = typeof r.variables === 'object' && r.variables !== null ? (r.variables as Json) : {};
  const vars: Json = {};
  for (const v of op.vars) vars[v.name] = v.name in given ? given[v.name] : v.def === null ? null : evalValue(v.def, {});
  const ctx: Ctx = { vars, errors: [], frags: doc.frags };
  const root = op.kind === 'mutation' ? 'Mutation' : 'Query';
  validate(root, op.sels, ctx, [`${op.kind}${op.name === null ? '' : ` ${op.name}`}`], new Set());
  if (ctx.errors.length > 0) return { errors: ctx.errors };
  const data: Json = {};
  try {
    execSels(root, null, op.sels, data, ctx, []);
  } catch (err) {
    process.stderr.write(`[forge] graphql failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    ctx.errors.push({ message: 'Something went wrong while executing your query.' });
    return { data: null, errors: ctx.errors };
  }
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

export function handleGraphql(req: Req): void {
  if (!authed(req)) {
    sendJson(req, 401, '{"message":"This endpoint requires you to be authenticated.","documentation_url":"https://docs.github.com/graphql/guides/forming-calls-with-graphql#authenticating-with-graphql"}');
    return;
  }
  if (req.method !== 'POST') {
    sendJson(req, 404, '{"message":"Not Found"}');
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(req.body.toString('utf8'));
  } catch {
    sendJson(req, 400, '{"message":"Problems parsing JSON"}');
    return;
  }
  const result = Array.isArray(body) ? body.map(runOne) : runOne(body);
  sendJson(req, 200, JSON.stringify(result));
}

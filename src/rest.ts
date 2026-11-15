// REST v3 under /api/v3: repositories, contents, refs, branches, commits, issues, comments, labels and
// pull requests. Every handler is synchronous; a GET of an issue is one map lookup and one cached write.

import { jsonResponse, parseQuery, sendJson, sendNoContent, type Req } from './http.ts';
import {
  T_BLOB,
  T_COMMIT,
  T_TREE,
  commitOf,
  flatten,
  isAncestor,
  mergeBase,
  parseTree,
  put,
  readCommit,
  store,
  treeAt,
  unflatten,
  type FlatEntry,
} from './git.ts';
import {
  USER_JSON,
  VIEWER,
  addComment,
  branchTip,
  commentJson,
  commitJson,
  commitOnBranch,
  createIssue,
  createLabel,
  createPull,
  createRepo,
  deleteRepo,
  findRepo,
  issueByPath,
  issueJson,
  iso,
  logFrom,
  nextTime,
  pullBaseSha,
  pullHeadSha,
  pullJson,
  repoJson,
  repos,
  setIssueState,
  setRef,
  touchIssue,
  userJsonFull,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const BEARER = `Bearer ${TOKEN}`;

/** Whether the request carries the trial's token (any token when none is configured). */
export function authed(req: Req): boolean {
  const a = req.auth;
  if (a === BEARER) return TOKEN !== '';
  if (a === '') return false;
  if (TOKEN === '') return true;
  return a === `token ${TOKEN}` || a === `bearer ${TOKEN}`;
}

const NOT_FOUND = '{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}';
const UNAUTHORIZED = '{"message":"Requires authentication","documentation_url":"https://docs.github.com/rest"}';
const BAD_JSON = '{"message":"Problems parsing JSON","documentation_url":"https://docs.github.com/rest"}';
const ROOT = '{"current_user_url":"/api/v3/user","repository_url":"/api/v3/repos/{owner}/{repo}","user_repositories_url":"/api/v3/user/repos","issues_url":"/api/v3/issues","rate_limit_url":"/api/v3/rate_limit"}';
const META = '{"verifiable_password_authentication":false,"installed_version":"3.14.0"}';

type Json = Record<string, unknown>;

function message(text: string): string {
  return JSON.stringify({ message: text, documentation_url: 'https://docs.github.com/rest' });
}

function validation(resource: string, field: string, code: string, msg?: string): string {
  return JSON.stringify({
    message: msg ?? 'Validation Failed',
    errors: [{ resource, field, code }],
    documentation_url: 'https://docs.github.com/rest',
  });
}

/** The JSON body as an object; on a malformed body the 400 is already sent and null comes back. */
function bodyOf(req: Req): Json | null {
  if (req.body.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(req.body.toString('utf8'));
  } catch {
    sendJson(req, 400, BAD_JSON);
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    sendJson(req, 400, BAD_JSON);
    return null;
  }
  return value as Json;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function decode(s: string): string {
  if (!s.includes('%')) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function intParam(q: Map<string, string>, key: string, def: number, max: number): number {
  const raw = q.get(key);
  const n = raw === undefined ? def : Number(raw);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(max, Math.floor(n));
}

/** Link header for a paged list, absolute on the request's own origin. */
function linkHeader(req: Req, page: number, perPage: number, total: number): string {
  const last = Math.max(1, Math.ceil(total / perPage));
  if (last <= 1) return '';
  const q = parseQuery(req.query);
  const url = (n: number): string => {
    q.set('page', String(n));
    q.set('per_page', String(perPage));
    const parts: string[] = [];
    for (const [k, v] of q) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    return `<http://${req.host}${req.path}?${parts.join('&')}>`;
  };
  const links: string[] = [];
  if (page < last) links.push(`${url(page + 1)}; rel="next"`, `${url(last)}; rel="last"`);
  if (page > 1) links.push(`${url(1)}; rel="first"`, `${url(page - 1)}; rel="prev"`);
  return links.length === 0 ? '' : `Link: ${links.join(', ')}\r\n`;
}

function sendPage(req: Req, items: string[], q: Map<string, string>, defPer = 30): void {
  const perPage = intParam(q, 'per_page', defPer, 100);
  const page = intParam(q, 'page', 1, 1_000_000);
  const slice = items.slice((page - 1) * perPage, page * perPage);
  sendJson(req, 200, `[${slice.join(',')}]`, linkHeader(req, page, perPage, items.length));
}

// ---------------------------------------------------------------- the router

export function handleRest(req: Req): void {
  if (req.method === 'GET') {
    const issue = issueByPath.get(req.path);
    if (issue !== undefined && authed(req)) {
      if (issue.resp === null) issue.resp = jsonResponse(200, issueJson(issue));
      req.sock.write(issue.resp);
      return;
    }
  }
  if (!authed(req)) {
    sendJson(req, 401, UNAUTHORIZED);
    return;
  }
  const sub = req.path.length > 7 ? req.path.slice(7) : '/';
  const segs = sub.split('/');
  if (segs[segs.length - 1] === '' && segs.length > 2) segs.pop();
  const top = segs[1] ?? '';
  const m = req.method;
  if (top === '') {
    if (m === 'GET') return sendJson(req, 200, ROOT, 'X-OAuth-Scopes: repo, read:org, workflow\r\n');
  } else if (top === 'repos' && segs.length >= 4) {
    const repo = findRepo(decode(segs[2]), decode(segs[3]));
    if (repo === undefined) return sendJson(req, 404, NOT_FOUND);
    return repoRoute(req, repo, segs.slice(4));
  } else if (top === 'user') {
    if (segs.length === 2 && m === 'GET') return sendJson(req, 200, userJsonFull(), 'X-OAuth-Scopes: repo, read:org, workflow\r\n');
    if (segs.length === 3 && segs[2] === 'repos') {
      if (m === 'GET') return listRepos(req);
      if (m === 'POST') return postRepo(req);
    }
  } else if (top === 'meta' && segs.length === 2 && m === 'GET') {
    return sendJson(req, 200, META);
  } else if (top === 'users' && segs.length === 3 && m === 'GET') {
    if (decode(segs[2]).toLowerCase() === VIEWER.login.toLowerCase()) return sendJson(req, 200, userJsonFull());
  } else if (top === 'rate_limit' && m === 'GET') {
    return sendJson(req, 200, '{"resources":{"core":{"limit":5000,"used":0,"remaining":5000,"reset":0}},"rate":{"limit":5000,"used":0,"remaining":5000,"reset":0}}');
  }
  sendJson(req, 404, NOT_FOUND);
}

function repoRoute(req: Req, repo: Repo, rest: string[]): void {
  const m = req.method;
  const kind = rest[0];
  if (kind === undefined) {
    if (m === 'GET') return sendJson(req, 200, repoJson(repo));
    if (m === 'PATCH') return patchRepo(req, repo);
    if (m === 'DELETE') {
      deleteRepo(repo);
      return sendNoContent(req);
    }
  } else if (kind === 'issues') {
    if (rest.length === 1) {
      if (m === 'GET') return listIssues(req, repo);
      if (m === 'POST') return postIssue(req, repo);
    } else {
      const issue = repo.issues.get(Number(rest[1]));
      const pull = issue === undefined ? repo.pulls.get(Number(rest[1])) : undefined;
      if (issue === undefined && pull === undefined) return sendJson(req, 404, NOT_FOUND);
      if (rest.length === 2) {
        if (issue !== undefined) {
          if (m === 'GET') return sendJson(req, 200, issueJson(issue));
          if (m === 'PATCH') return patchIssue(req, issue);
        } else if (m === 'GET') return sendJson(req, 200, pullJson(pull as Pull));
      } else if (rest.length === 3 && rest[2] === 'comments') {
        const target = (issue ?? pull) as Issue | Pull;
        if (m === 'GET') return sendPage(req, target.comments.map(commentJson), parseQuery(req.query));
        if (m === 'POST') {
          const b = bodyOf(req);
          if (b === null) return;
          const text = str(b.body);
          if (text === undefined || text === '') return sendJson(req, 422, validation('IssueComment', 'body', 'missing_field'));
          return sendJson(req, 201, commentJson(addComment(target, text)));
        }
      } else if (rest.length === 3 && rest[2] === 'labels' && issue !== undefined && m === 'GET') {
        return sendJson(req, 200, `[${issue.labels.map((l) => l.json).join(',')}]`);
      }
    }
  } else if (kind === 'pulls') {
    if (rest.length === 1) {
      if (m === 'GET') return listPulls(req, repo);
      if (m === 'POST') return postPull(req, repo);
    } else {
      const pull = repo.pulls.get(Number(rest[1]));
      if (pull === undefined) return sendJson(req, 404, NOT_FOUND);
      if (rest.length === 2) {
        if (m === 'GET') return sendJson(req, 200, pullJson(pull));
        if (m === 'PATCH') return patchPull(req, pull);
      } else if (rest[2] === 'files' && m === 'GET') {
        return sendPage(req, pullFiles(pull).map((f) => JSON.stringify(f)), parseQuery(req.query));
      } else if (rest[2] === 'merge') {
        if (m === 'PUT') return mergeRoute(req, pull);
        if (m === 'GET') return pull.merged ? sendNoContent(req) : sendJson(req, 404, NOT_FOUND);
      } else if (rest[2] === 'commits' && m === 'GET') {
        const base = pullBaseSha(pull);
        const list = logFrom(pullHeadSha(pull), 250).filter((c) => !isAncestor(c, base));
        return sendJson(req, 200, `[${list.reverse().map(commitJson).join(',')}]`);
      }
    }
  } else if (kind === 'labels') {
    if (rest.length === 1) {
      if (m === 'GET') return sendPage(req, [...repo.labels.values()].map((l) => l.json), parseQuery(req.query));
      if (m === 'POST') return postLabel(req, repo);
    } else if (m === 'GET') {
      const label = repo.labels.get(decode(rest.slice(1).join('/')).toLowerCase());
      if (label !== undefined) return sendJson(req, 200, label.json);
    }
  } else if (kind === 'branches') {
    if (m === 'GET') {
      if (rest.length === 1) return listBranches(req, repo);
      const name = rest.slice(1).map(decode).join('/');
      const tip = branchTip(repo, name);
      if (tip === undefined) return sendJson(req, 404, message('Branch not found'));
      return sendJson(req, 200, `{"name":${JSON.stringify(name)},"commit":${commitJson(tip)},"protected":false}`);
    }
  } else if (kind === 'commits') {
    if (m === 'GET') {
      if (rest.length === 1) return listCommits(req, repo);
      const oid = resolveRef(repo, rest.slice(1).map(decode).join('/'));
      if (oid === undefined || commitOf(oid) === null) return sendJson(req, 422, message('No commit found for SHA'));
      return sendJson(req, 200, commitJson(oid));
    }
  } else if (kind === 'contents') {
    const path = rest.slice(1).map(decode).join('/');
    if (m === 'GET') return getContents(req, repo, path);
    if (m === 'PUT') return putContents(req, repo, path);
    if (m === 'DELETE') return deleteContents(req, repo, path);
  } else if (kind === 'git') {
    return gitDataRoute(req, repo, rest);
  }
  sendJson(req, 404, NOT_FOUND);
}

// ---------------------------------------------------------------- repositories

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

function listRepos(req: Req): void {
  const items: string[] = [];
  for (const repo of repos.values()) items.push(repoJson(repo));
  sendPage(req, items, parseQuery(req.query));
}

function postRepo(req: Req): void {
  const b = bodyOf(req);
  if (b === null) return;
  const name = str(b.name);
  if (name === undefined || !NAME_RE.test(name) || name.endsWith('.git')) return sendJson(req, 422, validation('Repository', 'name', 'missing_field', 'Repository creation failed.'));
  const created = makeRepo(name, str(b.description) ?? null, b.private === true, b.auto_init === true);
  if (created === null) {
    return sendJson(
      req,
      422,
      JSON.stringify({
        message: 'Repository creation failed.',
        errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
        documentation_url: 'https://docs.github.com/rest',
      }),
    );
  }
  sendJson(req, 201, repoJson(created));
}

/** Create a repository (null when the name is taken); `autoInit` makes a first commit with a README. */
export function makeRepo(name: string, description: string | null, isPrivate: boolean, autoInit: boolean): Repo | null {
  if (findRepo(VIEWER.login, name) !== undefined) return null;
  const repo = createRepo(name, description, isPrivate);
  if (autoInit) {
    const blob = put(T_BLOB, Buffer.from(`# ${name}\n${description === null ? '' : `\n${description}\n`}`));
    const tree = unflatten(new Map([['README.md', { mode: '100644', oid: blob }]]));
    commitOnBranch(repo, repo.defaultBranch, tree, 'Initial commit');
  }
  return repo;
}

function patchRepo(req: Req, repo: Repo): void {
  const b = bodyOf(req);
  if (b === null) return;
  if ('description' in b) repo.description = str(b.description) ?? null;
  if (typeof b.private === 'boolean') repo.private = b.private;
  if (typeof b.default_branch === 'string' && b.default_branch !== '') {
    repo.defaultBranch = b.default_branch;
    setRef(repo, `refs/heads/${b.default_branch}`, branchTip(repo, b.default_branch) ?? null);
  }
  repo.updatedAt = iso(nextTime());
  sendJson(req, 200, repoJson(repo));
}

// ---------------------------------------------------------------- refs, branches, commits

/** A ref, branch, tag or commit id to the object id it names. */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (/^[0-9a-f]{40}$/.test(ref) && store.has(ref)) return ref;
  return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? repo.refs.get(ref);
}

function refJson(ref: string, oid: string): string {
  const o = store.get(oid);
  const type = o === undefined ? 'commit' : ['', 'commit', 'tree', 'blob', 'tag'][o.type];
  return `{"ref":${JSON.stringify(ref)},"node_id":"REF_${Buffer.from(ref).toString('base64url')}","object":{"sha":"${oid}","type":"${type}"}}`;
}

function gitDataRoute(req: Req, repo: Repo, rest: string[]): void {
  const m = req.method;
  const sub = rest[1];
  if (sub === 'refs' || sub === 'ref') {
    if (rest.length === 2) {
      if (m === 'GET' && sub === 'refs') {
        const names = [...repo.refs.keys()].sort();
        return sendJson(req, 200, `[${names.map((n) => refJson(n, repo.refs.get(n) as string)).join(',')}]`);
      }
      if (m === 'POST' && sub === 'refs') return postRef(req, repo);
    } else {
      const name = `refs/${rest.slice(2).map(decode).join('/')}`;
      const oid = repo.refs.get(name);
      if (m === 'GET') {
        if (oid !== undefined) return sendJson(req, 200, refJson(name, oid));
        const prefixed = [...repo.refs.keys()].filter((n) => n.startsWith(`${name}/`)).sort();
        if (sub === 'refs' && prefixed.length > 0) return sendJson(req, 200, `[${prefixed.map((n) => refJson(n, repo.refs.get(n) as string)).join(',')}]`);
        return sendJson(req, 404, NOT_FOUND);
      }
      if (oid === undefined) return sendJson(req, 422, message('Reference does not exist'));
      if (m === 'DELETE') {
        setRef(repo, name, null);
        return sendNoContent(req);
      }
      if (m === 'PATCH') {
        const b = bodyOf(req);
        if (b === null) return;
        const sha = str(b.sha);
        if (sha === undefined || !store.has(sha)) return sendJson(req, 422, message('Object does not exist'));
        if (b.force !== true && !isAncestor(oid, sha)) return sendJson(req, 422, message('Update is not a fast forward'));
        setRef(repo, name, sha);
        return sendJson(req, 200, refJson(name, sha));
      }
    }
  } else if (sub === 'commits' && rest.length === 3 && m === 'GET') {
    const c = readCommit(rest[2]);
    if (c !== null) return sendJson(req, 200, `{"sha":"${rest[2]}","tree":{"sha":"${c.tree}"},"message":${JSON.stringify(c.message)},"parents":[${c.parents.map((p) => `{"sha":"${p}"}`).join(',')}]}`);
  } else if (sub === 'trees' && rest.length === 3 && m === 'GET') {
    const oid = resolveRef(repo, decode(rest[2]));
    let tree = oid;
    if (oid !== undefined && store.get(oid)?.type === T_COMMIT) tree = (commitOf(oid) as { tree: string }).tree;
    const o = tree === undefined ? undefined : store.get(tree);
    if (o !== undefined && o.type === T_TREE) {
      const entries = parseTree(o.data).map((e) => `{"path":${JSON.stringify(e.name)},"mode":"${e.mode.padStart(6, '0')}","type":"${e.mode === '40000' ? 'tree' : 'blob'}","sha":"${e.oid}"}`);
      return sendJson(req, 200, `{"sha":"${tree}","tree":[${entries.join(',')}],"truncated":false}`);
    }
  }
  sendJson(req, 404, NOT_FOUND);
}

function postRef(req: Req, repo: Repo): void {
  const b = bodyOf(req);
  if (b === null) return;
  const ref = str(b.ref);
  const sha = str(b.sha);
  if (ref === undefined || !ref.startsWith('refs/') || ref.split('/').length < 3) return sendJson(req, 422, message('Reference name is invalid'));
  if (sha === undefined || !store.has(sha)) return sendJson(req, 422, message('Object does not exist'));
  if (repo.refs.has(ref)) return sendJson(req, 422, message('Reference already exists'));
  setRef(repo, ref, sha);
  sendJson(req, 201, refJson(ref, sha));
}

function listBranches(req: Req, repo: Repo): void {
  const items: string[] = [];
  for (const name of [...repo.refs.keys()].sort()) {
    if (!name.startsWith('refs/heads/')) continue;
    items.push(`{"name":${JSON.stringify(name.slice(11))},"commit":{"sha":"${repo.refs.get(name)}"},"protected":false}`);
  }
  sendPage(req, items, parseQuery(req.query));
}

function listCommits(req: Req, repo: Repo): void {
  const q = parseQuery(req.query);
  const ref = q.get('sha') ?? repo.defaultBranch;
  const tip = resolveRef(repo, ref);
  if (tip === undefined) {
    if (repo.refs.size === 0) return sendJson(req, 409, message('Git Repository is empty.'));
    return sendJson(req, 404, message('No commit found for SHA: ' + ref));
  }
  const perPage = intParam(q, 'per_page', 30, 100);
  const page = intParam(q, 'page', 1, 100_000);
  const list = logFrom(tip, perPage + 1, (page - 1) * perPage);
  const more = list.length > perPage;
  const shown = more ? list.slice(0, perPage) : list;
  const link = more ? linkHeader(req, page, perPage, page * perPage + 1) : '';
  sendJson(req, 200, `[${shown.map(commitJson).join(',')}]`, link);
}

// ---------------------------------------------------------------- contents

function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 10) n += 1;
  return data[data.length - 1] === 10 ? n : n + 1;
}

function contentEntry(path: string, oid: string, type: string, size: number): Json {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { name, path, sha: oid, size, type };
}

function getContents(req: Req, repo: Repo, path: string): void {
  const q = parseQuery(req.query);
  const ref = q.get('ref') ?? repo.defaultBranch;
  const tip = resolveRef(repo, ref);
  if (tip === undefined) {
    if (repo.refs.size === 0) return sendJson(req, 404, message('This repository is empty.'));
    return sendJson(req, 404, message(`No commit found for the ref ${ref}`));
  }
  const commit = commitOf(tip);
  if (commit === null) return sendJson(req, 404, NOT_FOUND);
  const root = commit.tree as string;
  const dir = treeAt(root, path);
  if (dir !== null) {
    const items = dir.entries.map((e) => {
      const full = path === '' ? e.name : `${path}/${e.name}`;
      const isDir = e.mode === '40000';
      const size = isDir ? 0 : store.get(e.oid)?.data.length ?? 0;
      return JSON.stringify(contentEntry(full, e.oid, isDir ? 'dir' : e.mode === '160000' ? 'submodule' : 'file', size));
    });
    return sendJson(req, 200, `[${items.join(',')}]`);
  }
  const slash = path.lastIndexOf('/');
  const parent = treeAt(root, slash < 0 ? '' : path.slice(0, slash));
  const leaf = slash < 0 ? path : path.slice(slash + 1);
  const entry = parent?.entries.find((e) => e.name === leaf);
  const blob = entry === undefined ? undefined : store.get(entry.oid);
  if (entry === undefined || blob === undefined || blob.type !== T_BLOB) return sendJson(req, 404, NOT_FOUND);
  const out = contentEntry(path, entry.oid, 'file', blob.data.length);
  out.encoding = 'base64';
  out.content = blob.data.toString('base64');
  sendJson(req, 200, JSON.stringify(out));
}

function commitResult(commit: string): string {
  return commitJson(commit);
}

/** Files of a branch (an empty map for an unborn branch). */
function filesOf(tip: string | undefined): Map<string, FlatEntry> {
  if (tip === undefined) return new Map();
  const c = commitOf(tip);
  return c === null ? new Map() : flatten(c.tree as string);
}

function putContents(req: Req, repo: Repo, path: string): void {
  const b = bodyOf(req);
  if (b === null) return;
  const content = str(b.content);
  const msg = str(b.message) ?? `Update ${path}`;
  if (content === undefined) return sendJson(req, 422, validation('Content', 'content', 'missing_field', 'Invalid request.\n\n"content" wasn\'t supplied.'));
  if (path === '') return sendJson(req, 422, message('path cannot be empty'));
  const branch = str(b.branch) ?? repo.defaultBranch;
  let tip = branchTip(repo, branch);
  if (tip === undefined && branch !== repo.defaultBranch) tip = branchTip(repo, repo.defaultBranch);
  const files = filesOf(tip);
  const existing = files.get(path);
  const sha = str(b.sha);
  if (existing !== undefined) {
    if (sha === undefined) return sendJson(req, 422, message('Invalid request.\n\n"sha" wasn\'t supplied.'));
    if (sha !== existing.oid) return sendJson(req, 409, message(`${path} does not match ${sha}`));
  }
  const data = Buffer.from(content, 'base64');
  const blob = put(T_BLOB, data);
  // A file replaces any directory at its path, and a directory any file on its way.
  for (const key of [...files.keys()]) if (key.startsWith(`${path}/`)) files.delete(key);
  const segs = path.split('/');
  for (let i = 1; i < segs.length; i += 1) files.delete(segs.slice(0, i).join('/'));
  files.set(path, { mode: existing?.mode ?? '100644', oid: blob });
  const tree = unflatten(files);
  const commit = commitOnBranch(repo, branch, tree, msg, tip === undefined ? [] : [tip]);
  const entry = contentEntry(path, blob, 'file', data.length);
  entry.encoding = 'base64';
  sendJson(req, existing === undefined ? 201 : 200, `{"content":${JSON.stringify(entry)},"commit":${commitResult(commit)}}`);
}

function deleteContents(req: Req, repo: Repo, path: string): void {
  const b = bodyOf(req);
  if (b === null) return;
  const branch = str(b.branch) ?? repo.defaultBranch;
  const tip = branchTip(repo, branch);
  const files = filesOf(tip);
  const existing = files.get(path);
  if (existing === undefined) return sendJson(req, 404, NOT_FOUND);
  const sha = str(b.sha);
  if (sha === undefined) return sendJson(req, 422, message('Invalid request.\n\n"sha" wasn\'t supplied.'));
  if (sha !== existing.oid) return sendJson(req, 409, message(`${path} does not match ${sha}`));
  files.delete(path);
  const commit = commitOnBranch(repo, branch, unflatten(files), str(b.message) ?? `Delete ${path}`);
  sendJson(req, 200, `{"content":null,"commit":${commitResult(commit)}}`);
}

// ---------------------------------------------------------------- issues, labels, comments

function labelsFrom(repo: Repo, value: unknown): Label[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return 'labels';
  const out: Label[] = [];
  for (const item of value) {
    const name = typeof item === 'string' ? item : typeof item === 'object' && item !== null ? str((item as Json).name) : undefined;
    if (name === undefined) return 'labels';
    const label = repo.labels.get(name.toLowerCase());
    if (label === undefined) return name;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

function labelError(name: string): string {
  return JSON.stringify({
    message: 'Validation Failed',
    errors: [{ value: name, resource: 'Label', field: 'labels', code: 'invalid' }],
    documentation_url: 'https://docs.github.com/rest',
  });
}

function postIssue(req: Req, repo: Repo): void {
  const b = bodyOf(req);
  if (b === null) return;
  const title = b.title;
  if (typeof title !== 'string' || title === '') return sendJson(req, 422, validation('Issue', 'title', 'missing_field'));
  const labels = labelsFrom(repo, b.labels);
  if (typeof labels === 'string') return sendJson(req, 422, labelError(labels));
  const issue = createIssue(repo, title, str(b.body) ?? null, labels);
  sendJson(req, 201, issueJson(issue));
}

function patchIssue(req: Req, issue: Issue): void {
  const b = bodyOf(req);
  if (b === null) return;
  if (b.state !== undefined && b.state !== 'open' && b.state !== 'closed') return sendJson(req, 422, validation('Issue', 'state', 'invalid'));
  if (b.labels !== undefined) {
    const labels = labelsFrom(issue.repo, b.labels);
    if (typeof labels === 'string') return sendJson(req, 422, labelError(labels));
    issue.labels = labels;
  }
  if (typeof b.title === 'string' && b.title !== '') issue.title = b.title;
  if ('body' in b) issue.body = str(b.body) ?? null;
  touchIssue(issue);
  if (b.state === 'open' || b.state === 'closed') setIssueState(issue, b.state, str(b.state_reason) ?? null);
  sendJson(req, 200, issueJson(issue));
}

function listIssues(req: Req, repo: Repo): void {
  const q = parseQuery(req.query);
  const state = q.get('state') ?? 'open';
  const sort = q.get('sort') ?? 'created';
  const asc = (q.get('direction') ?? 'desc') === 'asc';
  const wanted = (q.get('labels') ?? '').split(',').filter((s) => s !== '').map((s) => s.toLowerCase());
  let list = [...repo.issues.values()].filter((i) => state === 'all' || i.state === state);
  if (wanted.length > 0) list = list.filter((i) => wanted.every((w) => i.labels.some((l) => l.name.toLowerCase() === w)));
  const key = (i: Issue): number | string => (sort === 'updated' ? i.updatedAt : sort === 'comments' ? i.comments.length : i.number);
  list.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const c = x < y ? -1 : x > y ? 1 : a.number - b.number;
    return asc ? c : -c;
  });
  sendPage(req, list.map(issueJson), q);
}

function postLabel(req: Req, repo: Repo): void {
  const b = bodyOf(req);
  if (b === null) return;
  const name = str(b.name);
  if (name === undefined || name === '') return sendJson(req, 422, validation('Label', 'name', 'missing_field'));
  if (repo.labels.has(name.toLowerCase())) return sendJson(req, 422, validation('Label', 'name', 'already_exists'));
  const color = (str(b.color) ?? 'ededed').replace(/^#/, '');
  sendJson(req, 201, createLabel(repo, name, color, str(b.description) ?? null).json);
}

// ---------------------------------------------------------------- pull requests

function stripOwner(ref: string): string {
  const colon = ref.indexOf(':');
  return colon < 0 ? ref : ref.slice(colon + 1);
}

/** Open a pull request, or answer the 422 message that refuses it. */
export function openPull(repo: Repo, title: string, body: string | null, headRef: string, baseRef: string): Pull | string {
  const head = stripOwner(headRef);
  const base = stripOwner(baseRef);
  if (branchTip(repo, head) === undefined) return validation('PullRequest', 'head', 'invalid');
  if (branchTip(repo, base) === undefined) return validation('PullRequest', 'base', 'invalid');
  for (const p of repo.pulls.values()) {
    if (p.state === 'open' && p.head === head && p.base === base) {
      return JSON.stringify({ message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: `A pull request already exists for ${repo.owner}:${head}.` }] });
    }
  }
  return createPull(repo, title, body, head, base);
}

function postPull(req: Req, repo: Repo): void {
  const b = bodyOf(req);
  if (b === null) return;
  const title = str(b.title);
  const head = str(b.head);
  const base = str(b.base);
  if (title === undefined || title === '') return sendJson(req, 422, validation('PullRequest', 'title', 'missing_field'));
  if (head === undefined || base === undefined) return sendJson(req, 422, validation('PullRequest', head === undefined ? 'head' : 'base', 'missing_field'));
  const pull = openPull(repo, title, str(b.body) ?? null, head, base);
  if (typeof pull === 'string') return sendJson(req, 422, pull);
  sendJson(req, 201, pullJson(pull));
}

function patchPull(req: Req, pull: Pull): void {
  const b = bodyOf(req);
  if (b === null) return;
  if (typeof b.title === 'string' && b.title !== '') pull.title = b.title;
  if ('body' in b) pull.body = str(b.body) ?? null;
  if (typeof b.base === 'string' && branchTip(pull.repo, b.base) !== undefined) pull.base = b.base;
  pull.updatedAt = iso(nextTime());
  if (b.state === 'closed' && pull.state === 'open') closePull(pull);
  else if (b.state === 'open' && pull.state === 'closed' && !pull.merged) {
    pull.state = 'open';
    pull.closedAt = null;
    pull.headSha = null;
    pull.baseSha = null;
  }
  sendJson(req, 200, pullJson(pull));
}

export function closePull(pull: Pull): void {
  pull.headSha = pullHeadSha(pull);
  pull.baseSha = pullBaseSha(pull);
  pull.state = 'closed';
  pull.closedAt = iso(nextTime());
  pull.updatedAt = pull.closedAt;
}

function linesOf(oid: string): string[] {
  const o = store.get(oid);
  if (o === undefined) return [];
  const text = o.data.toString('utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

interface FileChange {
  sha: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

/** The files a pull request changes: its head tree against the merge base with its base. */
export function pullFiles(pull: Pull): FileChange[] {
  const head = pullHeadSha(pull);
  const base = pullBaseSha(pull);
  const headCommit = commitOf(head);
  if (headCommit === null) return [];
  const mb = mergeBase(base, head) ?? base;
  const mbCommit = commitOf(mb);
  const before = mbCommit === null ? new Map<string, FlatEntry>() : flatten(mbCommit.tree as string);
  const after = flatten(headCommit.tree as string);
  const paths = new Set([...before.keys(), ...after.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const x = before.get(path);
    const y = after.get(path);
    if (x !== undefined && y !== undefined && x.oid === y.oid) continue;
    let additions = 0;
    let deletions = 0;
    let status = 'modified';
    if (x === undefined) {
      status = 'added';
      additions = lineCount(store.get((y as FlatEntry).oid)?.data ?? Buffer.alloc(0));
    } else if (y === undefined) {
      status = 'removed';
      deletions = lineCount(store.get(x.oid)?.data ?? Buffer.alloc(0));
    } else {
      const counts = new Map<string, number>();
      for (const line of linesOf(x.oid)) counts.set(line, (counts.get(line) ?? 0) + 1);
      for (const line of linesOf(y.oid)) {
        const n = counts.get(line) ?? 0;
        if (n > 0) counts.set(line, n - 1);
        else additions += 1;
      }
      for (const n of counts.values()) deletions += n;
    }
    out.push({ sha: (y ?? x as FlatEntry).oid, filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

/** Merge a pull request; answers the merge commit id, or the HTTP status and message refusing it. */
export function mergePull(pull: Pull, method: string, title?: string, extra?: string): string | { status: number; message: string } {
  if (pull.merged || pull.state !== 'open') return { status: 405, message: 'Pull Request is not mergeable' };
  const repo = pull.repo;
  const headTip = branchTip(repo, pull.head);
  const baseTip = branchTip(repo, pull.base);
  if (headTip === undefined || baseTip === undefined) return { status: 422, message: 'Head or base branch is missing' };
  const headCommit = commitOf(headTip);
  const baseCommit = commitOf(baseTip);
  if (headCommit === null || baseCommit === null) return { status: 422, message: 'Head or base branch is missing' };
  let tree: string;
  const mb = mergeBase(baseTip, headTip);
  if (mb === baseTip) {
    tree = headCommit.tree as string;
  } else {
    const mbCommit = mb === null ? null : commitOf(mb);
    const B = mbCommit === null ? new Map<string, FlatEntry>() : flatten(mbCommit.tree as string);
    const O = flatten(baseCommit.tree as string);
    const T = flatten(headCommit.tree as string);
    const result = new Map(O);
    const same = (a: FlatEntry | undefined, b: FlatEntry | undefined): boolean => (a === undefined ? b === undefined : b !== undefined && a.oid === b.oid && a.mode === b.mode);
    for (const path of new Set([...B.keys(), ...T.keys()])) {
      const b = B.get(path);
      const t = T.get(path);
      const o = O.get(path);
      if (same(t, b) || same(o, t)) continue;
      if (same(o, b)) {
        if (t === undefined) result.delete(path);
        else result.set(path, t);
        continue;
      }
      return { status: 405, message: 'Merge conflict' };
    }
    tree = unflatten(result);
  }
  const msg = `${title ?? `${pull.title} (#${pull.number})`}${extra ? `\n\n${extra}` : ''}`;
  const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
  const sha = commitOnBranch(repo, pull.base, tree, msg, parents);
  pull.headSha = headTip;
  pull.baseSha = baseTip;
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeSha = sha;
  pull.mergedAt = iso(nextTime());
  pull.closedAt = pull.mergedAt;
  pull.updatedAt = pull.mergedAt;
  return sha;
}

function mergeRoute(req: Req, pull: Pull): void {
  const b = bodyOf(req);
  if (b === null) return;
  const result = mergePull(pull, str(b.merge_method) ?? 'merge', str(b.commit_title), str(b.commit_message));
  if (typeof result !== 'string') return sendJson(req, result.status, message(result.message));
  sendJson(req, 200, `{"sha":"${result}","merged":true,"message":"Pull Request successfully merged"}`);
}

function listPulls(req: Req, repo: Repo): void {
  const q = parseQuery(req.query);
  const state = q.get('state') ?? 'open';
  const asc = (q.get('direction') ?? 'desc') === 'asc';
  const head = q.get('head');
  const base = q.get('base');
  let list = [...repo.pulls.values()].filter((p) => state === 'all' || p.state === state);
  if (head !== undefined) list = list.filter((p) => p.head === stripOwner(head));
  if (base !== undefined) list = list.filter((p) => p.base === base);
  list.sort((a, b) => (asc ? a.number - b.number : b.number - a.number));
  sendPage(req, list.map(pullJson), q);
}

export { USER_JSON };

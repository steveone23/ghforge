// The in-memory store: the viewer, repositories and what they hold (refs, issues, pulls, labels,
// comments), with ids from counters and timestamps from a fixed epoch plus a counter, so two runs that
// see the same requests answer the same bytes.

import { ZERO, buildCommit, commitOf, readCommit } from './git.ts';

/** The login the suite's token names: the scenario's viewer (wire.ts buildScenario, a fixed seed). */
export const VIEWER = {
  login: process.env.FORGE_VIEWER_LOGIN ?? 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
  nodeId: 'U_kgDOAAAD6A',
};

export const USER_JSON = `{"login":${JSON.stringify(VIEWER.login)},"id":${VIEWER.id},"node_id":"${VIEWER.nodeId}","type":"User","site_admin":false}`;

const EPOCH_SEC = 1_735_689_600;
let tick = 0;

/** The next timestamp (seconds): the fixed epoch plus a counter, never the wall clock. */
export function nextTime(): number {
  tick += 1;
  return EPOCH_SEC + tick;
}

export function iso(sec: number): string {
  return `${new Date(sec * 1000).toISOString().slice(0, 19)}Z`;
}

/** The identity line of commits the forge makes itself. */
export function ident(sec: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${sec} +0000`;
}

let nextRepoId = 100_000;
let nextIssueId = 2_000_000;
let nextCommentId = 3_000_000;
let nextLabelId = 4_000_000;

function nodeId(prefix: string, id: number): string {
  return `${prefix}_kwDO${Buffer.from(`${prefix}:${id}`).toString('base64url')}`;
}

export interface Label {
  t: 'Label';
  id: number;
  nodeId: string;
  name: string;
  color: string;
  description: string | null;
  json: string;
}

export interface Comment {
  t: 'IssueComment';
  id: number;
  nodeId: string;
  body: string;
  createdAt: string;
  issue: Issue;
}

export interface Issue {
  t: 'Issue';
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  stateReason: string | null;
  labels: Label[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  repo: Repo;
  /** The issue's JSON, rebuilt only when the issue changes. */
  json: string | null;
  /** The whole GET response, rebuilt only when the issue changes. */
  resp: Buffer | null;
}

export interface Pull {
  t: 'PullRequest';
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  head: string;
  base: string;
  /** Tips frozen at merge or close time; null while open (the live branch tips are read instead). */
  headSha: string | null;
  baseSha: string | null;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
  repo: Repo;
}

export interface Repo {
  t: 'Repository';
  id: number;
  nodeId: string;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
  deleted: boolean;
  /** Smart-HTTP caches, dropped whenever a ref moves. */
  advUpload0: Buffer | null;
  advReceive: Buffer | null;
  lsRefs: Map<string, Buffer>;
}

export const repos = new Map<string, Repo>();
export const reposByNode = new Map<string, Repo>();
export const issuesByNode = new Map<string, Issue>();
export const pullsByNode = new Map<string, Pull>();
/** Exact request paths of GET issue, mapped to the issue: the read workload's one-lookup path. */
export const issueByPath = new Map<string, Issue>();

export function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export function findRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

export function createRepo(name: string, description: string | null, isPrivate: boolean): Repo {
  const now = iso(nextTime());
  const id = (nextRepoId += 1);
  const repo: Repo = {
    t: 'Repository',
    id,
    nodeId: `R_kgDO${Buffer.from(`repo:${id}`).toString('base64url')}`,
    owner: VIEWER.login,
    name,
    fullName: `${VIEWER.login}/${name}`,
    description,
    private: isPrivate,
    defaultBranch: 'main',
    createdAt: now,
    updatedAt: now,
    pushedAt: null,
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextNumber: 1,
    deleted: false,
    advUpload0: null,
    advReceive: null,
    lsRefs: new Map(),
  };
  repos.set(repoKey(repo.owner, name), repo);
  reposByNode.set(repo.nodeId, repo);
  return repo;
}

export function deleteRepo(repo: Repo): void {
  repo.deleted = true;
  repos.delete(repoKey(repo.owner, repo.name));
  reposByNode.delete(repo.nodeId);
  for (const issue of repo.issues.values()) issuesByNode.delete(issue.nodeId);
  for (const pull of repo.pulls.values()) pullsByNode.delete(pull.nodeId);
  for (const [path, issue] of issueByPath) if (issue.repo === repo) issueByPath.delete(path);
}

/** Move (or delete, with null) a ref, dropping every cache that depends on the refs. */
export function setRef(repo: Repo, ref: string, oid: string | null): void {
  if (oid === null || oid === ZERO) repo.refs.delete(ref);
  else repo.refs.set(ref, oid);
  repo.advUpload0 = null;
  repo.advReceive = null;
  if (repo.lsRefs.size > 0) repo.lsRefs.clear();
}

export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

/** Commit `tree` on `branch` (parent: its tip, if any) as the viewer; answers the commit id. */
export function commitOnBranch(repo: Repo, branch: string, tree: string, message: string, parents?: string[]): string {
  const tip = branchTip(repo, branch);
  const sec = nextTime();
  const commit = buildCommit(tree, parents ?? (tip === undefined ? [] : [tip]), message, ident(sec));
  setRef(repo, `refs/heads/${branch}`, commit);
  return commit;
}

// ---------------------------------------------------------------- issues, labels, comments

export function createLabel(repo: Repo, name: string, color: string, description: string | null): Label {
  const id = (nextLabelId += 1);
  const nid = nodeId('LA', id);
  const label: Label = {
    t: 'Label',
    id,
    nodeId: nid,
    name,
    color,
    description,
    json: `{"id":${id},"node_id":"${nid}","name":${JSON.stringify(name)},"color":${JSON.stringify(color)},"default":false,"description":${description === null ? 'null' : JSON.stringify(description)}}`,
  };
  repo.labels.set(name.toLowerCase(), label);
  return label;
}

export function createIssue(repo: Repo, title: string, body: string | null, labels: Label[]): Issue {
  const id = (nextIssueId += 1);
  const now = iso(nextTime());
  const issue: Issue = {
    t: 'Issue',
    id,
    nodeId: nodeId('I', id),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    stateReason: null,
    labels,
    comments: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    repo,
    json: null,
    resp: null,
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  issuesByNode.set(issue.nodeId, issue);
  issueByPath.set(`/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`, issue);
  return issue;
}

export function touchIssue(issue: Issue): void {
  issue.updatedAt = iso(nextTime());
  issue.json = null;
  issue.resp = null;
}

export function setIssueState(issue: Issue, state: 'open' | 'closed', reason: string | null): void {
  if (issue.state === state) return;
  issue.state = state;
  touchIssue(issue);
  issue.closedAt = state === 'closed' ? issue.updatedAt : null;
  issue.stateReason = state === 'closed' ? reason ?? 'completed' : reason === null ? null : 'reopened';
}

export function addComment(target: Issue | Pull, body: string): Comment {
  const id = (nextCommentId += 1);
  const comment: Comment = {
    t: 'IssueComment',
    id,
    nodeId: nodeId('IC', id),
    body,
    createdAt: iso(nextTime()),
    issue: target as Issue,
  };
  target.comments.push(comment);
  if (target.t === 'Issue') touchIssue(target);
  return comment;
}

export function issueJson(issue: Issue): string {
  if (issue.json !== null) return issue.json;
  let labels = '';
  for (let i = 0; i < issue.labels.length; i += 1) labels += (i === 0 ? '' : ',') + issue.labels[i].json;
  issue.json = `{"id":${issue.id},"node_id":"${issue.nodeId}","number":${issue.number},"title":${JSON.stringify(issue.title)},"user":${USER_JSON},"labels":[${labels}],"state":"${issue.state}","locked":false,"assignee":null,"assignees":[],"comments":${issue.comments.length},"created_at":"${issue.createdAt}","updated_at":"${issue.updatedAt}","closed_at":${issue.closedAt === null ? 'null' : `"${issue.closedAt}"`},"author_association":"OWNER","state_reason":${issue.stateReason === null ? 'null' : `"${issue.stateReason}"`},"body":${issue.body === null ? 'null' : JSON.stringify(issue.body)}}`;
  return issue.json;
}

export function commentJson(c: Comment): string {
  return `{"id":${c.id},"node_id":"${c.nodeId}","body":${JSON.stringify(c.body)},"user":${USER_JSON},"created_at":"${c.createdAt}","updated_at":"${c.createdAt}","author_association":"OWNER"}`;
}

// ---------------------------------------------------------------- pulls

export function createPull(repo: Repo, title: string, body: string | null, head: string, base: string): Pull {
  const id = (nextIssueId += 1);
  const now = iso(nextTime());
  const pull: Pull = {
    t: 'PullRequest',
    id,
    nodeId: nodeId('PR', id),
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    head,
    base,
    headSha: null,
    baseSha: null,
    merged: false,
    mergedAt: null,
    mergeSha: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
    repo,
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  pullsByNode.set(pull.nodeId, pull);
  return pull;
}

export function pullHeadSha(pull: Pull): string {
  return pull.headSha ?? branchTip(pull.repo, pull.head) ?? ZERO;
}

export function pullBaseSha(pull: Pull): string {
  return pull.baseSha ?? branchTip(pull.repo, pull.base) ?? ZERO;
}

function repoMini(repo: Repo): string {
  return `{"id":${repo.id},"node_id":"${repo.nodeId}","name":${JSON.stringify(repo.name)},"full_name":${JSON.stringify(repo.fullName)},"private":${repo.private},"owner":${USER_JSON},"default_branch":"${repo.defaultBranch}"}`;
}

export function pullJson(pull: Pull): string {
  const repo = pull.repo;
  const mini = repoMini(repo);
  const ref = (name: string, sha: string): string =>
    `{"label":${JSON.stringify(`${repo.owner}:${name}`)},"ref":${JSON.stringify(name)},"sha":"${sha}","user":${USER_JSON},"repo":${mini}}`;
  return `{"id":${pull.id},"node_id":"${pull.nodeId}","number":${pull.number},"state":"${pull.state}","locked":false,"title":${JSON.stringify(pull.title)},"user":${USER_JSON},"body":${pull.body === null ? 'null' : JSON.stringify(pull.body)},"labels":[],"created_at":"${pull.createdAt}","updated_at":"${pull.updatedAt}","closed_at":${pull.closedAt === null ? 'null' : `"${pull.closedAt}"`},"merged_at":${pull.mergedAt === null ? 'null' : `"${pull.mergedAt}"`},"merge_commit_sha":${pull.mergeSha === null ? 'null' : `"${pull.mergeSha}"`},"draft":false,"head":${ref(pull.head, pullHeadSha(pull))},"base":${ref(pull.base, pullBaseSha(pull))},"author_association":"OWNER","merged":${pull.merged},"mergeable":${pull.state === 'open' ? 'true' : 'null'},"mergeable_state":"${pull.state === 'open' ? 'clean' : 'unknown'}","comments":${pull.comments.length}}`;
}

// ---------------------------------------------------------------- repositories

export function repoJson(repo: Repo): string {
  return `{"id":${repo.id},"node_id":"${repo.nodeId}","name":${JSON.stringify(repo.name)},"full_name":${JSON.stringify(repo.fullName)},"private":${repo.private},"owner":${USER_JSON},"description":${repo.description === null ? 'null' : JSON.stringify(repo.description)},"fork":false,"created_at":"${repo.createdAt}","updated_at":"${repo.updatedAt}","pushed_at":${repo.pushedAt === null ? 'null' : `"${repo.pushedAt}"`},"default_branch":"${repo.defaultBranch}","visibility":"${repo.private ? 'private' : 'public'}","has_issues":true,"archived":false,"disabled":false,"permissions":{"admin":true,"maintain":true,"push":true,"triage":true,"pull":true}}`;
}

export function userJsonFull(): string {
  return `{"login":${JSON.stringify(VIEWER.login)},"id":${VIEWER.id},"node_id":"${VIEWER.nodeId}","type":"User","site_admin":false,"name":${JSON.stringify(VIEWER.name)},"email":${JSON.stringify(VIEWER.email)}}`;
}

// ---------------------------------------------------------------- commits as REST shows them

function personOf(line: string): { name: string; email: string; date: string } {
  const lt = line.indexOf('<');
  const gt = line.indexOf('>', lt);
  const name = lt > 0 ? line.slice(0, lt).trim() : line;
  const email = lt >= 0 && gt > lt ? line.slice(lt + 1, gt) : '';
  const rest = gt > 0 ? line.slice(gt + 1).trim().split(' ') : [];
  const sec = Number(rest[0]);
  return { name, email, date: Number.isFinite(sec) ? iso(sec) : iso(EPOCH_SEC) };
}

export function commitJson(oid: string): string {
  const c = readCommit(oid);
  if (c === null) return 'null';
  const a = personOf(c.author);
  const m = personOf(c.committer);
  const parents = c.parents.map((p) => `{"sha":"${p}"}`).join(',');
  return `{"sha":"${oid}","node_id":"C_${oid.slice(0, 20)}","commit":{"author":${JSON.stringify(a)},"committer":${JSON.stringify(m)},"message":${JSON.stringify(c.message.replace(/\n$/, ''))},"tree":{"sha":"${c.tree}"}},"author":${USER_JSON},"committer":${USER_JSON},"parents":[${parents}]}`;
}

/** Commits reachable from `tip`, newest first (breadth first, as a log of a linear history reads). */
export function logFrom(tip: string, limit: number, skip = 0): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  for (let i = 0; i < queue.length && out.length < limit + skip; i += 1) {
    const c = queue[i];
    if (seen.has(c)) continue;
    seen.add(c);
    const o = commitOf(c);
    if (o === null) continue;
    out.push(c);
    for (const p of o.parents as string[]) queue.push(p);
  }
  return out.slice(skip, skip + limit);
}

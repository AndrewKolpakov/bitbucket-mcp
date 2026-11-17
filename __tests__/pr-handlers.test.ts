import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { AddressInfo } from "node:net";
import path from "node:path";

type Recorded = {
  method: string;
  path: string;
  query: string;
  body: any;
};
type Stub = { status: number; body?: unknown; headers?: Record<string, string> };

const root = process.cwd();
const requests: Recorded[] = [];
let stubs: Array<{ match: (r: Recorded) => boolean; stub: Stub }> = [];
let http: Server;
let child: ChildProcessWithoutNullStreams;
let nextId = 1;
const pending = new Map<number, (msg: any) => void>();

function respondWith(match: (r: Recorded) => boolean, stub: Stub) {
  stubs.unshift({ match, stub });
}
const is = (method: string, p: string) => (r: Recorded) =>
  r.method === method && r.path === p;

let baseUrl = "";

function reset() {
  requests.length = 0;
  stubs = [];
}

function send(msg: object) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

function request(method: string, params: object): Promise<any> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 10000);
    pending.set(id, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

/** Returns {result} on success or {error} on a JSON-RPC / isError failure. */
async function call(name: string, args: object) {
  const msg = await request("tools/call", { name, arguments: args });
  if (msg.error) return { error: msg.error.message as string, code: msg.error.code as number };
  if (msg.result?.isError) {
    return { error: msg.result.content?.[0]?.text as string, code: undefined as number | undefined };
  }
  const text = msg.result.content?.[0]?.text as string;
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { result: json, text, error: undefined as string | undefined, code: undefined as number | undefined };
}

const PR = "/repositories/ws/r/pullrequests/5";

beforeAll(async () => {
  http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: any;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const rec: Recorded = {
        method: req.method ?? "",
        path: url.pathname,
        query: url.search.replace(/^\?/, ""),
        body,
      };
      requests.push(rec);
      const hit = stubs.find((s) => s.match(rec));
      const stub = hit?.stub ?? { status: 200, body: {} };
      res.writeHead(stub.status, {
        "content-type": "application/json",
        ...(stub.headers ?? {}),
      });
      res.end(stub.body === undefined ? "" : JSON.stringify(stub.body));
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;

  child = spawn(
    process.execPath,
    [path.join(root, "node_modules/tsx/dist/cli.mjs"), "src/index.ts"],
    {
      cwd: root,
      env: {
        ...process.env,
        BITBUCKET_URL: `http://127.0.0.1:${port}`,
        BITBUCKET_USERNAME: "u",
        BITBUCKET_PASSWORD: "p",
        BITBUCKET_WORKSPACE: "ws",
        BITBUCKET_LOG_DISABLE: "true",
        BITBUCKET_TOKEN: "",
      },
    }
  );
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {
        /* ignore non-JSON output */
      }
    }
  });
  child.stderr.on("data", () => {});

  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "jest", version: "0" },
  });
  expect(init.result).toBeDefined();
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
}, 20000);

afterAll(async () => {
  child?.kill("SIGKILL");
  await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
});

beforeEach(reset);

describe("request / unrequest changes", () => {
  it("POSTs and DELETEs request-changes", async () => {
    await call("requestChangesPullRequest", { workspace: "ws", repo_slug: "r", pull_request_id: "5" });
    await call("unrequestChangesPullRequest", { workspace: "ws", repo_slug: "r", pull_request_id: "5" });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `POST ${PR}/request-changes`,
      `DELETE ${PR}/request-changes`,
    ]);
  });
});

describe("updatePullRequest", () => {
  const current = {
    reviewers: [
      { uuid: "{A}", account_id: "acc-A" },
      { uuid: "{C}", account_id: "acc-C" },
    ],
  };

  it("GETs then PUTs the merged reviewers and only the given fields", async () => {
    respondWith(is("GET", PR), { status: 200, body: current });
    respondWith(is("PUT", PR), { status: 200, body: { id: 5 } });
    const out = await call("updatePullRequest", {
      workspace: "ws",
      repo_slug: "r",
      pull_request_id: "5",
      addReviewers: ["{B}"],
      removeReviewers: ["acc-A"],
      destinationBranch: "dev",
      closeSourceBranch: false,
    });
    expect(out.error).toBeUndefined();
    expect(requests.map((r) => r.method)).toEqual(["GET", "PUT"]);
    const body = requests[1].body;
    expect(body.reviewers).toEqual([{ uuid: "{C}" }, { uuid: "{B}" }]);
    expect(body.destination).toEqual({ branch: { name: "dev" } });
    expect(body.close_source_branch).toBe(false);
    expect("title" in body).toBe(false);
    expect("description" in body).toBe(false);
  });

  it("rejects an unmatched removal with InvalidParams and sends no PUT", async () => {
    respondWith(is("GET", PR), { status: 200, body: current });
    const out = await call("updatePullRequest", {
      workspace: "ws",
      repo_slug: "r",
      pull_request_id: "5",
      removeReviewers: ["acc-nobody"],
    });
    expect(out.error).toMatch(/acc-nobody/);
    expect(out.code).toBe(-32602);
    expect(requests.some((r) => r.method === "PUT")).toBe(false);
  });
});

describe("mergePullRequest", () => {
  it("passes async/strategy/closeSourceBranch and surfaces the task id on 202", async () => {
    respondWith(is("POST", `${PR}/merge`), {
      status: 202,
      headers: { Location: `http://127.0.0.1/repositories/ws/r/pullrequests/5/merge/task-status/task-1` },
    });
    const out = await call("mergePullRequest", {
      workspace: "ws",
      repo_slug: "r",
      pull_request_id: "5",
      async: true,
      closeSourceBranch: false,
      strategy: "squash",
    });
    expect(requests[0].query).toBe("async=true");
    expect(requests[0].body).toEqual({ merge_strategy: "squash", close_source_branch: false });
    expect(out.result.task_id).toBe("task-1");
  });

  it("returns null task id when Location is missing", async () => {
    respondWith(is("POST", `${PR}/merge`), { status: 202 });
    const out = await call("mergePullRequest", {
      workspace: "ws",
      repo_slug: "r",
      pull_request_id: "5",
      async: true,
    });
    expect(out.result.task_id).toBeNull();
    expect(out.result.task_status_url).toBeNull();
    expect(out.result.message).toMatch(/getPullRequest/);
  });

  it("returns the PR on a 200", async () => {
    respondWith(is("POST", `${PR}/merge`), { status: 200, body: { id: 5, state: "MERGED" } });
    const out = await call("mergePullRequest", { workspace: "ws", repo_slug: "r", pull_request_id: "5" });
    expect(out.result).toEqual({ id: 5, state: "MERGED" });
  });
});

describe("getPullRequestMergeTaskStatus", () => {
  it("GETs the task-status path", async () => {
    respondWith(is("GET", `${PR}/merge/task-status/task-1`), {
      status: 200,
      body: { task_status: "PENDING" },
    });
    const out = await call("getPullRequestMergeTaskStatus", {
      workspace: "ws",
      repo_slug: "r",
      pull_request_id: "5",
      task_id: "task-1",
    });
    expect(requests[0].method).toBe("GET");
    expect(requests[0].path).toBe(`${PR}/merge/task-status/task-1`);
    expect(out.result.task_status).toBe("PENDING");
  });
});

describe("getPullRequestsForCommit", () => {
  const p = "/repositories/ws/r/commit/abc123/pullrequests";
  const args = { workspace: "ws", repo_slug: "r", commit: "abc123" };

  it("reports indexing on 202", async () => {
    respondWith(is("GET", p), { status: 202 });
    const out = await call("getPullRequestsForCommit", args);
    expect(out.result.indexing).toBe(true);
  });

  it("reports indexing when a later page answers 202 (all=true)", async () => {
    respondWith((r) => r.method === "GET" && r.path === p && r.query.includes("page=2"), { status: 202 });
    respondWith((r) => r.method === "GET" && r.path === p && !r.query.includes("page=2"), {
      status: 200,
      body: { values: [{ id: 7 }], next: `${baseUrl}${p}?pagelen=10&page=2` },
    });
    const out = await call("getPullRequestsForCommit", { ...args, all: true });
    expect(out.result.indexing).toBe(true);
    expect(out.result.values).toEqual([]);
  });

  it("explains a 404", async () => {
    respondWith(is("GET", p), { status: 404, body: { error: { message: "nf" } } });
    const out = await call("getPullRequestsForCommit", args);
    expect(out.error).toMatch(/Pull Request Commit Links/);
  });

  it("returns values on 200", async () => {
    respondWith(is("GET", p), { status: 200, body: { values: [{ id: 7 }], pagelen: 1 } });
    const out = await call("getPullRequestsForCommit", args);
    expect(out.error).toBeUndefined();
    expect(out.text).toContain('"id": 7');
  });
});

describe("getUserPullRequests", () => {
  it("uses selected_user, repeated state params and pagelen", async () => {
    respondWith((r) => r.path.startsWith("/workspaces/ws/pullrequests/"), {
      status: 200,
      body: { values: [{ id: 1 }], pagelen: 5 },
    });
    const out = await call("getUserPullRequests", {
      selected_user: "{U}",
      state: ["OPEN", "MERGED"],
      pagelen: 5,
    });
    expect(out.error).toBeUndefined();
    const r = requests[0];
    expect(r.method).toBe("GET");
    expect(r.path).toBe("/workspaces/ws/pullrequests/%7BU%7D");
    expect(r.query).toContain("state=OPEN&state=MERGED");
    expect(r.query).toContain("pagelen=5");
    expect(r.query).not.toContain("state[]");
    expect(r.query).not.toContain("state%5B%5D");
  });

  it("looks up GET /user first when selected_user is omitted", async () => {
    respondWith(is("GET", "/user"), { status: 200, body: { uuid: "{ME}" } });
    respondWith((r) => r.path.startsWith("/workspaces/ws/pullrequests/"), {
      status: 200,
      body: { values: [] },
    });
    await call("getUserPullRequests", {});
    expect(requests[0].path).toBe("/user");
    expect(requests[1].path).toBe("/workspaces/ws/pullrequests/%7BME%7D");
  });
});

describe("createPullRequest close_source_branch", () => {
  const base = {
    workspace: "ws",
    repo_slug: "r",
    title: "t",
    description: "d",
    sourceBranch: "feat",
    targetBranch: "main",
  };
  it("defaults to true and honours false", async () => {
    respondWith(is("POST", "/repositories/ws/r/pullrequests"), { status: 201, body: { id: 9 } });
    await call("createPullRequest", base);
    await call("createPullRequest", { ...base, closeSourceBranch: false });
    const posts = requests.filter((r) => r.method === "POST");
    expect(posts[0].body.close_source_branch).toBe(true);
    expect(posts[1].body.close_source_branch).toBe(false);
  });
});

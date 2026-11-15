// Development tool (never run by the grader): time the kit's four benchmark workloads against the forge.
//
//   node tools/bench.ts <kit dir> [base URL] [--runs N] [--only push,clone,read,write] [--node-args "..."]
//
// With a base URL it benchmarks a forge that is already running. Without one it plays the env: it
// serves /register and /done on a loopback port, starts `node main.ts` with MAKEFUN_ENV_URL pointing at
// it, waits for the register, runs the kit's runBenchmark (sdk/conformance/bench.ts) and prints each
// workload's p50, then answers {"done":true} so the forge exits.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) {
    flags.set(argv[i].slice(2), argv[i + 1] ?? '');
    i += 1;
  } else positional.push(argv[i]);
}
const kit = positional[0];
if (kit === undefined) {
  process.stderr.write('usage: node tools/bench.ts <kit dir> [base URL] [--runs N] [--only push,clone,read,write]\n');
  process.exit(2);
}
const runs = Number(flags.get('runs') ?? '1');
const only = flags.get('only')?.split(',').filter((s) => s !== '');
const token = process.env.MAKEFUN_SHOP_TOKEN ?? 'bench-token';

const benchUrl = pathToFileURL(join(resolve(kit), 'sdk', 'conformance', 'bench.ts')).href;
const { runBenchmark } = (await import(benchUrl)) as {
  runBenchmark: (o: Record<string, unknown>) => Promise<{ workloads: { name: string; p50_ms: number; points: number; rounds: number[]; error?: string }[]; points_total: number }>;
};

let baseUrl = positional[1];
let finish = (): void => undefined;

if (baseUrl === undefined) {
  let done = false;
  let registered: (url: string) => void = () => undefined;
  const ready = new Promise<string>((r) => {
    registered = r;
  });
  const envServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/register') {
        const port = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { port: number }).port;
        registered(`http://127.0.0.1:${port}`);
        res.end('{"ok":true}');
      } else if (req.url === '/done') {
        res.end(JSON.stringify({ done }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  await new Promise<void>((r) => envServer.listen(0, '127.0.0.1', () => r()));
  const envPort = (envServer.address() as { port: number }).port;
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const nodeArgs = (flags.get('node-args') ?? '').split(' ').filter((s) => s !== '');
  const child = spawn(process.execPath, [...nodeArgs, join(root, 'main.ts')], {
    env: { ...process.env, MAKEFUN_ENV_URL: `http://127.0.0.1:${envPort}`, MAKEFUN_SHOP_TOKEN: token },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  baseUrl = await ready;
  finish = () => {
    done = true;
    setTimeout(() => {
      child.kill();
      envServer.close();
    }, 8000).unref();
  };
}

const totals: Record<string, number[]> = {};
for (let run = 0; run < runs; run += 1) {
  const perf = await runBenchmark({ baseUrl, token, workloads: only });
  const line: string[] = [];
  for (const w of perf.workloads) {
    (totals[w.name] ??= []).push(w.p50_ms);
    line.push(`${w.name} ${w.p50_ms.toFixed(1)} ms (${w.points} pts)${w.error === undefined ? '' : ` ERROR ${w.error}`}`);
  }
  process.stdout.write(`run ${run + 1}: ${line.join(' | ')} | total ${perf.points_total}\n`);
}
if (runs > 1) {
  const median = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  process.stdout.write(`median: ${Object.entries(totals).map(([k, v]) => `${k} ${median(v).toFixed(1)} ms`).join(' | ')}\n`);
}
finish();

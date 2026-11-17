import { spawn } from "node:child_process";

export interface DockerRunOptions {
  /** Text written to the process stdin, then closed. Never put secrets in argv. */
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface DockerRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** The only door to Docker. Implementations must never invoke a shell. */
export interface DockerCli {
  run(args: string[], opts: DockerRunOptions): Promise<DockerRunResult>;
}

export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** Real adapter: `docker <args>` through spawn with shell disabled. */
export class SpawnDockerCli implements DockerCli {
  constructor(private readonly options: { binary?: string; maxOutputChars?: number } = {}) {}

  run(args: string[], opts: DockerRunOptions): Promise<DockerRunResult> {
    const max = this.options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_BYTES;
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve({ exitCode, stdout, stderr, timedOut });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.options.binary ?? "docker", args, {
          shell: false,
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch (error) {
        stderr = String((error as Error).message);
        resolve({ exitCode: -1, stdout, stderr, timedOut });
        return;
      }
      // Keep the tail: the end of the output is the most useful part.
      const append = (current: string, chunk: Buffer) => {
        const next = current + chunk.toString("utf8");
        return next.length > max ? next.slice(next.length - max) : next;
      };
      child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      const kill = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
      const timer = setTimeout(() => { timedOut = true; kill(); }, Math.max(1, opts.timeoutMs));
      const onAbort = () => kill();
      if (opts.signal?.aborted) kill();
      else opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error) => {
        stderr = append(stderr, Buffer.from(String(error.message)));
        finish(-1);
      });
      child.on("close", (code, signal) => finish(code ?? (signal ? 137 : -1)));
      child.stdin?.on("error", () => { /* process exited before reading stdin */ });
      if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
      else child.stdin?.end();
    });
  }
}

export interface FakeCall {
  args: string[];
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

type Responder = Partial<DockerRunResult> | ((call: FakeCall) => Partial<DockerRunResult> | Promise<Partial<DockerRunResult>>);

/** Test double: records calls and answers with programmable rules. */
export class FakeDockerCli implements DockerCli {
  readonly calls: FakeCall[] = [];
  private readonly rules: Array<{ match: (args: string[]) => boolean; response: Responder; once: boolean }> = [];

  /** Rules are checked newest first. `match` is a prefix of argv or a predicate. */
  when(match: string[] | ((args: string[]) => boolean), response: Responder, options: { once?: boolean } = {}): this {
    const predicate = typeof match === "function"
      ? match
      : (args: string[]) => match.every((part, index) => args[index] === part);
    this.rules.unshift({ match: predicate, response, once: options.once ?? false });
    return this;
  }

  async run(args: string[], opts: DockerRunOptions): Promise<DockerRunResult> {
    const call: FakeCall = { args: [...args], stdin: opts.stdin, timeoutMs: opts.timeoutMs, signal: opts.signal };
    this.calls.push(call);
    const index = this.rules.findIndex((rule) => rule.match(args));
    let partial: Partial<DockerRunResult> = {};
    if (index >= 0) {
      const rule = this.rules[index]!;
      if (rule.once) this.rules.splice(index, 1);
      partial = typeof rule.response === "function" ? await rule.response(call) : rule.response;
    }
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...partial };
  }

  /** Calls whose argv starts with the given prefix. */
  callsMatching(prefix: string[]): FakeCall[] {
    return this.calls.filter((call) => prefix.every((part, index) => call.args[index] === part));
  }
}

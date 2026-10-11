#!/usr/bin/env node
/**
 * The Chess bot: an agent on the Ghostly CLI plays Chess with a contact, in the contact's own Chess app.
 *
 *   npm run bot -- invite <chat> [--time 10+0] [--level 2]     invite the contact to a game, and play it
 *   npm run bot -- play <chat> [--level 2]                     wait for the contact's invitation, and play it
 *
 * (`npm run bot` builds `bot/dist/main.mjs` first, bot/vite.config.ts: Node does not run the app's TypeScript as it is.)
 *
 * It needs a Ghostly daemon whose profile serves Chess with `chat` granted:
 *   ghostly app serve <app.ghostlyapp or its URL> --grant chat --grant name
 *   ghostly daemon restart
 * See bot/README.md. One line of JSON is printed for each thing the bot does.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ChessController } from "../src/game.ts";
import type { TimeControl } from "../src/protocol.ts";
import { DaemonBroker, fileStore } from "./broker.ts";
import { connectDaemon, DaemonError, type Daemon, type DaemonEvent } from "./daemon.ts";
import { LEVELS, type Level } from "./engine.ts";
import { Player, type Policy, type Said } from "./player.ts";

const USAGE = `usage: npm run bot -- invite <chat> [--time <minutes>+<increment seconds> | --time unlimited] [options]
       npm run bot -- play <chat> [options]

  --level <0-3>         how well it plays: 0 any legal move, 1 one ply, 2 two plies (default), 3 three
  --time <m+s>          invite: the clock, minutes and increment in seconds (default 10+0), or unlimited
  --no-takebacks        refuse the contact's takebacks
  --once                leave when the game is over (default: stay for a rematch)
  --think <ms>          a pause before each move (default 600)
  --no-card             invite: send no app card (the contact has Chess open in this chat)
  --app <ref|name>      the served app (default chess)
  --ghostly <command>   the ghostly command (default ghostly)
  --home <dir>          the Ghostly home, as ghostly --home
  --profile <name>      the profile, as ghostly --profile
  --socket <path>       the daemon's socket (default: asked of ghostly daemon status)
  --state <dir>         where the games are kept (default ~/.local/state/ghostly-chess-bot)`;

class UsageError extends Error {}

/** `10+0`, `3+2`, `0.5+0`: minutes and an increment in seconds, within what the protocol carries. `unlimited`: no clock. */
export function timeControl(text: string): TimeControl | "unlimited" {
  if (text === "unlimited") return "unlimited";
  const match = /^(\d+(?:\.\d+)?)\+(\d+)$/.exec(text);
  const base = match ? Math.round(Number(match[1]) * 60) : NaN, increment = match ? Number(match[2]) : NaN;
  if (!(base >= 15 && base <= 10800 && increment >= 0 && increment <= 60))
    throw new UsageError(`--time takes minutes+increment, like 10+0 or 3+2 (15 seconds to 3 hours, an increment up to 60 seconds), or unlimited, not ${JSON.stringify(text)}`);
  return [base, increment];
}

export interface Options { mode: "invite" | "play"; chat: string; policy: Policy; once: boolean; card: boolean; app: string; ghostly: string; home?: string; profile?: string; socket?: string; state: string }

export function options(argv: string[]): Options {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      level: { type: "string" }, time: { type: "string" }, "no-takebacks": { type: "boolean" }, once: { type: "boolean" }, think: { type: "string" },
      "no-card": { type: "boolean" }, app: { type: "string" }, ghostly: { type: "string" }, home: { type: "string" }, profile: { type: "string" },
      socket: { type: "string" }, state: { type: "string" },
    } });
  } catch (error) { throw new UsageError(error instanceof Error ? error.message : String(error)); }
  const { values, positionals } = parsed;
  const [mode, chat, ...rest] = positionals;
  if ((mode !== "invite" && mode !== "play") || !chat || rest.length) throw new UsageError("Name what to do and the chat: invite <chat> or play <chat>");
  const level = Number(values.level ?? 2);
  if (!(LEVELS as readonly number[]).includes(level)) throw new UsageError(`--level is 0, 1, 2 or 3, not ${JSON.stringify(values.level)}`);
  const think = Number(values.think ?? 600);
  if (!(Number.isInteger(think) && think >= 0 && think <= 60_000)) throw new UsageError(`--think is a pause in ms, 0 to 60000, not ${JSON.stringify(values.think)}`);
  if (mode === "play" && values.time !== undefined) throw new UsageError("--time is the inviter's to choose: play takes the contact's invitation as it comes");
  return {
    mode, chat, once: values.once === true, card: values["no-card"] !== true, app: values.app ?? "chess", ghostly: values.ghostly ?? "ghostly",
    home: values.home, profile: values.profile, socket: values.socket,
    state: values.state ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "ghostly-chess-bot"),
    policy: { level: level as Level, accept: true, takebacks: values["no-takebacks"] !== true, thinkMs: think, ...(mode === "invite" && { invite: timeControl(values.time ?? "10+0") }) },
  };
}

const print = (line: Record<string, unknown>) => process.stdout.write(JSON.stringify(line) + "\n");

/** Where the profile's daemon listens, asked of the `ghostly` command (the path is not one to guess: WISP 1100). */
function socketOf(o: Options): string {
  if (o.socket) return o.socket;
  const args = [...(o.home ? ["--home", o.home] : []), ...(o.profile ? ["--profile", o.profile] : []), "daemon", "status"];
  let status: { running?: boolean; socket?: string };
  try { status = JSON.parse(execFileSync(o.ghostly, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim().split("\n").pop() ?? "{}") as typeof status; }
  catch (error) { throw new Error(`Could not ask ${o.ghostly} daemon status: ${error instanceof Error ? error.message : String(error)}`); }
  if (!status.running || !status.socket) throw new Error("No Ghostly daemon runs this profile: ghostly daemon start");
  return status.socket;
}

/** Opens Chess in the chat on `daemon` and plays by `o.policy`, until the daemon goes or (`--once`) a game is over. */
export async function run(daemon: Daemon, o: Options, say: (line: Record<string, unknown>) => void = print): Promise<{ done: Promise<void>; stop(): Promise<void> }> {
  const { apps, offered } = await daemon.call("app.served") as { apps: { ref: string; version: string; granted: string[] }[]; offered: boolean };
  const served = apps.filter((a) => a.ref === o.app || a.ref.split("/")[1] === o.app);
  if (served.length !== 1) throw new Error(`This profile does not serve ${o.app}: ghostly app serve <app.ghostlyapp> --grant chat --grant name, then ghostly daemon restart`);
  if (!offered) throw new Error("The daemon started before Chess was served: ghostly daemon restart");
  const app = served[0]!;
  const name = app.granted.includes("name") ? ((await daemon.call("status")) as { name?: string | null }).name ?? undefined : undefined;
  // The broker starts from what `app open` says of the contact. What the stream says from before that call on is kept
  // and handed to it, in order: when both sides open at once, the contact's open comes while the call is answered.
  const early: DaemonEvent[] = [];
  const collected = daemon.onEvent((event) => early.push(event));
  const opened = await daemon.call("app.open", { chat: o.chat, ref: app.ref, noCard: !o.card || o.mode === "play" }) as { chat: string; peer: string | null; card: string | null };
  const broker = new DaemonBroker(daemon, {
    chat: opened.chat, app: app.ref, version: app.version, peer: opened.peer, ...(name ? { name } : {}), store: fileStore(join(o.state, `${opened.chat}.json`)),
    refused: (reason) => say({ bot: "refused", reason }),
  });
  const controller = new ChessController(broker);
  collected();
  for (const event of early) broker.heard(event);
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  say({ bot: "opened", chat: opened.chat, app: app.ref, version: app.version, peer: opened.peer, card: opened.card !== null });
  const player = new Player(controller, o.policy, (said: Said) => {
    say({ bot: said.what, ...said, what: undefined });
    if (said.what === "over" && o.once) finish();
  });
  controller.onNotice((notice) => say({ bot: "notice", notice }));
  await controller.start();
  // The clocks' periodic work, as the page's ticker does it (src/ui.ts).
  const ticker = setInterval(() => void controller.tick().then(() => player.act()), 250);
  void player.act();
  return {
    done,
    stop: async () => {
      clearInterval(ticker);
      player.stop();
      await controller.settled().catch(() => {});
      controller.stop();
      await broker.close();
    },
  };
}

async function main(): Promise<number> {
  let o: Options;
  try { o = options(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 2;
  }
  let gone!: () => void;
  const daemonGone = new Promise<void>((resolve) => { gone = resolve; });
  const daemon = await connectDaemon(socketOf(o), gone);
  const game = await run(daemon, o);
  const signal = new Promise<void>((resolve) => { for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(name, () => resolve()); });
  const ended = await Promise.race([game.done.then(() => "over"), signal.then(() => "stopped"), daemonGone.then(() => "daemon-gone")]);
  if (ended !== "daemon-gone") await game.stop();
  daemon.close();
  print({ bot: "left", why: ended });
  return ended === "daemon-gone" ? 1 : 0;
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().then((code) => process.exit(code), (error: unknown) => {
    print({ bot: "error", message: error instanceof Error ? error.message : String(error), ...(error instanceof DaemonError && { code: error.code, reason: error.reason }) });
    process.exit(1);
  });
}

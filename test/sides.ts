/**
 * Two sides of one chat for the UI tests: each a mock broker, a controller, and (when asked) the page mounted on it.
 * The same moves as test/game.test.ts makes, without touching that file.
 */
import type { Square } from "chess.js";
import { ChessController, type Notice } from "../src/game.ts";
import { PrefsStore } from "../src/prefs.ts";
import { en, type Strings } from "../src/strings.ts";
import { mountChess } from "../src/ui.ts";
import { chatPair, MockBroker } from "./mockBroker.ts";

export interface Side {
  broker: MockBroker;
  game: ChessController;
  notices: Notice[];
  prefs: PrefsStore;
  root?: HTMLElement;
  unmount?: () => void;
}

export async function open(broker: MockBroker): Promise<Side> {
  broker.launch();
  const game = new ChessController(broker);
  const notices: Notice[] = [];
  game.onNotice((n) => notices.push(n));
  const prefs = new PrefsStore(broker);
  await prefs.load();
  await game.start();
  return { broker, game, notices, prefs };
}

/** Until no frame is on its way and both apps handled what they got. */
export async function settle(...sides: Side[]): Promise<void> {
  for (let idle = 0; idle < 3; ) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(sides.map((s) => s.game.settled()));
    idle = sides.every((s) => s.broker.inFlight === 0) ? idle + 1 : 0;
  }
}

/** Two open sides, colours tossed. */
export async function startChat(): Promise<{ ana: Side; bob: Side; white: Side; black: Side }> {
  const [a, b] = chatPair();
  const ana = await open(a);
  const bob = await open(b);
  await settle(ana, bob);
  const white = ana.game.view().me === "w" ? ana : bob;
  const black = white === ana ? bob : ana;
  return { ana, bob, white, black };
}

/** One side playing alone (opened outside a chat). */
export async function startAlone(): Promise<Side> {
  return open(new MockBroker("solo", "1.1.0", false));
}

/** Plays UCI plies through the controllers, each by the side to move. */
export async function play(sides: { white: Side; black?: Side }, ...plies: string[]): Promise<void> {
  for (const uci of plies) {
    const mover = !sides.black || sides.white.game.view().turn === "w" ? sides.white : sides.black;
    const ok = await mover.game.move(uci.slice(0, 2) as Square, uci.slice(2, 4) as Square, uci[4] as "q" | undefined);
    if (!ok) throw new Error(`${uci} was refused`);
    await settle(...[sides.white, sides.black].filter((s): s is Side => Boolean(s)));
  }
}

/** Mounts the page for a side, in a fresh root. */
export function mount(side: Side, strings: Strings = en): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  side.unmount = mountChess(root, side.game, strings, side.prefs);
  side.root = root;
  return root;
}

export const sq = (root: ParentNode, square: string) => root.querySelector<HTMLButtonElement>(`[data-square="${square}"]`)!;

/** A pointer event as a browser would send it, on a square (or any element). */
export function pointer(target: Element, type: string, x = 0, y = 0, pointerId = 1): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, pointerType: "mouse", button: 0, isPrimary: true, clientX: x, clientY: y }));
}

/** Lets the timers of a pointer sequence run (the click after a pointerup is skipped until then). */
export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

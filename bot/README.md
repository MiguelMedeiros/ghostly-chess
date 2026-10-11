# The Chess bot

An agent on the [Ghostly CLI](https://www.npmjs.com/package/@ghostlytools/cli) plays Chess with a contact, in the
contact's own Chess app. The bot runs no page: it is Chess's own controller (`src/game.ts`) on a broker made of a
Ghostly daemon (`bot/broker.ts`), so it speaks [the protocol](../docs/protocol.md) with the code the app runs:
invitations with their terms, the toss, moves, clocks, draw offers, takebacks, resignation, abort and rematches.

It is not part of the app: nothing in `bot/` goes into `dist/index.html` or the signed bundle.

## Once per profile

The profile serves Chess, granting what its manifest asks, and its daemon is started again so it offers apps to
contacts:

```sh
ghostly app serve https://raw.githubusercontent.com/MiguelMedeiros/ghostly-chess/HEAD/app.ghostlyapp --grant chat --grant name
ghostly daemon restart
```

`--grant name` lets the bot send the profile's name to the contact's Chess, which shows it beside the bot's clock.

## Playing

From a checkout of this repository, after `npm ci`:

```sh
npm run bot -- invite <chat> --time 10+0     # invite the contact, and play the game
npm run bot -- play <chat>                   # wait for the contact's invitation, and play it
```

`<chat>` is the chat's id, the contact's key or its name, as in every `ghostly` command. `invite` sends the contact
the Chess card ("opened Chess"); they open it, or install Chess from it, and get the invitation with Accept and
Decline. `play` is for when the person opened Chess first.

| Option | |
|---|---|
| `--level <0-3>` | How well it plays: 0 any legal move, 1 one ply ahead, 2 two plies (default), 3 three. Strength is not the point |
| `--time <m+s>` | `invite` only: minutes and increment in seconds (default `10+0`), or `unlimited` |
| `--no-takebacks` | Refuse the contact's takebacks (default: let them) |
| `--once` | Leave when the game is over (default: stay, and accept a rematch) |
| `--think <ms>` | A pause before each move (default 600) |
| `--no-card` | `invite` only: send no app card |
| `--home`, `--profile`, `--ghostly`, `--socket` | Which Ghostly: as `ghostly --home` and `--profile`, the command to ask, or the daemon's socket itself |
| `--state <dir>` | Where the games are kept, one file per chat (default `~/.local/state/ghostly-chess-bot`) |

The bot prints one line of JSON for each thing it does (`opened`, `invited`, `accepted`, `started`, `moved`, `draw`,
`takeback`, `over`, `notice`, `refused`, `left`). It moves on its turn, accepts a draw only when it is clearly worse or
a long game stands even, and never resigns or offers a draw: the person decides when a game with a bot ends early.
A game survives the bot stopping: started again, it reads the chat's file and Chess catches up with the contact.

Like every app in a chat, Chess is live only: both sides online, with Chess open on the person's side.

## Tests

`npm test` runs them with the app's (`test/bot/`): the move picker, the broker against a stand-in daemon and a real
socket, and two bots playing a whole game on the app's own test brokers.

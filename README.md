# Total Recall

A voice agent for money that remembers your people, and only pays for the truth it has not already learned.

You talk to it the way you would talk to a person. It answers from memory when memory can answer, reads the chain only when memory cannot, and buys a name from a paid index only when neither of those worked. Every step is shown, and every step that cost money says so.

## The loop

```
you ask
  → Walrus memory is read first          free, 2 to 4 seconds
  → Tatum is read only if memory is empty free, but rate limited and slow
  → the paid index is bought only if the address is still nameless
                                        costs 0.01 USDC, and the receipt is stored
  → the answer is spoken back
```

The point of the build is the order. A wallet explorer answers every question by reading the chain. This one tries to never read the chain twice for the same fact, and the cost meter on the page proves it.

## The four tracks

| Track | What it does here |
| --- | --- |
| Tatum | Every chain read. Balances, transactions, counterparty history, on both mainnet and testnet, through the Sui GraphQL gateway. |
| Walrus Memory | The agent's long term memory. Names, notes and bought receipts live in per wallet namespaces on mainnet, so a fresh session already knows who Sana is. |
| Voice | A real call page. You choose the language, the voice and the pace, then talk. Microphone level drives the ribbon, the answer is spoken back, and it listens again after every turn. |
| Payments | x402 style two stage payment over Sui. The paid index charges for a name, the agent quotes, your wallet signs, and the receipt is written to memory so the same name is never bought twice. |

## Run it

```bash
npm install
cp .env.example .env      # then fill in the keys
npm run live              # real model, the model's own voice, payments on
```

Open http://127.0.0.1:8787. With a key in `.env` the brain is a live Gemini model making real function calls against the twelve tools, and the answer comes back in the model's own voice. No key? Nothing is lost:

```bash
npm run demo              # stub brain on 8899, app on 8787
```

`npm run demo` routes the same turns through a rule based stub in `src/stub-model.ts`, so the whole product can be reviewed offline on the same tools. The header prints which brain is answering, and it never claims to be Gemini when it is not.

```bash
npm run serve             # the live brain, payments left as .env has them
npm run chat              # the same agent in your terminal
npm run plumb             # every provider checked end to end
npm run selftest          # the tool loop, against a scripted model, offline
npm run selftest:live     # the same loop against the real model, and its spoken numbers checked against the chain
npm run voicetest         # the speech path, plus one real audio call when a key exists
```

`MODEL_NAME` is a chain, `gemini-3.1-flash-lite` then `gemini-3.5-flash`. The first makes the same tool calls in about a second instead of about twenty, and the second is what answers when the free tier returns a 503. The twelve tools are what carry the accuracy, not the model size.

## Pages

| Path | What it is |
| --- | --- |
| `/` | The whole product on one page. The cost ledger, the annotated payment ticket and the service hub are clickable. |
| `/app` | The agent. Transcript, balances, the people it knows, and a strip that lights up to show which source answered. |
| `/call` | The voice call. One open socket with audio both ways, the model closes its own sentences, and talking over it cuts it off. |
| `/report` | The statement card. Total out, month bars, the people paid and what it cost to learn them, saved as a PNG, a PDF or a CSV. |
| `/memory` | What is stored on Walrus, per namespace, with the search box that reads it. |
| `/pay` | The signing page. Nothing moves without your wallet approving it. |
| `/features` | Every capability on one sheet, each tile marked live, waiting on your wallet, or waiting on a key. The counts are measured from the tiles and the header state, so the page cannot drift into overclaiming. |
| `/how` | What is finished and what is not. |
| `/life` | The same mechanics described as scenes from an ordinary week. |

## Tools the model can call

`people_you_know` `who_is_this` `money_history` `monthly_summary` `name_a_person` `find_person` `remember_this` `what_do_i_remember` `memory_stats` `make_report` `pay_usdc` `paid_lookup`

`money_history` takes an optional `person`, so "how much have I sent Imran" answers about Imran and not about everybody.

`find_person` forgives a microphone, because a call hears "Sana" as "Sauna" often enough to matter, and returns the stored name with a confidence below one so the agent asks instead of assuming. `pay_usdc` deliberately does not use that matcher. Reading memory can afford a guess, spending real USDC on a guess cannot.

## Giving the demo a history

Cadence is a real measurement, so it needs transfers on different days. The seeder is day gated and will not pay the same person twice in one UTC day.

```bash
npm run seed
```

It prints who was paid and the next date each person is due. Run it once a day and the rhythm appears: Sana every two days, Imran every three, Tara every four, and Dev paying you back so one relationship reads as two way rather than a donation.

## What is finished

- Chain reads through Tatum on mainnet and testnet, with 429 and retry handling.
- Walrus memory writes and recalls, namespaced per wallet so one person's memories never leak into another's.
- The paid index and the paying agent, both halves of x402, with quotes, a stuck journal and stored receipts.
- Browser wallet connection through the Wallet Standard handshake, and the wallet signature as the payment confirmation.
- A live voice call. Microphone bytes go to the server, the server holds the socket to the model, and audio, transcripts and tool calls come back over one event stream. Nothing new was installed to do it, so there is no WebSocket library in this project.
- The model's own voice on `/speak`, real audio that drives the ribbon, and the same voice answers a typed question.
- Tool results carried forward inside the conversation, so an address the agent already paid to learn is visible to it on the next turn.
- A statement card typeset from the same tool calls that answer a spoken question, exported as PNG, PDF or CSV. It is vector text rather than a generated picture, because an image model draws convincing paper and unreliable digits.
- The model chain in `MODEL_NAME`, tried in order on one key, so a 503 or a 429 from a free tier moves to the next name instead of ending the turn.
- Nine pages, all of them working against the live server.

## What is not

- The live call has never been run through a real microphone. Every byte of it has been driven from a script against the app's own routes, including a spoken question resampled to 16 kHz, so the server half is proven and the browser capture is not.
- Only one call at a time can hold the wallet, because `src/session.ts` keeps one global session rather than one per visitor.
- Cadence needs several days of seeded history before it can say "about every three days" instead of "most recently today".
- Inbound money is invisible to `address.transactions`, which only links the signer. A counterparty's side has to be read to see money coming in, and that is what `src/knowledge.ts` does.

## Layout

```
src/
  server.ts      the only process that holds keys, tools and HTTP
  brain.ts       one OpenAI compatible path for Gemini, OpenRouter or OpenAI
  speech.ts      the model's own voice, and the honest answer when there is no key
  stub-model.ts  the rule based brain the demo runs on
  tools.ts       the twelve tools and their schemas
  live.ts        the two way audio socket, and the tool calls that run on it
  report.ts      the statement, and the vector card typeset from it
  knowledge.ts   counterparties, cadence, direction, usual amounts
  people.ts      the named roster on Walrus
  memory.ts      MemWal writes and recalls
  chain.ts       Tatum GraphQL reads and retries
  wallet.ts      USDC transfers and payment gating
  x402.ts        the charging index and the paying agent
  seed.ts        the day gated demo history
public/
  live.js        microphone capture, playback and barge in for the call page
  theme.css      the paper design system, tokens only
  shared.js      wallet, speech and page helpers shared by every page
  story.js       the one motion engine, runs once then holds
  wallet.js      the Wallet Standard handshake
  assets/        ink drawings, white keyed for multiply, shared by the pages
tools/
  normalize.mjs  resizes a drawing and pushes its own paper to pure white
  plate.mjs      one command from a sentence, or from a png you already have, to a finished plate
```

The drawings are original, generated in the same four colours the tokens already use, and sit on the page with `mix-blend-mode: multiply`. That only hides the rectangle if the sheet inside it is exactly white, so `tools/normalize.mjs` reads the PNG, resamples it, and lifts the measured paper tone per channel before `cwebp` encodes. A `transform` or a fade on any parent would isolate the blend and bring the box back, which is why the plates are left out of the reveal system.

`npm run plate -- life-market "a woman at a market stall handing over a coin"` asks a provider for the drawing. `npm run plate -- life-market --from downloads/drawing.png` takes one you made anywhere, and it goes through the same keying and the same encoder, so an image from a site with no api is finished by the same command as an image from a model. The style preamble is only used by the first form.

## Keys

`.env` is gitignored and every key stays server side. The browser never sees one, and the only thing it ever signs is a transaction it built itself.

The Walrus delegate key used during development was pasted into a chat once, so it gets rotated before this repository is made public. Rotation creates a new namespace, which means the demo memories have to be seeded again.

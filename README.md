# Ken

Ken is a personal agent for a Sui wallet. It reads the chain through Tatum, keeps your people on Walrus, and pays a few cents for a fact it has not learned yet. By default that money is `sui:mainnet` USDC, which is real money, and nothing leaves a wallet until its owner approves the transaction inside it.

It is more than a voice. Ken answers in a text chat, takes a live call, speaks a morning brief, sets a monthly limit, makes a payment request link, prints a statement, and sells or buys a memory behind a paid link. All of those share one memory and one wallet, so a name told on a call is already known when you type.

You talk to it the way you would talk to a person. It answers from memory when memory can answer, reads the chain only when memory cannot, and buys a measured profile from a paid index only when neither of those worked. Every step is shown, and every step that cost money says so.

## The loop

```
you ask, by voice or by text
  → Walrus memory is read first          free, 2 to 4 seconds
  → Tatum is read only if memory is empty free, but rate limited and slow
  → the paid index is bought only if the address is still nameless
                                        costs 0.01 USDC, or 0.03 for a busy wallet
  → the fact is written to Walrus, so the next asking is free
  → the answer is spoken, typed, or drawn on a statement
```

The point of the build is the order. A wallet explorer answers every question by reading the chain. This one tries to never read the chain twice for the same fact, and the cost meter on the page proves it.

### The market is two processes

The buyer and the seller cannot be the same call stack, so they are two processes.

`npm run sell` owns the index on port 8788, with its own payout wallet in `SELLER_WALLET` and its own ledger in `.seller.json`. It holds no key. The agent on 8787 asks for a price, gets a standard x402 v2 `PAYMENT-REQUIRED` header, and has your wallet sign the exact transfer without sending it. The signed Sui envelope goes back in `PAYMENT-SIGNATURE`. The seller's facilitator verifies that signature against those exact bytes, simulates the transfer, checks that the USDC credit at the quoted address is funded by a debit from the wallet that signed, and only then broadcasts the bytes. There is no second signature and no key on the seller side.

The price is one cent for a profile, three cents above twenty transactions because a busy wallet costs the seller more Tatum reads. The reason is published in the 402 reply. The buyer has its own ceiling in `PAID_MAX_USDC`, and a quote above it is refused rather than paid. A resource already sold to your wallet answers free, and a lost response can be retried with the same signed envelope without moving money twice.

## One agent, many surfaces

| Surface | What Ken does there |
| --- | --- |
| Text chat | The same tools, the same memory, and the same wallet, answered as writing. A payment ticket, an address field and a request form open under the reply. |
| Voice call | You pick one of five working voices, then talk. The answer is spoken back, and talking over it cuts it off. The call opens over the chat you are reading and writes back into it. |
| Morning brief | Ken reads what moved, what is due and what it remembers before you ask. |
| Limits | A monthly cap with a red, amber or green meter, set by typing or speaking. |
| Request links | A link that asks a named person for an amount, dies after a set time, and carries a QR. |
| Statement | A paper card typeset from chain reads and memory, saved as PNG, PDF or CSV. |
| Paid links | A note, a profile or a chain check sold from one cent over x402, with the receipt stored so it is never bought twice. |

## The hackathon tracks

| Track | What it does here |
| --- | --- |
| Tatum | Every chain read. Balances, transactions, counterparty history, on both mainnet and testnet, through the Sui GraphQL gateway. |
| Walrus Memory | The agent's long term memory. Names, notes and bought receipts live in per wallet namespaces on mainnet, so a fresh session already knows who Sana is. |
| Voice | One chat with two ways in. Type, or open the call sheet and talk. The microphone stays open, the answer arrives as speech, and every finished turn is written into the same chat, so a refresh does not erase it. Five working voices, and the choice is saved. |
| Payments | Standard x402 v2 over Sui, with a separate seller process. A price arrives in a `PAYMENT-REQUIRED` header, your wallet signs the exact transfer without sending it, the signed bytes leave in `PAYMENT-SIGNATURE`, and the seller's facilitator verifies and settles them without holding a key. The fact is written to memory so the same answer is never bought twice. |

## Run it

```bash
npm install
cp .env.example .env      # then fill in the keys
npm run sell              # the index on 8788: its own wallet, its own ledger, no key
npm run live              # the agent on 8787: real model, the model's own voice, payments on
```

Keep both terminals open. Without the seller the agent still answers from memory and the chain, but a paid lookup says the index is not answering rather than pretending it paid.

With `.env` as shipped, that is `sui:mainnet`, which is what the submission is judged on. Reading and remembering work there today. Spending does not, because there is no mainnet faucet and this build holds no bought USDC, so a paying scene is recorded with `PAY_NETWORK=testnet DEMO_WALLET_NETWORK=testnet npm run serve` and the person on camera says which ledger the numbers came from.

Open http://127.0.0.1:8787. With a key in `.env` the brain is a live model on Gemini direct, with NVIDIA NIM behind it, making real function calls against the tool layer, and the answer comes back in the model's own voice. No key? Nothing is lost:

```bash
npm run demo              # stub brain, seller and app on 8899, 8788 and 8787
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

`MODEL_NAME` names the Gemini models and `NVIDIA_MODEL` the NVIDIA ones. The two lanes are alternated, so the attempt order is `gemini-3.1-flash-lite`, the 550B Ultra, `gemini-3.5-flash`, then the 4B Bolt. On the nine shipped probes both leads were equally correct and Gemini was about three times slower, at a 3.4 second median against 1.2, with an 11.6 second tail that can spend the timeout and hand the turn to Ultra. The tools are what carry the accuracy, not the model size.

## Pages

| Path | What it is |
| --- | --- |
| `/` | Ken on one page. The cost ledger, the annotated payment ticket and the four-service hub are clickable. |
| `/app` | Ken's desk. One transcript with a session rail, a call sheet that opens on top of the chat, balances, and the people it knows. Text and voice share the same thread. |
| `/call` | Not a page of its own. The embeddable call sheet that `/app` opens over the current chat. One open socket with audio both ways, and every finished turn is written back to that chat. A direct visit lands on `/app` with the sheet open. |
| `/report` | The statement card. Total out, month bars, the people paid and what it cost to learn them, saved as a PNG, a PDF or a CSV. |
| `/memory` | What is stored on Walrus, per namespace, with the search box that reads it. |
| `/pay` | The signing page. Nothing moves without your wallet approving it. |
| `/request` | A payment request link. It names the amount, the reason and a deadline, carries a QR, and dies when it expires. |
| `/ask` | Sell a line out of your own memory. The words stay on the server and come out only after the chain says the money arrived. |
| `/features` | Every capability on one sheet, each tile marked live, waiting on your wallet, or waiting on a key. The counts are measured from the tiles and the header state, so the page cannot drift into overclaiming. |
| `/how` | What is finished and what is not. |
| `/life` | The same mechanics described as scenes from an ordinary week. |

## Tools the model can call

`people_you_know` `who_is_this` `money_history` `monthly_summary` `wallet_balance` `how_money_came` `address_activity` `name_a_person` `find_person` `remember_this` `what_do_i_remember` `memory_stats` `make_report` `what_is_due` `set_monthly_limit` `request_money` `pay_usdc` `paid_lookup` `verify_payment` `open_paid_link`

Sixteen of them exist always. The last four only appear when `PAY_ENABLED=1`, because a build that cannot spend should not offer to.

`wallet_balance` is the only tool allowed to answer how much money is in the wallet. It lists every coin with its own decimals, its own unit and a dollar value only when the price feed answered, and it prints a total only when every coin has a price. A movement total from `money_history` is never used as a balance.

`how_money_came` walks the wallet's own history back and reconciles the transfers against the balance, per coin. It names the faucet, names every counterparty it can, and when the transfers do not add up it says how much is missing and that gas is the usual reason. If it hits its read cap it says so instead of implying it reached the first transaction.

`address_activity` reads any address's newest twenty public transactions and reports counts and shapes: how often it sent, how often it received, how many addresses it dealt with, whether any of it was with this wallet. It reports a pattern, never a verdict, and it says when the window does not reach the whole history.

`money_history` takes an optional `person`, so "how much have I sent Imran" answers about Imran and not about everybody.

`what_is_due` answers the one question a person with debts actually asks: who is owed, how much, and how late. It reads the chain for the last payment to each named person and the usual amount, so the answer is a measurement rather than a recollection. Ask "what do I pay every month" and the same tool scales each rhythm to a month and totals it inside its own asset. The paid index is excluded from that total on purpose. A fee taken per question is a price, not a bill.

`verify_payment` sells the third resource kind behind the same x402 wall. Somebody claims they paid and hands over a digest, so the agent pays the same cent to have the chain read that transaction and answer what really moved. A digest that does not exist is delivered as the answer you paid for rather than as an error, because "nothing with that digest ever settled" is exactly the news a person needs. It earns its price in a way a name lookup does not: the seller spends a real Tatum read to answer, and a digest is the only pointer that names one transaction exactly, so a claim about a specific payment cannot be settled from an address list alone.

`find_person` forgives a microphone, because a call hears "Sana" as "Sauna" often enough to matter, and returns the stored name with a confidence below one so the agent asks instead of assuming. `pay_usdc` deliberately does not use that matcher. Reading memory can afford a guess, spending real USDC on a guess cannot.

## Giving the demo a history

Cadence is a real measurement, so it needs transfers on different days. The seeder is day gated and will not pay the same person twice in one UTC day.

```bash
npm run seed
```

It prints who was paid and the next date each person is due. Run it once a day and the rhythm appears: Sana every two days, Imran every three, Tara every four, and Dev paying you back so one relationship reads as two way rather than a donation.

The script pins `PAY_NETWORK=testnet`. The cast and its money only exist on that ledger, and the same command pointed at mainnet would try to move real USDC, which is exactly what the signing guard refuses.

## What is finished

- Chain reads through Tatum on mainnet and testnet, with 429 and retry handling. The header carries a network switch on the six pages that actually read a wallet, so the same wallet can be read on either ledger.
- Dollar values beside each coin, priced from CoinGecko. `CoinMetadata` has no price field, so the chain can name a coin and count it but cannot say what it is worth. When the price feed fails the dollars go absent rather than zero.
- A coin nobody in the build named still shows up, because balances are read as a list rather than looked up per type.
- A balance read that lists every coin the chain says is there, priced per coin, with a total only when every coin has a price. The agent can no longer answer a balance question with a monthly movement total.
- The newest transactions are read first, because the index orders oldest first by default. Measuring `first` on a busy testnet wallet returned August 2024 while `last` returned the same day, 2026-11-04. Paging back uses `last` with `before` and stops honestly at its cap.
- Inbound money is named from every side the build can read: `relation:AFFECTED` includes transfers the wallet received, and each known counterparty's newest transactions are read as a second pass. The faucet's published address is labelled, and it is kept out of the people and bill lists because it is where test money comes from, not a person you owe.
- Per-person and per-month rows are split by coin. Someone who sent 20 USDC and 0.0024 SUI reads as both. The month total that used to add SUI base units under USDC decimals, and once produced 110.84 USDC from a 12.63 USDC wallet, is gone and has an offline test that fails if it returns.
- Walrus memory writes and recalls, namespaced per wallet so one person's memories never leak into another's.
- The paid index and the paying agent as two processes speaking standard x402 v2. The seller runs on `SELLER_PORT` with its own wallet and ledger and holds no key. A price arrives in a base64 `PAYMENT-REQUIRED` header, the buyer's wallet signs the exact Sui transfer without executing it, and the signed envelope returns in `PAYMENT-SIGNATURE`. The facilitator verifies the signature against those bytes, simulates the transfer and checks the USDC credit is funded by the signing wallet before broadcasting. Three kinds of thing sit behind the wall: a measured profile of an address, a note somebody wrote and priced, and a transaction the chain has to be read for. A sold resource answers free, a repeated envelope returns the same digest, and a quote above `PAID_MAX_USDC` is refused.
- Browser wallet connection through the Wallet Standard handshake, and the wallet signature as the payment confirmation.
- A live voice call. Microphone bytes go to the server, the server holds the socket to the model, and audio, transcripts and tool calls come back over one event stream. Nothing new was installed to do it, so there is no WebSocket library in this project.
- The model's own voice on `/speak`, real audio that drives the live scope, and the same voice answers a typed question.
- Tool results carried forward inside the conversation, so an address the agent already paid to learn is visible to it on the next turn.
- A statement card typeset from the same tool calls that answer a spoken question, exported as PNG, PDF or CSV. It is vector text rather than a generated picture, because an image model draws convincing paper and unreliable digits.
- The model chain in `MODEL_NAME`, tried in order on one key, so a 503 or a 429 from a free tier moves to the next name instead of ending the turn.
- Selling from the inside. `/ask` lists every line this wallet keeps on Walrus and puts any of them behind the same 402 door at a price you choose. The server reads the words back out of the store to build the link, so a link cannot claim to sell a memory while selling something typed, and the words never appear in the page or in the reply that asks for money.
- Another agent can pay a person, not just an index. `open_paid_link` reads the price off the writer's link, pays the writer's wallet and writes the bought fact into the buyer's own memory. `/earned` reports what arrived by summing the receipts, never a number stored beside a link.
- Every page listed above, all of them working against the live server.

## What is not

- The live call has never been run through a real microphone. Every byte of it has been driven from a script against the app's own routes, including a spoken question resampled to 16 kHz, so the server half is proven and the browser capture is not.
- Money settles on mainnet by default (`PAY_NETWORK=mainnet`), and that is where a submitted demo is read from. What mainnet cannot show is the seeded story: the invented cast and the demo wallet's USDC exist only on testnet, so a recorded paying demo runs `PAY_NETWORK=testnet DEMO_WALLET_NETWORK=testnet` and says so out loud. There is no mainnet faucet, so a real mainnet settlement needs bought USDC, and this build holds none.
- The agent's own key will not sign on mainnet. `keySpendAllowed()` refuses before bytes are built, because that money is real. A mainnet transfer is prepared only for a connected browser wallet, and the signature in that wallet is the approval.
- The x402 browser path has been proven with a simulated Wallet Standard provider through the real seller process and its real facilitator, not with a browser extension holding a key. The in-app browser has no extensions, so a real extension signing a paid envelope is still the open check. The wire itself is proven live on testnet: a buyer-signed envelope was settled by the facilitator, the chain returned success, and the replay of the same envelope moved no second payment.
- Cadence needs several days of seeded history before it can say "about every three days" instead of "most recently today".
- The people list, the due list and the monthly summary read the newest 40 transactions, so a very busy wallet's older rhythms are outside that list. `how_money_came` pages up to 200 and says when it hit the cap. `address_activity` reads the newest 20 and says the window is not the whole history.
- The default transaction relation only lists what a wallet signed. Inbound money needs `relation:AFFECTED`, which this build uses, plus the payer's side as a second pass. A transfer older than those read windows can still be missing, and the balance reconciliation is what exposes the gap.

## Layout

```
src/
  server.ts      the app process: keys, tools and HTTP
  brain.ts       one OpenAI compatible path for Gemini, NVIDIA NIM or OpenAI
  speech.ts      the model's own voice, and the honest answer when there is no key
  stub-model.ts  the rule based brain the demo runs on
  tools.ts       the twenty tools and their schemas
  live.ts        the two way audio socket, and the tool calls that run on it
  report.ts      the statement, and the vector card typeset from it
  knowledge.ts   counterparties, cadence, direction, usual amounts
  people.ts      the named roster on Walrus
  memory.ts      MemWal writes and recalls
  chain.ts       Tatum GraphQL reads and retries
  wallet.ts      USDC transfers and payment gating
  x402.ts        the paying agent: price, sign, settle, learn
  x402wire.ts    the standard headers and the Sui signed envelope
  catalog.ts     the seller: price a profile, note or receipt, release after settlement
  facilitator.ts the self-hosted verify and settle endpoints, no key
  seller.ts      the seller as its own process on SELLER_PORT
  seed.ts        the day gated demo history
public/
  live.js        microphone capture and playback for the call sheet
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

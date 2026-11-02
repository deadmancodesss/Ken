# The agent that pays for what it does not know

Most wallet tools answer every question the same way. You ask, they read the chain, they show you a table. Ask the same question a minute later and they read the chain again. Nobody remembers anything, so every answer costs the same whether you asked it yesterday or twice in a row.

Total Recall is a voice agent that treats knowing something as cheaper than finding it out. It remembers your people on Walrus, reads Sui through Tatum only when memory comes up empty, and when an address is still nameless after both, it buys the name from a paid index for one cent. Then it writes the receipt into memory so it never buys that name again.

The whole build is that ordering. Everything else is a mouth.

## A scene rather than a feature list

You are walking somewhere and you say "has Dev paid me back". The ring on the screen moves with your voice because it is reading your actual microphone level, not animating. The agent checks memory, finds Dev, and answers in the voice you picked at the pace you set. It says Dev moved money both ways over two payments, most recently today. You did not open an app, you did not paste an address, and nothing was read from the chain because the chain had already been read once and remembered.

Now say "who is 0xaaf0..." for an address you have never seen. Memory has nothing. Tatum has the transfers but no name. So the agent asks to buy the name, the quote appears, your wallet signs it, and the answer arrives with the receipt attached: Nightlight Taxi Co, business, airport transfers, bought for 0.01 USDC. Ask about that address a week later and it costs nothing, because the agent already knows.

That second scene is the reason this is not a chat wrapper. Knowing has a price, the price is visible, and the price is paid once.

## What each track actually carries

Tatum is the eyes. Every balance, every transaction list, every counterparty read goes through the Sui GraphQL gateway, on mainnet for memory and testnet for the money. The free tier is about three requests a second, so the read paths batch and the client handles 429 with the retry-after header instead of falling over.

Walrus is the memory. Names, notes and bought receipts are written into namespaces scoped per wallet, so two people using the same agent never inherit each other's relationships. A recall costs two to four seconds, there is no delete and there is no upsert, which means correcting a fact creates a second row. That shaped the design more than any feature did. The agent stores facts it will not need to retract, and it reads the roster rather than trusting a single row.

Voice is the mouth. The call page lets you choose the language, the voice and the pace, and remembers all three. It listens one turn at a time, speaks the answer, then listens again, and you can tap to stop it mid-sentence. A live audio socket replaces one function in one file when the model key lands, and nothing above that function changes.

Payments are the proof. Both halves of an x402 style exchange run here: the index that charges for a name and the agent that pays for it, with a quote that expires, a journal for payments that got stuck, and a signature from your own browser wallet as the only thing that can move money.

## The things that broke

Inbound money is invisible. `address.transactions` only links the signer, so a wallet that received USDC sees nothing in its own history. The fix is to read the counterparty's side and reconstruct direction from both, which is why one relationship can honestly say "both ways" instead of guessing.

Cadence cannot be faked. The demo says someone pays "about every three days" only when there are real transfers three days apart. A seeder that is day gated pays each person at most once per UTC day, so the rhythm has to be accumulated over actual days. Any shortcut would be a fabricated memory, and a memory product that fabricates is worse than no product.

A model key never arrived. So the demo runs on a rule based brain that routes the same tools, and the header says "stub rules, no model key" rather than pretending. The seam is one OpenAI compatible path, so Gemini, OpenRouter or OpenAI all drop in without touching a tool.

## What it costs to run

Nothing, on testnet, apart from the cents the paid index charges itself. The agent wallet holds a few USDC of testnet dust and about one SUI for gas. Memory writes go to a Walrus account on mainnet. The only real money in the whole system is the one cent per name, and the meter on the page counts them.

## The honest version

This is not a finished consumer product. It is a working loop with a real wallet, real chain reads, real storage and a real price for knowledge, plus a voice you can actually talk to. The parts that are missing are missing for one reason, which is a model key, and they are all behind one function call.

If you only look at one thing, look at the cost meter. Ask the same question twice and watch the second one cost nothing.

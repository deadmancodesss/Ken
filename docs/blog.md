# The agent that pays for what it does not know

Most wallet tools answer every question the same way. You ask, they read the chain, they show you a table. Ask the same question a minute later and they read the chain again. Nobody remembers anything, so every answer costs the same whether you asked it yesterday or twice in a row.

Ken is a personal agent that treats knowing something as cheaper than finding it out. It remembers your people on Walrus, reads Sui through Tatum only when memory comes up empty, and when an address is still nameless after both, it buys a measured profile from a separate paid index for a cent or three. Then it writes the receipt into memory so it never buys that profile again.

Ken is not only a voice. The same memory answers a typed chat, a live call, a morning brief, a payment request link, a printed statement and a paid link somebody else can open. Text and voice are two mouths on one agent, not two products.

The whole build is that ordering. Everything else is a surface.

## A scene rather than a feature list

You are walking somewhere and you say "has Dev paid me back". The ring on the screen moves with your voice because it is reading your actual microphone level, not animating. The agent checks memory, finds Dev, and answers in the voice you picked. It says Dev moved money both ways over two payments, most recently today. You did not open an app, you did not paste an address, and nothing was read from the chain because the chain had already been read once and remembered.

Now say "who is 0xaaf0..." for an address you have never seen. Memory has nothing. Tatum has the transfers but no name, and no public chain can supply one. So the agent asks to buy a measured profile: the price arrives in a standard 402 header, your wallet signs the exact transfer without sending it, and the seller settles it. The answer is arithmetic over public history, not a made up business: fourteen transactions, mostly with you, first seen in March, bought for 0.01 USDC. Ask about that address a week later and it costs nothing, because the agent already knows.

That second scene is the reason this is not a chat wrapper. Knowing has a price, the price is visible, and the price is paid once.

## What each track actually carries

Tatum is the eyes. Every balance, every transaction list, every counterparty read goes through the Sui GraphQL gateway, on whichever ledger the question is about, and one value in `.env` says which ledger a payment settles on. The free tier is about three requests a second, so the read paths batch and the client handles 429 with the retry-after header instead of falling over.

Walrus is the memory. Names, notes and bought receipts are written into namespaces scoped per wallet, so two people using the same agent never inherit each other's relationships. A recall costs two to four seconds, there is no delete and there is no upsert, which means correcting a fact creates a second row. That shaped the design more than any feature did. The agent stores facts it will not need to retract, and it reads the roster rather than trusting a single row.

Voice is the mouth. The call sheet opens over the chat you are already reading and speaks into that same thread, because a spoken question and a typed one are the same conversation. Five Gemini voices are offered, each one measured on this build, and the choice survives a reload. It listens one turn at a time, speaks the answer, then listens again. Refresh the page mid-conversation and the transcript is still there, because every finished turn is written to the chat store before the sheet closes.

Payments are the proof. The buyer and the seller are two processes speaking standard x402 v2. The seller has its own wallet, its own ledger and no key. The price arrives in a `PAYMENT-REQUIRED` header, your browser wallet signs the exact Sui transfer without executing it, and the signed envelope goes back in `PAYMENT-SIGNATURE`. The seller's facilitator verifies that signature, simulates the transfer, checks the USDC credit at its own address is funded by the debit from the signing wallet, and then broadcasts those exact bytes. A buyer ceiling refuses a quote above it, a lost response is retried with the same envelope, and a settled resource is never paid for twice.

## The things that broke

Inbound money is invisible. `address.transactions` only links the signer, so a wallet that received USDC sees nothing in its own history. The fix is to read the counterparty's side and reconstruct direction from both, which is why one relationship can honestly say "both ways" instead of guessing.

Cadence cannot be faked. The demo says someone pays "about every three days" only when there are real transfers three days apart. A seeder that is day gated pays each person at most once per UTC day, so the rhythm has to be accumulated over actual days. Any shortcut would be a fabricated memory, and a memory product that fabricates is worse than no product.

A model key never arrived at first. So the demo can run on a rule based brain that routes the same tools, and the header says "stub rules, no model key" rather than pretending. The seam is one OpenAI compatible path, so Gemini, NVIDIA or OpenAI all drop in without touching a tool, and the live build now answers through that path.

## What it costs to run

Reading costs nothing on either ledger. Memory writes go to a Walrus namespace scoped to the connected wallet on mainnet. The paid index charges one to three cents for a measured profile, the meter on the page counts them, and each connected seat can switch cleanly between `sui:testnet` and `sui:mainnet` from the masthead. On either network, nothing leaves a wallet until the person approves the transaction inside their own Wallet Standard extension.

## The honest version

Every workspace surface is gated behind a real Sui wallet connection so no visitor can pollute another wallet's Walrus memory, chat history, reminders, spending limits, or payment tickets. Even when a wallet holds zero gas on mainnet, signing a personal message challenge verifies Ed25519 ownership, live Tatum GraphQL connectivity, and live Walrus namespace access in one round trip.

If you only look at one thing, look at the cost meter. Ask the same question twice and watch the second one cost nothing.

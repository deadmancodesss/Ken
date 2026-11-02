# Video script, two minutes forty

Record the screen at 1080p with the browser in full screen. Voice over is recorded separately and laid over the top. Before you start, run `npm run demo`, open http://127.0.0.1:8787, connect the wallet, and ask one throwaway question so the caches are warm and nothing stalls on camera.

Say out loud at the top of the recording which brain is answering. The header shows it, and a judge who finds out later feels tricked.

## 0:00 to 0:15, the problem

On screen: the landing page, top of the fold, nothing scrolling yet.

Voice over: "Every wallet tool answers a question by reading the chain. Ask it again a minute later and it reads the chain again. Nothing is remembered, so every answer costs the same. This is an agent that treats knowing something as cheaper than finding it out."

## 0:15 to 0:40, the loop

On screen: scroll to the cost ledger. Click the struck through rows so the second run reads as free.

Voice over: "Memory first, on Walrus. The chain only when memory is empty, through Tatum. And when an address still has no name after both, it buys one, for a cent, and stores the receipt. Seven seconds the first time. Four the next, and never a paid lookup twice."

Cut to: the annotated ticket. Click `held`, then `signed`, then `refused`, one second each.

Voice over: "Money only moves when a wallet signs it. Nothing is ever sent by voice."

## 0:40 to 1:20, the call

On screen: `/call`. Show the language picker open, pick English, then show the voice list, move the pace slider, click audition.

Voice over: "You choose the language, the voice and how fast it talks. All three are remembered."

Then: click Start call, allow the microphone, and say "who do I pay most often".

Let the whole answer play out on camera, ring moving, captions filling. Do not cut away while it is listening, because the point is that it hears you and answers out loud.

Voice over, after the answer finishes: "The ring is your real microphone level. It listens again after every answer, and you can interrupt it."

## 1:20 to 1:55, the paid lookup

On screen: `/app`. Ask "who is" followed by an address that has never been named. Use the copy button on the memory page to get one.

Voice over: "Memory has nothing. Tatum has the transfers but no name. So it asks to buy one."

Show the quote appearing, then cut to `/pay`, connect the wallet, and sign.

Voice over: "The quote expires in ten minutes, the signature comes from my own wallet, and the receipt goes back into memory."

Then: ask the same question again.

Voice over: "Same question, no cost. It already knows."

## 1:55 to 2:20, the memory

On screen: `/memory`. Show the namespace list and the per wallet scoping, then search a name.

Voice over: "Namespaces are scoped per wallet, so two people using the same agent never inherit each other's relationships. Names and notes live on Walrus mainnet. Balances and transfers live on Sui. Neither one is a cache of the other."

## 2:20 to 2:40, the honest close

On screen: `/how`. Scroll slowly through the finished and not finished columns.

Voice over: "The demo brain is a rule based stub, because a model key never arrived. Gemini function calling, Gemini voice and Gemini Live all sit behind one function, and the header tells you which one is answering. Everything else is real. Real wallet, real chain reads, real storage, and a real price for knowledge."

Last frame: hold on the cost meter.

Voice over: "Ask it twice and watch the second one cost nothing."

## Notes for the recording

- Never show `.env`, a secret key, or a chat window with a key in it.
- If a Tatum read hits the rate limit on camera, keep it in. The retry is part of the build and cutting it makes the demo look scripted.
- The cadence line only appears once the same person has been paid on two different days. If the seeder has not run for a few days, do not claim a rhythm in the voice over.
- Total runtime target is two minutes forty. Anything over three minutes loses the person judging it.

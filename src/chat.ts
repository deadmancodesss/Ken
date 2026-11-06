import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { runTurn, modelName, fallbackNote } from "./brain.js";

let history: unknown[] = [];

const rl = createInterface({ input: stdin, output: stdout });
console.log(`ken · a personal agent for a Sui wallet · model ${modelName()} · Ctrl-C to leave`);

// Iterating ends cleanly on EOF. rl.question() hangs forever when stdin closes.
for await (const raw of rl) {
  const text = raw.trim();
  if (!text || text === "/quit" || text === "/exit") break;

  try {
    const turn = await runTurn(text, history);
    history = turn.history;
    for (const s of turn.steps) {
      console.log(`  tool ${s.name} ${JSON.stringify(s.args)}${s.ok ? "" : ` FAILED: ${s.error}`}`);
    }
    console.log(`ken > ${turn.text}`);
    const note = fallbackNote();
    if (note) console.log(`  ${note}`);
  } catch (err) {
    console.log(`error > ${(err as Error).message}`);
  }
}
rl.close();

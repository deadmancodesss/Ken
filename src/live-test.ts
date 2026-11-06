/**
 * The live socket's FunctionResponse.response is a protobuf Struct, so it must be an
 * object. On 2026-11-04 a real call asked for money_history, the tool returned a list,
 * the list was sent bare, and Google closed the socket with "Proto field is not
 * repeatable" in the middle of the conversation. Every tool that answers with a list
 * had the same fault, so the guard is tested on the shapes a tool can return.
 *
 * The same audit found two silences: a tool name the model invented got no reply at
 * all, and a tool that never returned held the call open with no audio and no error.
 * A model waiting on a function response does not speak again, and microphone frames
 * keep the idle timer from firing, so both were calls that simply stopped.
 */
import { answerToolCall, toolStruct, withToolTimeout } from "./live.js";

const checks: string[] = [];
function expect(label: string, ok: boolean) {
  checks.push(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) throw new Error(label);
}

const isStruct = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);

const list = toolStruct([{ name: "Sana", flows: 5 }]);
expect("a list is wrapped under one key", JSON.stringify(list) === '{"result":[{"name":"Sana","flows":5}]}');
expect("the wrapped reply is an object", isStruct(list));

const object = toolStruct({ rows: [1, 2], total: 3 });
expect("an object passes through unchanged", object.total === 3 && Array.isArray(object.rows));
expect("an object with a list inside is still a struct", isStruct(object));

expect("a bare string is wrapped", isStruct(toolStruct("ok")) && toolStruct("ok").result === "ok");
expect("a bare number is wrapped", isStruct(toolStruct(7)) && toolStruct(7).result === 7);
expect("null is wrapped rather than sent as null", isStruct(toolStruct(null)) && toolStruct(null).result === null);
expect("an empty list is still a list case", JSON.stringify(toolStruct([])) === '{"result":[]}');

const sent: any[] = [];
const step = await answerToolCall({ id: "call-1", name: "read_the_stars", args: { sky: "night" } }, (m) => sent.push(m));
const replies = sent[0]?.toolResponse?.functionResponses;
expect("an invented tool name still sends exactly one reply", sent.length === 1);
expect("the reply carries the id the model gave", replies?.[0]?.id === "call-1");
expect("the reply carries the tool name", replies?.[0]?.name === "read_the_stars");
expect("the reply body is a struct", isStruct(replies?.[0]?.response));
expect("the reply says no such tool exists", /no tool named/.test(String(replies?.[0]?.response?.error ?? "")));
expect("the step reports the failure", step.kind === "tool" && step.ok === false && step.error === "unknown tool");

const quick = await withToolTimeout(Promise.resolve("done"), 50);
expect("a tool that answers in time passes through", quick === "done");

const own = await withToolTimeout(Promise.reject(new Error("boom")), 50).catch((e: Error) => e.message);
expect("a tool that fails keeps its own reason", own === "boom");

const slow = await withToolTimeout(
  new Promise<string>((resolve) => {
    setTimeout(() => resolve("late"), 200);
  }),
  40,
).catch((e: Error) => e.message);
expect("a tool that misses its deadline is refused", /longer than 40 milliseconds/.test(slow));

console.log(checks.join("\n"));
console.log("\nthe live tool reply is always an object and always arrives, whatever the tool returns");

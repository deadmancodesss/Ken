import "dotenv/config";

/*
 * The two ways a voice call humiliates itself, both measured rather than argued.
 *
 * One is the loop: the agent's answer leaves the speaker, the microphone carries it back
 * as if it were the caller, and the call ends up interrupting itself and answering its own
 * sentence one turn late. The other is the voice: an unknown name is not rejected by the
 * live socket, it is ignored, and the model then answers with whatever speaker it chose, so
 * every reply sounds like a different person.
 *
 * Neither half needs a key, a microphone or a credit. The gate is a pure function over the
 * frames the browser would have sent, and the voice is a pure function over the string the
 * page would have sent, so both can be graded here instead of on a call.
 */

// The fallback is read from the environment on every call, so the test owns it outright.
process.env.LIVE_VOICE = "";
process.env.TTS_VOICE = "Kore";

const { liveVoice, liveState } = await import("./live.js");
const { upstream, silence, floorIsMine } = await import("../public/live.js");

const checks: string[] = [];
const expect = (label: string, ok: boolean) => {
  checks.push(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) throw new Error(label);
};

const loud = (n: number, v = 1200) => {
  const a = new Int16Array(n);
  a.fill(v);
  return a;
};
const isSilent = (a: Int16Array) => a.every((s) => s === 0);

/*
 * The voice. The picker stores ids for three vendors, and only Google's own names mean
 * anything to this socket, so the mapping has to hold up against everything the page can
 * hand it rather than only the one case that was thought of.
 */
expect("a prefixed gemini name becomes that name", liveVoice("gemini:Kore") === "Kore");
expect("a bare name still works, because older visits saved it that way", liveVoice("Puck") === "Puck");
expect("a fish id is not sent to a gemini socket", liveVoice("fish:default") === "Kore");
expect("a heygen id is not sent either", liveVoice("openrouter:noelle") === "Kore");
expect("an invented name is refused rather than ignored by the model", liveVoice("gemini:Not Real") === "Kore");
expect("nothing at all still lands on one real voice", liveVoice("") === "Kore" && liveVoice(undefined) === "Kore");
expect("a browser voice index never becomes a speaker name", liveVoice("3") === "Kore");
process.env.LIVE_VOICE = "Sulafat";
expect("the configured live voice wins over the speech default", liveVoice("fish:default") === "Sulafat");
expect("and still does not override a name the caller actually chose", liveVoice("gemini:Charon") === "Charon");
process.env.LIVE_VOICE = "";
expect("every answer is a name the socket knows", [liveVoice("fish:default"), liveVoice("gemini:Zephyr"), liveVoice("nonsense")].every((v) => /^[A-Z][a-z]+$/.test(v)));

const state = liveState();
expect("the state reports the voice it will pin", typeof state.voice === "string" && (state.enabled ? state.voice !== "" : true));

/*
 * The gate. One frame is 1600 samples of 16 kHz, a tenth of a second, which is what the
 * browser posts. What matters is that nothing but zeros can leave the page while the
 * agent's own audio is playing.
 */
const frame = loud(1600);
expect("an open floor passes the real bytes", upstream(frame, true) === frame);
const gated = upstream(frame, false);
expect("a shut floor sends the same length of silence", isSilent(gated) && gated.length === 1600);
expect("silence is reused rather than built per frame, so the gate costs nothing", silence(1600) === silence(1600));
expect("a different block size gets its own buffer", silence(960) !== silence(1600) && silence(960).length === 960);

const T = 100_000;
expect("a quiet room is the caller's floor", floorIsMine({ now: T, tailUntil: 0 }).open);
const whileSpeaking = floorIsMine({ speaking: true, now: T });
expect("while the agent talks the microphone is shut", !whileSpeaking.open);
expect("and the tail starts from the moment it stopped", whileSpeaking.tailUntil === T + 400);
expect("the tail keeps it shut, because the room is still ringing", !floorIsMine({ speaking: false, now: T + 200, tailUntil: T + 400 }).open);
expect("and then it opens again on its own", floorIsMine({ speaking: false, now: T + 401, tailUntil: T + 400 }).open);
expect("headphones hand the floor back even mid sentence", floorIsMine({ barge: true, speaking: true, now: T }).open);
expect("and the tail is not held open once it has been waived", floorIsMine({ barge: true, speaking: true, now: T }).tailUntil === 0);

/*
 * The whole loop, as the browser would actually run it: a caller asks something, the agent
 * answers over six chunks, and every frame captured during the answer and its tail must
 * reach the model as silence. This is the exact shape that used to feed the agent its own
 * sentence back as a question.
 */
let tailUntil = 0;
const sent: Int16Array[] = [];
// Six chunks of answer, then the room, then the caller again. The last frame sits past the
// tail on purpose, because the frame that used to reopen the loop was the first one after it.
const now = [T, T + 100, T + 200, T + 300, T + 400, T + 500, T + 600, T + 950];
const speaking = [false, true, true, true, true, true, false, false];
for (let i = 0; i < now.length; i++) {
  const floor = floorIsMine({ barge: false, speaking: speaking[i], now: now[i], tailUntil });
  tailUntil = floor.tailUntil;
  sent.push(upstream(loud(1600, 3000 + i), floor.open));
}
expect("the question goes up as sound", !isSilent(sent[0]));
expect("every frame captured under the answer goes up as silence", sent.slice(1, 6).every(isSilent));
expect("the tail covers the last chunk still ringing in the room", isSilent(sent[6]));
expect("and the caller gets the microphone back after it", !isSilent(sent[7]));

console.log(checks.join("\n"));
console.log(`\n${checks.length} echo and voice checks, none of which needed a live call`);

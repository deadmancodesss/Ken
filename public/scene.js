/* GSAP is vendored into public/vendor rather than pulled from a CDN, so a demo-day
   network failure costs animation and not the page.
   Everything here is additive. If gsap never loads, or the visitor has asked for
   less motion, the page is already complete and correct without it, because the
   scroll reveal system in theme.css runs on its own and no element on any page
   depends on this file to become visible. */

const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

const ready = () => {
  if (!window.gsap || still) return false;
  return true;
};

/**
 * The hand-drawn underline under the one word the sentence is about. It is drawn
 * rather than faded because a line that arrives as a line is the single cheapest
 * thing on this page that reads as drawn by a person.
 */
function squiggle(delay = 0.4) {
  const path = document.querySelector(".squiggle path");
  if (!path) return null;
  const len = path.getTotalLength();
  window.gsap.set(path, { strokeDasharray: len, strokeDashoffset: len });
  return window.gsap.to(path, { strokeDashoffset: 0, duration: 0.62, ease: "power2.out", delay });
}

/**
 * The landing hero. The drawing lifts in on a spring, the card beside it settles,
 * and the underline draws itself under the word it belongs to.
 *
 * The sheet used to drift against the scroll here. It was the only parallax in the
 * build, and it was the thing that made the drawing feel glued on badly rather than
 * printed with the page, so it is gone. Nothing on this page moves while you read it.
 */
export function heroScene() {
  if (!ready()) return;
  const g = window.gsap;
  const plate = document.querySelector(".hero .plate");
  const card = document.getElementById("demo");

  squiggle(0.5);
  if (plate) g.from(plate, { y: 30, rotate: -1.2, opacity: 0, duration: 0.85, ease: "back.out(1.5)", delay: 0.15 });
  if (card) g.from(card, { y: 18, opacity: 0, duration: 0.6, ease: "back.out(1.4)", delay: 0.2 });
}

/**
 * Called after the live roster has actually painted, because these chips do not
 * exist when the document is parsed. Each face lands a hand-width after the last.
 */
export function facesPop() {
  if (!ready()) return;
  if (!document.querySelector("#faces .face")) return;
  window.gsap.from("#faces .face", { scale: 0.72, opacity: 0, duration: 0.5, ease: "back.out(2.2)", stagger: 0.07, clearProps: "transform" });
}

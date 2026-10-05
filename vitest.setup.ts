import { beforeEach } from "vitest";
// v1.0.0 exports resetChromeMocks(); it also aliases chrome.reset() at runtime,
// but only the exported name is in the type declarations.
import { chrome, resetChromeMocks } from "vitest-chrome-mv3";

Object.assign(globalThis, { chrome });

/*
 * happy-dom's `Animation.play()` REASSIGNS the public `finished` field with a fresh
 * promise (`Animation.js:110`), where the WAAPI spec says one `Animation` has one
 * `finished`. `motion` captures `finished` at one point in the lifecycle and rejects
 * it later on `stop()`/`cancel()`, so under happy-dom a rejection can land on a promise
 * no caller ever attached a handler to — two unhandled `AbortError`s per run from
 * `SelectionBar` and `Sheet`, from code that is correct in a real browser.
 *
 * Re-attaching a no-op catch on every `play()` is enough: the rejected promise is the
 * current `finished`, and this runs after the reassignment, so it always covers it.
 */
const AnimationCtor = (globalThis as { Animation?: typeof Animation }).Animation;
if (AnimationCtor) {
  const play = AnimationCtor.prototype.play;
  AnimationCtor.prototype.play = function patchedPlay(this: Animation) {
    play.call(this);
    this.finished.catch(() => undefined);
  };
}

beforeEach(() => {
  resetChromeMocks();
});

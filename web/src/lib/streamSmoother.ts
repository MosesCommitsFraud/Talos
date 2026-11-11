/** Evens out streamed text so it appears word by word, at a steady pace,
 *  instead of in the bursts the model and network actually deliver. A dense
 *  model at ~8 tok/s hands us a clump of characters every ~120ms, which reads
 *  as choppy; the smoother parks incoming text in a queue and releases it on
 *  animation frames at a rate derived from the backlog, one whole word at a
 *  time — half a word, or half a `**bold**` marker, never shows.
 *
 *  Thinking and answer text share one queue so their order is preserved — a
 *  round's thinking always finishes revealing before its answer starts. */

export type SmootherSink = (chunk: string, thinking: boolean) => void;

interface Segment {
  text: string;
  thinking: boolean;
}

/** Backlog horizon: the queue is drained at `pending / DRAIN_MS` chars per ms,
 *  so a large backlog catches up fast while a trickle still moves every frame. */
const DRAIN_MS = 220;
/** Slowest reveal (chars/s) — keeps a nearly empty queue from stalling. */
const MIN_CPS = 20;
/** Fastest reveal (chars/s) — a huge backlog (replayed run) must not crawl. */
const MAX_CPS = 1200;
/** Most characters ever kept in flight. Beyond this the excess is emitted at
 *  once: a replayed run arrives as one huge lump, and animating tens of
 *  thousands of characters would leave the user watching a typewriter for
 *  half a minute. The tail still reveals smoothly. */
const MAX_BACKLOG = 400;
/** A frame gap this long means the tab was backgrounded or the main thread was
 *  blocked; drop the animation and emit everything rather than fast-forwarding
 *  through a whole message. */
const STALL_MS = 400;
/** How long an unfinished word may wait for its end before it is shown as is. */
const WORD_WAIT_MS = 180;
/** Longest run without whitespace that is held back as "one word". */
const WORD_HOLD = 32;

export class StreamSmoother {
  private queue: Segment[] = [];
  private pending = 0;
  /** Budget not yet spent, carried between frames: slow rates still add up, and
   *  a long word is paid for over several frames. */
  private carry = 0;
  private raf: number | null = null;
  private lastFrame = 0;
  /** When text last arrived, on the animation-frame clock. */
  private lastPush = 0;

  constructor(private readonly sink: SmootherSink) {}

  push(text: string, thinking: boolean): void {
    if (!text) return;
    const tail = this.queue[this.queue.length - 1];
    if (tail && tail.thinking === thinking) tail.text += text;
    else this.queue.push({ text, thinking });
    this.pending += text.length;
    this.lastPush = performance.now();
    if (this.pending > MAX_BACKLOG) this.emit(this.pending - MAX_BACKLOG);
    this.schedule();
  }

  /** Emit everything still queued right now. Call before any event whose
   *  handling depends on the text already being on screen (a new round, a tool
   *  row, the authoritative `content_final`), and when the turn ends. */
  flush(): void {
    this.stop();
    if (this.pending) this.emit(this.pending);
    this.carry = 0;
  }

  /** Drop queued text without emitting it (the bubble is going away). */
  cancel(): void {
    this.stop();
    this.queue = [];
    this.pending = 0;
    this.carry = 0;
  }

  private stop(): void {
    if (this.raf !== null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }

  private schedule(): void {
    if (this.raf !== null || !this.pending) return;
    this.lastFrame = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    this.raf = null;
    if (!this.pending) return;
    const dt = this.lastFrame ? now - this.lastFrame : 16;
    this.lastFrame = now;
    if (dt >= STALL_MS) {
      this.flush();
      return;
    }
    const cps = Math.min(MAX_CPS, Math.max(MIN_CPS, (this.pending / DRAIN_MS) * 1000));
    // The budget is still counted in characters, so the pace is the one the
    // backlog asks for; it is only spent a whole word at a time.
    let budget = Math.min(this.carry + (cps * dt) / 1000, this.pending);
    for (;;) {
      const word = this.nextWord(now);
      if (!word || word > budget) break;
      this.emit(word);
      budget -= word;
    }
    this.carry = budget;
    if (this.pending) this.raf = requestAnimationFrame(this.tick);
  };

  /** Length of the next piece to release: one word with the whitespace after
   *  it, so text lands word by word instead of letter by letter. Zero while the
   *  word at the head is still arriving.
   *
   *  A word counts as finished when whitespace follows it, when text of the
   *  other kind is queued behind it, or when nothing has arrived for a moment
   *  (the model paused, or this is the last word before a tool call). A run
   *  with no whitespace at all — a long URL, a language written without spaces
   *  — is not held back past WORD_HOLD characters. */
  private nextWord(now: number): number {
    const head = this.queue[0];
    if (!head) return 0;
    const match = /^\s*\S+\s+/.exec(head.text);
    if (match) return match[0].length;
    const complete = this.queue.length > 1 || now - this.lastPush > WORD_WAIT_MS;
    if (complete || head.text.length > WORD_HOLD) return head.text.length;
    return 0;
  }

  /** Hand `count` characters to the sink, one call per run of same-kind text. */
  private emit(count: number): void {
    let left = count;
    while (left > 0 && this.queue.length) {
      const head = this.queue[0];
      const take = Math.min(left, head.text.length);
      const chunk = head.text.slice(0, take);
      if (take === head.text.length) this.queue.shift();
      else head.text = head.text.slice(take);
      left -= take;
      this.pending -= take;
      this.sink(chunk, head.thinking);
    }
  }
}

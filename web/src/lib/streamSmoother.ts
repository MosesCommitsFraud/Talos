/** Evens out streamed text so it appears letter-by-letter instead of in the
 *  bursts the model and network actually deliver. A dense model at ~8 tok/s
 *  hands us a clump of characters every ~120ms, which reads as choppy; the
 *  smoother parks incoming text in a queue and releases it on every animation
 *  frame at a rate derived from the backlog.
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

export class StreamSmoother {
  private queue: Segment[] = [];
  private pending = 0;
  /** Sub-character remainder carried between frames, so slow rates still add up. */
  private carry = 0;
  private raf: number | null = null;
  private lastFrame = 0;

  constructor(private readonly sink: SmootherSink) {}

  push(text: string, thinking: boolean): void {
    if (!text) return;
    const tail = this.queue[this.queue.length - 1];
    if (tail && tail.thinking === thinking) tail.text += text;
    else this.queue.push({ text, thinking });
    this.pending += text.length;
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
    const budget = this.carry + (cps * dt) / 1000;
    const chars = Math.floor(budget);
    this.carry = budget - chars;
    if (chars > 0) this.emit(Math.min(chars, this.pending));
    if (this.pending) this.raf = requestAnimationFrame(this.tick);
  };

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

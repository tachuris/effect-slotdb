import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Ref from 'effect/Ref'
import * as Schema from 'effect/Schema'
import * as SchemaGetter from 'effect/SchemaGetter'

/**
 * A hybrid logical clock stamp ordered by physical time, counter, and node. Logical
 * counters preserve ordering when physical time decreases.
 */
export class Hlc extends Schema.Class<Hlc>('Hlc')({
  millis: Schema.Int,
  counter: Schema.Int,
  node: Schema.String,
}) {
  static readonly new = (millis: number, counter = 0, node = '') =>
    Hlc.make({ millis, counter, node })

  static readonly zero = (node: string, millis = 0, counter = 0): Hlc =>
    Hlc.make({ millis, counter, node })

  static readonly max = (a: Hlc, b: Hlc): Hlc => (Hlc.compare(a, b) >= 0 ? a : b)

  /**
   * Returns a deterministic stamp greater than `prior` without reading a clock. Without
   * `prior`, uses time zero and counter one.
   */
  static readonly beating = (node: string, prior?: Hlc): Hlc =>
    Hlc.make({ millis: prior?.millis ?? 0, counter: (prior?.counter ?? 0) + 1, node })

  static readonly compare = (a: Hlc, b: Hlc): -1 | 0 | 1 =>
    a.millis !== b.millis
      ? a.millis < b.millis
        ? -1
        : 1
      : a.counter !== b.counter
        ? a.counter < b.counter
          ? -1
          : 1
        : a.node < b.node
          ? -1
          : a.node > b.node
            ? 1
            : 0

  /** Advance for a local event observed at physical time `physical`. */
  sendEvent(physical: number): Hlc {
    const millis = Math.max(this.millis, physical)
    const counter = millis === this.millis ? this.counter + 1 : 0
    return Hlc.make({ millis, counter, node: this.node })
  }

  /** Advances the local clock to include `remote` at physical time `physical`. */
  receiveEvent(physical: number, remote: Hlc): Hlc {
    const millis = Math.max(this.millis, remote.millis, physical)
    const counter =
      millis === this.millis && millis === remote.millis
        ? Math.max(this.counter, remote.counter) + 1
        : millis === this.millis
          ? this.counter + 1
          : millis === remote.millis
            ? remote.counter + 1
            : 0
    return Hlc.make({ millis, counter, node: this.node })
  }
}

/** A text codec that preserves stamp ordering with padded time and counter components. */
export const HlcColumn = Schema.String.pipe(
  Schema.decodeTo(Hlc, {
    decode: SchemaGetter.transform(s => {
      const sep1 = s.indexOf(':')
      const sep2 = s.indexOf(':', sep1 + 1)
      return {
        millis: Number(s.slice(0, sep1)),
        counter: Number(s.slice(sep1 + 1, sep2)),
        node: s.slice(sep2 + 1),
      }
    }),
    encode: SchemaGetter.transform(
      hlc =>
        `${hlc.millis.toString().padStart(15, '0')}:${hlc.counter.toString().padStart(10, '0')}:${hlc.node}`,
    ),
  }),
)

/** Encodes an `Hlc` into its stored column text. */
export const encodeHlcColumn = Schema.encodeSync(HlcColumn)

/**
 * Decodes an `Hlc` from its stored column text.
 * @internal
 */
export const decodeHlcColumn = Schema.decodeSync(HlcColumn)

/**
 * A clock for local writes and received stamps. Uses wall time independently of Effect
 * Clock so simulated domain time cannot change replication order.
 */
export class HybridLogicalClock extends Context.Service<
  HybridLogicalClock,
  {
    readonly now: Effect.Effect<Hlc>
    readonly receive: (remote: Hlc) => Effect.Effect<Hlc>
    /**
     * The local wall time in epoch milliseconds. Use for occurrence times because HLC
     * stamps can advance beyond local time after receiving a remote stamp.
     */
    readonly physical: Effect.Effect<number>
  }
>()('changes/HybridLogicalClock') {
  static readonly layer = (node: string, physical: () => number = () => Date.now()) =>
    Layer.effect(
      this,
      Effect.gen(function* () {
        const ref = yield* Ref.make(Hlc.zero(node))
        const read = Effect.sync(physical)
        return HybridLogicalClock.of({
          now: read.pipe(Effect.flatMap(pt => Ref.updateAndGet(ref, clock => clock.sendEvent(pt)))),
          physical: read,
          receive: remote =>
            read.pipe(
              Effect.flatMap(pt => Ref.updateAndGet(ref, clock => clock.receiveEvent(pt, remote))),
            ),
        })
      }),
    )
}

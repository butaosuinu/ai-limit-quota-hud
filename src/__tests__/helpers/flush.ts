/**
 * Drain microtask + macrotask ticks. Each `setTimeout(0)` round flushes one
 * macrotask layer; two rounds covers the typical jotai onMount chain
 * (invoke promise → catch → setState → re-derive) without depending on
 * exactly how many awaits the atom code introduces.
 */
export async function flush(rounds = 2): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

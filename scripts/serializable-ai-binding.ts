import type { WorkersAIBinding } from '../src/ai/workers-ai';

// Node AbortSignal is not serializable across getPlatformProxy's RPC boundary.
// Keep native Worker adapter cancellation unchanged. This Node-only wrapper
// checks pre-abort locally; HybridEngine still enforces its local timeout.
// An already-dispatched remote request cannot be cancelled through this wrapper.
export function serializableAIBinding(binding: WorkersAIBinding): WorkersAIBinding {
  return { run(model, inputs, options) {
    options?.signal?.throwIfAborted();
    const { signal: _localSignal, ...rpcOptions } = options ?? {};
    return binding.run(model, inputs, rpcOptions);
  } };
}

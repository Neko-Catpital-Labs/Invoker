export type CapabilityRole = 'planning' | 'execution';

export type HarnessModelPolicy =
  | { kind: 'implicit' }
  | { kind: 'fixed'; model: string }
  | { kind: 'select'; models: string[]; defaultModel: string };

export interface HarnessCapability {
  modelPolicy: HarnessModelPolicy;
}

export interface MachineCapabilities {
  planning?: Record<string, HarnessCapability>;
  execution?: Record<string, HarnessCapability>;
}

export interface HarnessSelectionRequest {
  role: CapabilityRole;
  harness: string;
  model?: string;
}

export interface ResolvedHarnessSelection {
  harness: string;
  model?: string;
}

export function resolveHarnessSelection(
  capabilities: MachineCapabilities | undefined,
  request: HarnessSelectionRequest,
): { ok: true; selection: ResolvedHarnessSelection } | { ok: false; reason: string } {
  if (!capabilities) {
    return {
      ok: true,
      selection: { harness: request.harness, model: request.model },
    };
  }

  const roleCapabilities = capabilities[request.role];
  if (!roleCapabilities) {
    return { ok: false, reason: `missing ${request.role} capabilities` };
  }

  const capability = roleCapabilities[request.harness];
  if (!capability) {
    return { ok: false, reason: `missing ${request.role} harness "${request.harness}"` };
  }

  const policy = capability.modelPolicy;
  if (policy.kind === 'implicit') {
    if (request.model) {
      return { ok: false, reason: `harness "${request.harness}" does not accept an explicit model` };
    }
    return { ok: true, selection: { harness: request.harness } };
  }

  if (policy.kind === 'fixed') {
    if (request.model && request.model !== policy.model) {
      return { ok: false, reason: `harness "${request.harness}" is fixed to model "${policy.model}"` };
    }
    return {
      ok: true,
      selection: { harness: request.harness, model: policy.model },
    };
  }

  if (policy.models.length === 0) {
    return { ok: false, reason: `harness "${request.harness}" does not advertise any models` };
  }
  if (!request.model) {
    return {
      ok: true,
      selection: { harness: request.harness, model: policy.defaultModel },
    };
  }
  if (!policy.models.includes(request.model)) {
    return { ok: false, reason: `harness "${request.harness}" does not advertise model "${request.model}"` };
  }
  return {
    ok: true,
    selection: { harness: request.harness, model: request.model },
  };
}

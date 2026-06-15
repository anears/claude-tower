import { useState } from 'react';

// A declarative, multi-step "prompt flow" abstraction. Each flow is described
// as data (steps with labels / placeholders / validation, or a single yes/no
// confirm) plus an async onComplete that performs the side effect and returns
// the flash message to show. This replaces the hand-rolled per-flow state in
// App: adding a new flow is now a matter of declaring a FlowDef.

export interface FlowContext {
  // Emit an intermediate flash *before* onComplete resolves (e.g. "launching…").
  flash: (msg: string) => void;
}

export interface FlowStep {
  key: string;
  // Per-step prompt label (after the "(n/total)"). May depend on prior answers.
  label: (draft: Record<string, string>) => string;
  placeholder?: (draft: Record<string, string>) => string;
  // Return an error message to abort the flow (and flash it), or undefined to
  // accept the value and advance. Receives the trimmed input.
  validate?: (value: string, draft: Record<string, string>) => string | undefined;
  // What to store for this step. Defaults to the trimmed input.
  transform?: (value: string) => string;
  // Optional async Tab-completion. Given the current (trimmed) input + prior
  // answers, return candidate completions (e.g. full directory paths). Drives
  // the Tab key: FlowPrompt fills the longest common prefix and lists the
  // candidates below the input. Steps without this ignore Tab.
  complete?: (value: string, draft: Record<string, string>) => Promise<string[]>;
}

// A degenerate single-key yes/no confirmation (rendered red, no text input).
export interface ConfirmSpec {
  prefix: string;
  subject: string;
  suffix: string;
  color: string;
}

export interface FlowDef {
  kind: string;
  header: string; // e.g. "Add 서버" | "New session"; unused for confirm flows
  steps: FlowStep[]; // empty for confirm flows
  confirm?: ConfirmSpec; // present → this is a yes/no confirm flow
  onComplete: (draft: Record<string, string>, ctx: FlowContext) => Promise<string>;
}

export interface ActiveFlow {
  def: FlowDef;
  step: number;
  draft: Record<string, string>;
  value: string;
  candidates: string[] | null; // null = not yet completed; [] = completed, none found
  completing: boolean; // a complete() call is in flight
  completeNonce: number; // bumps only when Tab fills the value (forces input remount → cursor to end)
}

export interface UseFlow {
  active: ActiveFlow | null;
  start: (def: FlowDef) => void;
  setValue: (v: string) => void;
  submit: (value: string) => void; // advance an input flow with the submitted value
  tab: () => void; // run the current step's completion (no-op if it has none)
  confirm: () => void; // accept a confirm flow (yes)
  cancel: () => void; // Esc / no
}

// Longest common prefix across candidates — what Tab auto-fills.
function commonPrefix(strs: string[]): string {
  if (strs.length === 0) return '';
  let p = strs[0]!;
  for (const s of strs) {
    let i = 0;
    while (i < p.length && i < s.length && p[i] === s[i]) i++;
    p = p.slice(0, i);
    if (!p) break;
  }
  return p;
}

export function useFlow(onFlash: (msg: string) => void): UseFlow {
  const [active, setActive] = useState<ActiveFlow | null>(null);

  const finish = async (def: FlowDef, draft: Record<string, string>): Promise<void> => {
    const msg = await def.onComplete(draft, { flash: onFlash });
    onFlash(msg);
  };

  const fresh = (def: FlowDef, step: number, draft: Record<string, string>): ActiveFlow => ({
    def,
    step,
    draft,
    value: '',
    candidates: null,
    completing: false,
    completeNonce: 0,
  });

  const start = (def: FlowDef): void => setActive(fresh(def, 0, {}));
  // User edits clear any stale candidate list (it no longer matches the input).
  const setValue = (v: string): void =>
    setActive((a) => (a ? { ...a, value: v, candidates: null } : a));
  const cancel = (): void => setActive(null);

  const tab = (): void => {
    if (!active) return;
    const { def, step, draft, value } = active;
    const stepDef = def.steps[step];
    if (!stepDef?.complete) return;
    setActive((a) => (a ? { ...a, completing: true } : a));
    const query = value.trim();
    void (async () => {
      let candidates: string[] = [];
      try {
        candidates = await stepDef.complete!(query, draft);
      } catch {
        candidates = [];
      }
      setActive((a) => {
        // Bail if the flow moved on (step/def changed) while we awaited.
        if (!a || a.def !== def || a.step !== step) return a;
        // Fill to the longest common prefix when it extends the input. We trust
        // complete() to return only sensible extensions (it may also normalize,
        // e.g. anchor a bare path to ~/), so we require "longer" rather than a
        // literal startsWith on the raw input.
        const lcp = commonPrefix(candidates);
        const fill = lcp.length > a.value.length ? lcp : a.value;
        return {
          ...a,
          completing: false,
          candidates,
          value: fill,
          completeNonce: a.completeNonce + (fill !== a.value ? 1 : 0),
        };
      });
    })();
  };

  const submit = (value: string): void => {
    if (!active) return;
    const { def, step, draft } = active;
    const stepDef = def.steps[step];
    if (!stepDef) return;
    const v = value.trim();
    const err = stepDef.validate?.(v, draft);
    if (err !== undefined) {
      setActive(null);
      onFlash(err);
      return;
    }
    const stored = stepDef.transform ? stepDef.transform(v) : v;
    const nextDraft = { ...draft, [stepDef.key]: stored };
    if (step + 1 < def.steps.length) {
      setActive(fresh(def, step + 1, nextDraft));
      return;
    }
    setActive(null);
    void finish(def, nextDraft);
  };

  const confirm = (): void => {
    if (!active || !active.def.confirm) return;
    const { def, draft } = active;
    setActive(null);
    void finish(def, draft);
  };

  return { active, start, setValue, submit, tab, confirm, cancel };
}

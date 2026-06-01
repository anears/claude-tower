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
}

export interface UseFlow {
  active: ActiveFlow | null;
  start: (def: FlowDef) => void;
  setValue: (v: string) => void;
  submit: (value: string) => void; // advance an input flow with the submitted value
  confirm: () => void; // accept a confirm flow (yes)
  cancel: () => void; // Esc / no
}

export function useFlow(onFlash: (msg: string) => void): UseFlow {
  const [active, setActive] = useState<ActiveFlow | null>(null);

  const finish = async (def: FlowDef, draft: Record<string, string>): Promise<void> => {
    const msg = await def.onComplete(draft, { flash: onFlash });
    onFlash(msg);
  };

  const start = (def: FlowDef): void => setActive({ def, step: 0, draft: {}, value: '' });
  const setValue = (v: string): void => setActive((a) => (a ? { ...a, value: v } : a));
  const cancel = (): void => setActive(null);

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
      setActive({ def, step: step + 1, draft: nextDraft, value: '' });
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

  return { active, start, setValue, submit, confirm, cancel };
}

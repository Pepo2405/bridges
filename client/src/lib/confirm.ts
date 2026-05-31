import { createSignal } from "solid-js";

export type ConfirmOpts = {
  title: string;
  description?: string;
  confirmText?: string;
  destructive?: boolean;
};
type Pending = ConfirmOpts & { resolve: (v: boolean) => void };

const [pending, setPending] = createSignal<Pending | null>(null);
export { pending, setPending };

/** Confirmación estilada (reemplaza al confirm() nativo). Resuelve true/false. */
export function askConfirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => setPending({ ...opts, resolve }));
}

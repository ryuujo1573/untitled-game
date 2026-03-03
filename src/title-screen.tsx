import { For, Show, createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { SaveSummary } from "~/game/session-types";

export interface TitleScreenState {
  saves: SaveSummary[];
  selectedSaveId: string | null;
}

export interface TitleScreenHandlers {
  onSelectSave: (id: string) => void;
  onContinue: () => void;
  onCreateWorld: () => void;
  onRename: () => void;
  onDelete: () => void;
}

export interface TitleScreenController {
  setState: (state: TitleScreenState) => void;
  destroy: () => void;
}

export function mountTitleScreen(
  container: HTMLElement,
  initialState: TitleScreenState,
  handlers: TitleScreenHandlers,
): TitleScreenController {
  const [state, setState] = createSignal(initialState);

  const dispose = render(
    () => (
      <div class="fixed inset-0 z-40 flex items-center justify-center bg-[radial-gradient(circle_at_20%_20%,#2a3748_0%,#0f1219_40%,#07090d_100%)] text-white">
        <div class="w-[min(92vw,760px)] rounded-xl border border-white/15 bg-black/35 backdrop-blur-md p-6">
          <h1 class="text-4xl font-bold tracking-wide">Voxxer</h1>
          <p class="text-white/70 mt-1">Choose a world or create a new one.</p>

          <div class="mt-5 rounded-lg border border-white/10 bg-black/30 max-h-72 overflow-y-auto">
            <Show
              when={state().saves.length > 0}
              fallback={<p class="p-4 text-white/60 text-sm">No saves yet. Create your first world.</p>}
            >
              <div class="divide-y divide-white/10">
                <For each={state().saves}>
                  {(save) => (
                    <button
                      class="w-full text-left px-4 py-3 hover:bg-white/8 transition-colors"
                      classList={{ "bg-white/15": state().selectedSaveId === save.id }}
                      onClick={() => handlers.onSelectSave(save.id)}
                    >
                      <div class="font-semibold">{save.name}</div>
                      <div class="text-xs text-white/55">Updated {new Date(save.updatedAtMs).toLocaleString()}</div>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>

          <div class="mt-5 grid grid-cols-2 md:grid-cols-4 gap-2">
            <button
              class="btn btn-primary"
              disabled={!state().selectedSaveId}
              onClick={handlers.onContinue}
            >
              Continue
            </button>
            <button class="btn btn-soft btn-secondary" onClick={handlers.onCreateWorld}>
              New World
            </button>
            <button
              class="btn btn-soft btn-warning"
              disabled={!state().selectedSaveId}
              onClick={handlers.onRename}
            >
              Rename
            </button>
            <button
              class="btn btn-soft btn-error"
              disabled={!state().selectedSaveId}
              onClick={handlers.onDelete}
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    ),
    container,
  );

  return {
    setState,
    destroy: dispose,
  };
}

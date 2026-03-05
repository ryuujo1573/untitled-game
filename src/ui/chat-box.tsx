import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { render } from "solid-js/web";
import Time from "~/environment/time/time-manager";
import { Settings } from "~/logic/settings/settings";

export interface ChatMessage {
  text: string;
  type: "info" | "chat" | "error";
}

const [messages, setMessages] = createSignal<ChatMessage[]>([]);
const [isOpen, setIsOpen] = createSignal(false);
const [inputValue, setInputValue] = createSignal("");
const [lastMessageAtMs, setLastMessageAtMs] = createSignal<number | null>(null);

export function addMessage(text: string, type: ChatMessage["type"] = "chat") {
  setMessages([...messages(), { text, type }]);
  setLastMessageAtMs(Date.now());
}

export class ChatBox {
  private disposeUI: (() => void) | null = null;
  private readonly onFocusLost: () => void;

  constructor(onFocusLost: () => void) {
    this.onFocusLost = onFocusLost;
  }

  get openStatus(): boolean {
    return isOpen();
  }

  mount(container: HTMLElement): void {
    this.disposeUI = render(() => <ChatOverlay chat={this} />, container);
  }

  open(initialValue = "") {
    setIsOpen(true);
    setInputValue(initialValue);
    // When opening, we should let the input focus.
  }

  close() {
    setIsOpen(false);
    this.onFocusLost();
  }

  destroy(): void {
    this.disposeUI?.();
    this.disposeUI = null;
  }
}

function ChatOverlay(props: { chat: ChatBox }) {
  let inputRef: HTMLInputElement | undefined;
  let listRef: HTMLDivElement | undefined;
  const [nowMs, setNowMs] = createSignal(Date.now());
  const [hasOverflow, setHasOverflow] = createSignal(false);
  const [pinnedToBottom, setPinnedToBottom] = createSignal(true);

  createEffect(() => {
    if (isOpen() && inputRef) {
      inputRef.focus();
    }
  });

  createEffect(() => {
    const last = lastMessageAtMs();
    if (last === null) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 250);
    onCleanup(() => window.clearInterval(id));
  });

  const shouldFadeOut = createMemo(() => {
    const last = lastMessageAtMs();
    if (last === null) return false;
    if (isOpen()) return false;
    return nowMs() - last > Settings.message.fadeOutAfterMs;
  });

  const listMaskImage = createMemo(() => {
    if (!pinnedToBottom() || !hasOverflow()) return undefined;
    const ratio = Settings.message.topFadeStartRatio;
    const pct = Math.round(ratio * 1000) / 10;
    return `linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,1) ${pct}%, rgba(0,0,0,1) 100%)`;
  });

  const updateScrollState = () => {
    if (!listRef) return;
    setHasOverflow(listRef.scrollHeight > listRef.clientHeight);
    const epsilon = 2;
    const atBottom =
      listRef.scrollTop + listRef.clientHeight >=
      listRef.scrollHeight - epsilon;
    setPinnedToBottom(atBottom);
  };

  const scrollToBottom = () => {
    if (!listRef) return;
    listRef.scrollTop = listRef.scrollHeight;
    updateScrollState();
  };

  createEffect(() => {
    if (!isOpen()) return;
    queueMicrotask(() => {
      scrollToBottom();
    });
  });

  createEffect(() => {
    const wasPinned = pinnedToBottom();
    messages();
    queueMicrotask(() => {
      if (!listRef) return;
      updateScrollState();
      if (wasPinned) {
        scrollToBottom();
      }
    });
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const val = inputValue().trim();
      if (val) {
        processInput(val);
      }
      props.chat.close();
      setInputValue("");
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.chat.close();
      setInputValue("");
    }
  };

  const processInput = (input: string) => {
    if (input.startsWith("/")) {
      const parts = input.slice(1).trim().split(/\s+/);
      const command = parts[0].toLowerCase();
      // const args = parts.slice(1);

      switch (command) {
        case "date": {
          const time = Time.worldTime;
          const day = Time.day;
          // 0.00 = midnight, 0.25 = sunrise, 0.50 = noon, 0.75 = sunset
          const totalMinutesInDay = 24 * 60;
          const currentMinutes = Math.floor(time * totalMinutesInDay);
          const hours = Math.floor(currentMinutes / 60);
          const minutes = currentMinutes % 60;
          addMessage(
            `Day ${day}, ${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`,
            "info",
          );
          break;
        }
        case "help": {
          addMessage("Available commands: /date, /help", "info");
          break;
        }
        default: {
          addMessage(`Unknown command: /${command}`, "error");
        }
      }
    } else {
      addMessage(input, "chat");
    }
  };

  return (
    <div
      class="fixed bottom-0 left-0 w-full p-4 pointer-events-none z-50"
      style={{ height: `${Settings.chat.areaHeightVh}vh` }}
    >
      {/* Message List */}
      <Show when={messages().length > 0}>
        <div
          class="max-w-2xl rounded bg-black/50 px-2 py-1.5 transition-opacity duration-500 h-full overflow-hidden"
          classList={{ "opacity-0": shouldFadeOut() }}
          style={{ "padding-bottom": `${Settings.chat.inputReservedPx}px` }}
        >
          <div
            ref={listRef}
            class="h-full overflow-y-auto flex flex-col justify-end gap-1 text-sm font-mono whitespace-pre-wrap"
            style={
              {
                ...(listMaskImage()
                  ? {
                      "-webkit-mask-image": listMaskImage()!,
                      "mask-image": listMaskImage()!,
                    }
                  : {}),
                "pointer-events": isOpen() ? "auto" : "none",
              } as any
            }
            onScroll={() => updateScrollState()}
          >
            <For each={messages()}>
              {(msg) => (
                <div
                  classList={{
                    "text-blue-300": msg.type === "info",
                    "text-red-300": msg.type === "error",
                    "text-white": msg.type === "chat",
                  }}
                >
                  {msg.text}
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Input Field */}
      <div
        class="absolute bottom-4 left-4 right-4 pointer-events-none"
        style={{ height: `${Settings.chat.inputReservedPx}px` }}
      >
        <div
          class="h-full bg-black/70 p-2 rounded flex items-center gap-2 transition-opacity"
          classList={{ "opacity-0": !isOpen() }}
          style={{ "pointer-events": isOpen() ? "auto" : "none" }}
        >
          <span class="text-white font-mono">
            {inputValue().startsWith("/") ? "" : ">"}
          </span>
          <input
            ref={inputRef}
            type="text"
            class="bg-transparent text-white outline-none flex-1 font-mono"
            value={inputValue()}
            onInput={(e) => setInputValue(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
      </div>
    </div>
  );
}

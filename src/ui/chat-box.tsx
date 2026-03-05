import makeCli from "make-cli";
import {
  createEffect,
  createSignal,
  For,
  Show,
} from "solid-js";
import { render } from "solid-js/web";
import Time from "~/environment/time/time-manager";

export interface ChatMessage {
  text: string;
  type: "info" | "chat" | "error";
}

const [messages, setMessages] = createSignal<ChatMessage[]>(
  [],
);
const [isOpen, setIsOpen] = createSignal(false);
const [inputValue, setInputValue] = createSignal("");

export function addMessage(
  text: string,
  type: ChatMessage["type"] = "chat",
) {
  setMessages([...messages(), { text, type }]);
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
    this.disposeUI = render(
      () => <ChatOverlay chat={this} />,
      container,
    );
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

  createEffect(() => {
    if (isOpen() && inputRef) {
      inputRef.focus();
    }
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      const val = inputValue().trim();
      if (val) {
        processInput(val);
      }
      props.chat.close();
      setInputValue("");
    } else if (e.key === "Escape") {
      props.chat.close();
      setInputValue("");
    }
  };

  const processInput = (input: string) => {
    if (input.startsWith("/")) {
      const args = input.slice(1).trim().split(/\s+/);

      // Monkey-patch process for make-cli/commander
      const win = window as any;
      if (typeof win.process === "undefined") {
        win.process = {
          argv: [],
          stdout: { write: () => {} },
          stderr: { write: () => {} },
          exit: () => {},
        };
      }
      const oldArgv = win.process.argv;
      win.process.argv = ["node", "script", ...args];

      try {
        makeCli({
          commands: {
            date: {
              description: "Show current game time",
              handler: () => {
                const time = Time.worldTime;
                const day = Time.day;
                // 0.00 = midnight, 0.25 = sunrise, 0.50 = noon, 0.75 = sunset
                const totalMinutesInDay = 24 * 60;
                const currentMinutes = Math.floor(
                  time * totalMinutesInDay,
                );
                const hours = Math.floor(
                  currentMinutes / 60,
                );
                const minutes = currentMinutes % 60;
                addMessage(
                  `Day ${day}, ${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`,
                  "info",
                );
              },
            },
          },
        });
      } catch (e) {
        // Commander might throw if it can't parse or command is unknown
        // but it usually just exits or logs to console.
        addMessage(
          `Error executing command: ${e}`,
          "error",
        );
      } finally {
        win.process.argv = oldArgv;
      }
    } else {
      addMessage(input, "chat");
    }
  };

  return (
    <div class="fixed bottom-0 left-0 w-full p-4 pointer-events-none z-50 flex flex-col justify-end h-1/2">
      {/* Message List */}
      <div class="overflow-y-auto max-h-full mb-2 flex flex-col gap-1">
        <For each={messages()}>
          {(msg) => (
            <div
              class="bg-black/50 text-white px-2 py-1 rounded text-sm w-fit max-w-2xl"
              classList={{
                "text-blue-300": msg.type === "info",
                "text-red-300": msg.type === "error",
              }}
            >
              {msg.text}
            </div>
          )}
        </For>
      </div>

      {/* Input Field */}
      <Show when={isOpen()}>
        <div class="pointer-events-auto bg-black/70 p-2 rounded flex items-center gap-2">
          <span class="text-white font-mono">
            {inputValue().startsWith("/") ? "" : ">"}
          </span>
          <input
            ref={inputRef}
            type="text"
            class="bg-transparent text-white outline-none flex-1 font-mono"
            value={inputValue()}
            onInput={(e) =>
              setInputValue(e.currentTarget.value)
            }
            onKeyDown={handleKeyDown}
          />
        </div>
      </Show>
    </div>
  );
}
